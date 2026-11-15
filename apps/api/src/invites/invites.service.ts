import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import {
  maskPhone,
  normalizePhone,
  parseAvatar,
  type ClaimInviteResponse,
  type ClaimedInvite,
  type CreateInviteRequest,
  type CreatedInvite,
  type GuestRunState,
  type GuestSession,
  type InvitePublic,
  type InviteStatus,
  type InviteSummary,
  type InvitesResponse,
} from '@dyce/shared';
import { AuthError } from '../auth/auth-error.ts';
import { hashPhone, lockKey, safeEqual, sha256 } from '../auth/crypto.ts';
import type { Clock } from '../auth/tokens.ts';
import { lagosDayStart, readConfigInt, secondsUntilLagosMidnight } from '../db/config.ts';
import { withTx } from '../db/tx.ts';
import { ENGINES } from '../matches/engines.ts';
import { lockPair } from '../social/relationship.ts';
import { SmsDeliveryError, type SmsProvider } from '../sms/sms-provider.ts';
import { GUEST_GAMES, GUEST_HOST_ID, GUEST_ID, GUEST_RUN_TTL_MS } from './guest-games.ts';

/** Starts the Free match for a signed-up invitee (MatchesService). */
export interface InviteMatches {
  startFromInvite(input: {
    id: string;
    inviterId: string;
    userId: string;
    conversationId: string;
    gameSlug: string;
    seed: string;
    played: { action: unknown; at: Date }[] | null;
  }): Promise<string>;
}

/** Opens the chat between two people (MessagesService). */
export interface InviteChat {
  openDirect(userId: string, peerId: string): Promise<{ id: string }>;
}

export type InvitesConfig = {
  /** PHONE_HASH_SALT: the same keyed hash as `users.phone_hash`, so joining is an equality check. */
  phoneSecret: string;
  /** Origin that serves `/i/<token>` (INVITE_BASE_URL). */
  linkBase: string;
};

type Logger = { warn(message: string): void };

/** Spam guard: the same sender may not text the same number again within this many seconds. */
export const INVITE_RESEND_COOLDOWN_SECONDS = 60;

const DAY_MS = 24 * 60 * 60 * 1000;

type InviteRow = {
  id: string;
  inviter_id: string;
  phone_hash: Buffer;
  game_slug: string;
  match_id: string | null;
  token: string;
  status: InviteStatus;
  created_at: Date;
  expires_at: Date;
  joined_user_id: string | null;
};

type RunRow = {
  id: string;
  invite_id: string;
  token_hash: Buffer;
  game_slug: string;
  seed: string;
  state: unknown;
  moves: { action: unknown; at: string }[];
  run_state: GuestRunState;
  expires_at: Date;
};

/**
 * SMS invites for people who are not on Dyce, the guest game they can play in a browser, and joining up when
 * they sign up (ADR-020).
 *
 * The number only exists in memory while the text goes out: the row keeps `HMAC(PHONE_HASH_SALT, number)`.
 * The link is `<base>/i/<token>#p=<digits>`; the fragment hands the number to the invitee's own browser (to
 * prefill sign-up) and is never sent to a server. The token is 96 random bits and expires after
 * `invite_ttl_days`. A guest has no account: a run is issued a secret guest token, the server holds the engine
 * state and screens every move, so the browser only renders.
 */
export class InvitesService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly sms: SmsProvider,
    private readonly matches: InviteMatches,
    private readonly chat: InviteChat,
    private readonly config: InvitesConfig,
    private readonly clock: Clock = () => new Date(),
    private readonly logger: Logger = { warn: () => undefined },
  ) {}

  // ---- sending ----------------------------------------------------------------------------------

  /**
   * Texts a game invite to a phone number from the sender's contacts. Refuses numbers already on Dyce (they
   * are in the sender's contacts as people to add, not to text), the sender's own number, and over-sending:
   * `sms_invites_per_day` per sender, `sms_invites_per_number_per_day` per number from everyone, and one text
   * per sender and number per minute.
   */
  async create(userId: string, input: CreateInviteRequest): Promise<CreatedInvite> {
    const e164 = normalizePhone(input.phone, input.country);
    if (!e164) throw new AuthError('invalid_phone');
    const hash = hashPhone(this.config.phoneSecret, e164);
    const now = this.clock();

    const me = await this.pool.query<{
      phone_hash: Buffer;
      display_name: string;
      username: string;
    }>(
      `SELECT u.phone_hash, p.display_name, p.username
         FROM users u JOIN profiles p ON p.id = u.id WHERE u.id = $1 AND u.disabled_at IS NULL`,
      [userId],
    );
    const sender = me.rows[0];
    if (!sender) throw new AuthError('profile_required');
    if (safeEqual(sender.phone_hash, hash)) throw new AuthError('cannot_add_self');

    const game = await this.pool.query<{ name: string }>(
      `SELECT name FROM games WHERE slug = $1 AND enabled`,
      [input.gameSlug],
    );
    const entry = ENGINES[input.gameSlug];
    if (!game.rows[0] || !entry || entry.devOnly) throw new AuthError('game_not_found');

    const ttlDays = await readConfigInt(this.pool, 'invite_ttl_days', 7);
    const token = newToken();
    const row = await withTx(this.pool, async (c) => {
      // One writer at a time per number and per sender, so parallel requests cannot slip past the limits.
      await c.query('SELECT pg_advisory_xact_lock($1::bigint)', [lockKey(hash)]);
      await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1::text, 16))`, [userId]);

      const onDyce = await c.query(`SELECT 1 FROM users WHERE phone_hash = $1`, [hash]);
      if (onDyce.rows[0]) throw new AuthError('already_on_dyce');

      const last = await c.query<{ created_at: Date }>(
        `SELECT max(created_at) AS created_at FROM sms_invites WHERE inviter_id = $1 AND phone_hash = $2`,
        [userId, hash],
      );
      const lastAt = last.rows[0]?.created_at;
      if (lastAt) {
        const since = (now.getTime() - lastAt.getTime()) / 1000;
        if (since < INVITE_RESEND_COOLDOWN_SECONDS) {
          throw new AuthError('invite_too_soon', {
            retryAfterSeconds: Math.ceil(INVITE_RESEND_COOLDOWN_SECONDS - since),
          });
        }
      }

      const perDay = await readConfigInt(c, 'sms_invites_per_day', 50);
      const mine = await c.query<{ n: string }>(
        `SELECT count(*) AS n FROM sms_invites WHERE inviter_id = $1 AND created_at >= $2`,
        [userId, lagosDayStart(now)],
      );
      if (Number(mine.rows[0]!.n) >= perDay) {
        throw new AuthError('invite_rate_limited', {
          retryAfterSeconds: secondsUntilLagosMidnight(now),
        });
      }

      const perNumber = await readConfigInt(c, 'sms_invites_per_number_per_day', 3);
      const toThem = await c.query<{ n: string; oldest: Date | null }>(
        `SELECT count(*) AS n, min(created_at) AS oldest FROM sms_invites
          WHERE phone_hash = $1 AND created_at > $2`,
        [hash, new Date(now.getTime() - DAY_MS)],
      );
      if (Number(toThem.rows[0]!.n) >= perNumber) {
        const oldest = toThem.rows[0]!.oldest ?? now;
        throw new AuthError('invite_number_limited', {
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((oldest.getTime() + DAY_MS - now.getTime()) / 1000),
          ),
        });
      }

      const expires = new Date(now.getTime() + ttlDays * DAY_MS);
      const ins = await c.query<{ id: string }>(
        `INSERT INTO sms_invites (inviter_id, phone_hash, game_slug, token, status, created_at, expires_at)
         VALUES ($1, $2, $3, $4, 'sent', $5, $6) RETURNING id`,
        [userId, hash, input.gameSlug, token, now, expires],
      );
      return { id: ins.rows[0]!.id, expires };
    });

    const link = `${this.config.linkBase.replace(/\/$/, '')}/i/${token}#p=${e164.slice(1)}`;
    const name = sender.display_name.trim() || `@${sender.username}`;
    try {
      await this.sms.send(
        e164,
        `${name} challenged you to ${game.rows[0].name} on Dyce. Play in your browser, no app needed: ${link}`,
      );
    } catch (err) {
      // A failed send must not use up anybody's limit, and must leave no live invite behind.
      await this.pool.query('DELETE FROM sms_invites WHERE id = $1', [row.id]);
      const provider = err instanceof SmsDeliveryError ? err.provider : 'unknown';
      this.logger.warn(`invite sms failed via ${provider} to ${maskPhone(e164)}`);
      throw new AuthError('sms_failed');
    }

    return {
      id: row.id,
      token,
      status: 'sent',
      gameSlug: input.gameSlug,
      link,
      createdAt: now.toISOString(),
      expiresAt: row.expires.toISOString(),
    };
  }

  /** The invites you sent, newest first. Never includes who they were sent to. */
  async list(userId: string): Promise<InvitesResponse> {
    const r = await this.pool.query<{
      id: string;
      game_slug: string;
      game_name: string;
      status: InviteStatus;
      created_at: Date;
      expires_at: Date;
      username: string | null;
      display_name: string | null;
    }>(
      `SELECT i.id, i.game_slug, g.name AS game_name, i.status, i.created_at, i.expires_at,
              p.username, p.display_name
         FROM sms_invites i
         JOIN games g ON g.slug = i.game_slug
         LEFT JOIN profiles p ON p.id = i.joined_user_id
        WHERE i.inviter_id = $1
        ORDER BY i.created_at DESC LIMIT 100`,
      [userId],
    );
    const invites: InviteSummary[] = r.rows.map((x) => ({
      id: x.id,
      gameSlug: x.game_slug,
      gameName: x.game_name,
      status: x.status,
      createdAt: x.created_at.toISOString(),
      expiresAt: x.expires_at.toISOString(),
      joinedAs: x.username ? { username: x.username, displayName: x.display_name ?? '' } : null,
    }));
    return { invites };
  }

  // ---- the landing page --------------------------------------------------------------------------

  /** What the page behind a link shows. Opening a fresh invite marks it `opened`. */
  async get(token: string): Promise<InvitePublic> {
    const now = this.clock();
    const r = await this.pool.query<
      InviteRow & {
        game_name: string;
        username: string;
        display_name: string;
        avatar: unknown;
        run_state: GuestRunState | null;
        run_state_json: unknown;
      }
    >(
      `SELECT i.id, i.inviter_id, i.phone_hash, i.game_slug, i.match_id, i.token, i.status, i.created_at,
              i.expires_at, i.joined_user_id, g.name AS game_name, p.username, p.display_name, p.avatar,
              gr.run_state, gr.state AS run_state_json
         FROM sms_invites i
         JOIN games g ON g.slug = i.game_slug
         JOIN profiles p ON p.id = i.inviter_id
         JOIN users u ON u.id = i.inviter_id AND u.disabled_at IS NULL
         LEFT JOIN guest_runs gr ON gr.invite_id = i.id
        WHERE i.token = $1`,
      [token],
    );
    const row = r.rows[0];
    if (!row) throw new AuthError('invite_not_found');

    const joined = row.status === 'joined';
    const expired = !joined && row.expires_at.getTime() <= now.getTime();
    let status = row.status;
    if (!expired && !joined && status === 'sent') {
      await this.pool.query(
        `UPDATE sms_invites SET status = 'opened', opened_at = $2 WHERE id = $1 AND status = 'sent'`,
        [row.id, now],
      );
      status = 'opened';
    }

    const guestGame = GUEST_GAMES[row.game_slug];
    const playable = guestGame !== undefined && ENGINES[row.game_slug] !== undefined;
    const finished = row.run_state === 'done';
    return {
      state: joined ? 'joined' : expired ? 'expired' : 'open',
      status,
      inviter: {
        username: row.username,
        displayName: row.display_name,
        avatar: parseAvatar(row.avatar),
      },
      game: {
        slug: row.game_slug,
        name: row.game_name,
        guestPlayable: playable,
        roundSeconds: playable
          ? Math.round(guestGame.roundMs(ENGINES[row.game_slug]!.cfg) / 1000)
          : null,
      },
      guest: {
        started: row.run_state === 'playing' || finished,
        finished,
        score: finished && guestGame ? guestGame.score(row.run_state_json) : null,
      },
      expiresAt: row.expires_at.toISOString(),
    };
  }

  // ---- the guest game ----------------------------------------------------------------------------

  /**
   * Starts (or resumes) the guest's run for this invite. A run that has not started yet can be re-issued with
   * a new secret (a refresh before the first tap); once the grid has been shown, only the holder of the guest
   * token can continue, so a link cannot be used to see the board again and again.
   */
  async startGuest(token: string, guestToken?: string): Promise<GuestSession> {
    const now = this.clock();
    return withTx(this.pool, async (c) => {
      const invite = await this.openInvite(c, token, now);
      const guestGame = GUEST_GAMES[invite.game_slug];
      const entry = ENGINES[invite.game_slug];
      if (!guestGame || !entry || entry.devOnly) throw new AuthError('guest_game_unavailable');

      const existing = await c.query<RunRow>(
        `SELECT * FROM guest_runs WHERE invite_id = $1 FOR UPDATE`,
        [invite.id],
      );
      const run = existing.rows[0];
      const expiresAt = new Date(now.getTime() + GUEST_RUN_TTL_MS);

      if (run) {
        if (guestToken && this.tokenMatches(run, guestToken) && run.expires_at > now) {
          return this.session(run, undefined);
        }
        if (run.run_state !== 'idle') throw new AuthError('guest_already_played');
        const fresh = newGuestToken();
        await c.query(`UPDATE guest_runs SET token_hash = $2, expires_at = $3 WHERE id = $1`, [
          run.id,
          sha256(fresh),
          expiresAt,
        ]);
        return this.session({ ...run, expires_at: expiresAt }, fresh);
      }

      const seed = newSeed();
      const state = entry.engine.init([GUEST_HOST_ID, GUEST_ID], BigInt(seed), entry.cfg);
      const fresh = newGuestToken();
      const ins = await c.query<RunRow>(
        `INSERT INTO guest_runs (invite_id, token_hash, game_slug, seed, state, expires_at, created_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7) RETURNING *`,
        [invite.id, sha256(fresh), invite.game_slug, seed, JSON.stringify(state), expiresAt, now],
      );
      return this.session(ins.rows[0]!, fresh);
    });
  }

  /** The guest's current view (to resume after a refresh). */
  async guestView(token: string, guestToken: string): Promise<GuestSession> {
    const now = this.clock();
    const { run } = await this.authGuest(this.pool, token, guestToken, now);
    return this.session(run, undefined);
  }

  /**
   * One move by the guest. Validated and applied with the game's engine on the server, with the same clock
   * screening as a signed-in player (a Word Hunt submit that is late scores nothing). A repeat of the final
   * submit returns the result again, so a lost response is harmless.
   */
  async guestMove(token: string, guestToken: string, rawAction: unknown): Promise<GuestSession> {
    const now = this.clock();
    return withTx(this.pool, async (c) => {
      const { run, inviteId } = await this.authGuest(c, token, guestToken, now, true);
      const entry = ENGINES[run.game_slug];
      const guestGame = GUEST_GAMES[run.game_slug];
      if (!entry || !guestGame) throw new AuthError('guest_game_unavailable');
      const { engine } = entry;

      let action: unknown = rawAction;
      if (engine.actionSchema) {
        const parsed = engine.actionSchema.safeParse(rawAction);
        if (!parsed.success) throw new AuthError('invalid_action');
        action = parsed.data;
      }
      if (run.run_state === 'done') {
        if (guestGame.isFinalMove(action)) return this.session(run, undefined);
        throw new AuthError('illegal_move', { reason: 'already_played' });
      }

      const state = run.state;
      if (entry.screenAction) {
        action = entry.screenAction({
          state,
          by: GUEST_ID,
          action,
          now,
          history: run.moves.map((m) => ({ action: m.action, at: new Date(m.at) })),
        });
      }
      const verdict = engine.validate(state, GUEST_ID, action);
      if (!verdict.ok) throw new AuthError('illegal_move', { reason: verdict.code });

      const next = engine.apply(state, GUEST_ID, action);
      const moves = [...run.moves, { action, at: now.toISOString() }];
      const done = !engine.currentPlayers(next).includes(GUEST_ID);
      const runState: GuestRunState = done ? 'done' : 'playing';
      await c.query(
        `UPDATE guest_runs SET state = $2::jsonb, moves = $3::jsonb, run_state = $4, finished_at = $5
          WHERE id = $1`,
        [run.id, JSON.stringify(next), JSON.stringify(moves), runState, done ? now : null],
      );
      if (done) {
        await c.query(
          `UPDATE sms_invites SET status = 'played', played_at = $2
            WHERE id = $1 AND status IN ('sent', 'opened')`,
          [inviteId, now],
        );
      }
      return this.session({ ...run, state: next, moves, run_state: runState }, undefined);
    });
  }

  // ---- joining up ---------------------------------------------------------------------------------

  /**
   * After sign-up (the profile exists): every live invite sent to this account's number makes the sender and
   * the new user friends, opens their chat and starts the game as a normal match. If the guest finished a
   * browser round, that round is kept (their turn is already played) and the inviter plays next. Idempotent: a
   * second call, or one that follows a crash half-way, finishes what is missing and changes nothing else.
   * `token` only puts that invite first in the answer; it never grants a join to someone with another number.
   */
  async claim(userId: string, token?: string): Promise<ClaimInviteResponse> {
    const me = await this.pool.query<{ phone_hash: Buffer }>(
      `SELECT u.phone_hash FROM users u JOIN profiles p ON p.id = u.id
        WHERE u.id = $1 AND u.disabled_at IS NULL`,
      [userId],
    );
    if (!me.rows[0]) throw new AuthError('profile_required');
    const now = this.clock();

    const pending = await this.pool.query<InviteRow>(
      `SELECT * FROM sms_invites
        WHERE (phone_hash = $1 AND status IN ('sent', 'opened', 'played') AND expires_at > $3)
           OR (joined_user_id = $2 AND status = 'joined' AND match_id IS NULL)
        ORDER BY created_at DESC LIMIT 20`,
      [me.rows[0].phone_hash, userId, now],
    );

    const joined: ClaimedInvite[] = [];
    for (const invite of pending.rows) {
      const done = await this.joinOne(invite, userId, now);
      if (done) joined.push(done);
    }
    // The invite the user arrived with goes first, so the app lands in that game.
    const first = pending.rows.find((r) => r.token === token)?.id;
    if (first) joined.sort((a, b) => Number(b.inviteId === first) - Number(a.inviteId === first));
    return { joined };
  }

  private async joinOne(
    invite: InviteRow,
    userId: string,
    now: Date,
  ): Promise<ClaimedInvite | null> {
    const inviter = await withTx(this.pool, async (c) => {
      await lockPair(c, invite.inviter_id, userId);
      const who = await c.query<{ username: string; display_name: string; avatar: unknown }>(
        `SELECT p.username, p.display_name, p.avatar
           FROM users u JOIN profiles p ON p.id = u.id
          WHERE u.id = $1 AND u.disabled_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM blocks b
               WHERE (b.blocker_id = u.id AND b.blocked_id = $2::uuid)
                  OR (b.blocker_id = $2::uuid AND b.blocked_id = u.id))`,
        [invite.inviter_id, userId],
      );
      if (!who.rows[0]) return null; // gone, disabled or blocked either way: the invite just stays unclaimed

      // The sender chose to text this number and the new user chose to sign up with it: that is consent
      // enough on both sides, so they are friends and the chat is not a stranger's request.
      await c.query(
        `INSERT INTO friendships (user_low, user_high, status, requested_by, created_at, responded_at)
         VALUES (LEAST($1::uuid, $2::uuid), GREATEST($1::uuid, $2::uuid), 'accepted', $1, $3, $3)
         ON CONFLICT (user_low, user_high) DO UPDATE
           SET status = 'accepted', responded_at = coalesce(friendships.responded_at, EXCLUDED.responded_at)
         WHERE friendships.status <> 'accepted'`,
        [invite.inviter_id, userId, now],
      );
      await c.query(
        `UPDATE sms_invites SET status = 'joined', joined_at = coalesce(joined_at, $3), joined_user_id = $2
          WHERE id = $1 AND (status <> 'joined' OR joined_user_id = $2)`,
        [invite.id, userId, now],
      );
      return who.rows[0];
    });
    if (!inviter) return null;

    const conversation = await this.chat.openDirect(invite.inviter_id, userId);

    let matchId = invite.match_id;
    if (!matchId) {
      const runRes = await this.pool.query<RunRow>(
        `SELECT * FROM guest_runs WHERE invite_id = $1`,
        [invite.id],
      );
      const run = runRes.rows[0];
      // Only a finished round is kept. One that was started but not sent has shown the grid, so the game
      // begins fresh (a new seed) instead of letting them have seen it.
      const played =
        run && run.run_state === 'done'
          ? run.moves.map((m) => ({ action: m.action, at: new Date(m.at) }))
          : null;
      try {
        matchId = await this.matches.startFromInvite({
          id: invite.id,
          inviterId: invite.inviter_id,
          userId,
          conversationId: conversation.id,
          gameSlug: invite.game_slug,
          seed: played && run ? String(run.seed) : newSeed(),
          played,
        });
        await this.pool.query(`UPDATE sms_invites SET match_id = $2 WHERE id = $1`, [
          invite.id,
          matchId,
        ]);
      } catch (err) {
        // Friends and chat stand; the match can be sent from the chat. A retry of claim() tries again.
        this.logger.warn(`invite ${invite.id} joined without a match: ${(err as Error).message}`);
        matchId = null;
      }
    }

    return {
      inviteId: invite.id,
      inviter: {
        id: invite.inviter_id,
        username: inviter.username,
        displayName: inviter.display_name,
        avatar: parseAvatar(inviter.avatar),
      },
      conversationId: conversation.id,
      matchId,
      gameSlug: invite.game_slug,
    };
  }

  // ---- internals ----------------------------------------------------------------------------------

  /** The invite for a link, locked, and only if it can still be played: not expired, not already joined. */
  private async openInvite(c: pg.PoolClient, token: string, now: Date): Promise<InviteRow> {
    const r = await c.query<InviteRow>(
      `SELECT i.* FROM sms_invites i JOIN users u ON u.id = i.inviter_id AND u.disabled_at IS NULL
        WHERE i.token = $1 FOR UPDATE OF i`,
      [token],
    );
    const invite = r.rows[0];
    if (!invite) throw new AuthError('invite_not_found');
    if (invite.status === 'joined') throw new AuthError('invite_used');
    if (invite.expires_at.getTime() <= now.getTime()) throw new AuthError('invite_expired');
    return invite;
  }

  /** Finds the run for `guestToken` on this invite, or refuses. `lock` takes the row lock for a move. */
  private async authGuest(
    db: Pick<pg.Pool, 'query'>,
    token: string,
    guestToken: string,
    now: Date,
    lock = false,
  ): Promise<{ run: RunRow; inviteId: string }> {
    const r = await db.query<RunRow & { inv_status: InviteStatus; inv_expires: Date }>(
      `SELECT gr.*, i.status AS inv_status, i.expires_at AS inv_expires
         FROM guest_runs gr JOIN sms_invites i ON i.id = gr.invite_id
        WHERE i.token = $1 ${lock ? 'FOR UPDATE OF gr' : ''}`,
      [token],
    );
    const row = r.rows[0];
    if (!row || !this.tokenMatches(row, guestToken)) throw new AuthError('guest_unauthorized');
    if (row.inv_status === 'joined') throw new AuthError('invite_used');
    if (row.inv_expires.getTime() <= now.getTime()) throw new AuthError('invite_expired');
    if (row.expires_at.getTime() <= now.getTime()) {
      throw new AuthError('guest_unauthorized', { reason: 'expired' });
    }
    return { run: row, inviteId: row.invite_id };
  }

  private tokenMatches(run: Pick<RunRow, 'token_hash'>, guestToken: string): boolean {
    return safeEqual(run.token_hash, sha256(guestToken));
  }

  private session(run: RunRow, guestToken: string | undefined): GuestSession {
    const entry = ENGINES[run.game_slug]!;
    return {
      ...(guestToken ? { guestToken } : {}),
      runState: run.run_state,
      expiresAt: run.expires_at.toISOString(),
      view: entry.engine.view(run.state, GUEST_ID),
      guestId: GUEST_ID,
      hostId: GUEST_HOST_ID,
    };
  }
}

/** 96 random bits as 16 URL-safe characters: unguessable, short enough for an SMS. */
export function newToken(): string {
  return randomBytes(12).toString('base64url');
}

function newGuestToken(): string {
  return randomBytes(32).toString('base64url');
}

/** A random 62-bit seed (fits a Postgres bigint), as a decimal string. */
function newSeed(): string {
  return (randomBytes(8).readBigUInt64BE() & ((1n << 62n) - 1n)).toString();
}
