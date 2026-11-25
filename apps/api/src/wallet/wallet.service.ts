import type pg from 'pg';
import {
  formatNaira,
  parseAvatar,
  type CreatePaymentRequestInput,
  type HistoryItem,
  type HistoryQuery,
  type HistoryResponse,
  type MoneyParty,
  type MoneyResult,
  type PayPaymentRequestInput,
  type PaymentRequestView,
  type PaymentRequestsResponse,
  type Receipt,
  type Relationship,
  type SendMoneyRequest,
  type TxnKind,
  type WalletSummary,
  type WeeklyActivity,
} from '@dyce/shared';
import { AuthError } from '../auth/auth-error.ts';
import type { Clock } from '../auth/tokens.ts';
import type { MessagesService } from '../chat/messages.service.ts';
import { DyceError } from '../common/dyce-error.ts';
import { lagosDayStart, readConfigInt, secondsUntilLagosMidnight } from '../db/config.ts';
import { withTx } from '../db/tx.ts';
import { assertNotRestricted } from '../integrity/restrictions.ts';
import type { LedgerRepo } from '../ledger/ledger.repo.ts';
import { FRIENDSHIP_JOIN, NOT_BLOCKED, RELATIONSHIP_EXPR } from '../social/relationship.ts';

/** The parts of messaging the wallet uses to put money cards in chats. */
export type CardPoster = Pick<MessagesService, 'openDirect' | 'postCard' | 'updateCardPayload'>;

const QR_TTL_MINUTES = 15;
const CHAT_TTL_MINUTES = 7 * 24 * 60;

const FILTER_SQL: Record<HistoryQuery['filter'], string> = {
  all: 'TRUE',
  pool: `t.kind IN ('stake', 'payout')`,
  transfer: `t.kind IN ('transfer', 'request_payment')`,
  bonus: `t.kind IN ('grant', 'topup', 'refund', 'reversal', 'adjust')`,
};

const SYSTEM_LABELS: Partial<Record<TxnKind, string>> = {
  grant: 'Dyce welcome gift',
  topup: 'Daily top-up',
  stake: 'Pool stake',
  payout: 'Pool payout',
  refund: 'Pool refund',
  reversal: 'Reversal',
  adjust: 'Adjustment',
};

type SummaryExtras = Pick<WalletSummary, 'stats' | 'locked'>;

type Meta = {
  from_user?: string;
  to_user?: string;
  note?: string;
  code?: string;
  amount_kobo?: number;
};

/** The Lagos calendar day ("2026-11-15"): Lagos is UTC+1 all year. */
const lagosDate = (now: Date) => new Date(now.getTime() + 3_600_000).toISOString().slice(0, 10);

/**
 * Dyce Cash: balance, send, request with a code, pay a code, history and receipts. Every movement is a
 * ledger function in PostgreSQL (limits, blocks, balances and idempotency are enforced there); this layer
 * adds who may pay whom, scopes idempotency keys to the caller, shapes the responses, and posts the cards
 * that appear in chats. Dyce Cash is virtual: nothing here buys, withdraws or exchanges it.
 */
export class WalletService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly ledger: LedgerRepo,
    private readonly chat: CardPoster,
    private readonly clock: Clock = () => new Date(),
    private readonly log: { warn(message: string): void } = { warn: () => undefined },
  ) {}

  // ---- balance and limits -----------------------------------------------------------------------

  async summary(userId: string): Promise<WalletSummary> {
    const now = this.clock();
    const wallet = await this.pool.query<{ balance_kobo: string }>(
      `SELECT balance_kobo FROM wallets WHERE user_id = $1`,
      [userId],
    );
    if (!wallet.rows[0]) throw new DyceError('no_wallet');
    const balance = Number(wallet.rows[0].balance_kobo);

    const [perSend, daily, threshold, topupAmount] = await Promise.all([
      readConfigInt(this.pool, 'send_limit_kobo', 5_000_000),
      readConfigInt(this.pool, 'send_daily_limit_kobo', 20_000_000),
      readConfigInt(this.pool, 'topup_threshold_kobo', 1_000_000),
      readConfigInt(this.pool, 'topup_amount_kobo', 2_000_000),
    ]);
    const today = lagosDate(now);
    const [used, claimed, open] = await Promise.all([
      this.pool.query<{ sent: string }>(
        `SELECT coalesce(sum(sent_kobo), 0) AS sent FROM daily_usage WHERE user_id = $1 AND day = $2::date`,
        [userId, today],
      ),
      this.pool.query(`SELECT 1 FROM ledger_txns WHERE idempotency_key = $1`, [
        `topup:${userId}:${today}`,
      ]),
      this.pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM payment_requests
          WHERE requester = $1 AND status = 'open' AND expires_at > $2`,
        [userId, now],
      ),
    ]);
    return {
      balanceKobo: balance,
      topup: {
        available: balance < threshold && claimed.rows.length === 0,
        amountKobo: topupAmount,
        thresholdKobo: threshold,
      },
      limits: {
        perSendKobo: perSend,
        dailyKobo: daily,
        sentTodayKobo: Number(used.rows[0]?.sent ?? 0),
      },
      openRequests: Number(open.rows[0]?.n ?? 0),
      ...(await this.extras(userId, now)),
    };
  }

  /** Win stats and stakes held in unfinished Pools. All zero until games are played. */
  private async extras(userId: string, now: Date): Promise<SummaryExtras> {
    const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
    const [won, results, locked] = await Promise.all([
      this.pool.query<{ total: string }>(
        `SELECT coalesce(sum(e.amount_kobo), 0) AS total
           FROM ledger_entries e
           JOIN ledger_txns t ON t.id = e.txn_id
           JOIN wallets w ON w.account_id = e.account_id AND w.user_id = $1
          WHERE t.kind = 'payout' AND t.created_at >= $2`,
        [userId, weekAgo],
      ),
      this.pool.query<{ result: string }>(
        `SELECT mp.result::text AS result
           FROM match_players mp JOIN matches m ON m.id = mp.match_id
          WHERE mp.user_id = $1 AND m.status = 'finished' AND mp.result IS NOT NULL
          ORDER BY m.finished_at DESC NULLS LAST, m.created_at DESC
          LIMIT 200`,
        [userId],
      ),
      this.pool.query<{ kobo: string; pools: string }>(
        `SELECT coalesce(sum(mp.staked_kobo), 0) AS kobo, count(*) AS pools
           FROM match_players mp JOIN matches m ON m.id = mp.match_id
          WHERE mp.user_id = $1 AND m.mode = 'pool' AND mp.staked_kobo > 0
            AND m.status IN ('invited', 'countered', 'active')`,
        [userId],
      ),
    ]);
    const list = results.rows.map((r) => r.result);
    const wins = list.filter((r) => r === 'win').length;
    let streak = 0;
    for (const r of list) {
      if (r !== 'win') break;
      streak++;
    }
    return {
      stats: {
        wonThisWeekKobo: Math.max(0, Number(won.rows[0]?.total ?? 0)),
        winRatePct: list.length === 0 ? null : Math.round((wins / list.length) * 100),
        winStreak: streak,
      },
      locked: {
        kobo: Number(locked.rows[0]?.kobo ?? 0),
        pools: Number(locked.rows[0]?.pools ?? 0),
      },
    };
  }

  /** What moved each of the last 7 Lagos days (the bars on History and the week grid on Top-up). */
  async weekly(userId: string): Promise<WeeklyActivity> {
    const now = this.clock();
    const r = await this.pool.query<{ day: string; net: string; topup: string }>(
      `SELECT to_char(t.created_at AT TIME ZONE 'Africa/Lagos', 'YYYY-MM-DD') AS day,
              sum(e.amount_kobo) AS net,
              coalesce(sum(e.amount_kobo) FILTER (WHERE t.kind = 'topup'), 0) AS topup
         FROM ledger_entries e
         JOIN ledger_txns t ON t.id = e.txn_id
         JOIN wallets w ON w.account_id = e.account_id AND w.user_id = $1
        WHERE (t.created_at AT TIME ZONE 'Africa/Lagos')::date >= $2::date
          AND t.kind <> 'grant'
        GROUP BY 1`,
      [userId, lagosDate(new Date(now.getTime() - 6 * 86_400_000))],
    );
    const byDay = new Map(r.rows.map((row) => [row.day, row]));
    const days = Array.from({ length: 7 }, (_, i) => {
      const date = lagosDate(new Date(now.getTime() - (6 - i) * 86_400_000));
      const row = byDay.get(date);
      return { date, netKobo: Number(row?.net ?? 0), topupKobo: Number(row?.topup ?? 0) };
    });
    return { days, netKobo: days.reduce((n, d) => n + d.netKobo, 0) };
  }

  /** The free daily top-up (balance under the threshold, once per Lagos day). */
  async claimTopup(userId: string): Promise<MoneyResult> {
    const r = await this.ledger.claimDailyTopup(userId);
    return this.result(userId, r.txnId, r.replayed);
  }

  // ---- send -------------------------------------------------------------------------------------

  /**
   * Friend-to-friend send. Only people you can already talk to: friends, contacts, or someone whose chat
   * you've both accepted. (Strangers get paid by scanning their request code instead.)
   */
  async send(userId: string, input: SendMoneyRequest): Promise<MoneyResult> {
    if (input.toUserId === userId) throw new DyceError('self_payment');
    await this.assertCanPay(userId, input.toUserId);

    const r = await this.ledger.transfer(
      userId,
      input.toUserId,
      input.amountKobo,
      input.note,
      `send:${userId}:${input.idempotencyKey}`, // scoped to the caller: nobody can replay someone else's key
    );
    // Even on a replay: if the first attempt died after the money moved, this puts the card back (idempotent).
    await this.cardForTransfer(userId, input.toUserId, r.txnId!, input.amountKobo, input.note);
    return this.result(userId, r.txnId, r.replayed);
  }

  // ---- requests ---------------------------------------------------------------------------------

  async createRequest(
    userId: string,
    input: CreatePaymentRequestInput,
  ): Promise<PaymentRequestView> {
    await assertNotRestricted(this.pool, userId);
    await this.assertUnderRequestLimit(userId);
    if (input.targetUserId) await this.assertCanPay(userId, input.targetUserId);
    const inChat = input.delivery === 'chat' || Boolean(input.targetUserId);
    const req = await this.ledger.createPaymentRequest(
      userId,
      input.amountKobo ?? null,
      input.note,
      input.targetUserId ?? null,
      inChat ? CHAT_TTL_MINUTES : QR_TTL_MINUTES,
    );

    if (input.targetUserId) {
      try {
        const conv = await this.chat.openDirect(userId, input.targetUserId);
        await this.chat.postCard(conv.id, userId, {
          id: req.id,
          kind: 'money_request',
          body:
            req.amountKobo === null
              ? 'Requested money'
              : `Requested ${formatNaira(req.amountKobo)}`,
          payload: {
            amountKobo: req.amountKobo,
            note: req.note,
            code: req.code,
            status: 'open',
            expiresAt: req.expiresAt.toISOString(),
          },
        });
      } catch (err) {
        this.log.warn(`request card not posted: ${err instanceof Error ? err.message : 'error'}`);
      }
    }
    return this.getRequest(userId, req.code);
  }

  /**
   * What the Pay sheet shows. Always read from the server: the QR holds only the code, never an amount or a
   * name. Someone who blocked you (or whom you blocked) looks like a missing code.
   */
  async getRequest(userId: string, rawCode: string): Promise<PaymentRequestView> {
    const rows = await this.requestRows(userId, { code: rawCode });
    if (!rows[0]) throw new DyceError('request_not_found');
    if (!rows[0].mine) await this.capStrangerScan(userId, rows[0].requester.id, rows[0].code);
    return rows[0];
  }

  /** Requests you made, newest first. */
  async myRequests(userId: string): Promise<PaymentRequestsResponse> {
    return { requests: await this.requestRows(userId, { mineOnly: true }) };
  }

  async cancelRequest(userId: string, code: string): Promise<void> {
    const before = await this.pool.query<{ id: string }>(
      `SELECT id FROM payment_requests WHERE code = $1 AND requester = $2`,
      [code, userId],
    );
    await this.ledger.cancelPaymentRequest(code, userId);
    if (before.rows[0])
      await this.chat.updateCardPayload(before.rows[0].id, { status: 'cancelled' });
  }

  /**
   * Pay a request (the "scan" half). Works for strangers too: the requester shared the code on purpose, and the
   * chat that results lands in the requester's Requests, not their Chat.
   */
  async payRequest(
    userId: string,
    code: string,
    input: PayPaymentRequestInput,
  ): Promise<MoneyResult> {
    const req = await this.pool.query<{ id: string; requester: string; note: string }>(
      `SELECT id, requester, note FROM payment_requests WHERE code = $1`,
      [code],
    );
    if (!req.rows[0]) throw new DyceError('request_not_found');
    const { id, requester, note } = req.rows[0];
    // paying a code without opening it first does not get round the daily cap on strangers' codes
    if (requester !== userId) await this.capStrangerScan(userId, requester, code);

    const r = await this.ledger.payPaymentRequest(
      code,
      userId,
      input.amountKobo ?? null,
      `pay:${userId}:${input.idempotencyKey}`,
    );
    const amount = await this.txnAmount(r.txnId!);
    await this.chat.updateCardPayload(id, { status: 'paid' }).catch(() => undefined);
    await this.cardForTransfer(userId, requester, r.txnId!, amount, note, true);
    return this.result(userId, r.txnId, r.replayed);
  }

  // ---- history and receipts ---------------------------------------------------------------------

  async history(userId: string, query: HistoryQuery): Promise<HistoryResponse> {
    const limit = Math.min(Math.max(query.limit, 1), 50);
    const params: unknown[] = [userId, limit + 1];
    let cursor = '';
    if (query.before) {
      const [ts, id] = query.before.split('|') as [string, string];
      params.push(ts, id);
      cursor = `AND (t.created_at, t.id) < ($3::timestamptz, $4::uuid)`;
    }
    const r = await this.pool.query<{
      id: string;
      kind: TxnKind;
      amount_kobo: string;
      created_at: Date;
      cursor_ts: string;
      meta: Meta;
    }>(
      `SELECT t.id, t.kind, e.amount_kobo, t.created_at, t.meta,
              to_char(t.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_ts
         FROM ledger_entries e
         JOIN ledger_txns t ON t.id = e.txn_id
         JOIN wallets w ON w.account_id = e.account_id AND w.user_id = $1
        WHERE ${FILTER_SQL[query.filter]} ${cursor}
        ORDER BY t.created_at DESC, t.id DESC
        LIMIT $2`,
      params,
    );
    const page = r.rows.slice(0, limit);
    const people = await this.parties(
      page.flatMap((row) => [row.meta.from_user, row.meta.to_user]).filter((x): x is string => !!x),
    );
    const items: HistoryItem[] = page.map((row) => {
      const other = row.meta.from_user === userId ? row.meta.to_user : row.meta.from_user;
      return {
        id: row.id,
        kind: row.kind,
        amountKobo: Number(row.amount_kobo),
        createdAt: row.created_at.toISOString(),
        counterparty: other && other !== userId ? (people.get(other) ?? null) : null,
        note: row.meta.note ?? '',
        requestCode: row.meta.code ?? null,
      };
    });
    const last = r.rows[limit - 1];
    return {
      items,
      nextCursor: r.rows.length > limit && last ? `${last.cursor_ts}|${last.id}` : null,
    };
  }

  /** A receipt, only for someone whose wallet the transaction touched. */
  async receipt(userId: string, txnId: string): Promise<Receipt> {
    const r = await this.pool.query<{
      id: string;
      kind: TxnKind;
      created_at: Date;
      meta: Meta;
      mine: string;
    }>(
      `SELECT t.id, t.kind, t.created_at, t.meta, e.amount_kobo AS mine
         FROM ledger_txns t
         JOIN ledger_entries e ON e.txn_id = t.id
         JOIN wallets w ON w.account_id = e.account_id AND w.user_id = $1
        WHERE t.id = $2
        LIMIT 1`,
      [userId, txnId],
    );
    const row = r.rows[0];
    if (!row) throw new AuthError('transaction_not_found');
    const people = await this.parties(
      [row.meta.from_user, row.meta.to_user].filter((x): x is string => !!x),
    );
    const mine = Number(row.mine);
    return {
      id: row.id,
      kind: row.kind,
      direction: mine < 0 ? 'out' : 'in',
      amountKobo: Math.abs(mine),
      createdAt: row.created_at.toISOString(),
      from: row.meta.from_user ? (people.get(row.meta.from_user) ?? null) : null,
      to: row.meta.to_user ? (people.get(row.meta.to_user) ?? null) : null,
      systemLabel:
        row.meta.from_user && row.meta.to_user ? null : (SYSTEM_LABELS[row.kind] ?? null),
      note: row.meta.note ?? '',
      requestCode: row.meta.code ?? null,
    };
  }

  // ---- internals --------------------------------------------------------------------------------

  /** SPEC section 13: a limit on money requests a day (`money_requests_per_day`, by the Lagos calendar). */
  private async assertUnderRequestLimit(userId: string): Promise<void> {
    const now = this.clock();
    const perDay = await readConfigInt(this.pool, 'money_requests_per_day', 30);
    const made = await this.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM payment_requests WHERE requester = $1 AND created_at >= $2`,
      [userId, lagosDayStart(now)],
    );
    if ((made.rows[0]?.n ?? 0) >= perDay) {
      throw new AuthError('money_requests_rate_limited', {
        retryAfterSeconds: secondsUntilLagosMidnight(now),
      });
    }
  }

  /**
   * WALLET_AND_QR section 4: at most `stranger_scans_per_day` different codes a day from people who are not your
   * friends or contacts (a code someone shared on purpose is a way to be sent a stranger, so it is counted). The
   * same code again is free; a friend's or contact's code is never counted.
   */
  private async capStrangerScan(userId: string, requesterId: string, code: string): Promise<void> {
    const known = await this.pool.query<{ ok: boolean }>(
      `SELECT (EXISTS (SELECT 1 FROM friendships f
                        WHERE f.user_low = LEAST($1::uuid, $2::uuid) AND f.user_high = GREATEST($1::uuid, $2::uuid)
                          AND f.status = 'accepted')
               OR EXISTS (SELECT 1 FROM contact_links
                           WHERE (owner_id = $1 AND contact_user_id = $2) OR (owner_id = $2 AND contact_user_id = $1))
              ) AS ok`,
      [userId, requesterId],
    );
    if (known.rows[0]?.ok) return;
    const now = this.clock();
    const limit = await readConfigInt(this.pool, 'stranger_scans_per_day', 20);
    const day = lagosDate(now);
    const wanted = code.trim().toUpperCase();
    // one person's checks are serialised, so two codes opened at once cannot both slip under the limit
    await withTx(this.pool, async (c) => {
      await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`scan:${userId}`]);
      const seen = await c.query(
        `SELECT 1 FROM stranger_scans WHERE user_id = $1 AND day = $2::date AND code = $3`,
        [userId, day, wanted],
      );
      if (seen.rows.length > 0) return; // a code you already opened today stays open
      const used = await c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM stranger_scans WHERE user_id = $1 AND day = $2::date`,
        [userId, day],
      );
      if ((used.rows[0]?.n ?? 0) >= limit) {
        throw new AuthError('stranger_scans_rate_limited', {
          retryAfterSeconds: secondsUntilLagosMidnight(now),
        });
      }
      await c.query(`INSERT INTO stranger_scans (user_id, day, code) VALUES ($1, $2::date, $3)`, [
        userId,
        day,
        wanted,
      ]);
    });
  }

  /** Friends, contacts, or people whose chat both sides have accepted. */
  private async assertCanPay(userId: string, otherId: string): Promise<void> {
    const r = await this.pool.query<{ exists: boolean; ok: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM users u JOIN profiles p ON p.id = u.id
                       WHERE u.id = $2 AND u.disabled_at IS NULL) AS exists,
              (EXISTS (SELECT 1 FROM friendships f
                        WHERE f.user_low = LEAST($1::uuid, $2::uuid) AND f.user_high = GREATEST($1::uuid, $2::uuid)
                          AND f.status = 'accepted')
               OR EXISTS (SELECT 1 FROM contact_links
                           WHERE (owner_id = $1 AND contact_user_id = $2) OR (owner_id = $2 AND contact_user_id = $1))
               OR EXISTS (SELECT 1 FROM conversation_members a
                            JOIN conversation_members b ON b.conversation_id = a.conversation_id
                            JOIN conversations c ON c.id = a.conversation_id
                           WHERE a.user_id = $1 AND b.user_id = $2
                             AND a.state = 'active' AND b.state = 'active' AND c.last_message_at IS NOT NULL)
              ) AS ok`,
      [userId, otherId],
    );
    if (!r.rows[0]?.exists) throw new AuthError('user_not_found');
    if (!r.rows[0].ok) throw new AuthError('recipient_not_reachable');
  }

  private async txnAmount(txnId: string): Promise<number> {
    const r = await this.pool.query<{ amount: string }>(
      `SELECT meta ->> 'amount_kobo' AS amount FROM ledger_txns WHERE id = $1`,
      [txnId],
    );
    return Number(r.rows[0]?.amount ?? 0);
  }

  /** "Sent Ð5,000" (or "Paid Ð2,000 · suya") in the chat between the two people. Never fails the payment. */
  private async cardForTransfer(
    from: string,
    to: string,
    txnId: string,
    amountKobo: number,
    note: string,
    paid = false,
  ): Promise<void> {
    try {
      const conv = await this.chat.openDirect(from, to);
      await this.chat.postCard(conv.id, from, {
        id: txnId,
        kind: 'money_sent',
        body: `${paid ? 'Paid' : 'Sent'} ${formatNaira(amountKobo)}${note ? ` · ${note}` : ''}`,
        payload: { amountKobo, note, txnId },
      });
    } catch (err) {
      this.log.warn(`money card not posted: ${err instanceof Error ? err.message : 'error'}`);
    }
  }

  private async result(
    userId: string,
    txnId: string | null,
    replayed: boolean,
  ): Promise<MoneyResult> {
    const w = await this.pool.query<{ balance_kobo: string }>(
      `SELECT balance_kobo FROM wallets WHERE user_id = $1`,
      [userId],
    );
    return { txnId: txnId!, replayed, balanceKobo: Number(w.rows[0]?.balance_kobo ?? 0) };
  }

  private async parties(ids: string[]): Promise<Map<string, MoneyParty>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const r = await this.pool.query<{
      id: string;
      username: string;
      display_name: string;
      avatar: unknown;
    }>(`SELECT id, username, display_name, avatar FROM profiles WHERE id = ANY($1::uuid[])`, [
      unique,
    ]);
    return new Map(
      r.rows.map((p) => [
        p.id,
        {
          id: p.id,
          username: p.username,
          displayName: p.display_name,
          avatar: parseAvatar(p.avatar),
        },
      ]),
    );
  }

  private async requestRows(
    userId: string,
    opts: { code?: string; mineOnly?: boolean },
  ): Promise<PaymentRequestView[]> {
    const params: unknown[] = [userId];
    let where = `${NOT_BLOCKED}`;
    if (opts.code) {
      params.push(opts.code.trim().toUpperCase());
      where += ` AND pr.code = $${params.length}`;
    }
    if (opts.mineOnly) where += ` AND pr.requester = $1::uuid`;

    const r = await this.pool.query<{
      code: string;
      status: PaymentRequestView['status'];
      amount_kobo: string | null;
      note: string;
      created_at: Date;
      expires_at: Date;
      target_user: string | null;
      paid_by: string | null;
      requester: string;
      username: string;
      display_name: string;
      avatar: unknown;
      relationship: Relationship;
    }>(
      `SELECT pr.code, pr.status, pr.amount_kobo, pr.note, pr.created_at, pr.expires_at,
              pr.target_user, pr.paid_by, u.id AS requester, p.username, p.display_name, p.avatar,
              ${RELATIONSHIP_EXPR} AS relationship
         FROM payment_requests pr
         JOIN users u ON u.id = pr.requester
         JOIN profiles p ON p.id = u.id
         ${FRIENDSHIP_JOIN}
        WHERE ${where}
        ORDER BY pr.created_at DESC
        LIMIT 50`,
      params,
    );
    const now = this.clock();
    const payers = await this.parties(r.rows.flatMap((row) => (row.paid_by ? [row.paid_by] : [])));
    return r.rows.map((row) => {
      const mine = row.requester === userId;
      return {
        code: row.code,
        // an open request past its time is expired, whether or not the nightly job has marked it yet
        status: row.status === 'open' && row.expires_at <= now ? 'expired' : row.status,
        amountKobo: row.amount_kobo === null ? null : Number(row.amount_kobo),
        note: row.note,
        createdAt: row.created_at.toISOString(),
        expiresAt: row.expires_at.toISOString(),
        requester: {
          id: row.requester,
          username: row.username,
          displayName: row.display_name,
          avatar: parseAvatar(row.avatar),
          relationship: mine ? 'none' : row.relationship,
        },
        mine,
        forYou: row.target_user === userId,
        paidBy: mine && row.paid_by ? (payers.get(row.paid_by) ?? null) : null,
      };
    });
  }
}
