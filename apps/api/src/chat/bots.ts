import { createHash } from 'node:crypto';
import type pg from 'pg';
import { BOTS, botBySlug, type BotSlug, type RealtimeEvent } from '@dyce/shared';
import { AuthError } from '../auth/auth-error.ts';
import type { Clock } from '../auth/tokens.ts';
import { withTx } from '../db/tx.ts';
import { hydrateOne, type MessageRow } from './message-rows.ts';

/**
 * The practice bots (SPEC §5; ADR-026). Every reply is scripted on the server: there is no AI behind them
 * (no model call, no cost, nothing sent to a third party). A script is a greeting, a few keyword rules and a
 * rotation of fallback lines. Quiz Mama also keeps a tiny state (which question is open) in the payload of
 * her last message, so a quiz survives a restart and costs no table.
 */

type Reply = { body: string; payload?: { quiz: number } };
type Rule = { match: RegExp; say: string };
type Script = { greeting: string; rules: Rule[]; fallbacks: string[] };

const SCRIPTS: Record<Exclude<BotSlug, 'quiz-mama'>, Script> = {
  'coach-cue': {
    greeting:
      "Coach Cue here. Tell me what's going wrong on the table: breaks, bank shots, position, or safeties. I'll give you a drill.",
    rules: [
      {
        match: /\b(break|breaking)\b/i,
        say: 'Break drill: put the cue ball just behind the head string, a little off centre, and hit the head ball square with a smooth, firm stroke. Power is not the goal, a tight rack spread is. Do ten breaks and count how many pockets something.',
      },
      {
        match: /\bbank(s| shot| shots)?\b/i,
        say: 'Bank shots: mirror the shot. Imagine the pocket flipped across the rail, then aim at the spot where the ball and its mirror meet. Use a touch less speed than you want, and add no spin until the line is steady.',
      },
      {
        match: /\b(position|leave|shape)\b/i,
        say: "Position drill: set five balls in a line and run them, naming where you want the cue ball before every shot. If you can't name it, you're shooting blind.",
      },
      {
        match: /\b(safe|safety|defen[cs]e)\b/i,
        say: 'A safety is just a shot where you pick the cue ball’s hiding place first. Aim to leave it behind a ball of yours with the other side blocked. Soft stroke, and watch where the cue ball stops, not where it goes.',
      },
      {
        match: /\b(hi|hello|hey|yo|howdy)\b/i,
        say: 'Chalk up. What do you want to fix first: breaks, banks, position or safeties?',
      },
    ],
    fallbacks: [
      "Good. Here's a warm-up: place the cue ball on the head spot and pot the object ball straight down the table, ten times in a row, then step the cue ball a diamond to the side and repeat.",
      'Slow your back-swing down. Most missed shots are rushed. Pause at the end of the back-swing, then accelerate through the ball.',
      'Check your eyes. Look at the object ball last, not the cue ball. Settle there before you hit.',
      "Try the one-pocket drill: pick one pocket and pot every ball into it for five minutes. You'll learn angles faster than from any lecture.",
      'Say "break", "bank", "position" or "safety" and I will give you a drill for it. Then go play a Free game and tell me how it went.',
    ],
  },
  'word-hunt-trainer': {
    greeting:
      'Word Hunt Trainer here. Say "warm up" and I\'ll give you a drill, or ask for a tip on long words, prefixes or speed.',
    rules: [
      {
        match: /\b(warm ?up|drill|practice|start)\b/i,
        say: 'Warm-up: look at any six letters and find as many words as you can in 60 seconds. Start with the shortest three-letter words to get your eyes moving, then hunt for the longest one. Say "done" when you finish and I will give you the next one.',
      },
      {
        match: /\b(long|longer|big|biggest)\b/i,
        say: 'Long words: look for endings first. -ING, -ED, -ER, -ERS, -EST and -LY are free letters. Find a short root, then bolt an ending on.',
      },
      {
        match: /\b(prefix|prefixes|suffix|suffixes)\b/i,
        say: 'Prefixes worth knowing: RE-, UN-, DE-, IN-, DIS-, MIS-. Suffixes: -ER, -ED, -ING, -S. If a word fits the board with one of these, check it twice before you give up on it.',
      },
      {
        match: /\b(speed|faster|quick|quicker|fast)\b/i,
        say: "Speed: don't scan, sweep. Fix your eyes on the middle and let the letters move around it. Say each word in your head once, then move on. Re-reading is where the seconds go.",
      },
      {
        match: /\bdone\b/i,
        say: "Nice. Next drill: same six letters, but only words of five letters or more. If you find none, that's your homework: the long ones.",
      },
    ],
    fallbacks: [
      'Try the wide-eyed drill: look at the middle of the grid and notice words in your periphery. Do not trace letters one by one.',
      'Keep a list of the common three-letter words: ART, ARE, ATE, EAR, EAT, ERA, RAT, TAR, TEA. They are the fast points.',
      'When you are stuck, change your view. Tilt your head or read the grid bottom-to-top and new words appear.',
      'Say "warm up" for a drill, or "long", "prefix" or "speed" for a tip.',
    ],
  },
  'admiral-ade': {
    greeting:
      'Admiral Ade reporting. Three levels of Sea Battle practice: recruit, officer and admiral. Which one are you? (Say "recruit", "officer" or "admiral".)',
    rules: [
      {
        match: /\brecruit\b/i,
        say: 'Recruit: place your ships apart, not in a cluster. Open by firing on a checkerboard pattern: every second square. It finds the biggest ship in the fewest shots. When you hit, fire on the four squares around it.',
      },
      {
        match: /\bofficer\b/i,
        say: 'Officer: after a hit, probe along a line before you go sideways, because ships are straight. Sink it before you hunt for another. And do not leave a ship touching the edge: it is a favourite place to look.',
      },
      {
        match: /\badmiral\b/i,
        say: "Admiral: vary your layout every game, since good players remember it. Put a small ship in the middle of the board where nobody looks. Count the squares left: if the smallest ship can't fit, don't fire there.",
      },
      {
        match: /\b(hi|hello|hey)\b/i,
        say: 'Attention. Recruit, officer or admiral?',
      },
    ],
    fallbacks: [
      'Tip: your first five shots should never touch. Spread them out and let the pattern do the work.',
      'Do not chase a single hit across the board. Finish the ship first.',
      "Keep a count of ships still afloat. It tells you how big the largest gap you're looking for is.",
      'Say "recruit", "officer" or "admiral" and I will give you a plan for that rank. Then go play a Free game.',
    ],
  },
};

type Question = { q: string; answers: string[]; reveal: string };

/** Ten questions a day is the design's promise; this is the rotation. */
export const QUIZ: readonly Question[] = [
  { q: 'Which river gives Nigeria its name?', answers: ['niger'], reveal: 'The Niger.' },
  { q: 'What is the capital of Nigeria?', answers: ['abuja'], reveal: 'Abuja.' },
  { q: 'In what year did Nigeria gain independence?', answers: ['1960'], reveal: '1960.' },
  {
    q: 'Which city was the capital of Nigeria before Abuja?',
    answers: ['lagos'],
    reveal: 'Lagos.',
  },
  {
    q: 'Jollof rice is cooked in a sauce of tomatoes, peppers and which other vegetable?',
    answers: ['onion', 'onions'],
    reveal: 'Onions.',
  },
  {
    q: 'What is the name of the Nigerian national football team?',
    answers: ['super eagles', 'eagles'],
    reveal: 'The Super Eagles.',
  },
  {
    q: 'Which Nigerian author wrote Things Fall Apart?',
    answers: ['achebe'],
    reveal: 'Chinua Achebe.',
  },
  {
    q: 'What colour are the two outer stripes on the Nigerian flag?',
    answers: ['green'],
    reveal: 'Green, with white in the middle.',
  },
  {
    q: 'Which tower-shaped rock near Abuja is a famous landmark? (Hint: it is a "rock".)',
    answers: ['aso', 'aso rock'],
    reveal: 'Aso Rock.',
  },
  {
    q: 'Which Nigerian musician is known as the "African Giant"?',
    answers: ['burna', 'burna boy'],
    reveal: 'Burna Boy.',
  },
];

const QUIZ_GREETING =
  'Quiz Mama here. Ten Naija questions, one at a time. Say "start" when you are ready. Get one wrong and I will tell you the answer, no wahala.';

export const BOT_GREETINGS: Record<BotSlug, string> = {
  'coach-cue': SCRIPTS['coach-cue'].greeting,
  'quiz-mama': QUIZ_GREETING,
  'word-hunt-trainer': SCRIPTS['word-hunt-trainer'].greeting,
  'admiral-ade': SCRIPTS['admiral-ade'].greeting,
};

/**
 * What a bot says back. `count` is how many messages the person has sent this conversation (it rotates the
 * fallbacks); `openQuiz` is the question Quiz Mama last asked, if one is waiting for an answer.
 */
export function botReply(
  slug: BotSlug,
  text: string,
  count: number,
  openQuiz: number | null,
): Reply {
  if (slug === 'quiz-mama') return quizReply(text, openQuiz);
  const script = SCRIPTS[slug];
  const rule = script.rules.find((r) => r.match.test(text));
  if (rule) return { body: rule.say };
  return { body: script.fallbacks[(Math.max(count, 1) - 1) % script.fallbacks.length]! };
}

function quizReply(text: string, open: number | null): Reply {
  const norm = text
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (open === null) {
    if (/\b(start|begin|ready|go|play|yes|ok|okay)\b/.test(norm)) {
      return { body: `Question 1 of ${QUIZ.length}: ${QUIZ[0]!.q}`, payload: { quiz: 0 } };
    }
    return { body: 'Say "start" and I will ask the first question.' };
  }
  const current = QUIZ[open]!;
  const right = current.answers.some((a) => norm.includes(a));
  const verdict = right ? 'Correct!' : `Not quite. ${current.reveal}`;
  const next = open + 1;
  if (next >= QUIZ.length) {
    return { body: `${verdict} That was the last one. Say "start" to go again.` };
  }
  return {
    body: `${verdict} Question ${next + 1} of ${QUIZ.length}: ${QUIZ[next]!.q}`,
    payload: { quiz: next },
  };
}

/** A repeatable id for a bot's reply to one message, so a retried send can't make two replies. */
export function botReplyId(userMessageId: string): string {
  const h = createHash('sha1').update(`dyce-bot-reply:${userMessageId}`).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

/** The greeting's id is fixed per conversation, so opening a bot twice posts it once. */
export const botGreetingId = (conversationId: string): string =>
  botReplyId(`greeting:${conversationId}`);

type Publisher = { publish(userIds: readonly string[], event: RealtimeEvent): void };

/**
 * Opening a bot chat and answering in it. Replies arrive after a short pause (`replyDelayMs`) so it feels
 * like someone typing; the pause is not part of the guarantee: a reply is only ever sent once per message.
 */
export class BotService {
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly pool: pg.Pool,
    private readonly publisher: Publisher,
    private readonly clock: Clock = () => new Date(),
    private readonly replyDelayMs = 700,
  ) {}

  /** Resolves when every reply scheduled so far has been sent (for tests and for shutdown). */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  /** Your conversation with one bot, created (with its greeting) if it doesn't exist. */
  async open(userId: string, slug: BotSlug): Promise<string> {
    if (!botBySlug(slug)) throw new AuthError('conversation_not_found');
    return withTx(this.pool, async (c) => {
      await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`, [
        `bot:${userId}:${slug}`,
      ]);
      const found = await c.query<{ id: string }>(
        `SELECT id FROM conversations WHERE kind = 'bot' AND created_by = $1 AND bot_slug = $2`,
        [userId, slug],
      );
      if (found.rows[0]) return found.rows[0].id;
      const now = this.clock();
      const created = await c.query<{ id: string }>(
        `INSERT INTO conversations (kind, bot_slug, created_by, created_at, last_message_at)
         VALUES ('bot', $1, $2, $3, $3) RETURNING id`,
        [slug, userId, now],
      );
      const id = created.rows[0]!.id;
      // The greeting is read from the start: it must not light up the Chat badge on first open.
      await c.query(
        `INSERT INTO conversation_members (conversation_id, user_id, state, last_read_at, joined_at)
         VALUES ($1, $2, 'active', $3, $3)`,
        [id, userId, now],
      );
      await c.query(
        `INSERT INTO messages (id, conversation_id, sender_id, kind, body, created_at)
         VALUES ($1, $2, NULL, 'text', $3, $4)`,
        [botGreetingId(id), id, BOT_GREETINGS[slug], now],
      );
      return id;
    });
  }

  /** All four bots exist for you (the Bots filter lists them). */
  async ensureAll(userId: string): Promise<void> {
    for (const b of BOTS) await this.open(userId, b.slug);
  }

  /** Called after the person's message is stored. Sends the scripted reply a moment later. */
  scheduleReply(userId: string, conversationId: string, userMessageId: string): void {
    const job: Promise<void> = new Promise<void>((resolve) =>
      setTimeout(resolve, this.replyDelayMs),
    )
      .then(() => this.reply(userId, conversationId, userMessageId))
      .catch(() => undefined) // a failed reply is not worth surfacing: they can just ask again
      .finally(() => {
        this.pending.delete(job);
      });
    this.pending.add(job);
  }

  private async reply(
    userId: string,
    conversationId: string,
    userMessageId: string,
  ): Promise<void> {
    const now = this.clock();
    const sent = await withTx(this.pool, async (c) => {
      const conv = await c.query<{ bot_slug: BotSlug }>(
        `SELECT c.bot_slug FROM conversations c
           JOIN conversation_members m ON m.conversation_id = c.id AND m.user_id = $2 AND m.state = 'active'
          WHERE c.id = $1 AND c.kind = 'bot'`,
        [conversationId, userId],
      );
      const slug = conv.rows[0]?.bot_slug;
      if (!slug) return null;
      const said = await c.query<{ body: string | null; deleted_at: Date | null }>(
        `SELECT body, deleted_at FROM messages WHERE id = $1 AND conversation_id = $2 AND sender_id = $3`,
        [userMessageId, conversationId, userId],
      );
      const text = said.rows[0];
      if (!text || text.deleted_at) return null;
      const count = Number(
        (
          await c.query<{ n: string }>(
            `SELECT count(*) AS n FROM messages WHERE conversation_id = $1 AND sender_id = $2`,
            [conversationId, userId],
          )
        ).rows[0]!.n,
      );
      // The open quiz question is whatever her latest message asked (a plain reply closes the quiz).
      const open = await c.query<{ quiz: number | null }>(
        `SELECT (payload->>'quiz')::int AS quiz FROM messages
          WHERE conversation_id = $1 AND sender_id IS NULL AND id <> $2
          ORDER BY created_at DESC, id DESC LIMIT 1`,
        [conversationId, botReplyId(userMessageId)],
      );
      const openQuiz = open.rows[0]?.quiz ?? null;
      const reply = botReply(slug, text.body ?? '', count, openQuiz);
      const inserted = await c.query<MessageRow>(
        `INSERT INTO messages (id, conversation_id, sender_id, kind, body, payload, created_at)
         VALUES ($1, $2, NULL, 'text', $3, $4::jsonb, $5)
         ON CONFLICT (id) DO NOTHING
         RETURNING id, conversation_id, sender_id, kind, body, payload, created_at, deleted_at, reply_to,
                   $6::text AS bot_slug`,
        [
          botReplyId(userMessageId),
          conversationId,
          reply.body,
          JSON.stringify(reply.payload ?? {}),
          now,
          slug,
        ],
      );
      if (!inserted.rows[0]) return null; // already answered (a retried send)
      await c.query(`UPDATE conversations SET last_message_at = $2 WHERE id = $1`, [
        conversationId,
        now,
      ]);
      return inserted.rows[0];
    });
    if (sent) {
      const message = await hydrateOne(this.pool, userId, sent);
      try {
        this.publisher.publish([userId], { type: 'message', message });
      } catch {
        // best effort, like every live event
      }
    }
  }
}
