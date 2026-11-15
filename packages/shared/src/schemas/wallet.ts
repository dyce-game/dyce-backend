import { z } from 'zod';
import type { PublicUser } from './contacts.ts';
import { messageCursorSchema } from './messages.ts';

/** Longest note on a payment. */
export const MAX_NOTE_LENGTH = 140;

const noteSchema = z.string().trim().max(MAX_NOTE_LENGTH).default('');
/** Whole kobo, positive, comfortably inside the safe-integer range. */
const amountSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
/** Chosen by the app for every money action, so a retry (even after a lost response) can't pay twice. */
export const idempotencyKeySchema = z
  .string()
  .min(8)
  .max(80)
  .regex(/^[A-Za-z0-9_:.-]+$/, 'invalid key');

export const sendMoneySchema = z.object({
  toUserId: z.uuid(),
  amountKobo: amountSchema,
  note: noteSchema,
  idempotencyKey: idempotencyKeySchema,
});
export type SendMoneyRequest = z.infer<typeof sendMoneySchema>;

/**
 * Ask for money. `delivery: 'qr'` is shown in person (expires in 15 minutes); `'chat'` is sent to one friend
 * (7 days). Leave `amountKobo` out for "any amount".
 */
export const createPaymentRequestSchema = z.object({
  amountKobo: amountSchema.optional(),
  note: noteSchema,
  targetUserId: z.uuid().optional(),
  delivery: z.enum(['qr', 'chat']).default('qr'),
});
export type CreatePaymentRequestInput = z.infer<typeof createPaymentRequestSchema>;

export const payPaymentRequestSchema = z.object({
  /** Needed only for "any amount" requests; must match the amount otherwise. */
  amountKobo: amountSchema.optional(),
  idempotencyKey: idempotencyKeySchema,
});
export type PayPaymentRequestInput = z.infer<typeof payPaymentRequestSchema>;

/** A request code as printed in the QR link: 10 characters of base32, case-insensitive on input. */
export const requestCodeSchema = z
  .string()
  .trim()
  .transform((s) => s.toUpperCase())
  .pipe(z.string().regex(/^[A-Z2-7]{10}$/, 'invalid code'));

/** The History chips: Pools (stakes and winnings), Transfers (sends and request payments), Bonuses & refunds. */
export const HISTORY_FILTERS = ['all', 'pool', 'transfer', 'bonus'] as const;
export type HistoryFilter = (typeof HISTORY_FILTERS)[number];

export const historyQuerySchema = z.object({
  filter: z.enum(HISTORY_FILTERS).default('all'),
  before: messageCursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
});
export type HistoryQuery = z.infer<typeof historyQuerySchema>;

export type WalletSummary = {
  balanceKobo: number;
  /** Free daily top-up: available when the balance is under the threshold and today's is unclaimed. */
  topup: { available: boolean; amountKobo: number; thresholdKobo: number };
  limits: { perSendKobo: number; dailyKobo: number; sentTodayKobo: number };
  openRequests: number;
  /** The three small cards on the Wallet tab. Zero until games are played. */
  stats: {
    /** Pool winnings paid out in the last 7 days. */
    wonThisWeekKobo: number;
    /** Wins as a share of finished games (0-100), or null before the first game. */
    winRatePct: number | null;
    /** Wins in a row, counting back from the latest finished game. */
    winStreak: number;
  };
  /** Stakes held in Pools that haven't finished yet. */
  locked: { kobo: number; pools: number };
};

/** The last 7 Lagos days, oldest first: what moved each day, and any free top-up. */
export type WeeklyActivity = {
  days: { date: string; netKobo: number; topupKobo: number }[];
  /** Sum of the seven days' net. */
  netKobo: number;
};

export type MoneyParty = { id: string; username: string; displayName: string };

export type TxnKind =
  | 'grant'
  | 'topup'
  | 'transfer'
  | 'request_payment'
  | 'stake'
  | 'payout'
  | 'refund'
  | 'reversal'
  | 'adjust';

export type HistoryItem = {
  /** The ledger transaction id (also the receipt id). */
  id: string;
  kind: TxnKind;
  /** Signed: negative leaves your wallet. */
  amountKobo: number;
  createdAt: string;
  counterparty: MoneyParty | null;
  note: string;
  requestCode: string | null;
};
export type HistoryResponse = { items: HistoryItem[]; nextCursor: string | null };

export type Receipt = {
  id: string;
  kind: TxnKind;
  direction: 'in' | 'out';
  /** Always positive. */
  amountKobo: number;
  createdAt: string;
  from: MoneyParty | null;
  to: MoneyParty | null;
  /** Shown instead of a person for grants and top-ups ("Dyce welcome gift", "Daily top-up"). */
  systemLabel: string | null;
  note: string;
  requestCode: string | null;
};

export type PaymentRequestStatus = 'open' | 'paid' | 'expired' | 'cancelled';

/** What anyone with the code can see: always read from the server, never from the QR itself. */
export type PaymentRequestView = {
  code: string;
  status: PaymentRequestStatus;
  /** null = "any amount": the payer chooses. */
  amountKobo: number | null;
  note: string;
  createdAt: string;
  expiresAt: string;
  requester: PublicUser;
  /** True when you are the requester. */
  mine: boolean;
  /** True when the request was made for one specific person and that person is you. */
  forYou: boolean;
  /** Who paid (only the requester sees this). */
  paidBy: MoneyParty | null;
};
export type PaymentRequestsResponse = { requests: PaymentRequestView[] };

export type MoneyResult = { txnId: string; replayed: boolean; balanceKobo: number };
