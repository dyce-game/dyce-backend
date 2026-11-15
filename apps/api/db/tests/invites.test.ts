import { randomUUID } from 'node:crypto';
import { solveWordHuntBoard, wordHuntDictionary, wordHuntTotalScore } from '@dyce/games';
import type { GuestSession, RealtimeEvent } from '@dyce/shared';
import { hashPhone } from '../../src/auth/crypto.ts';
import { MessagesService } from '../../src/chat/messages.service.ts';
import { WORD_HUNT_GRACE_MS } from '../../src/matches/engines.ts';
import { MatchesService } from '../../src/matches/matches.service.ts';
import {
  INVITE_RESEND_COOLDOWN_SECONDS,
  InvitesService,
} from '../../src/invites/invites.service.ts';
import { MemorySmsProvider } from '../../src/sms/sms-provider.ts';
import { createTestDb, createUser, type TestDb, type TestUser } from '../testing/testDb.ts';
import { setConfig } from './helpers.ts';

/**
 * SMS invites, the guest browser game and joining up, on the real services and a real PostgreSQL:
 * limits, token expiry and reuse, the server deciding the guest's score, and what signing up with the
 * invited number does.
 */

const SECRET = 'test-secret-test-secret-test-secret-0123456789';
const T0 = new Date('2026-11-15T10:00:00Z').getTime();
const clock = { t: T0 };
const now = () => new Date(clock.t);
const jump = (ms: number) => void (clock.t += ms);
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

let db: TestDb;
let sms: MemorySmsProvider;
let invites: InvitesService;
let chat: MessagesService;
let matches: MatchesService;
const published: { users: readonly string[]; event: RealtimeEvent }[] = [];
const publisher = {
  publish: (users: readonly string[], event: RealtimeEvent) =>
    void published.push({ users, event }),
};

beforeAll(async () => {
  db = await createTestDb();
  chat = new MessagesService(db.app, publisher, now);
  matches = new MatchesService(db.app, publisher, chat, now, { allowDevGames: false });
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  clock.t = T0;
  published.length = 0;
  sms = new MemorySmsProvider();
  invites = new InvitesService(
    db.app,
    sms,
    matches,
    chat,
    { phoneSecret: SECRET, linkBase: 'https://dyce.test' },
    now,
  );
  // Limits start from the defaults in every test; tests that lower one put it back through this.
  await setConfig(db, 'sms_invites_per_day', 50);
  await setConfig(db, 'sms_invites_per_number_per_day', 3);
  await setConfig(db, 'invite_ttl_days', 7);
});

const code = (c: string) => expect.objectContaining({ code: c });

let phoneCounter = 0;
/** A fictional Nigerian number (the 555 range), different every call. */
const newPhone = () => `+23480355${(5000 + ++phoneCounter).toString().padStart(5, '0')}`;

/** A user whose number is `e164`, as if they had signed up with it. */
async function userWithPhone(e164: string): Promise<TestUser> {
  const u = await createUser(db);
  await db.admin.query('UPDATE users SET phone_hash = $2 WHERE id = $1', [
    u.id,
    hashPhone(SECRET, e164),
  ]);
  return u;
}

async function send(inviter: TestUser, phone = newPhone(), gameSlug = 'word-hunt') {
  const invite = await invites.create(inviter.id, { phone, gameSlug });
  return { invite, phone, token: invite.token };
}

type WhView = {
  board: string[] | null;
  status: Record<string, 'idle' | 'playing' | 'done'>;
  scores: Record<string, number | null>;
  words: Record<string, string[] | null>;
  rejected: number | null;
};
const whView = (s: GuestSession) => s.view as WhView;

const invitesBy = async (u: TestUser): Promise<number> =>
  (await db.admin.query(`SELECT count(*)::int AS n FROM sms_invites WHERE inviter_id = $1`, [u.id]))
    .rows[0].n;
const friendsOf = async (u: TestUser): Promise<number> =>
  (
    await db.admin.query(
      `SELECT count(*)::int AS n FROM friendships WHERE $1::uuid IN (user_low, user_high)`,
      [u.id],
    )
  ).rows[0].n;

const bearer = (s: GuestSession) => s.guestToken!;

/** The grid that was dealt, read as the server holds it (a test may look, the guest may not). */
async function boardOf(token: string): Promise<string[]> {
  const r = await db.admin.query<{ state: { board: string[] } }>(
    `SELECT gr.state FROM guest_runs gr JOIN sms_invites i ON i.id = gr.invite_id WHERE i.token = $1`,
    [token],
  );
  return r.rows[0]!.state.board;
}

/** Plays a full guest round with the best words on the grid. */
async function playGuestRound(token: string, wordCount = 4) {
  const started = await invites.startGuest(token);
  const g = bearer(started);
  const afterStart = await invites.guestMove(token, g, { kind: 'start' });
  const board = whView(afterStart).board!;
  const words = solveWordHuntBoard(board, wordHuntDictionary).slice(0, wordCount);
  jump(30_000);
  const done = await invites.guestMove(token, g, { kind: 'submit', words });
  return { g, words, done };
}

describe('sending an invite', () => {
  it('texts a link with the token and the number as a fragment, and stores only a hash', async () => {
    const inviter = await createUser(db);
    const { invite, phone } = await send(inviter);

    expect(invite.token).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(invite.link).toBe(`https://dyce.test/i/${invite.token}#p=${phone.slice(1)}`);
    expect(invite.status).toBe('sent');
    expect(sms.sent).toHaveLength(1);
    expect(sms.sent[0]!.to).toBe(phone);
    expect(sms.sent[0]!.body).toContain(invite.link);
    expect(sms.sent[0]!.body).toContain('Word Hunt');

    // The row holds a keyed hash and nothing that contains the number.
    const row = await db.admin.query(`SELECT * FROM sms_invites WHERE id = $1`, [invite.id]);
    expect(row.rows[0].phone_hash.equals(hashPhone(SECRET, phone))).toBe(true);
    const dump = JSON.stringify(row.rows[0]);
    expect(dump).not.toContain(phone.slice(1));
    expect(dump).not.toContain(phone.slice(4));
    // The expiry is ttl days from now.
    expect(new Date(invite.expiresAt).getTime()).toBe(T0 + 7 * DAY);
  });

  it('reads a national-format number with the sender country', async () => {
    const inviter = await createUser(db);
    await invites.create(inviter.id, {
      phone: '0803 555 5001',
      country: 'NG',
      gameSlug: 'word-hunt',
    });
    expect(sms.sent[0]!.to).toBe('+2348035555001');
  });

  it('refuses a bad number, your own number, an unknown game and the dev game', async () => {
    const inviter = await userWithPhone(newPhone());
    const own = (
      await db.admin.query<{ phone_hash: Buffer }>(`SELECT phone_hash FROM users WHERE id = $1`, [
        inviter.id,
      ])
    ).rows[0]!;
    expect(own.phone_hash).toHaveLength(32);

    await expect(
      invites.create(inviter.id, { phone: 'nope', gameSlug: 'word-hunt' }),
    ).rejects.toEqual(code('invalid_phone'));
    await expect(
      invites.create(inviter.id, { phone: newPhone(), gameSlug: 'no-such-game' }),
    ).rejects.toEqual(code('game_not_found'));
    await expect(
      invites.create(inviter.id, { phone: newPhone(), gameSlug: '_example' }),
    ).rejects.toEqual(code('game_not_found'));

    const mine = newPhone();
    const me = await userWithPhone(mine);
    await expect(invites.create(me.id, { phone: mine, gameSlug: 'word-hunt' })).rejects.toEqual(
      code('cannot_add_self'),
    );
    expect(sms.sent).toHaveLength(0);
  });

  it('sends nothing to a number that is already on Dyce', async () => {
    const inviter = await createUser(db);
    const phone = newPhone();
    await userWithPhone(phone);
    await expect(invites.create(inviter.id, { phone, gameSlug: 'word-hunt' })).rejects.toEqual(
      code('already_on_dyce'),
    );
    expect(sms.sent).toHaveLength(0);
    expect(await invitesBy(inviter)).toBe(0);
  });

  it('allows one text per sender and number per minute', async () => {
    const inviter = await createUser(db);
    const { phone } = await send(inviter);
    await expect(invites.create(inviter.id, { phone, gameSlug: 'word-hunt' })).rejects.toEqual(
      expect.objectContaining({
        code: 'invite_too_soon',
        details: { retryAfterSeconds: INVITE_RESEND_COOLDOWN_SECONDS },
      }),
    );
    jump(INVITE_RESEND_COOLDOWN_SECONDS * 1000);
    await invites.create(inviter.id, { phone, gameSlug: 'word-hunt' });
    expect(sms.sent).toHaveLength(2);
  });

  it('limits each sender per day (Lagos day) and resets at midnight', async () => {
    await setConfig(db, 'sms_invites_per_day', 2);
    const inviter = await createUser(db);
    await send(inviter);
    await send(inviter);
    await expect(send(inviter)).rejects.toEqual(code('invite_rate_limited'));
    expect(sms.sent).toHaveLength(2);
    // Lagos midnight is 23:00 UTC: after it, a new day starts
    clock.t = new Date('2026-11-15T23:30:00Z').getTime();
    await send(inviter);
    expect(sms.sent).toHaveLength(3);
  });

  it('limits each number per rolling day across every sender', async () => {
    const phone = newPhone();
    for (let i = 0; i < 3; i++) await send(await createUser(db), phone);
    const fourth = await createUser(db);
    await expect(invites.create(fourth.id, { phone, gameSlug: 'word-hunt' })).rejects.toEqual(
      code('invite_number_limited'),
    );
    jump(DAY + MIN);
    await invites.create(fourth.id, { phone, gameSlug: 'word-hunt' });
    expect(sms.sent).toHaveLength(4);
  });

  it('serialises parallel sends so the per-number limit holds', async () => {
    const phone = newPhone();
    const senders = await Promise.all([1, 2, 3, 4, 5].map(() => createUser(db)));
    const results = await Promise.allSettled(
      senders.map((s) => invites.create(s.id, { phone, gameSlug: 'word-hunt' })),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    expect(sms.sent).toHaveLength(3);
  });

  it('leaves nothing behind (and uses no limit) when the SMS cannot be sent', async () => {
    const inviter = await createUser(db);
    sms.failWith = 'down';
    const phone = newPhone();
    await expect(invites.create(inviter.id, { phone, gameSlug: 'word-hunt' })).rejects.toEqual(
      code('sms_failed'),
    );
    expect(await invitesBy(inviter)).toBe(0);
    sms.failWith = null;
    await invites.create(inviter.id, { phone, gameSlug: 'word-hunt' }); // no "too soon", no limit used
    expect(sms.sent).toHaveLength(1);
  });

  it('lists what you sent without saying to whom', async () => {
    const inviter = await createUser(db);
    const { invite } = await send(inviter);
    const { invites: list } = await invites.list(inviter.id);
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual(
      expect.objectContaining({
        id: invite.id,
        status: 'sent',
        gameName: 'Word Hunt',
        joinedAs: null,
      }),
    );
    expect(JSON.stringify(list)).not.toMatch(/\+?234/);
  });
});

describe('the landing page', () => {
  it('shows who invited you and the game, and marks a fresh invite opened', async () => {
    const inviter = await createUser(db);
    const { token } = await send(inviter);
    const page = await invites.get(token);
    expect(page.state).toBe('open');
    expect(page.status).toBe('opened');
    expect(page.inviter.username).toBe(inviter.username);
    expect(page.game).toEqual({
      slug: 'word-hunt',
      name: 'Word Hunt',
      guestPlayable: true,
      roundSeconds: 80,
    });
    expect(page.guest).toEqual({ started: false, finished: false, score: null });
    const row = await db.admin.query(`SELECT status, opened_at FROM sms_invites WHERE token = $1`, [
      token,
    ]);
    expect(row.rows[0].status).toBe('opened');
    expect(row.rows[0].opened_at).not.toBeNull();
    // opening again does not move it
    expect((await invites.get(token)).status).toBe('opened');
    // a phone number never appears on the page
    expect(JSON.stringify(page)).not.toMatch(/\+?234/);
  });

  it('404s for an unknown token and says expired for an old one', async () => {
    await expect(invites.get('does-not-exist-0')).rejects.toEqual(code('invite_not_found'));
    const inviter = await createUser(db);
    const { token } = await send(inviter);
    jump(7 * DAY + MIN);
    const page = await invites.get(token);
    expect(page.state).toBe('expired');
    expect(page.status).toBe('sent'); // an expired invite is not marked opened
  });
});

describe('the guest game', () => {
  it('hides the grid until the guest starts, and the server scores their words', async () => {
    const inviter = await createUser(db);
    const { token } = await send(inviter);

    const first = await invites.startGuest(token);
    expect(first.guestToken).toEqual(expect.any(String));
    expect(first.runState).toBe('idle');
    expect(whView(first).board).toBeNull();
    // the inviter's real id never reaches the browser
    expect(JSON.stringify(first)).not.toContain(inviter.id);

    const g = bearer(first);
    const playing = await invites.guestMove(token, g, { kind: 'start' });
    expect(playing.runState).toBe('playing');
    const board = whView(playing).board!;
    expect(board).toHaveLength(16);
    expect(board).toEqual(await boardOf(token));

    const solved = solveWordHuntBoard(board, wordHuntDictionary);
    const good = solved.slice(0, 3);
    jump(20_000);
    const done = await invites.guestMove(token, g, {
      kind: 'submit',
      // real words plus one that is not on the grid: the server drops it and says so
      words: [...good, 'ZZZZZ'],
    });
    expect(done.runState).toBe('done');
    expect(whView(done).scores.guest).toBe(wordHuntTotalScore(good));
    expect(whView(done).words.guest).toEqual(good);
    expect(whView(done).rejected).toBe(1);

    // the invite moved to played and the landing page reports the score
    const page = await invites.get(token);
    expect(page.status).toBe('played');
    expect(page.guest).toEqual({ started: true, finished: true, score: wordHuntTotalScore(good) });
  });

  it('refuses a late submit its points: the clock is the server’s', async () => {
    const inviter = await createUser(db);
    const { token } = await send(inviter);
    const g = bearer(await invites.startGuest(token));
    const started = await invites.guestMove(token, g, { kind: 'start' });
    const words = solveWordHuntBoard(whView(started).board!, wordHuntDictionary).slice(0, 3);
    jump(80_000 + WORD_HUNT_GRACE_MS + 1_000);
    const done = await invites.guestMove(token, g, { kind: 'submit', words });
    expect(whView(done).scores.guest).toBe(0);
  });

  it('acknowledges a repeated final submit but refuses anything else after the round', async () => {
    const inviter = await createUser(db);
    const { token } = await send(inviter);
    const { g, words, done } = await playGuestRound(token);
    const again = await invites.guestMove(token, g, { kind: 'submit', words });
    expect(whView(again).scores.guest).toBe(whView(done).scores.guest);
    await expect(invites.guestMove(token, g, { kind: 'start' })).rejects.toEqual(
      code('illegal_move'),
    );
  });

  it('refuses actions that make no sense: a submit before start, nonsense', async () => {
    const inviter = await createUser(db);
    const { token } = await send(inviter);
    const g = bearer(await invites.startGuest(token));
    await expect(invites.guestMove(token, g, { kind: 'submit', words: ['CAT'] })).rejects.toEqual(
      code('illegal_move'),
    );
    await expect(invites.guestMove(token, g, { kind: 'teleport' })).rejects.toEqual(
      code('invalid_action'),
    );
  });

  it('only the holder of the guest token can continue, and a started run cannot be re-dealt', async () => {
    const inviter = await createUser(db);
    const { token } = await send(inviter);
    const first = await invites.startGuest(token);
    const g = bearer(first);
    await invites.guestMove(token, g, { kind: 'start' });

    // a second visitor with the link only (no token) is turned away
    await expect(invites.startGuest(token)).rejects.toEqual(code('guest_already_played'));
    await expect(invites.startGuest(token, 'someone-elses-token')).rejects.toEqual(
      code('guest_already_played'),
    );
    // the holder resumes the same run and sees the same grid
    const resumed = await invites.startGuest(token, g);
    expect(resumed.guestToken).toBeUndefined();
    expect(resumed.runState).toBe('playing');
    expect(whView(resumed).board).toEqual(await boardOf(token));
    expect((await invites.guestView(token, g)).runState).toBe('playing');

    await expect(invites.guestView(token, 'nope')).rejects.toEqual(code('guest_unauthorized'));
    await expect(invites.guestMove(token, 'nope', { kind: 'submit', words: [] })).rejects.toEqual(
      code('guest_unauthorized'),
    );
  });

  it('re-issues a run that has not started (a refresh) and kills the old token', async () => {
    const inviter = await createUser(db);
    const { token } = await send(inviter);
    const first = await invites.startGuest(token);
    const second = await invites.startGuest(token);
    expect(second.guestToken).toEqual(expect.any(String));
    expect(second.guestToken).not.toBe(first.guestToken);
    await expect(invites.guestView(token, bearer(first))).rejects.toEqual(
      code('guest_unauthorized'),
    );
    expect((await invites.guestView(token, bearer(second))).runState).toBe('idle');
    // the grid is the same deal either way: it was never shown
    const n = await db.admin.query(
      `SELECT count(*)::int AS n FROM guest_runs gr JOIN sms_invites i ON i.id = gr.invite_id WHERE i.token = $1`,
      [token],
    );
    expect(n.rows[0].n).toBe(1);
  });

  it('a guest token only works on its own invite', async () => {
    const inviter = await createUser(db);
    const a = await send(inviter);
    const b = await send(inviter);
    const ga = bearer(await invites.startGuest(a.token));
    await invites.startGuest(b.token);
    await expect(invites.guestView(b.token, ga)).rejects.toEqual(code('guest_unauthorized'));
  });

  it('guest tokens expire after an hour', async () => {
    const inviter = await createUser(db);
    const { token } = await send(inviter);
    const g = bearer(await invites.startGuest(token));
    jump(61 * MIN);
    await expect(invites.guestView(token, g)).rejects.toEqual(code('guest_unauthorized'));
    await expect(invites.guestMove(token, g, { kind: 'start' })).rejects.toEqual(
      code('guest_unauthorized'),
    );
    // not started, so the link can still be used for a new run
    expect((await invites.startGuest(token)).runState).toBe('idle');
  });

  it('an expired invite cannot be played, and an old run stops working with it', async () => {
    const inviter = await createUser(db);
    const { token } = await send(inviter);
    const g = bearer(await invites.startGuest(token));
    jump(7 * DAY + MIN);
    await expect(invites.startGuest(token)).rejects.toEqual(code('invite_expired'));
    await expect(invites.guestMove(token, g, { kind: 'start' })).rejects.toEqual(
      code('invite_expired'),
    );
  });

  it('refuses a token that does not exist', async () => {
    await expect(invites.startGuest('nothing-here-0000')).rejects.toEqual(code('invite_not_found'));
  });

  it('a game with no guest round says so', async () => {
    const inviter = await createUser(db);
    const { token } = await send(inviter);
    await db.admin.query(`UPDATE sms_invites SET game_slug = '_example' WHERE token = $1`, [token]);
    expect((await invites.get(token)).game.guestPlayable).toBe(false);
    await expect(invites.startGuest(token)).rejects.toEqual(code('guest_game_unavailable'));
  });
});

describe('signing up with the invited number', () => {
  it('makes them friends, opens the chat and keeps the guest round as their turn', async () => {
    const inviter = await createUser(db);
    const { phone, token, invite } = await send(inviter);
    const { words } = await playGuestRound(token, 5);
    const newcomer = await userWithPhone(phone);

    const res = await invites.claim(newcomer.id, token);
    expect(res.joined).toHaveLength(1);
    const j = res.joined[0]!;
    expect(j.inviteId).toBe(invite.id);
    expect(j.inviter.username).toBe(inviter.username);
    expect(j.gameSlug).toBe('word-hunt');
    expect(j.matchId).toBe(invite.id);

    // friends, and a chat with the card in it
    const f = await db.admin.query(`SELECT status, requested_by FROM friendships`);
    expect(f.rows).toEqual([{ status: 'accepted', requested_by: inviter.id }]);
    const members = await db.admin.query(
      `SELECT user_id, state FROM conversation_members WHERE conversation_id = $1`,
      [j.conversationId],
    );
    expect(members.rows.map((m) => m.state)).toEqual(['active', 'active']);
    const cards = await db.admin.query(
      `SELECT id, kind FROM messages WHERE conversation_id = $1 AND kind = 'game'`,
      [j.conversationId],
    );
    expect(cards.rows).toEqual([{ id: invite.id, kind: 'game' }]);

    // the match is a normal active Free match: the newcomer has played, the inviter plays next
    const m = await matches.get(newcomer.id, j.matchId!);
    expect(m.status).toBe('active');
    expect(m.mode).toBe('free');
    expect(m.currentTurn).toBe(inviter.id);
    const v = m.view as WhView;
    expect(v.status[newcomer.id]).toBe('done');
    expect(v.status[inviter.id]).toBe('idle');
    expect(v.scores[newcomer.id]).toBe(wordHuntTotalScore(words));

    // the inviter then plays the same grid with the normal moves and wins or loses against it
    const asInviter = await matches.get(inviter.id, j.matchId!);
    expect(asInviter.status).toBe('active');
    const started = await matches.submitMove(inviter.id, j.matchId!, {
      expectedVersion: asInviter.stateVersion,
      action: { kind: 'start' },
    });
    const board = (started.view as WhView).board!;
    expect(board).toEqual(await boardOf(token));
    const best = solveWordHuntBoard(board, wordHuntDictionary);
    const finished = await matches.submitMove(inviter.id, j.matchId!, {
      expectedVersion: started.stateVersion,
      action: { kind: 'submit', words: best },
    });
    expect(finished.status).toBe('finished');
    expect(finished.players.find((p) => p.userId === inviter.id)!.result).toBe('win');
    expect(finished.players.find((p) => p.userId === newcomer.id)!.result).toBe('loss');

    // the invite is joined, remembers who and which match
    const row = await db.admin.query(
      `SELECT status, joined_user_id, match_id, joined_at FROM sms_invites WHERE id = $1`,
      [invite.id],
    );
    expect(row.rows[0]).toEqual(
      expect.objectContaining({
        status: 'joined',
        joined_user_id: newcomer.id,
        match_id: invite.id,
      }),
    );
    expect(row.rows[0].joined_at).not.toBeNull();
    expect((await invites.list(inviter.id)).invites[0]!.joinedAs).toEqual({
      username: newcomer.username,
      displayName: newcomer.username,
    });
  });

  it('is idempotent: calling again changes nothing and posts one card', async () => {
    const inviter = await createUser(db);
    const { phone, token } = await send(inviter);
    await playGuestRound(token);
    const newcomer = await userWithPhone(phone);
    const first = await invites.claim(newcomer.id, token);
    const second = await invites.claim(newcomer.id, token);
    expect(second.joined).toEqual([]); // nothing is waiting any more
    const cards = await db.admin.query(
      `SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1 AND kind = 'game'`,
      [first.joined[0]!.conversationId],
    );
    expect(cards.rows[0].n).toBe(1);
    const matchesN = await db.admin.query(
      `SELECT count(*)::int AS n FROM matches WHERE created_by = $1`,
      [inviter.id],
    );
    expect(matchesN.rows[0].n).toBe(1);
    expect(first.joined[0]!.matchId).not.toBeNull();
  });

  it('retries a join that stopped before the match existed', async () => {
    const inviter = await createUser(db);
    const { phone, token, invite } = await send(inviter);
    await playGuestRound(token);
    const newcomer = await userWithPhone(phone);
    // a crash after "joined" but before the match: friends and status set, no match yet
    await db.admin.query(
      `UPDATE sms_invites SET status = 'joined', joined_user_id = $2, joined_at = now() WHERE id = $1`,
      [invite.id, newcomer.id],
    );
    const res = await invites.claim(newcomer.id);
    expect(res.joined).toHaveLength(1);
    expect(res.joined[0]!.matchId).toBe(invite.id);
    const m = await matches.get(newcomer.id, invite.id);
    expect((m.view as WhView).scores[newcomer.id]).toBeGreaterThanOrEqual(0);
  });

  it('with no browser round, the inviter’s game arrives as a normal invite', async () => {
    const inviter = await createUser(db);
    const { phone } = await send(inviter);
    const newcomer = await userWithPhone(phone);
    const { joined } = await invites.claim(newcomer.id);
    expect(joined).toHaveLength(1);
    const m = await matches.get(newcomer.id, joined[0]!.matchId!);
    expect(m.status).toBe('invited');
    expect(m.createdBy).toBe(inviter.id);
  });

  it('a round that was started but never sent does not carry over (the grid was seen)', async () => {
    const inviter = await createUser(db);
    const { phone, token } = await send(inviter);
    const g = bearer(await invites.startGuest(token));
    await invites.guestMove(token, g, { kind: 'start' });
    const seenBoard = await boardOf(token);
    const newcomer = await userWithPhone(phone);
    const { joined } = await invites.claim(newcomer.id);
    const m = await matches.accept(newcomer.id, joined[0]!.matchId!);
    expect(m.status).toBe('active');
    const state = (
      await db.admin.query(`SELECT state FROM matches WHERE id = $1`, [joined[0]!.matchId])
    ).rows[0].state as { board: string[] };
    expect(state.board).not.toEqual(seenBoard);
  });

  it('only joins the number the invite was sent to', async () => {
    const inviter = await createUser(db);
    const { token } = await send(inviter);
    const stranger = await userWithPhone(newPhone());
    const res = await invites.claim(stranger.id, token);
    expect(res.joined).toEqual([]);
    const row = await db.admin.query(`SELECT status FROM sms_invites WHERE token = $1`, [token]);
    expect(row.rows[0].status).toBe('sent');
    expect(await friendsOf(inviter)).toBe(0);
    expect(await friendsOf(stranger)).toBe(0);
  });

  it('does not join an expired invite', async () => {
    const inviter = await createUser(db);
    const { phone } = await send(inviter);
    jump(7 * DAY + MIN);
    const newcomer = await userWithPhone(phone);
    expect((await invites.claim(newcomer.id)).joined).toEqual([]);
    expect(await friendsOf(inviter)).toBe(0);
  });

  it('does not join across a block, either way', async () => {
    const inviter = await createUser(db);
    const { phone } = await send(inviter);
    const newcomer = await userWithPhone(phone);
    await db.admin.query(`INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)`, [
      newcomer.id,
      inviter.id,
    ]);
    expect((await invites.claim(newcomer.id)).joined).toEqual([]);
    expect(await friendsOf(inviter)).toBe(0);
  });

  it('a joined invite link is used up: the page says joined and the game is closed', async () => {
    const inviter = await createUser(db);
    const { phone, token } = await send(inviter);
    const g = bearer(await invites.startGuest(token));
    const newcomer = await userWithPhone(phone);
    await invites.claim(newcomer.id, token);
    expect((await invites.get(token)).state).toBe('joined');
    await expect(invites.startGuest(token)).rejects.toEqual(code('invite_used'));
    await expect(invites.guestMove(token, g, { kind: 'start' })).rejects.toEqual(
      code('invite_used'),
    );
  });

  it('joins several invites for one number, the arriving link first', async () => {
    const a = await createUser(db);
    const b = await createUser(db);
    const phone = newPhone();
    const first = await send(a, phone);
    const second = await send(b, phone);
    const newcomer = await userWithPhone(phone);
    const { joined } = await invites.claim(newcomer.id, first.token);
    expect(joined.map((j) => j.inviteId)).toEqual([first.invite.id, second.invite.id]);
    expect(await friendsOf(newcomer)).toBe(2);
  });

  it('needs a profile', async () => {
    const id = randomUUID();
    await db.admin.query(`INSERT INTO users (id, phone_hash) VALUES ($1, $2)`, [
      id,
      hashPhone(SECRET, newPhone()),
    ]);
    await expect(invites.claim(id)).rejects.toEqual(code('profile_required'));
  });
});
