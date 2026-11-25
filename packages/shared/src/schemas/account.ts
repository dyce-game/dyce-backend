import { z } from 'zod';

/**
 * Edge flows (backend ADR-037): disputing a Pool result, deleting your account and downloading your data.
 * Pure schemas and types: no Node, DOM or React Native APIs.
 */

// ---- disputes (SPEC section 9) ----------------------------------------------------------------

/** What went wrong, in the order of the Dispute screen. */
export const DISPUTE_REASONS = ['cheat', 'glitch', 'score', 'disconnect', 'other'] as const;
export type DisputeReason = (typeof DISPUTE_REASONS)[number];
export const MAX_DISPUTE_NOTE_LENGTH = 500;

export const createDisputeSchema = z.object({
  reason: z.enum(DISPUTE_REASONS),
  note: z.string().trim().max(MAX_DISPUTE_NOTE_LENGTH).optional(),
});
export type CreateDisputeRequest = z.infer<typeof createDisputeSchema>;

/** open = waiting for a person; reviewing = a person picked it up; upheld = the result stands; reversed = corrected. */
export type DisputeStatus = 'open' | 'reviewing' | 'upheld' | 'reversed';

export type DisputeView = {
  id: string;
  /** What you quote to support, e.g. "DY-DSP-4F2K9A". */
  reference: string;
  matchId: string;
  status: DisputeStatus;
  reason: DisputeReason;
  note: string | null;
  createdAt: string;
  reviewingAt: string | null;
  resolvedAt: string | null;
  /** The moderator's note once it is decided. */
  decisionNote: string | null;
};

/** Where a result stands for disputing: your dispute if you made one, and whether you still can. */
export type MatchDisputeInfo = {
  dispute: DisputeView | null;
  /** A finished Pool match you played, inside the window, with no dispute from you yet. */
  canDispute: boolean;
  /** Why not, when `canDispute` is false and there is no dispute: 'not_pool' | 'window_closed' | 'not_finished'. */
  blockedBy: 'not_pool' | 'window_closed' | 'not_finished' | null;
  /** The last moment a dispute is accepted (finish time + the window). Null until the match has finished. */
  windowEndsAt: string | null;
};

// ---- account deletion (SPEC section 12) --------------------------------------------------------

/** You type your username to confirm; the server checks it against the account. */
export const deleteAccountSchema = z.object({ username: z.string().trim().min(1).max(40) });
export type DeleteAccountRequest = z.infer<typeof deleteAccountSchema>;

export type DeletionStatus = {
  /** A request is waiting out its grace period. Signing back in cancels it. */
  pending: boolean;
  requestedAt: string | null;
  /** When the account will be erased unless you sign in first. */
  executeAfter: string | null;
};

/** What deleting does, in the words of the confirm screen. `openGames` are cancelled and any Pool stake returned. */
export type DeletionPreview = {
  username: string;
  balanceKobo: number;
  openGames: number;
  graceDays: number;
};

// ---- data export --------------------------------------------------------------------------------

/** The file "Download my data" saves. Your own data only; never anyone else's phone number or hash. */
export type DataExport = {
  format: 'dyce-data-export';
  version: 1;
  generatedAt: string;
  profile: {
    username: string;
    displayName: string;
    level: number;
    xp: number;
    city: string | null;
    birthYear: number | null;
    createdAt: string;
    requestPolicy: string;
    showOnline: boolean;
  };
  wallet: { balanceKobo: number; transactions: DataExportTransaction[] };
  matches: DataExportMatch[];
  friends: string[];
  blocked: string[];
  reportsFiled: { reason: string; status: string; createdAt: string }[];
  disputes: { reference: string; reason: string; status: string; createdAt: string }[];
  badges: { slug: string; earnedAt: string }[];
  streak: { current: number; best: number } | null;
  messagesSent: { conversationId: string; kind: string; body: string | null; createdAt: string }[];
};

export type DataExportTransaction = {
  id: string;
  kind: string;
  amountKobo: number;
  createdAt: string;
};

export type DataExportMatch = {
  id: string;
  game: string;
  mode: string;
  status: string;
  stakeKobo: number;
  result: string | null;
  payoutKobo: number | null;
  opponents: string[];
  createdAt: string;
  finishedAt: string | null;
};
