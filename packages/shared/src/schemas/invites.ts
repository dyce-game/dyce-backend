import { z } from 'zod';
import type { AvatarConfig } from './avatar.ts';

/**
 * SMS invites and the guest web game (SPEC "Sending a game to a non-Dyce contact", docs/DECISIONS.md ADR-020).
 *
 * An invite is a row keyed by a random token; the invitee's number is only ever stored as a keyed hash. The
 * link in the text is `<base>/i/<token>#p=<digits>`: the fragment carries the number back to the invitee's own
 * browser so sign-up can be prefilled, and a fragment is never sent to a server.
 */

export const INVITE_STATUSES = ['sent', 'opened', 'played', 'joined'] as const;
export type InviteStatus = (typeof INVITE_STATUSES)[number];

/** `phone` is what the device has (E.164 or national format; `country` reads a national one). */
export const createInviteSchema = z.object({
  phone: z.string().trim().min(5).max(32),
  country: z
    .string()
    .length(2)
    .regex(/^[A-Za-z]{2}$/)
    .optional(),
  gameSlug: z.string().min(1).max(40),
});
export type CreateInviteRequest = z.infer<typeof createInviteSchema>;

export type CreatedInvite = {
  id: string;
  token: string;
  status: InviteStatus;
  gameSlug: string;
  /** The full link that was texted (with the prefill fragment), so the sender can also share it. */
  link: string;
  createdAt: string;
  expiresAt: string;
};

export type InviteSummary = {
  id: string;
  gameSlug: string;
  gameName: string;
  status: InviteStatus;
  createdAt: string;
  expiresAt: string;
  /** Set once the invitee has signed up. */
  joinedAs: { username: string; displayName: string } | null;
};
export type InvitesResponse = { invites: InviteSummary[] };

/** What the landing page may show to anyone holding the link. Never a phone number. */
export type InvitePublic = {
  /** `open` = can be played or answered; `expired` = past its date; `joined` = the invitee already signed up. */
  state: 'open' | 'expired' | 'joined';
  status: InviteStatus;
  inviter: { username: string; displayName: string; avatar: AvatarConfig | null };
  game: {
    slug: string;
    name: string;
    /** A round can be played in the browser with no account. */
    guestPlayable: boolean;
    /** Length of the guest round, for "80 second game". Null when not guest-playable. */
    roundSeconds: number | null;
  };
  /** The guest's own run, once there is one (the page can then skip straight to the end screen). */
  guest: { started: boolean; finished: boolean; score: number | null };
  expiresAt: string;
};

export const GUEST_RUN_STATES = ['idle', 'playing', 'done'] as const;
export type GuestRunState = (typeof GUEST_RUN_STATES)[number];

/** What the browser holds while it plays: the engine's `view` for the guest, and where the run stands. */
export type GuestSession = {
  /** Secret for this run. Sent as `Authorization: Bearer`. Only returned when the run is created. */
  guestToken?: string;
  runState: GuestRunState;
  expiresAt: string;
  /** Engine view for the guest (hides the grid until they start). Word Hunt: see WordHuntView in the app. */
  view: unknown;
  /** The player ids used inside `view`: the guest and the person who invited them. */
  guestId: string;
  hostId: string;
};

export const guestMoveSchema = z.object({ action: z.unknown() });
export type GuestMoveRequest = z.infer<typeof guestMoveSchema>;

export const claimInviteSchema = z.object({ token: z.string().min(8).max(64).optional() });
export type ClaimInviteRequest = z.infer<typeof claimInviteSchema>;

export type ClaimedInvite = {
  inviteId: string;
  inviter: { id: string; username: string; displayName: string; avatar: AvatarConfig | null };
  conversationId: string;
  matchId: string | null;
  gameSlug: string;
};
/** Newest first. Empty when nothing was waiting for this number. */
export type ClaimInviteResponse = { joined: ClaimedInvite[] };
