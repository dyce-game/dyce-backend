import { LIVE_GAMES, type DoodleState, type PartyGame } from '@dyce/games';
import type { LiveState } from '@dyce/shared';
import { DEFAULT_OPTIONS } from './live-match.ts';
import { PartyMatch } from './party-match.ts';
import { FakeScheduler, MemoryStore } from './testing.ts';

/**
 * Soak numbers for one room type: Doodle Guess, the heaviest (a drawer streaming strokes to 7 guessers, all
 * guessing). Time is simulated, so this measures the work the room does (CPU, bytes, writes), not the
 * network. The figures are recorded in docs/TEST_PLAN.md; the asserts are loose guards so a regression
 * (say, sending every stroke to everyone at once) fails here.
 */
const ROOMS = 20;
const SEATS = 8;
const SIM_SECONDS = 150;
const STROKES_PER_SECOND = 6;

type Room = {
  match: PartyMatch;
  store: MemoryStore;
  players: string[];
};

it(`soak: ${ROOMS} Doodle Guess rooms x ${SEATS} seats, ${SIM_SECONDS} simulated seconds each`, async () => {
  const game = LIVE_GAMES['doodle-guess'] as PartyGame;
  const sched = new FakeScheduler();
  let bytes = 0;
  let stateMessages = 0;
  let streamMessages = 0;
  const rooms: Room[] = [];
  for (let r = 0; r < ROOMS; r++) {
    const players = Array.from({ length: SEATS }, (_, i) => `r${r}u${i}`);
    const store = new MemoryStore();
    const state = game.engine.init(players, BigInt(100 + r), game.buildCfg({ rounds: 3 }, SEATS));
    const match = new PartyMatch(
      {
        matchId: `m${r}`,
        spaceId: `s${r}`,
        gameSlug: 'doodle-guess',
        mode: 'free',
        state,
        version: 0,
        players: players.map((userId, i) => ({ userId, seat: i + 1 })),
        forfeited: [],
      },
      game,
      store,
      sched,
      {
        state: (_u: string, s: LiveState) => {
          // what the wire would carry, to the byte (the real transport packs it a little tighter)
          bytes += JSON.stringify(s).length;
          stateMessages += 1;
        },
        chat: () => undefined,
        stream: (_u: string, m: unknown) => {
          bytes += JSON.stringify(m).length;
          streamMessages += 1;
        },
        finished: () => undefined,
      },
      DEFAULT_OPTIONS,
    );
    match.start();
    for (const p of players) match.setConnected(p, true);
    rooms.push({ match, store, players });
  }

  const cpu0 = process.cpuUsage();
  const wall0 = Date.now();
  for (let sec = 0; sec < SIM_SECONDS; sec++) {
    for (const room of rooms) {
      const s = room.match.state as DoodleState;
      if (s.phase === 'over') continue;
      const drawer = s.order[s.turn % s.order.length]!;
      if (s.phase === 'choose') {
        void room.match.submit(drawer, undefined, { kind: 'choose', index: 0 });
      } else {
        for (let i = 0; i < STROKES_PER_SECOND; i++) {
          void room.match.submit(drawer, undefined, {
            kind: 'stroke',
            points: Array.from({ length: 12 }, (_, k) => [
              (sec * 7 + i * 31 + k * 13) % 1000,
              (sec * 11 + k * 17) % 1000,
            ]) as [number, number][],
            color: i % 8,
            width: 2,
            cont: i % 3 !== 0 && s.strokes.length > 0,
          });
        }
        // one wrong guess a second from some guesser
        const guesser = s.players.find((p) => p !== drawer && !s.solvers.includes(p));
        if (guesser && sec % 2 === 0) {
          void room.match.submit(guesser, undefined, { kind: 'guess', text: `try ${sec}` });
        }
      }
    }
    await sched.advance(1000);
  }
  const cpu = process.cpuUsage(cpu0);
  const wallMs = Date.now() - wall0;
  for (const room of rooms) await room.match.idle();

  const cpuMs = (cpu.user + cpu.system) / 1000;
  const roomSeconds = ROOMS * SIM_SECONDS;
  const clientSeconds = roomSeconds * SEATS;
  const saves = rooms.reduce((n, r) => n + r.store.saves, 0);
  const moves = rooms.reduce((n, r) => n + r.store.moves.length, 0);
  const report = {
    rooms: ROOMS,
    seatsPerRoom: SEATS,
    simulatedSeconds: SIM_SECONDS,
    cpuMsPerRoomSecond: +(cpuMs / roomSeconds).toFixed(3),
    wallMs,
    stateMessagesPerClientSecond: +(stateMessages / clientSeconds).toFixed(2),
    canvasMessagesPerClientSecond: +(streamMessages / clientSeconds).toFixed(2),
    kbPerClientSecond: +(bytes / 1024 / clientSeconds).toFixed(2),
    dbWritesPerRoomSecond: +(saves / roomSeconds).toFixed(3),
    movesLogged: moves,
  };
  console.log('party soak', JSON.stringify(report));

  // Loose guards, an order of magnitude from where this measures on a laptop.
  expect(report.cpuMsPerRoomSecond).toBeLessThan(25); // one core would hold >40 rooms
  expect(report.stateMessagesPerClientSecond).toBeLessThan(8); // streams are coalesced, not per stroke
  expect(report.dbWritesPerRoomSecond).toBeLessThan(1.5); // strokes are batched, not one write each
  expect(
    rooms.every((r) => r.store.moves.every((m, i, a) => i === 0 || m.seq > a[i - 1]!.seq)),
  ).toBe(true);
}, 120_000);
