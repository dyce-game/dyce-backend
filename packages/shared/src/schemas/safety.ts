import { z } from 'zod';
import type { MoneyParty } from './wallet.ts';

/** The reasons on the Report screen (design: Report). */
export const REPORT_REASONS = ['cheat', 'abuse', 'scam', 'spam', 'name', 'other'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export const MAX_REPORT_NOTE_LENGTH = 500;

export const blockSchema = z.object({ userId: z.uuid() });
export type BlockRequest = z.infer<typeof blockSchema>;

export const reportSchema = z.object({
  userId: z.uuid(),
  reason: z.enum(REPORT_REASONS),
  note: z.string().trim().max(MAX_REPORT_NOTE_LENGTH).optional(),
  /** Attach the recent messages of this conversation (it must be your chat with the person you report). */
  conversationId: z.uuid().optional(),
  /** The specific message you are reporting (it must be in `conversationId`). */
  messageId: z.uuid().optional(),
  /** Also block them, in the same step. */
  alsoBlock: z.boolean().default(false),
});
export type ReportRequest = z.infer<typeof reportSchema>;

export type BlockedUser = { user: MoneyParty; blockedAt: string };
export type BlocksResponse = { blocked: BlockedUser[] };

export type ReportResult = {
  reportId: string;
  /** True when the person is blocked now (you asked to, or you already had). */
  blocked: boolean;
};
