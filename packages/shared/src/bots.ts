/**
 * The practice bots (SPEC §5): scripted 1:1 conversations, Free only, no Pool. The metadata is here so the
 * app and the server agree; the scripts that answer live in the API (`apps/api/src/chat/bots.ts`).
 */
export const BOT_SLUGS = ['coach-cue', 'quiz-mama', 'word-hunt-trainer', 'admiral-ade'] as const;
export type BotSlug = (typeof BOT_SLUGS)[number];

export type BotInfo = {
  slug: BotSlug;
  name: string;
  /** The line under the name in the Bots list, until the first message. */
  tagline: string;
  /** Tile colour behind the two "eyes" (design: Chats, bots). */
  color: string;
  /** The game it warms you up for. */
  gameSlug: string;
};

export const BOTS: readonly BotInfo[] = [
  {
    slug: 'coach-cue',
    name: 'Coach Cue',
    tagline: '8 Ball drills · beat my bank shot',
    color: '#5A4FCF',
    gameSlug: 'eight-ball',
  },
  {
    slug: 'quiz-mama',
    name: 'Quiz Mama',
    tagline: 'Naija trivia · 10 questions a day',
    color: '#17834F',
    gameSlug: 'trivia',
  },
  {
    slug: 'word-hunt-trainer',
    name: 'Word Hunt Trainer',
    tagline: 'Warm up before you play Zainab',
    color: '#C98500',
    gameSlug: 'word-hunt',
  },
  {
    slug: 'admiral-ade',
    name: 'Admiral Ade',
    tagline: 'Sea Battle practice, 3 levels',
    color: '#0A3A6B',
    gameSlug: 'sea-battle',
  },
];

export function botBySlug(slug: string): BotInfo | undefined {
  return BOTS.find((b) => b.slug === slug);
}

/** Messages from a bot carry `senderId` = `bot:<slug>` (a bot is not a user). */
export const BOT_SENDER_PREFIX = 'bot:';
export const botSenderId = (slug: string): string => `${BOT_SENDER_PREFIX}${slug}`;
export const isBotSender = (senderId: string): boolean => senderId.startsWith(BOT_SENDER_PREFIX);
