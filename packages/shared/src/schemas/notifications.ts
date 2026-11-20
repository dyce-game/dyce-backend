import { z } from 'zod';
import { formatNaira } from '../format.ts';
import type { AvatarConfig } from './avatar.ts';

// ---- what a notification is (ADR-023) -------------------------------------------------------------------

export const NOTIFICATION_KINDS = [
  'friend_request',
  'friend_accepted',
  'game_invite',
  'game_accepted',
  'your_turn',
  'game_result',
  'pool_result',
  'pool_countered',
  'pool_refunded',
  'money_received',
  'money_requested',
  'space_starting',
  'level_up',
  'badge_earned',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** The switches in Settings. Each one turns a group of notifications on or off for push. */
export const PUSH_GROUPS = ['turns', 'invites', 'pool', 'money', 'spaces'] as const;
export type PushGroup = (typeof PUSH_GROUPS)[number];

export const PUSH_GROUP_LABELS: Record<PushGroup, { title: string; subtitle: string }> = {
  turns: { title: 'Your turn', subtitle: 'When a friend has played and it is your move' },
  invites: { title: 'Invites and requests', subtitle: 'Friend requests and game challenges' },
  pool: { title: 'Pool matches', subtitle: 'Counter-offers, results and refunds' },
  money: { title: 'Money', subtitle: 'Dyce Cash you receive or are asked for' },
  spaces: { title: 'Spaces', subtitle: 'When a space you joined is starting' },
};

/** Which switch governs a kind. `null` = never pushed (it only appears in the Notifications list). */
export const PUSH_GROUP_OF: Record<NotificationKind, PushGroup | null> = {
  friend_request: 'invites',
  friend_accepted: 'invites',
  game_invite: 'invites',
  game_accepted: 'invites',
  your_turn: 'turns',
  game_result: null,
  pool_result: 'pool',
  pool_countered: 'pool',
  pool_refunded: 'pool',
  money_received: 'money',
  money_requested: 'money',
  space_starting: 'spaces',
  level_up: null,
  badge_earned: null,
};

/** The list's filter chips (design: Activity). */
export const NOTIFICATION_FILTERS = ['all', 'turn', 'pool'] as const;
export const notificationFilterSchema = z.enum(NOTIFICATION_FILTERS);
export type NotificationFilter = z.infer<typeof notificationFilterSchema>;

export const notificationFilterKinds: Record<
  Exclude<NotificationFilter, 'all'>,
  NotificationKind[]
> = {
  turn: ['your_turn', 'game_accepted', 'game_invite', 'space_starting'],
  pool: ['pool_result', 'pool_countered', 'pool_refunded', 'money_received', 'money_requested'],
};

export type NotificationActor = {
  id: string;
  username: string;
  displayName: string;
  avatar: AvatarConfig | null;
};

export type NotificationItem = {
  id: string;
  kind: NotificationKind;
  actor: NotificationActor | null;
  /** Facts the text and the link are built from; see `describeNotification`. */
  payload: Record<string, unknown>;
  createdAt: string;
  read: boolean;
};

export type NotificationsResponse = {
  items: NotificationItem[];
  /** Pass as `before` for older ones; null at the end. */
  nextCursor: string | null;
  unread: number;
};

export const notificationsQuerySchema = z.object({
  filter: notificationFilterSchema.default('all'),
  before: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(30),
});
export type NotificationsQuery = z.output<typeof notificationsQuerySchema>;

export const markReadSchema = z.union([
  z.object({ all: z.literal(true) }).strict(),
  z.object({ ids: z.array(z.uuid()).min(1).max(100) }).strict(),
]);
export type MarkReadRequest = z.infer<typeof markReadSchema>;

export type UnreadCount = { unread: number };

// ---- preferences ------------------------------------------------------------------------------------------

const minuteOfDay = z.number().int().min(0).max(1439);

export type NotificationPrefs = {
  /** Every group is present; a person who never visited Settings has them all on. */
  groups: Record<PushGroup, boolean>;
  quietHours: { enabled: boolean; startMinute: number; endMinute: number };
  /** Minutes east of UTC on their phone when they last saved. */
  tzOffsetMin: number;
};

export const notificationPrefsUpdateSchema = z
  .object({
    groups: z
      .object(Object.fromEntries(PUSH_GROUPS.map((g) => [g, z.boolean().optional()])))
      .strict()
      .optional(),
    quietHours: z
      .object({ enabled: z.boolean(), startMinute: minuteOfDay, endMinute: minuteOfDay })
      .partial()
      .strict()
      .optional(),
    tzOffsetMin: z.number().int().min(-840).max(840).optional(),
  })
  .strict();
export type NotificationPrefsUpdate = z.infer<typeof notificationPrefsUpdateSchema>;

/** "22:00" style for a minute of the day. */
export function formatMinuteOfDay(minute: number): string {
  const h = Math.floor(minute / 60) % 24;
  const m = minute % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Whether `now` falls inside quiet hours on the person's own clock. The window may wrap past midnight
 * (22:00 to 07:00). Equal start and end means no window.
 */
export function inQuietHours(
  now: Date,
  q: { enabled: boolean; startMinute: number; endMinute: number },
  tzOffsetMin: number,
): boolean {
  if (!q.enabled || q.startMinute === q.endMinute) return false;
  const local = (((Math.floor(now.getTime() / 60_000) + tzOffsetMin) % 1440) + 1440) % 1440;
  return q.startMinute < q.endMinute
    ? local >= q.startMinute && local < q.endMinute
    : local >= q.startMinute || local < q.endMinute;
}

// ---- push tokens ------------------------------------------------------------------------------------------

export const PUSH_PLATFORMS = ['ios', 'android'] as const;

/** Expo push tokens look like ExponentPushToken[xxxx] (or ExpoPushToken[xxxx]). */
export const expoPushTokenSchema = z
  .string()
  .regex(/^Expo(nent)?PushToken\[[A-Za-z0-9_-]{8,64}\]$/, 'Not an Expo push token');

export const pushTokenSchema = z.object({
  token: expoPushTokenSchema,
  platform: z.enum(PUSH_PLATFORMS),
});
export type PushTokenRequest = z.infer<typeof pushTokenSchema>;

export const pushTokenRemoveSchema = z.object({ token: expoPushTokenSchema });

// ---- the words (shared by the list and by push, so they can never disagree) -------------------------------

export type NotificationText = {
  /** Push title and the list's bold part. */
  title: string;
  /** Push body and the list's text. */
  body: string;
  /** Where tapping it goes. */
  route: string;
  /** The button on the list row (design: Play, Open game, Join, Run it back). */
  cta: string | null;
};

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * The text and destination for a notification. Pure: the API uses it for push and the app for the list.
 * `who` is the other person's display name (or @username), when there is one.
 */
export function describeNotification(
  kind: NotificationKind,
  payload: Record<string, unknown>,
  who: string | null,
): NotificationText {
  const name = who ?? 'Someone';
  const game = str(payload.gameName) ?? 'a game';
  const matchId = str(payload.matchId);
  const matchRoute = matchId ? `/g/${matchId}` : '/chat';
  const stake = num(payload.stakeKobo);
  const isPool = payload.mode === 'pool' && stake !== null && stake > 0;
  const mode = isPool ? `Pool ${formatNaira(stake, { compact: true })}` : 'Free';

  switch (kind) {
    case 'friend_request':
      return {
        title: `${name} wants to be friends`,
        body: 'Tap to answer.',
        route: '/friends',
        cta: 'View',
      };
    case 'friend_accepted':
      return {
        title: `${name} accepted your request`,
        body: 'You are friends now. Send a game.',
        route: '/friends',
        cta: null,
      };
    case 'game_invite':
      return {
        title: isPool
          ? `${name} challenged you for ${formatNaira(stake, { compact: true })}`
          : `${name} challenged you`,
        body: `${game} · ${mode}`,
        route: matchRoute,
        cta: 'Open game',
      };
    case 'game_accepted': {
      const first = payload.yourTurn === true;
      return {
        title: isPool
          ? `${name} matched ${formatNaira(stake, { compact: true })}`
          : `${name} accepted your challenge`,
        body: first ? `${game}. Your move.` : `${game}. They go first.`,
        route: matchRoute,
        cta: first ? 'Play' : 'Open game',
      };
    }
    case 'your_turn':
      return {
        title: 'Your move',
        body: `${name} played in ${game}. ${mode}.`,
        route: matchRoute,
        cta: 'Play',
      };
    case 'pool_countered': {
      const counter = num(payload.counterStakeKobo);
      return {
        title: 'Counter-offer',
        body:
          counter === 0
            ? `${name} wants to play ${game} free instead.`
            : `${name} wants ${counter === null ? 'a different stake' : formatNaira(counter, { compact: true })} each instead of ${formatNaira(stake ?? 0, { compact: true })}.`,
        route: matchRoute,
        cta: 'Review',
      };
    }
    case 'pool_refunded': {
      const amount = num(payload.amountKobo) ?? 0;
      const reason =
        payload.reason === 'expired' ? `${name} did not answer in time.` : `${name} declined.`;
      return {
        title: `Refund · ${formatNaira(amount, { compact: true })}`,
        body: `${reason} It is back in your wallet.`,
        route: '/wallet/history',
        cta: null,
      };
    }
    case 'game_result':
    case 'pool_result': {
      const result = str(payload.result);
      const placement = num(payload.placement);
      const payout = num(payload.payoutKobo) ?? 0;
      const staked = num(payload.stakeKobo) ?? 0;
      const xp = num(payload.xp);
      const xpText = xp && xp > 0 ? ` +${xp} XP` : '';
      const route = str(payload.spaceId)
        ? `/space/${str(payload.spaceId)}/result`
        : matchId
          ? `/g/${matchId}/result`
          : '/chat';
      if (kind === 'pool_result') {
        if (result === 'win')
          return {
            title: `You won ${formatNaira(payout, { compact: true })}`,
            body: `${game}${who ? ` against ${who}` : ''}. It is in your wallet.`,
            route,
            cta: 'Run it back',
          };
        if (result === 'draw')
          return {
            title: 'It was a draw',
            body: `${game}. Your ${formatNaira(staked, { compact: true })} came back.`,
            route,
            cta: null,
          };
        return {
          title: payout > 0 ? `You placed in ${game}` : `${name} won the pot`,
          body:
            payout > 0
              ? `You got ${formatNaira(payout, { compact: true })} back.`
              : `${game} · you lost ${formatNaira(staked, { compact: true })}.`,
          route,
          cta: 'Run it back',
        };
      }
      const outcome =
        result === 'win'
          ? 'You won'
          : result === 'draw'
            ? 'It was a draw'
            : placement && placement > 1 && !who
              ? `You came ${placement}${placement === 2 ? 'nd' : placement === 3 ? 'rd' : 'th'}`
              : 'You lost';
      return {
        title: `${outcome} · ${game}`,
        body: `Free game.${xpText}`.trim(),
        route,
        cta: 'Play again',
      };
    }
    case 'money_received': {
      const amount = num(payload.amountKobo) ?? 0;
      return {
        title: `${name} sent you ${formatNaira(amount, { compact: true })}`,
        body: payload.viaRequest === true ? 'They paid your request.' : 'It is in your wallet.',
        route: '/wallet/history',
        cta: null,
      };
    }
    case 'money_requested': {
      const amount = num(payload.amountKobo);
      const code = str(payload.code);
      return {
        title: amount
          ? `${name} asked for ${formatNaira(amount, { compact: true })}`
          : `${name} asked for money`,
        body: 'Pay it from your Dyce Cash.',
        route: code ? `/wallet/pay/${code}` : '/wallet',
        cta: 'Pay',
      };
    }
    case 'space_starting': {
      const spaceId = str(payload.spaceId);
      const fee = num(payload.seatFeeKobo);
      return {
        title: 'Space is starting',
        body: `${str(payload.name) ?? game} · ${game}${fee ? ` · ${formatNaira(fee, { compact: true })} a seat` : ''}`,
        route: spaceId ? `/space/${spaceId}` : '/spaces',
        cta: 'Join',
      };
    }
    case 'level_up': {
      const level = num(payload.level);
      return {
        title: level ? `Level ${level}` : 'Level up',
        body: 'You reached a new level.',
        route: '/profile',
        cta: null,
      };
    }
    case 'badge_earned':
      return {
        title: `Badge earned · ${str(payload.badgeName) ?? 'New badge'}`,
        body: 'See it on your profile.',
        route: '/profile/badges',
        cta: null,
      };
  }
}
