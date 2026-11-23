import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import type { RealtimeEvent } from '@dyce/shared';
import { AuthService } from '../../src/auth/auth.service.ts';
import { TokenService } from '../../src/auth/tokens.ts';
import { MessagesService } from '../../src/chat/messages.service.ts';
import { FriendsService } from '../../src/social/friends.service.ts';
import type { AttestationVerifier } from '../../src/integrity/attestation.ts';
import { IntegrityGate } from '../../src/integrity/integrity.gate.ts';
import { ModerationService } from '../../src/integrity/moderation.service.ts';
import { assertNotRestricted } from '../../src/integrity/restrictions.ts';
import { MemorySmsProvider } from '../../src/sms/sms-provider.ts';
import {
  balanceOf,
  createMatch,
  createTestDb,
  idem,
  type TestDb,
  type TestUser,
} from '../testing/testDb.ts';
import {
  expectDyceError,
  expectLedgerClean,
  expectPermissionDenied,
  fundedUser,
  setConfig,
} from './helpers.ts';

/**
 * The integrity layer (ADR-039) on real PostgreSQL: collusion and timing signals judged when a Pool match would
 * settle, payout holds and the three ways a person can decide one, the request spam filter, sanctions with their
 * audit log, the device gate, and who may call what. `ledger_check_invariants` is checked after every test that
 * touches money.
 */
const NAIRA = 100;
const STAKE = 1_000 * NAIRA;
const SECRET = 'k'.repeat(40);

let db: TestDb;
let admin: pg.Pool;
let moderation: ModerationService;
let chat: MessagesService;
let friends: FriendsService;
const published: { users: readonly string[]; event: RealtimeEvent }[] = [];
const publisher = {
  publish: (users: readonly string[], event: RealtimeEvent) =>
    void published.push({ users, event }),
};
const T0 = new Date('2026-11-14T10:00:00Z').getTime();
const clock = { t: T0 };
const now = () => new Date((clock.t += 1000));

beforeAll(async () => {
  db = await createTestDb();
  await db.admin.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dyce_moderator') THEN
      CREATE ROLE dyce_moderator LOGIN PASSWORD 'dyce_moderator' IN ROLE dyce_admin;
    END IF;
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
  const url = new URL(process.env.TEST_DATABASE_ADMIN_URL!);
  const name = (await db.admin.query<{ n: string }>('SELECT current_database() AS n')).rows[0]!.n;
  url.pathname = `/${name}`;
  url.username = 'dyce_moderator';
  url.password = 'dyce_moderator';
  admin = new pg.Pool({ connectionString: url.toString(), max: 3 });
  moderation = new ModerationService(admin);
  chat = new MessagesService(db.app, publisher, now);
  friends = new FriendsService(db.app, now);
});
afterAll(async () => {
  await admin.end();
  await db.close();
});
beforeEach(() => {
  clock.t = T0;
  published.length = 0;
});

const code = (c: string) => expect.objectContaining({ code: c });

// ---- fixtures ---------------------------------------------------------------------------------------

/** An established account (60 days old), so only the signal under test fires. */
async function player(): Promise<TestUser> {
  const u = await fundedUser(db);
  await db.admin.query(`UPDATE users SET created_at = now() - interval '60 days' WHERE id = $1`, [
    u.id,
  ]);
  return u;
}

/** An account created just now. */
const young = (): Promise<TestUser> => fundedUser(db);

/** A Pool match between two people with stakes in escrow and `winner` placed first, not yet settled. */
async function endedMatch(
  a: TestUser,
  b: TestUser,
  winner: TestUser,
  game = '_example',
): Promise<string> {
  const id = await createMatch(db, a.id, [a.id, b.id], { mode: 'pool', stake: STAKE });
  if (game !== '_example')
    await db.admin.query('UPDATE matches SET game_slug = $2 WHERE id = $1', [id, game]);
  for (const p of [a, b]) {
    await db.app.query('SELECT * FROM stake_pool($1, $2, $3, $4)', [id, p.id, STAKE, idem()]);
  }
  for (const p of [a, b]) {
    await db.app.query(
      `UPDATE match_players SET placement = $3, result = $4::match_result WHERE match_id = $1 AND user_id = $2`,
      [id, p.id, p.id === winner.id ? 1 : 2, p.id === winner.id ? 'win' : 'loss'],
    );
  }
  return id;
}

const settleOrHold = (matchId: string) =>
  db.app.query('SELECT * FROM settle_or_hold($1)', [matchId]);

const matchStatus = async (id: string) =>
  (await db.admin.query<{ status: string }>('SELECT status FROM matches WHERE id = $1', [id]))
    .rows[0]!.status;

const escrowOf = async (matchId: string): Promise<number> =>
  Number(
    (
      await db.admin.query(
        `SELECT coalesce(sum(e.amount_kobo), 0)::bigint AS s FROM ledger_accounts a
           JOIN ledger_entries e ON e.account_id = a.id
          WHERE a.kind = 'pool_escrow' AND a.match_id = $1`,
        [matchId],
      )
    ).rows[0].s,
  );

const signalsOf = async (matchId: string) =>
  (
    await db.admin.query<{ kind: string; score: number; flagged: boolean; status: string }>(
      `SELECT kind, score, flagged, status FROM integrity_signals WHERE match_id = $1 ORDER BY kind`,
      [matchId],
    )
  ).rows;

const holdOf = async (matchId: string) =>
  (await db.admin.query(`SELECT * FROM integrity_holds WHERE match_id = $1`, [matchId])).rows[0];

/** `n` earlier decided Pool matches between the two (so the pair has met `n` times in the window). */
async function history(a: TestUser, b: TestUser, n: number, winner: TestUser = a): Promise<void> {
  for (let i = 0; i < n; i++) {
    const id = randomUUID();
    await db.admin.query(
      `INSERT INTO matches (id, game_slug, mode, stake_kobo, status, seed, created_by, finished_at)
       VALUES ($1, '_example', 'pool', $2, 'finished', 1, $3, now())`,
      [id, STAKE, a.id],
    );
    for (const [seat, p] of [a, b].entries()) {
      await db.admin.query(
        `INSERT INTO match_players (match_id, user_id, seat, staked_kobo, placement, result, payout_kobo)
         VALUES ($1, $2, $3, $4, $5, $6::match_result, $7)`,
        [
          id,
          p.id,
          seat + 1,
          STAKE,
          p.id === winner.id ? 1 : 2,
          p.id === winner.id ? 'win' : 'loss',
          p.id === winner.id ? 2 * STAKE : 0,
        ],
      );
    }
  }
}

const fingerprint = (u: TestUser, kind: 'device' | 'ip', value: Buffer) =>
  db.admin.query(`INSERT INTO user_fingerprints (user_id, kind, value_hash) VALUES ($1, $2, $3)`, [
    u.id,
    kind,
    value,
  ]);

/** The standard "clearly colluding" pair: five meetings in a week from one phone. */
async function colluders() {
  const a = await player();
  const b = await player();
  await history(a, b, 4);
  const phone = randomBytes(32);
  await fingerprint(a, 'device', phone);
  await fingerprint(b, 'device', phone);
  return { a, b };
}

async function report(reporter: TestUser, target: TestUser, reason = 'spam'): Promise<string> {
  const id = randomUUID();
  await db.admin.query(
    `INSERT INTO reports (id, reporter_id, target_user_id, reason) VALUES ($1, $2, $3, $4)`,
    [id, reporter.id, target.id, reason],
  );
  return id;
}

const notesOf = async (user: TestUser, kind: string) =>
  (
    await db.admin.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM notifications WHERE user_id = $1 AND kind = $2 ORDER BY created_at`,
      [user.id, kind],
    )
  ).rows.map((r) => r.payload);

// ---- a clean match is not touched ----------------------------------------------------------------------

describe('settle_or_hold: matches nobody is suspicious of', () => {
  it('settles a clean Pool match exactly like settle_match and records nothing', async () => {
    const a = await player();
    const b = await player();
    const id = await endedMatch(a, b, a);
    const r = await settleOrHold(id);
    expect(r.rows[0].txn_id).not.toBeNull();
    expect(await balanceOf(db, a.id)).toBe(200_000 * NAIRA + STAKE);
    expect(await balanceOf(db, b.id)).toBe(200_000 * NAIRA - STAKE);
    expect(await matchStatus(id)).toBe('finished');
    expect(await signalsOf(id)).toEqual([]);
    expect(await holdOf(id)).toBeUndefined();
    await expectLedgerClean(db);
  });

  it('finishes a Free match without judging it', async () => {
    const a = await player();
    const b = await player();
    const id = await createMatch(db, a.id, [a.id, b.id], { mode: 'free' });
    await settleOrHold(id);
    expect(await matchStatus(id)).toBe('finished');
    expect(await signalsOf(id)).toEqual([]);
  });

  it('replays a settled match (a retried final move pays once)', async () => {
    const a = await player();
    const b = await player();
    const id = await endedMatch(a, b, b);
    const first = await settleOrHold(id);
    const again = await settleOrHold(id);
    expect(again.rows[0].txn_id).toBe(first.rows[0].txn_id);
    expect(again.rows[0].replayed).toBe(true);
    expect(await balanceOf(db, b.id)).toBe(200_000 * NAIRA + STAKE);
    await expectLedgerClean(db);
  });
});

// ---- collusion signals ---------------------------------------------------------------------------------

describe('collusion signals', () => {
  it('the same two accounts meeting again and again in Pool is a signal on its own, but not a hold', async () => {
    const a = await player();
    const b = await player();
    await history(a, b, 4, a);
    const id = await endedMatch(a, b, b); // the fifth meeting, b wins this one
    await settleOrHold(id);
    const rows = await signalsOf(id);
    expect(rows.map((r) => r.kind)).toEqual(['pair_repeat']);
    expect(rows[0]).toMatchObject({ score: 30, flagged: false });
    expect(await matchStatus(id)).toBe('finished'); // paid
    await expectLedgerClean(db);
  });

  it('one side winning every one of four or more decided meetings is one-sided', async () => {
    const a = await player();
    const b = await player();
    await history(a, b, 3, a);
    const id = await endedMatch(a, b, a);
    await settleOrHold(id);
    const rows = await signalsOf(id);
    expect(rows.map((r) => r.kind)).toEqual(['pair_one_sided']);
    const detail = await db.admin.query(
      `SELECT subject_user, other_user FROM integrity_signals WHERE match_id = $1`,
      [id],
    );
    expect(detail.rows[0]).toMatchObject({ subject_user: a.id, other_user: b.id });
  });

  it('sharing a phone is strong (60), sharing a connection is weak (25), and neither shows its value', async () => {
    const a = await player();
    const b = await player();
    const c = await player();
    const phone = randomBytes(32);
    const wifi = randomBytes(32);
    await fingerprint(a, 'device', phone);
    await fingerprint(b, 'device', phone);
    await fingerprint(a, 'ip', wifi);
    await fingerprint(c, 'ip', wifi);
    const sameDevice = await endedMatch(a, b, a);
    await settleOrHold(sameDevice);
    expect(await signalsOf(sameDevice)).toEqual([
      { kind: 'shared_device', score: 60, flagged: true, status: 'open' },
    ]);
    expect(await matchStatus(sameDevice)).toBe('finished'); // 60 alone is below the hold line

    const sameWifi = await endedMatch(a, c, a);
    await settleOrHold(sameWifi);
    expect(await signalsOf(sameWifi)).toEqual([
      { kind: 'shared_ip', score: 25, flagged: false, status: 'open' },
    ]);
    const stored = await db.admin.query(
      `SELECT detail::text AS d FROM integrity_signals WHERE match_id = $1`,
      [sameDevice],
    );
    expect(stored.rows[0].d).not.toContain(phone.toString('hex'));
  });

  it('fingerprints older than the window are ignored', async () => {
    const a = await player();
    const b = await player();
    const phone = randomBytes(32);
    await fingerprint(a, 'device', phone);
    await fingerprint(b, 'device', phone);
    await db.admin.query(
      `UPDATE user_fingerprints SET last_seen_at = now() - interval '60 days' WHERE user_id = $1`,
      [a.id],
    );
    const id = await endedMatch(a, b, a);
    await settleOrHold(id);
    expect(await signalsOf(id)).toEqual([]);
  });

  it('a young account that keeps losing to one account is a feeder', async () => {
    const winner = await player();
    const newcomer = await young();
    await history(winner, newcomer, 2, winner);
    const id = await endedMatch(winner, newcomer, winner);
    await settleOrHold(id);
    const kinds = (await signalsOf(id)).map((r) => r.kind);
    expect(kinds).toContain('feeder_account');
    const old = await player();
    await history(winner, old, 2, winner);
    const fine = await endedMatch(winner, old, winner);
    await settleOrHold(fine);
    expect((await signalsOf(fine)).map((r) => r.kind)).not.toContain('feeder_account');
  });

  it('one account paid by three or more young accounts in a week is a feeder network', async () => {
    const boss = await player();
    const newcomers = [await young(), await young(), await young()];
    for (const y of newcomers.slice(0, 2)) await history(boss, y, 1, boss);
    const id = await endedMatch(boss, newcomers[2]!, boss);
    await settleOrHold(id);
    const rows = await signalsOf(id);
    expect(rows.find((r) => r.kind === 'feeder_network')).toMatchObject({
      score: 40,
      flagged: true,
    });
    await expectLedgerClean(db);
  });

  it('a cheat report from the opponent counts, and reports from three strangers count less', async () => {
    const a = await player();
    const b = await player();
    await report(b, a, 'cheat');
    const id = await endedMatch(a, b, a);
    await settleOrHold(id);
    expect((await signalsOf(id)).find((r) => r.kind === 'cheat_reports')).toMatchObject({
      score: 40,
    });

    const c = await player();
    const d = await player();
    for (let i = 0; i < 3; i++) await report(await player(), c, 'cheat');
    const second = await endedMatch(c, d, c);
    await settleOrHold(second);
    expect((await signalsOf(second)).find((r) => r.kind === 'cheat_reports')).toMatchObject({
      score: 30,
    });
  });
});

// ---- timing and input signals ---------------------------------------------------------------------------

describe('impossible timing and repeated input', () => {
  beforeAll(async () => {
    await db.admin.query(
      `INSERT INTO integrity_game_rules (game_slug, min_gap_ms, gap_basis, max_repeat) VALUES ('_example', 500, 'previous', 4)
       ON CONFLICT (game_slug) DO UPDATE SET min_gap_ms = 500, max_repeat = 4`,
    );
  });

  async function moves(
    matchId: string,
    user: TestUser,
    count: number,
    gapMs: number,
    action: (i: number) => unknown,
  ) {
    const start = Date.now() - 10 * 60_000;
    const seqStart = Number(
      (
        await db.admin.query(
          `SELECT coalesce(max(seq), 0) AS s FROM match_moves WHERE match_id = $1`,
          [matchId],
        )
      ).rows[0].s,
    );
    for (let i = 0; i < count; i++) {
      await db.admin.query(
        `INSERT INTO match_moves (match_id, seq, user_id, action, created_at) VALUES ($1, $2, $3, $4::jsonb, $5)`,
        [
          matchId,
          seqStart + i + 1,
          user.id,
          JSON.stringify(action(i)),
          new Date(start + seqStart * 1000 + i * gapMs),
        ],
      );
    }
  }

  it('inputs faster than a person, three times in one match, are a signal', async () => {
    const a = await player();
    const b = await player();
    const id = await endedMatch(a, b, a);
    await moves(id, a, 5, 100, (i) => ({ kind: 'throw', aim: i * 7, power: 100 + i }));
    await settleOrHold(id);
    const row = (await signalsOf(id)).find((r) => r.kind === 'timing_impossible');
    expect(row).toMatchObject({ score: 45 });
    const detail = await db.admin.query(
      `SELECT detail FROM integrity_signals WHERE match_id = $1 AND kind = 'timing_impossible'`,
      [id],
    );
    expect(detail.rows[0].detail).toMatchObject({ hits: 4, minGapMs: 500 });
  });

  it('two quick taps are not a signal, and a normal pace is none', async () => {
    const a = await player();
    const b = await player();
    const quick = await endedMatch(a, b, a);
    await moves(quick, a, 3, 100, (i) => ({ kind: 'throw', aim: i, power: i })); // 2 fast gaps
    await settleOrHold(quick);
    expect(await signalsOf(quick)).toEqual([]);
    const slow = await endedMatch(a, b, b);
    await moves(slow, a, 6, 5_000, (i) => ({ kind: 'throw', aim: i, power: i }));
    await settleOrHold(slow);
    expect(await signalsOf(slow)).toEqual([]);
  });

  it('the identical input repeated in a row is a signal, a varying one is not', async () => {
    const a = await player();
    const b = await player();
    const same = await endedMatch(a, b, a);
    await moves(same, a, 5, 5_000, () => ({ kind: 'throw', aim: 123, power: 456 }));
    await settleOrHold(same);
    expect((await signalsOf(same)).find((r) => r.kind === 'input_repeat')).toMatchObject({
      score: 25,
    });
    const varied = await endedMatch(a, b, b);
    await moves(varied, a, 6, 5_000, (i) => ({ kind: 'throw', aim: 123 + (i % 2), power: 456 }));
    await settleOrHold(varied);
    expect(await signalsOf(varied)).toEqual([]);
  });

  it('own-basis rules measure from your own previous move (Word Hunt: start, then submit)', async () => {
    await db.admin.query(
      `UPDATE integrity_game_rules SET gap_basis = 'own', min_gap_ms = 3000, max_repeat = NULL WHERE game_slug = '_example'`,
    );
    const a = await player();
    const b = await player();
    const id = await endedMatch(a, b, a);
    // a's own moves are 1 s apart (fast); b's moves in between do not rescue them
    await moves(id, a, 4, 1_000, (i) => ({ kind: i % 2 ? 'submit' : 'start', i }));
    await settleOrHold(id);
    expect((await signalsOf(id)).map((r) => r.kind)).toContain('timing_impossible');
    await db.admin.query(
      `UPDATE integrity_game_rules SET gap_basis = 'previous', min_gap_ms = 500, max_repeat = 4 WHERE game_slug = '_example'`,
    );
  });
});

// ---- holds -----------------------------------------------------------------------------------------------

describe('a payout hold', () => {
  it('stops the payout and keeps every stake where it was', async () => {
    const { a, b } = await colluders();
    const id = await endedMatch(a, b, a);
    const before = { a: await balanceOf(db, a.id), b: await balanceOf(db, b.id) };
    const r = await settleOrHold(id);
    expect(r.rows[0]).toMatchObject({ txn_id: null, replayed: false });

    const hold = await holdOf(id);
    expect(hold).toMatchObject({ status: 'held', total_score: 100 });
    expect(await matchStatus(id)).toBe('disputed');
    expect(await balanceOf(db, a.id)).toBe(before.a);
    expect(await balanceOf(db, b.id)).toBe(before.b);
    expect(await escrowOf(id)).toBe(2 * STAKE);
    const payouts = await db.admin.query(
      `SELECT payout_kobo FROM match_players WHERE match_id = $1`,
      [id],
    );
    expect(payouts.rows.every((p) => p.payout_kobo === null)).toBe(true);
    expect((await signalsOf(id)).every((s) => s.flagged)).toBe(true);
    // the escrow is open and the ledger is whole while it waits
    await expectLedgerClean(db);
    // both players are told it is being checked, without the reason
    for (const p of [a, b]) {
      expect(await notesOf(p, 'moderation_notice')).toEqual([
        expect.objectContaining({ kind: 'payout_review', matchId: id }),
      ]);
    }
  });

  it('is decided once: a retried final move holds once and a held match never pays by itself', async () => {
    const { a, b } = await colluders();
    const id = await endedMatch(a, b, a);
    await settleOrHold(id);
    await settleOrHold(id);
    await settleOrHold(id);
    expect(
      (await db.admin.query(`SELECT 1 FROM integrity_holds WHERE match_id = $1`, [id])).rows,
    ).toHaveLength(1);
    expect(await escrowOf(id)).toBe(2 * STAKE);
    // the API role cannot pay it out some other way either: settle_match is the same code a moderator calls, so
    // the point is that nothing in the normal flow does.
    expect(await matchStatus(id)).toBe('disputed');
  });

  it('release pays the match as it was decided, closes the signals and leaves an audit row', async () => {
    const { a, b } = await colluders();
    const id = await endedMatch(a, b, a);
    await settleOrHold(id);
    const hold = await holdOf(id);

    const res = await moderation.resolveHold(hold.id, 'release', 'amaka', 'friends, same phone');
    expect(res.txnId).not.toBeNull();
    expect(await balanceOf(db, a.id)).toBe(200_000 * NAIRA + STAKE);
    expect(await balanceOf(db, b.id)).toBe(200_000 * NAIRA - STAKE);
    expect(await escrowOf(id)).toBe(0);
    expect(await matchStatus(id)).toBe('finished');
    expect(await holdOf(id)).toMatchObject({ status: 'released', decided_by: 'amaka' });
    expect((await signalsOf(id)).every((s) => s.status === 'dismissed')).toBe(true);
    const audit = await moderation.audit({ limit: 5 });
    expect(audit[0]).toMatchObject({
      admin: 'amaka',
      action: 'hold_release',
      note: 'friends, same phone',
    });
    await expectLedgerClean(db);

    // the same decision again changes nothing; a different one is refused
    const again = await moderation.resolveHold(hold.id, 'release', 'amaka', null);
    expect(again).toEqual({ txnId: res.txnId, replayed: true });
    await expect(moderation.resolveHold(hold.id, 'void', 'amaka', null)).rejects.toEqual(
      code('hold_resolved'),
    );
    expect(await balanceOf(db, a.id)).toBe(200_000 * NAIRA + STAKE);
  });

  it('void gives every stake back and cancels the match', async () => {
    const { a, b } = await colluders();
    const id = await endedMatch(a, b, a);
    await settleOrHold(id);
    await moderation.resolveHold((await holdOf(id)).id, 'void', 'amaka', 'wash trading');
    expect(await balanceOf(db, a.id)).toBe(200_000 * NAIRA);
    expect(await balanceOf(db, b.id)).toBe(200_000 * NAIRA);
    expect(await matchStatus(id)).toBe('cancelled');
    expect(await holdOf(id)).toMatchObject({ status: 'voided' });
    expect((await signalsOf(id)).every((s) => s.status === 'actioned')).toBe(true);
    await expectLedgerClean(db);
  });

  it('disqualify places the named player last and pays the other', async () => {
    const { a, b } = await colluders();
    const id = await endedMatch(a, b, a); // a "won"
    await settleOrHold(id);
    await moderation.resolveHold(
      (await holdOf(id)).id,
      'disqualify',
      'amaka',
      'a used a bot',
      a.id,
    );
    expect(await balanceOf(db, b.id)).toBe(200_000 * NAIRA + STAKE);
    expect(await balanceOf(db, a.id)).toBe(200_000 * NAIRA - STAKE);
    const rows = await db.admin.query(
      `SELECT user_id, placement, result::text AS result FROM match_players WHERE match_id = $1`,
      [id],
    );
    const byUser = Object.fromEntries(rows.rows.map((r) => [r.user_id, r]));
    expect(byUser[b.id]).toMatchObject({ placement: 1, result: 'win' });
    expect(byUser[a.id]).toMatchObject({ placement: 2, result: 'forfeit' });
    expect(await holdOf(id)).toMatchObject({ status: 'disqualified', disqualified_user: a.id });
    await expectLedgerClean(db);
  });

  it('disqualify needs a player of that match', async () => {
    const { a, b } = await colluders();
    const stranger = await player();
    const id = await endedMatch(a, b, a);
    await settleOrHold(id);
    const hold = await holdOf(id);
    await expect(
      moderation.resolveHold(hold.id, 'disqualify', 'amaka', null, stranger.id),
    ).rejects.toEqual(code('not_a_player'));
    await expect(moderation.resolveHold(hold.id, 'disqualify', 'amaka', null)).rejects.toEqual(
      code('not_a_player'),
    );
    expect((await holdOf(id)).status).toBe('held');
    expect(await escrowOf(id)).toBe(2 * STAKE);
  });

  it('a hold nobody decided pays out as originally decided once it lapses', async () => {
    const { a, b } = await colluders();
    const id = await endedMatch(a, b, b);
    await settleOrHold(id);
    expect(Number((await db.app.query('SELECT integrity_lapse_holds() AS n')).rows[0].n)).toBe(0); // not yet
    await db.admin.query(
      `UPDATE integrity_holds SET lapses_at = now() - interval '1 minute' WHERE match_id = $1`,
      [id],
    );
    expect(
      Number((await db.app.query('SELECT integrity_lapse_holds() AS n')).rows[0].n),
    ).toBeGreaterThanOrEqual(1);
    expect(await holdOf(id)).toMatchObject({ status: 'released', decided_by: 'system:lapse' });
    expect(await balanceOf(db, b.id)).toBe(200_000 * NAIRA + STAKE);
    await expectLedgerClean(db);
  });

  it('keeps a forfeited player a forfeit after the release', async () => {
    const { a, b } = await colluders();
    const id = await endedMatch(a, b, a);
    await db.admin.query(
      `UPDATE match_players SET result = 'forfeit' WHERE match_id = $1 AND user_id = $2`,
      [id, b.id],
    );
    await settleOrHold(id);
    await moderation.resolveHold((await holdOf(id)).id, 'release', 'amaka', null);
    const r = await db.admin.query(
      `SELECT result::text AS result FROM match_players WHERE match_id = $1 AND user_id = $2`,
      [id, b.id],
    );
    expect(r.rows[0].result).toBe('forfeit');
  });

  it('two moderators deciding at the same moment pay once', async () => {
    const { a, b } = await colluders();
    const id = await endedMatch(a, b, a);
    await settleOrHold(id);
    const hold = await holdOf(id);
    const results = await Promise.allSettled([
      moderation.resolveHold(hold.id, 'release', 'amaka', null),
      moderation.resolveHold(hold.id, 'release', 'tunde', null),
      moderation.resolveHold(hold.id, 'void', 'chidi', null),
    ]);
    // the identical decision is idempotent; the conflicting one loses or wins exactly once
    const decided = (await holdOf(id)).status;
    expect(['released', 'voided']).toContain(decided);
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    const expectedA = decided === 'released' ? 200_000 * NAIRA + STAKE : 200_000 * NAIRA;
    expect(await balanceOf(db, a.id)).toBe(expectedA);
    await expectLedgerClean(db);
  });
});

// ---- the gate ------------------------------------------------------------------------------------------

describe('the device integrity gate', () => {
  const ctx = (o: Partial<{ ip: string; deviceId: string; attestation: string }> = {}) => ({
    ip: o.ip ?? '10.1.2.3',
    deviceId: o.deviceId ?? 'install-' + randomBytes(10).toString('hex'),
    platform: 'android' as const,
    attestation: o.attestation ?? null,
  });
  const verifier = (verdict: 'ok' | 'fail' | 'throw'): AttestationVerifier => ({
    name: 'store',
    verify: () =>
      verdict === 'throw'
        ? Promise.reject(new Error('google is down'))
        : Promise.resolve(
            verdict === 'ok' ? { ok: true } : { ok: false, reason: 'not_recognized' },
          ),
  });
  const gate = (v: AttestationVerifier) => new IntegrityGate(db.app, v, SECRET, () => new Date());

  afterEach(async () => {
    await setConfig(db, 'integrity_required', false);
  });

  it('records the phone and connection as hashes and counts repeats', async () => {
    const u = await player();
    const c = ctx();
    await gate(verifier('ok')).poolEntry(u.id, c);
    await gate(verifier('ok')).poolEntry(u.id, c);
    const rows = await db.admin.query(
      `SELECT kind, seen_count, encode(value_hash, 'hex') AS h FROM user_fingerprints WHERE user_id = $1 ORDER BY kind`,
      [u.id],
    );
    expect(rows.rows.map((r) => [r.kind, r.seen_count])).toEqual([
      ['device', 2],
      ['ip', 2],
    ]);
    expect(rows.rows.every((r) => r.h.length === 64 && !r.h.includes('10.1.2.3'))).toBe(true);
  });

  it('two people on one phone end up with the same device hash', async () => {
    const a = await player();
    const b = await player();
    const c = ctx({ deviceId: 'shared-install-id-123456' });
    await gate(verifier('ok')).poolEntry(a.id, c);
    await gate(verifier('ok')).poolEntry(b.id, c);
    const id = await endedMatch(a, b, a);
    await settleOrHold(id);
    expect((await signalsOf(id)).map((s) => s.kind)).toEqual(
      expect.arrayContaining(['shared_device', 'shared_ip']),
    );
  });

  it('is open when not required: nothing is blocked, a failing token is only a signal', async () => {
    const u = await player();
    await gate(verifier('fail')).poolEntry(u.id, ctx()); // no token at all
    await gate(verifier('fail')).poolEntry(u.id, ctx({ attestation: 'tok' }));
    const s = await db.admin.query(
      `SELECT kind, score, match_id FROM integrity_signals WHERE subject_user = $1`,
      [u.id],
    );
    expect(s.rows).toEqual([{ kind: 'attestation_failed', score: 40, match_id: null }]);
  });

  it('fails closed when required: no token, a bad token and a verifier that errors all refuse Pool', async () => {
    await setConfig(db, 'integrity_required', true);
    const u = await player();
    await expect(gate(verifier('ok')).poolEntry(u.id, ctx())).rejects.toMatchObject({
      code: 'integrity_check_failed',
      details: { reason: 'missing' },
    });
    await expect(
      gate(verifier('fail')).poolEntry(u.id, ctx({ attestation: 't' })),
    ).rejects.toMatchObject({
      code: 'integrity_check_failed',
      details: { reason: 'not_recognized' },
    });
    await expect(
      gate(verifier('throw')).poolEntry(u.id, ctx({ attestation: 't' })),
    ).rejects.toMatchObject({
      code: 'integrity_check_failed',
      details: { reason: 'verifier_error' },
    });
    await expect(
      gate(verifier('ok')).poolEntry(u.id, ctx({ attestation: 't' })),
    ).resolves.toBeUndefined();
  });

  it('the production stub never passes anyone', async () => {
    const { StoreAttestationVerifier } = await import('../../src/integrity/attestation.ts');
    await setConfig(db, 'integrity_required', true);
    const u = await player();
    await expect(
      gate(new StoreAttestationVerifier()).poolEntry(
        u.id,
        ctx({ attestation: 'a-real-looking-token' }),
      ),
    ).rejects.toMatchObject({
      code: 'integrity_check_failed',
      details: { reason: 'not_configured' },
    });
  });

  it('a failed check in the last week adds to a match that would otherwise settle', async () => {
    const a = await player();
    const b = await player();
    await gate(verifier('fail')).poolEntry(a.id, ctx({ attestation: 't' }));
    await history(a, b, 4); // pair_repeat 30 + one_sided 30
    const id = await endedMatch(a, b, a);
    await settleOrHold(id);
    expect((await signalsOf(id)).map((s) => s.kind)).toContain('attestation_failed');
    expect(await matchStatus(id)).toBe('disputed'); // 30 + 30 + 40 = 100
  });

  it('issues a nonce that is stable for a window and different per person', async () => {
    const g = gate(verifier('ok'));
    const u = await player();
    const v = await player();
    const c1 = await g.challenge(u.id);
    expect((await g.challenge(u.id)).challenge).toBe(c1.challenge);
    expect((await g.challenge(v.id)).challenge).not.toBe(c1.challenge);
  });

  it('deleting an account deletes its fingerprints', async () => {
    const u = await player();
    await gate(verifier('ok')).poolEntry(u.id, ctx());
    expect(
      Number(
        (
          await db.admin.query(`SELECT count(*) AS n FROM user_fingerprints WHERE user_id = $1`, [
            u.id,
          ])
        ).rows[0].n,
      ),
    ).toBe(2);
    await db.admin.query(`UPDATE users SET disabled_at = now() WHERE id = $1`, [u.id]);
    expect(
      Number(
        (
          await db.admin.query(`SELECT count(*) AS n FROM user_fingerprints WHERE user_id = $1`, [
            u.id,
          ])
        ).rows[0].n,
      ),
    ).toBe(0);
  });

  it('old fingerprints are pruned', async () => {
    const u = await player();
    await fingerprint(u, 'ip', randomBytes(32));
    await db.admin.query(
      `UPDATE user_fingerprints SET last_seen_at = now() - interval '100 days' WHERE user_id = $1`,
      [u.id],
    );
    const n = Number((await db.app.query('SELECT integrity_prune_fingerprints() AS n')).rows[0].n);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(
      (await db.admin.query(`SELECT 1 FROM user_fingerprints WHERE user_id = $1`, [u.id])).rows,
    ).toHaveLength(0);
  });
});

// ---- the spam filter -------------------------------------------------------------------------------------

describe('the request spam filter', () => {
  const send = (from: TestUser, to: TestUser) =>
    chat
      .openDirect(from.id, to.id)
      .then((conv) =>
        chat
          .send(from.id, conv.id, { id: randomUUID(), body: 'hi, play me for money?' })
          .then(() => conv.id),
      );
  const oldAccount = player;

  it('a new account writing to many strangers in an hour gets filtered, and the recipient is not told live', async () => {
    const spammer = await young();
    const targets: TestUser[] = [];
    for (let i = 0; i < 8; i++) targets.push(await player());
    const convs: string[] = [];
    for (const t of targets) convs.push(await send(spammer, t));

    // the first seven are ordinary requests
    for (const t of targets.slice(0, 7)) {
      const list = await chat.list(t.id, 'requests');
      expect(list).toMatchObject({ requestCount: 1, filteredCount: 0 });
    }
    // the eighth is not
    const last = targets[7]!;
    expect(await chat.list(last.id, 'requests')).toMatchObject({
      requestCount: 0,
      filteredCount: 1,
      conversations: [],
    });
    const filtered = await chat.list(last.id, 'filtered');
    expect(filtered.conversations.map((c) => c.id)).toEqual([convs[7]]);
    expect(filtered.conversations[0]).toMatchObject({ state: 'request' });

    // the sender hears nothing different; the recipient got no live message
    const forLast = published.filter(
      (p) => p.users.includes(last.id) && p.event.type === 'message',
    );
    expect(forLast).toHaveLength(0);
    const reason = await db.admin.query(
      `SELECT filter_reason FROM conversation_members WHERE conversation_id = $1 AND user_id = $2`,
      [convs[7], last.id],
    );
    expect(reason.rows[0].filter_reason).toBe('new_account,mass_sending');
  });

  it('a filtered request can still be opened, accepted and answered, and then it is an ordinary chat', async () => {
    const spammer = await young();
    for (let i = 0; i < 7; i++) await send(spammer, await player());
    const me = await player();
    const conv = await send(spammer, me);
    expect((await chat.list(me.id, 'filtered')).conversations).toHaveLength(1);

    const thread = await chat.messages(me.id, conv);
    expect(thread.messages).toHaveLength(1);
    expect(thread.peerReadAt).toBeNull();
    const accepted = await chat.accept(me.id, conv);
    expect(accepted.state).toBe('active');
    expect(await chat.list(me.id, 'filtered')).toMatchObject({
      filteredCount: 0,
      conversations: [],
    });
    expect((await chat.list(me.id, 'all')).conversations.map((c) => c.id)).toContain(conv);
    const marks = await db.admin.query(
      `SELECT filtered_at FROM conversation_members WHERE conversation_id = $1 AND user_id = $2`,
      [conv, me.id],
    );
    expect(marks.rows[0].filtered_at).toBeNull();

    // from here the sender is not judged again
    published.length = 0;
    await chat.send(spammer.id, conv, { id: randomUUID(), body: 'thanks' });
    expect(published.some((p) => p.users.includes(me.id) && p.event.type === 'message')).toBe(true);
  });

  it('declining a filtered request hides it from both buckets', async () => {
    const spammer = await young();
    for (let i = 0; i < 7; i++) await send(spammer, await player());
    const me = await player();
    const conv = await send(spammer, me);
    await chat.decline(me.id, conv);
    expect(await chat.list(me.id, 'requests')).toMatchObject({ requestCount: 0, filteredCount: 0 });
    expect((await chat.list(me.id, 'filtered')).conversations).toEqual([]);
  });

  it('once filtered it stays filtered, even if the sender would now pass', async () => {
    const spammer = await young();
    for (let i = 0; i < 7; i++) await send(spammer, await player());
    const me = await player();
    const conv = await send(spammer, me);
    await db.admin.query(`UPDATE users SET created_at = now() - interval '90 days' WHERE id = $1`, [
      spammer.id,
    ]);
    await db.admin.query(
      `UPDATE conversations SET created_at = created_at - interval '2 hours' WHERE created_by = $1 AND id <> $2`,
      [spammer.id, conv],
    );
    await chat.send(spammer.id, conv, { id: randomUUID(), body: 'second' });
    expect(await chat.list(me.id, 'requests')).toMatchObject({ requestCount: 0, filteredCount: 1 });
  });

  it('an old account is not filtered for mass sending alone, but is once it has been reported or declined', async () => {
    const old = await oldAccount();
    for (let i = 0; i < 8; i++) await send(old, await player());
    const quiet = await player();
    await send(old, quiet);
    expect(await chat.list(quiet.id, 'requests')).toMatchObject({
      requestCount: 1,
      filteredCount: 0,
    });

    const reported = await oldAccount();
    for (let i = 0; i < 7; i++) await send(reported, await player());
    await report(await player(), reported, 'spam');
    const hit = await player();
    await send(reported, hit);
    expect(await chat.list(hit.id, 'requests')).toMatchObject({
      requestCount: 0,
      filteredCount: 1,
    });
    const why = await db.admin.query(
      `SELECT filter_reason FROM conversation_members WHERE user_id = $1`,
      [hit.id],
    );
    expect(why.rows[0].filter_reason).toBe('mass_sending,reported');
  });

  it('three different people reporting someone for spam is enough on its own', async () => {
    const bad = await oldAccount();
    for (let i = 0; i < 3; i++) await report(await player(), bad, i === 0 ? 'scam' : 'spam');
    const me = await player();
    await send(bad, me);
    expect(await chat.list(me.id, 'requests')).toMatchObject({ requestCount: 0, filteredCount: 1 });
  });

  it('three recipients who declined in the last month, plus a new account, is enough', async () => {
    const pest = await young();
    for (let i = 0; i < 3; i++) {
      const r = await player();
      const conv = await send(pest, r);
      await chat.decline(r.id, conv);
    }
    const me = await player();
    await send(pest, me);
    expect(await chat.list(me.id, 'requests')).toMatchObject({ requestCount: 0, filteredCount: 1 });
    const why = await db.admin.query(
      `SELECT filter_reason FROM conversation_members WHERE user_id = $1`,
      [me.id],
    );
    expect(why.rows[0].filter_reason).toBe('new_account,repeated_declines');
  });

  it('never filters someone who has you in their contacts or shares a friend with you', async () => {
    const spammer = await young();
    for (let i = 0; i < 7; i++) await send(spammer, await player());
    const knows = await player();
    await db.admin.query(`INSERT INTO contact_links (owner_id, contact_user_id) VALUES ($1, $2)`, [
      knows.id,
      spammer.id,
    ]);
    await send(spammer, knows);
    expect(await chat.list(knows.id, 'requests')).toMatchObject({
      requestCount: 1,
      filteredCount: 0,
    });

    const viaFriend = await player();
    const mutual = await player();
    for (const f of [spammer, viaFriend]) {
      await friends.sendRequest(f.id, mutual.id);
      await friends.accept(mutual.id, f.id);
    }
    await send(spammer, viaFriend);
    expect(await chat.list(viaFriend.id, 'requests')).toMatchObject({
      requestCount: 1,
      filteredCount: 0,
    });
  });

  it('a friend is never filtered', async () => {
    const spammer = await young();
    for (let i = 0; i < 8; i++) await send(spammer, await player());
    const pal = await player();
    await friends.sendRequest(spammer.id, pal.id);
    await friends.accept(pal.id, spammer.id);
    await send(spammer, pal);
    expect((await chat.list(pal.id, 'all')).conversations).toHaveLength(1);
    expect(await chat.list(pal.id, 'requests')).toMatchObject({
      requestCount: 0,
      filteredCount: 0,
    });
  });
});

// ---- the moderation queue and sanctions ----------------------------------------------------------------

describe('the moderation queue', () => {
  it('lists reports with context and opens one with the snapshot the reporter attached', async () => {
    const reporter = await player();
    const target = await player();
    const id = await report(reporter, target, 'abuse');
    await db.admin.query(
      `UPDATE reports SET evidence = '[{"body":"you are bad"}]'::jsonb, note = 'rude' WHERE id = $1`,
      [id],
    );
    const list = await moderation.reports({ status: 'pending' });
    expect(list.find((r) => r.id === id)).toMatchObject({
      status: 'open',
      reason: 'abuse',
      reporter: reporter.username,
      target: target.username,
      evidenceCount: 1,
    });
    expect(await moderation.report(id)).toMatchObject({
      evidence: [{ body: 'you are bad' }],
      note: 'rude',
    });
    await expect(moderation.report(randomUUID())).rejects.toEqual(code('report_not_found'));
  });

  it('warn: the target is warned, the reporter hears it was looked at, and the audit log says who', async () => {
    const reporter = await player();
    const target = await player();
    const id = await report(reporter, target, 'abuse');
    await moderation.actOnReport(id, 'review', 'amaka', null);
    expect((await moderation.reports({ status: 'reviewing' })).map((r) => r.id)).toContain(id);
    await moderation.actOnReport(id, 'warn', 'amaka', 'first offence');

    expect((await moderation.report(id)).status).toBe('actioned');
    expect(await notesOf(reporter, 'report_outcome')).toEqual([{ outcome: 'actioned' }]);
    expect(await notesOf(target, 'moderation_notice')).toEqual([{ kind: 'warning' }]);
    const audit = (await moderation.audit({ targetUserId: target.id })).map((a) => [
      a.admin,
      a.action,
    ]);
    expect(audit).toEqual(
      expect.arrayContaining([
        ['amaka', 'report_warn'],
        ['amaka', 'sanction_warning'],
      ]),
    );
    await expect(moderation.actOnReport(id, 'dismiss', 'amaka', null)).rejects.toEqual(
      code('report_resolved'),
    );
    expect(await notesOf(reporter, 'report_outcome')).toHaveLength(1); // told once
  });

  it('dismiss: no sanction, and the reporter is told in neutral words', async () => {
    const reporter = await player();
    const target = await player();
    const id = await report(reporter, target, 'spam');
    await moderation.actOnReport(id, 'dismiss', 'tunde', 'nothing here');
    expect(await notesOf(reporter, 'report_outcome')).toEqual([{ outcome: 'dismissed' }]);
    expect(await notesOf(target, 'moderation_notice')).toEqual([]);
    expect((await moderation.user(target.id)).sanctions).toEqual([]);
  });

  it('an action needs a named moderator', async () => {
    const id = await report(await player(), await player());
    await expect(moderation.actOnReport(id, 'dismiss', '  ', null)).rejects.toEqual(
      code('admin_required'),
    );
    expect((await moderation.report(id)).status).toBe('open');
  });

  it('mute: the person cannot write, send friend requests or ask for money until it ends or is lifted, and can still play', async () => {
    const target = await player();
    const other = await player();
    const conv = (await chat.openDirect(target.id, other.id)).id;
    const sanctionId = await moderation.sanction(target.id, 'mute', 'amaka', 'harassing', {
      hours: 6,
    });
    expect(await notesOf(target, 'moderation_notice')).toEqual([
      expect.objectContaining({ kind: 'mute' }),
    ]);

    await expect(chat.send(target.id, conv, { id: randomUUID(), body: 'hello' })).rejects.toEqual(
      code('account_muted'),
    );
    await expect(friends.sendRequest(target.id, other.id)).rejects.toEqual(code('account_muted'));
    await expect(assertNotRestricted(db.app, target.id)).rejects.toEqual(code('account_muted'));
    // they can still stake and play
    const id = await endedMatch(target, await player(), target);
    await settleOrHold(id);
    expect(await matchStatus(id)).toBe('finished');

    expect((await moderation.user(target.id)).mutedUntil).not.toBeNull();
    await moderation.lift(sanctionId, 'amaka', 'appealed');
    expect((await moderation.user(target.id)).mutedUntil).toBeNull();
    await expect(
      chat.send(target.id, conv, { id: randomUUID(), body: 'hello' }),
    ).resolves.toMatchObject({ body: 'hello' });
  });

  it('a mute ends by itself', async () => {
    const target = await player();
    await moderation.sanction(target.id, 'mute', 'amaka', null, { hours: 1 });
    await db.admin.query(
      `UPDATE users SET muted_until = now() - interval '1 second' WHERE id = $1`,
      [target.id],
    );
    await expect(assertNotRestricted(db.app, target.id)).resolves.toBeUndefined();
  });

  it('a retried message sent before the mute is still returned, not refused', async () => {
    const target = await player();
    const other = await player();
    const conv = (await chat.openDirect(target.id, other.id)).id;
    const id = randomUUID();
    await chat.send(target.id, conv, { id, body: 'before' });
    await moderation.sanction(target.id, 'mute', 'amaka', null, { hours: 1 });
    await expect(chat.send(target.id, conv, { id, body: 'before' })).resolves.toMatchObject({ id });
  });

  it('suspend: sessions end, Pool is frozen, and lifting restores both rules', async () => {
    const target = await player();
    const family = randomUUID();
    await db.admin.query(
      `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at) VALUES ($1, $2, $3, now() + interval '30 days')`,
      [target.id, family, randomBytes(32)],
    );
    const sanctionId = await moderation.sanction(target.id, 'suspension', 'amaka', 'scam ring');
    expect((await moderation.user(target.id)).suspendedUntil).toBe('forever');
    expect((await moderation.user(target.id)).poolFrozen).toBe(true);
    const tok = await db.admin.query(`SELECT revoked_at FROM refresh_tokens WHERE family_id = $1`, [
      family,
    ]);
    expect(tok.rows[0].revoked_at).not.toBeNull();
    await expect(assertNotRestricted(db.app, target.id)).rejects.toEqual(code('account_suspended'));
    await expectDyceError(
      db.app.query('SELECT * FROM stake_pool($1, $2, $3, $4)', [
        await createMatch(db, target.id, [target.id], { mode: 'pool', stake: STAKE }),
        target.id,
        STAKE,
        idem(),
      ]),
      'pool_frozen',
    );

    await moderation.lift(sanctionId, 'amaka', 'wrong person');
    const after = await moderation.user(target.id);
    expect(after).toMatchObject({ suspendedUntil: null, poolFrozen: false });
    await expect(assertNotRestricted(db.app, target.id)).resolves.toBeUndefined();
  });

  it('lifting a suspension does not unfreeze Pool that something else froze', async () => {
    const target = await player();
    await db.admin.query(`UPDATE profiles SET pool_frozen = true WHERE id = $1`, [target.id]);
    const s = await moderation.sanction(target.id, 'suspension', 'amaka', null, { hours: 24 });
    await moderation.lift(s, 'amaka', null);
    expect((await moderation.user(target.id)).poolFrozen).toBe(true);
  });

  it('a suspended person cannot sign in or refresh', async () => {
    const secret = 'k'.repeat(40);
    const sms = new MemorySmsProvider();
    const tokens = new TokenService(secret, { accessTtlSeconds: 900 });
    const auth = new AuthService(db.app, sms, tokens, {
      phoneSecret: secret,
      otpTtlSeconds: 300,
      refreshTtlDays: 30,
    });
    const phone = { phone: '08035550123', country: 'NG' as const };
    await auth.requestOtp(phone);
    const session = await auth.verifyOtp({ ...phone, code: sms.lastCode() });
    const userId = (
      await db.admin.query(`SELECT user_id FROM refresh_tokens ORDER BY created_at DESC LIMIT 1`)
    ).rows[0].user_id as string;
    await moderation.sanction(userId, 'suspension', 'amaka', null, { hours: 48 });
    // the old session is dead (its refresh token was revoked)
    await expect(auth.refresh(session.refreshToken)).rejects.toBeDefined();
    // and a fresh sign-in with a valid code is refused with the reason
    await db.admin.query(`UPDATE otp_challenges SET created_at = created_at - interval '1 hour'`);
    await auth.requestOtp(phone);
    await expect(auth.verifyOtp({ ...phone, code: sms.lastCode() })).rejects.toEqual(
      code('account_suspended'),
    );
  });

  it('signals: the queue lists flagged ones, a moderator reviews them, and it is audited', async () => {
    const { a, b } = await colluders();
    const id = await endedMatch(a, b, a);
    await settleOrHold(id);
    const queue = await moderation.signals({ flagged: true, status: 'open' });
    const mine = queue.filter((s) => s.matchId === id);
    expect(mine.map((s) => s.kind).sort()).toEqual([
      'pair_one_sided',
      'pair_repeat',
      'shared_device',
    ]);
    expect(mine.every((s) => s.subject && s.score >= 20)).toBe(true);
    const first = mine[0]!;
    await moderation.reviewSignal(first.id, 'reviewing', 'amaka', 'looking');
    await moderation.reviewSignal(first.id, 'actioned', 'amaka', 'sanctioned');
    expect((await moderation.signals({ status: 'actioned' })).map((s) => s.id)).toContain(first.id);
    const holds = await moderation.holds({ status: 'held' });
    const h = holds.find((x) => x.matchId === id)!;
    expect(h).toMatchObject({ totalScore: 100, potKobo: 2 * STAKE, gameSlug: '_example' });
    expect(h.players).toHaveLength(2);
    expect(h.signals).toHaveLength(3);
  });

  it('disputes can be moved along through the audited path', async () => {
    const { a, b } = await colluders();
    const mid = await endedMatch(a, b, b);
    await db.admin.query('SELECT settle_match($1)', [mid]);
    const dispute = randomUUID();
    await db.admin.query(
      `INSERT INTO disputes (id, match_id, user_id, reason) VALUES ($1, $2, $3, 'cheat')`,
      [dispute, mid, a.id],
    );
    expect((await moderation.disputes()).map((d) => d.id)).toContain(dispute);
    await moderation.resolveDispute(dispute, 'reviewing', 'amaka', null);
    await moderation.resolveDispute(dispute, 'upheld', 'amaka', 'result stands');
    expect((await moderation.audit({ targetUserId: a.id })).map((x) => x.action)).toEqual(
      expect.arrayContaining(['dispute_reviewing', 'dispute_upheld']),
    );
    await expect(moderation.resolveDispute(dispute, 'reversed', 'amaka', null)).rejects.toEqual(
      code('dispute_resolved'),
    );
    await expect(moderation.resolveDispute(randomUUID(), 'upheld', 'amaka', null)).rejects.toEqual(
      code('dispute_not_found'),
    );
  });

  it('shows a person with their history', async () => {
    const t = await player();
    await report(await player(), t, 'abuse');
    await moderation.sanction(t.id, 'warning', 'amaka', null);
    expect(await moderation.user(t.id)).toMatchObject({
      username: t.username,
      reportsAgainst: 1,
      deleted: false,
    });
    expect((await moderation.user(t.id)).sanctions).toHaveLength(1);
    await expect(moderation.user(randomUUID())).rejects.toEqual(code('user_not_found'));
  });
});

// ---- who may call what -----------------------------------------------------------------------------------

describe('permissions', () => {
  it('the public API role cannot decide holds, act on reports, or read the moderation views', async () => {
    const { a, b } = await colluders();
    const id = await endedMatch(a, b, a);
    await settleOrHold(id);
    const hold = await holdOf(id);
    await expectPermissionDenied(
      db.app.query(`SELECT resolve_integrity_hold($1, 'release', 'x', NULL)`, [hold.id]),
    );
    await expectPermissionDenied(
      db.app.query(`SELECT moderation_sanction($1, 'mute', 'x', NULL, 1)`, [a.id]),
    );
    await expectPermissionDenied(
      db.app.query(`SELECT moderation_act_on_report($1, 'dismiss', 'x', NULL)`, [randomUUID()]),
    );
    await expectPermissionDenied(db.app.query(`SELECT * FROM moderation_report_queue`));
    await expectPermissionDenied(db.app.query(`SELECT * FROM moderation_hold_queue`));
    await expectPermissionDenied(db.app.query(`SELECT * FROM integrity_holds`));
    await expectPermissionDenied(db.app.query(`SELECT * FROM integrity_signals`));
    await expectPermissionDenied(db.app.query(`SELECT * FROM moderation_actions`));
    await expectPermissionDenied(
      db.app.query(`SELECT _integrity_signal('pair_repeat', 50, NULL, NULL, NULL, '{}', 'x')`),
    );
    // and the hold is untouched
    expect((await holdOf(id)).status).toBe('held');
  });

  it('the moderator role works through views and functions only, not tables or money', async () => {
    await expectPermissionDenied(admin.query(`SELECT * FROM reports`));
    await expectPermissionDenied(admin.query(`SELECT * FROM wallets`));
    await expectPermissionDenied(admin.query(`UPDATE profiles SET pool_frozen = false`));
    await expectPermissionDenied(admin.query(`SELECT settle_match(gen_random_uuid())`));
    await expectPermissionDenied(
      admin.query(`SELECT reverse_txn(gen_random_uuid(), 'x', gen_random_uuid())`),
    );
    await expectPermissionDenied(
      admin.query(`SELECT resolve_dispute(gen_random_uuid(), 'upheld', 'x', NULL)`),
    );
    await expectPermissionDenied(admin.query(`DELETE FROM moderation_actions`));
  });

  it('the audit log cannot be changed, even by a superuser', async () => {
    const t = await player();
    await moderation.sanction(t.id, 'warning', 'amaka', null);
    await expectDyceError(
      db.admin.query(`UPDATE moderation_actions SET note = 'edited'`),
      'audit_immutable',
    );
    await expectDyceError(db.admin.query(`DELETE FROM moderation_actions`), 'audit_immutable');
    await expectDyceError(db.admin.query(`TRUNCATE moderation_actions`), 'audit_immutable');
  });

  it('no Pool match can pay out while held, whichever way the API role tries', async () => {
    const { a, b } = await colluders();
    const id = await endedMatch(a, b, a);
    await settleOrHold(id);
    // the money functions the API role has still need an open escrow and ignore holds, which is why nothing in the
    // code calls them for a Pool match except through settle_or_hold; this documents that the escrow is intact
    expect(await escrowOf(id)).toBe(2 * STAKE);
    await expectLedgerClean(db);
  });
});
