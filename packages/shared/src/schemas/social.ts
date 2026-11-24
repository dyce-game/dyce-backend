import { z } from 'zod';
import type { AvatarConfig } from './avatar.ts';
import type { Relationship } from './contacts.ts';

// ---- search (ADR-023) ----------------------------------------------------------------------------

/** Strangers can only be found by the start of their @username, so a search needs this many characters. */
export const SEARCH_MIN_CHARS = 3;
/** People already in your world (friends, contacts, people you chat or play with) match from here. */
export const SEARCH_MIN_CHARS_KNOWN = 2;
export const SEARCH_MAX_CHARS = 30;
export const SEARCH_MAX_RESULTS = 15;

export const peopleSearchQuerySchema = z.object({
  q: z
    .string()
    .trim()
    .transform((s) => s.replace(/^@/, '').toLowerCase())
    .pipe(z.string().min(SEARCH_MIN_CHARS_KNOWN).max(SEARCH_MAX_CHARS)),
});
export type PeopleSearchQuery = z.output<typeof peopleSearchQuerySchema>;

/** Why this person is in the results: someone you know, or only a stranger whose @username starts with the text. */
export type SearchSource = 'friend' | 'contact' | 'known' | 'stranger';

export type PersonResult = {
  id: string;
  username: string;
  displayName: string;
  avatar: AvatarConfig | null;
  level: number;
  relationship: Relationship;
  source: SearchSource;
  /** Friends you share, for people who are not your friends. */
  mutualFriends: number;
};

export type PeopleSearchResponse = { people: PersonResult[] };

// ---- someone's profile -----------------------------------------------------------------------------

export type ProfileRelationship = Relationship | 'self';

export type MutualFriend = {
  id: string;
  username: string;
  displayName: string;
  avatar: AvatarConfig | null;
};

export type ProfileBadge = {
  slug: string;
  name: string;
  description: string;
  /** The short mark drawn on the badge ("1st", "10", "Ð"). */
  mark: string;
  color: string;
  earnedAt: string | null;
};

export type HeadToHeadLast = {
  gameSlug: string;
  gameName: string;
  mode: 'free' | 'pool';
  /** From the signed-in person's side. */
  result: 'win' | 'loss' | 'draw';
  /** What you won or lost in the pot (Pool only), in kobo; null for Free. */
  netKobo: number | null;
  at: string;
};

export type HeadToHead = {
  wins: number;
  losses: number;
  draws: number;
  last: HeadToHeadLast | null;
};

export type RecentGame = {
  matchId: string;
  gameSlug: string;
  gameName: string;
  mode: 'free' | 'pool';
  /** From the profile owner's side. */
  result: 'win' | 'loss' | 'draw' | 'forfeit';
  /** Their opponent's @username, or null for a Space. */
  against: string | null;
  isSpace: boolean;
  /** Pool only, and only for your own profile: what the game paid you minus your stake. */
  netKobo: number | null;
  at: string;
};

export type PlaysMost = { gameSlug: string; gameName: string; wins: number; played: number };

export type ProfileStats = {
  games: number;
  wins: number;
  /** 0..1, null until they have played. */
  winRate: number | null;
  streak: number;
  bestStreak: number;
};

/** Your own money figures. Only ever present on your own profile. */
export type ProfileMoney = { poolNetKobo: number; bestPotKobo: number };

export type UserProfile = {
  id: string;
  username: string;
  displayName: string;
  avatar: AvatarConfig | null;
  level: number;
  /** Progress inside the current level, with the XP that fills it. */
  xp: number;
  xpForLevel: number;
  relationship: ProfileRelationship;
  /** One of your contacts on Dyce, or you are one of theirs ("In your contacts"). */
  inContacts: boolean;
  mutualFriends: { count: number; sample: MutualFriend[] };
  stats: ProfileStats;
  playsMost: PlaysMost[];
  badges: ProfileBadge[];
  /** You against them. Null on your own profile. */
  headToHead: HeadToHead | null;
  /** Friends and yourself only: a stranger's activity is not shown. */
  recentGames: RecentGame[] | null;
  /** Your own profile only. */
  money: ProfileMoney | null;
  /** Whether they take new friend requests from you right now (their "who can add me" setting). */
  canRequest: boolean;
};

export type BadgesResponse = { badges: ProfileBadge[] };

// ---- leaderboards ----------------------------------------------------------------------------------

export const LEADERBOARD_SCOPES = ['friends', 'global'] as const;
export const leaderboardScopeSchema = z.enum(LEADERBOARD_SCOPES);
export type LeaderboardScope = z.infer<typeof leaderboardScopeSchema>;

export const LEADERBOARD_METRICS = ['xp', 'pool'] as const;
export const leaderboardMetricSchema = z.enum(LEADERBOARD_METRICS);
export type LeaderboardMetric = z.infer<typeof leaderboardMetricSchema>;

export const leaderboardQuerySchema = z
  .object({
    scope: leaderboardScopeSchema.default('friends'),
    metric: leaderboardMetricSchema.default('xp'),
    /** A game slug, or omit for all games. */
    game: z
      .string()
      .regex(/^[a-z0-9_-]{1,40}$/)
      .optional(),
  })
  // Pool winnings are money: they are shown among friends only, never on the global board.
  .refine((q) => !(q.metric === 'pool' && q.scope === 'global'), {
    message: 'Pool winnings are only ranked among friends',
    path: ['metric'],
  });
export type LeaderboardQuery = z.output<typeof leaderboardQuerySchema>;

export type LeaderboardRow = {
  rank: number;
  userId: string;
  username: string;
  displayName: string;
  avatar: AvatarConfig | null;
  /** XP this week, or net Pool winnings in kobo (can be negative). */
  value: number;
  isMe: boolean;
  isFriend: boolean;
};

export type LeaderboardResponse = {
  scope: LeaderboardScope;
  metric: LeaderboardMetric;
  game: string | null;
  /** Top of the board (up to 50). */
  rows: LeaderboardRow[];
  /** You, even when you are outside the top. Null when you have no result this week. */
  me: LeaderboardRow | null;
  /** The person right above you, so "N XP behind" can be shown. */
  above: LeaderboardRow | null;
  weekStartsAt: string;
  /** The next Monday 00:00 in Lagos. */
  resetsAt: string;
};
