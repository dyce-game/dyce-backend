import type pg from 'pg';
import { DyceError, parseDbError } from '../common/dyce-error.ts';

/**
 * The moderation queue (SPEC section 13, ADR-039): read what needs a person, act on it, and leave an audit row.
 * Everything goes through the views and `SECURITY DEFINER` functions of migration 0025, which the `dyce_admin`
 * role (and only it) may use, so a moderator cannot do anything here that is not written to `moderation_actions`.
 * The pool passed in must connect as that role; the public API's pool cannot read or call any of this.
 */
export type ReportAction = 'review' | 'warn' | 'mute' | 'suspend' | 'dismiss';
export type SignalStatus = 'reviewing' | 'actioned' | 'dismissed';
export type HoldDecision = 'release' | 'void' | 'disqualify';
export type SanctionKind = 'warning' | 'mute' | 'suspension';
export type DisputeDecision = 'reviewing' | 'upheld' | 'reversed';

type Row = Record<string, unknown>;

const num = (v: unknown): number => Number(v);
const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : null);
/** A suspension with no end reads as 'forever' (Postgres 'infinity' comes back as Infinity). */
const until = (v: unknown): string | null => (v === Infinity ? 'forever' : iso(v));

export class ModerationService {
  constructor(private readonly pool: pg.Pool) {}

  // ---- reports ----------------------------------------------------------------------------------

  async reports(
    opts: {
      status?: 'open' | 'reviewing' | 'actioned' | 'dismissed' | 'pending';
      limit?: number;
    } = {},
  ) {
    const limit = clamp(opts.limit, 50);
    const params: unknown[] = [limit];
    let where = 'true';
    if (opts.status === 'pending') where = `status IN ('open', 'reviewing')`;
    else if (opts.status) {
      params.push(opts.status);
      where = `status = $2::report_status`;
    }
    const r = await this.pool.query<Row>(
      `SELECT id, status, reason, note, created_at, reviewed_by, reviewed_at, outcome, decision_note,
              reporter, target, target_user_id, other_reports_90d, prior_sanctions,
              CASE WHEN jsonb_typeof(evidence) = 'array' THEN jsonb_array_length(evidence) ELSE 0 END AS evidence_count
         FROM moderation_report_queue WHERE ${where} LIMIT $1`,
      params,
    );
    return r.rows.map((x) => ({
      id: x.id as string,
      status: x.status as string,
      reason: x.reason as string,
      note: (x.note as string | null) ?? null,
      createdAt: iso(x.created_at),
      reporter: (x.reporter as string | null) ?? null,
      target: (x.target as string | null) ?? null,
      targetUserId: (x.target_user_id as string | null) ?? null,
      otherReports90d: num(x.other_reports_90d),
      priorSanctions: num(x.prior_sanctions),
      evidenceCount: num(x.evidence_count),
      outcome: (x.outcome as string | null) ?? null,
      reviewedBy: (x.reviewed_by as string | null) ?? null,
    }));
  }

  /** One report with the conversation snapshot the reporter attached (what they saw, kept even if deleted). */
  async report(id: string) {
    const r = await this.pool.query<Row>(`SELECT * FROM moderation_report_queue WHERE id = $1`, [
      id,
    ]);
    const x = r.rows[0];
    if (!x) throw new DyceError('report_not_found');
    return {
      id: x.id as string,
      status: x.status as string,
      reason: x.reason as string,
      note: (x.note as string | null) ?? null,
      createdAt: iso(x.created_at),
      reporter: (x.reporter as string | null) ?? null,
      target: (x.target as string | null) ?? null,
      targetUserId: (x.target_user_id as string | null) ?? null,
      conversationId: (x.conversation_id as string | null) ?? null,
      messageId: (x.message_id as string | null) ?? null,
      evidence: x.evidence ?? null,
      otherReports90d: num(x.other_reports_90d),
      priorSanctions: num(x.prior_sanctions),
      outcome: (x.outcome as string | null) ?? null,
      decisionNote: (x.decision_note as string | null) ?? null,
    };
  }

  async actOnReport(
    id: string,
    action: ReportAction,
    admin: string,
    note: string | null,
    hours?: number,
  ): Promise<void> {
    await this.call(`SELECT moderation_act_on_report($1, $2, $3, $4, $5)`, [
      id,
      action,
      admin,
      note,
      hours ?? null,
    ]);
  }

  // ---- signals ----------------------------------------------------------------------------------

  async signals(
    opts: {
      flagged?: boolean;
      status?: 'open' | 'reviewing' | 'actioned' | 'dismissed';
      limit?: number;
    } = {},
  ) {
    const params: unknown[] = [clamp(opts.limit, 50)];
    const where: string[] = [];
    if (opts.flagged !== undefined) {
      params.push(opts.flagged);
      where.push(`flagged = $${params.length}`);
    }
    if (opts.status) {
      params.push(opts.status);
      where.push(`status = $${params.length}`);
    }
    const r = await this.pool.query<Row>(
      `SELECT * FROM moderation_signal_queue ${where.length ? `WHERE ${where.join(' AND ')}` : ''} LIMIT $1`,
      params,
    );
    return r.rows.map((x) => ({
      id: x.id as string,
      kind: x.kind as string,
      score: num(x.score),
      status: x.status as string,
      flagged: x.flagged as boolean,
      createdAt: iso(x.created_at),
      matchId: (x.match_id as string | null) ?? null,
      subject: (x.subject as string | null) ?? null,
      subjectUserId: (x.subject_user as string | null) ?? null,
      other: (x.other as string | null) ?? null,
      otherUserId: (x.other_user as string | null) ?? null,
      detail: x.detail,
    }));
  }

  async reviewSignal(
    id: string,
    status: SignalStatus,
    admin: string,
    note: string | null,
  ): Promise<void> {
    await this.call(`SELECT moderation_review_signal($1, $2, $3, $4)`, [id, status, admin, note]);
  }

  // ---- payout holds -----------------------------------------------------------------------------

  async holds(
    opts: { status?: 'held' | 'released' | 'voided' | 'disqualified'; limit?: number } = {},
  ) {
    const params: unknown[] = [clamp(opts.limit, 50)];
    let where = '';
    if (opts.status) {
      params.push(opts.status);
      where = `WHERE status = $2`;
    }
    const r = await this.pool.query<Row>(
      `SELECT * FROM moderation_hold_queue ${where} LIMIT $1`,
      params,
    );
    return r.rows.map((x) => ({
      id: x.id as string,
      matchId: x.match_id as string,
      gameSlug: x.game_slug as string,
      status: x.status as string,
      totalScore: num(x.total_score),
      potKobo: num(x.pot_kobo),
      moves: num(x.moves),
      createdAt: iso(x.created_at),
      lapsesAt: iso(x.lapses_at),
      decidedAt: iso(x.decided_at),
      decidedBy: (x.decided_by as string | null) ?? null,
      players: x.players,
      signals: x.signals,
    }));
  }

  /**
   * Decides a held payout. `release` pays the match as it was decided, `void` gives every stake back,
   * `disqualify` (with `userId`) places that player last and pays the rest. Idempotent for the same decision.
   */
  async resolveHold(
    id: string,
    decision: HoldDecision,
    admin: string,
    note: string | null,
    userId?: string,
  ): Promise<{ txnId: string | null; replayed: boolean }> {
    const r = await this.call<{ r: string }>(
      `SELECT resolve_integrity_hold($1, $2, $3, $4, $5)::text AS r`,
      [id, decision, admin, note, userId ?? null],
    );
    // the composite comes back as "(uuid,t)"
    const m = /^\((.*),([tf])\)$/.exec(r.rows[0]?.r ?? '');
    const txn = m?.[1]?.replaceAll('"', '') ?? '';
    return { txnId: txn === '' ? null : txn, replayed: m?.[2] === 't' };
  }

  // ---- disputes (the table is ADR-037's; the actions are audited here) --------------------------

  async disputes(opts: { limit?: number } = {}) {
    const r = await this.pool.query<Row>(`SELECT * FROM moderation_dispute_queue LIMIT $1`, [
      clamp(opts.limit, 50),
    ]);
    return r.rows.map((x) => ({
      id: x.id as string,
      reference: x.reference as string,
      status: x.status as string,
      reason: x.reason as string,
      note: (x.note as string | null) ?? null,
      matchId: x.match_id as string,
      gameSlug: x.game_slug as string,
      potKobo: num(x.pot_kobo),
      disputer: x.disputer as string,
      opponents: (x.opponents as string | null) ?? null,
      moves: num(x.moves),
      createdAt: iso(x.created_at),
    }));
  }

  async resolveDispute(
    id: string,
    status: DisputeDecision,
    admin: string,
    note: string | null,
    txnId?: string,
  ): Promise<void> {
    await this.call(`SELECT moderation_resolve_dispute($1, $2::dispute_status, $3, $4, $5)`, [
      id,
      status,
      note,
      admin,
      txnId ?? null,
    ]);
  }

  // ---- people -----------------------------------------------------------------------------------

  async user(id: string) {
    const r = await this.pool.query<Row>(`SELECT * FROM moderation_user_overview WHERE id = $1`, [
      id,
    ]);
    const x = r.rows[0];
    if (!x) throw new DyceError('user_not_found');
    return {
      id: x.id as string,
      username: x.username as string,
      displayName: x.display_name as string,
      createdAt: iso(x.created_at),
      deleted: x.disabled_at !== null,
      mutedUntil: until(x.muted_until),
      suspendedUntil: until(x.suspended_until),
      poolFrozen: x.pool_frozen as boolean,
      reportsAgainst: num(x.reports_against),
      reportsFiled: num(x.reports_filed),
      flaggedSignals: num(x.flagged_signals),
      poolMatches: num(x.pool_matches),
      sanctions: x.sanctions,
    };
  }

  async sanction(
    userId: string,
    kind: SanctionKind,
    admin: string,
    note: string | null,
    opts: { hours?: number; reportId?: string; signalId?: string } = {},
  ): Promise<string> {
    const r = await this.call<{ id: string }>(
      `SELECT moderation_sanction($1, $2, $3, $4, $5, $6, $7) AS id`,
      [userId, kind, admin, note, opts.hours ?? null, opts.reportId ?? null, opts.signalId ?? null],
    );
    return r.rows[0]!.id;
  }

  async lift(sanctionId: string, admin: string, note: string | null): Promise<void> {
    await this.call(`SELECT moderation_lift_sanction($1, $2, $3)`, [sanctionId, admin, note]);
  }

  async audit(opts: { limit?: number; targetUserId?: string } = {}) {
    const params: unknown[] = [clamp(opts.limit, 100)];
    let where = '';
    if (opts.targetUserId) {
      params.push(opts.targetUserId);
      where = `WHERE target_user = $2`;
    }
    const r = await this.pool.query<Row>(
      `SELECT * FROM moderation_audit ${where} LIMIT $1`,
      params,
    );
    return r.rows.map((x) => ({
      id: x.id as string,
      at: iso(x.created_at),
      admin: x.admin as string,
      action: x.action as string,
      target: (x.target as string | null) ?? null,
      reportId: (x.report_id as string | null) ?? null,
      signalId: (x.signal_id as string | null) ?? null,
      holdId: (x.hold_id as string | null) ?? null,
      disputeId: (x.dispute_id as string | null) ?? null,
      sanctionId: (x.sanction_id as string | null) ?? null,
      note: (x.note as string | null) ?? null,
      meta: x.meta,
    }));
  }

  /** Runs one admin function, turning its `dyce:<code>` errors into typed ones. */
  private async call<T extends Row = Row>(
    sql: string,
    params: unknown[],
  ): Promise<pg.QueryResult<T>> {
    try {
      return await this.pool.query<T>(sql, params);
    } catch (err) {
      throw parseDbError(err) ?? err;
    }
  }
}

function clamp(limit: number | undefined, fallback: number): number {
  return Math.min(Math.max(Math.trunc(limit ?? fallback), 1), 200);
}
