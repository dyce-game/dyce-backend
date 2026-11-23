# Dyce — Test plan (backend)

Owner: qa-engineer. Server-side layers for `dyce-backend`; the app side is in `../Dyce/docs/TEST_PLAN.md`.

## 1. Principles
- **Money and fairness are tested at the database and engine level first**, then through the API, then end to end. A UI test never replaces a ledger test.
- Every test that touches money runs as the **restricted application role** (`dyce_app`, member of `dyce_api`), so permissions are part of what is tested.
- Engines are tested with **property tests** (random legal play never breaks invariants) plus a **cross-runtime determinism** check (Node, Deno, Hermes).
- Definition of done (from `../Dyce/docs/BUILD_PLAN.md`): spec behaviour incl. edge cases, tests, no lint/type errors, reviewer "approve".

## 2. Layers
| Layer | Tool | Where | Run with |
|---|---|---|---|
| Money, ledger, matches (SQL) | Jest + real PostgreSQL | `apps/api/db/tests` | `pnpm test:db` (embedded PG locally, service container in CI) |
| Auth: OTP limits/lockout, sessions, profile, age gate, onboarding | Jest + real PostgreSQL | `apps/api/db/tests/auth.test.ts`, `profile.test.ts` | `pnpm test:db` |
| Contacts matching + friend requests (privacy, blocks, limits, races) | Jest + real PostgreSQL | `apps/api/db/tests/contacts.test.ts` | `pnpm test:db` |
| Friends list, accept, ignore, cancel, remove (silent ignore, races, blocks) | Jest + real PostgreSQL | `apps/api/db/tests/friends.test.ts` | `pnpm test:db` |
| Messaging: conversations, Requests, limits, read state, paging, blocks, races | Jest + real PostgreSQL | `apps/api/db/tests/messages.test.ts` | `pnpm test:db` |
| Wallet: send, requests and codes, history, receipts, cards, idempotency, races, limits | Jest + real PostgreSQL | `apps/api/db/tests/wallet.test.ts` | `pnpm test:db` |
| Profile update: name and request policy, strict schema (no username), no profile | Jest + real PostgreSQL | `packages/shared/src/profile.test.ts`, `apps/api/db/tests/profile.test.ts` | `pnpm test`, `pnpm test:db` |
| Avatar: starter look ids, strict config, `parseAvatar`; save/change/onboarding step; friends and chats carry the look | Jest + real PostgreSQL | `packages/shared/src/avatar.test.ts`, `apps/api/db/tests/avatar.test.ts` | `pnpm test`, `pnpm test:db` |
| Block and report: blocking cuts off chat/money/friend requests, unblock, reports with evidence snapshot, duplicates, daily limit, constraints | Jest + real PostgreSQL | `apps/api/db/tests/safety.test.ts` | `pnpm test:db` |
| Realtime hub and WebSocket server (auth frame, token expiry, typing, limits) | Jest + real sockets | `apps/api/src/chat/realtime.test.ts` | `pnpm test` |
| Auth + contacts + friends + messaging (incl. a live WebSocket) + wallet + block/report over real HTTP (whole journey, throttling, production-safety) | script | `apps/api/scripts/auth-e2e.mjs` | `pnpm -F @dyce/api e2e` |
| SMS providers, env validation, tokens, hashing | Jest | `apps/api/src/**/*.test.ts` | `pnpm test` |
| Money utils, config, phone/username/onboarding rules | Jest | `packages/shared/src/*.test.ts` | `pnpm test` |
| Engine contract + rules + RNG | Jest + fast-check | `packages/games/src/**` | `pnpm test` |
| Whot!, Word Hunt, Cup Pong engines: contract harness (random legal play terminates, replay hash, JSON round trip, views), rules, ends and results, views hide secrets, wire schemas | Jest + fast-check | `packages/games/src/{whot,wordhunt,cuppong}/engine.test.ts` | `pnpm test` |
| Crazy Cards, Doodle Guess, Imposter, Werewolf, Charades engines: contract harness with room ticks, rules, phase order, ends and placements, views hide secrets for every role, wire schemas; word packs and the profanity check | Jest + fast-check | `packages/games/src/{crazycards,doodleguess,imposter,werewolf,charades,party}/*.test.ts` | `pnpm test` |
| Determinism (Node) | script | `packages/games/scripts/determinism.ts` | `pnpm test:determinism` |
| API units | Jest | `apps/api/src/**/*.test.ts` | `pnpm test` |
| API boots | script | `apps/api/scripts/smoke.mjs` | `pnpm -F @dyce/api smoke` |

## 3. Money invariants and the tests that prove them (WALLET_AND_QR §8)
| Rule | Test |
|---|---|
| Welcome grant once, ₦200,000 | `ledger.test.ts › welcome grant` (incl. unique-index backstop) |
| Transfer success, balanced entries | `transfer › moves money, writes balanced entries` |
| Insufficient funds leaves no trace | `transfer › rejects insufficient funds` |
| Non-positive amount rejected | `transfer › rejects a non-positive amount` |
| Idempotent retry returns same txn | `transfer › a retry with the same key…` (+ retry after balance dropped) |
| Two concurrent spends of the last ₦1,000: one wins | `transfer › two concurrent spends…` |
| Opposite concurrent transfers don't deadlock | `transfer › many concurrent opposite transfers` |
| Request paid twice fails second time | `payment requests › paid twice…`, `two payers racing…` |
| Expired / cancelled / self-pay / wrong amount / targeted | `payment requests › …` |
| Per-send + daily limits, blocks | `transfer › enforces the per-send and daily limits`, `refuses transfers between blocked users` |
| Settle 1v1, 50/30/20 with remainder, 60/40, ties, draw | `pool.test.ts › settle_match` |
| Settle exactly once, even concurrently | `settle twice…`, `concurrent settles pay exactly once` |
| Refund on expiry; refund/settle exclusivity | `pool.test.ts › refund_match` |
| Adult required, daily pool limits, frozen users | `pool.test.ts › stake_pool` |
| Pool match end to end (stake on create and accept, refusals leave nothing behind, double tap and retry stake once, decline / cancel / expiry refunds, counter-offer paths, payout on a win, refund on a draw, retried final move; ledger invariants after each) | `pool-matches.test.ts` (ADR-018) |
| Nightly invariant check finds a planted mismatch | `database-level safety › the invariant check finds a planted mismatch` |
| App role cannot write money tables or call admin functions | `database-level safety › the app role cannot…` |
| Ledger is append-only; unbalanced commit rejected; balance never negative | `database-level safety › …` |

## 3b. Engine rules and what proves them (ADR-017)
| Rule | Test |
|---|---|
| Whot: 54-card deck, deal 6/5, ordinary starter, card conservation through any play | `whot deck and deal`, `whot properties` |
| Whot: match by shape/number, Whot names a shape, request survives a draw | `whot basic plays`, `whot special cards` |
| Whot: Hold On, Pick Two/Three stacking and defence, Suspension (2p), General Market | `whot special cards` |
| Whot: last card and check up penalties, win, placements by hand points | `whot last card, check up and winning` |
| Whot: market reshuffle, partial pick, blocked end | `whot empty market` |
| Whot: hands, market order and RNG hidden; hands revealed only at the end | `whot views hide secrets` |
| Word Hunt: board deterministic per seed, enough words, vowels sane | `word hunt board generator` |
| Word Hunt: path rules (adjacent, no reuse), dictionary only, duplicates once, scoring | `word hunt word finding`, `word hunt rules` |
| Word Hunt: start before submit, once each; grid hidden until start; words private until you finish | `word hunt rules`, `word hunt views hide what they must` |
| Cup Pong: physics is a pure function; hit, short, long, wide, bounce shot, rim; pinned outcomes | `cup pong physics` |
| Cup Pong: turn order, rounds, wobble from seed, equal turns, both-clear tie-break, max rounds, draw | `cup pong turns`, `cup pong endings` |
| Cup Pong: re-rack once, 2–6 cups, before the first ball, own rack only | `cup pong re-rack` |
| Cup Pong: state is integers only; RNG hidden; wire schema | `cup pong view and wire schema` |
| All three: identical hash in the cross-runtime scenario | `pnpm test:determinism` (Node; Deno and Hermes not yet run) |

## 3d. Phase 3 engines and what proves them (ADR-023)
| Rule | Test |
|---|---|
| Crazy Cards: 108-card deck, deal 7, number starter, card conservation | `crazy cards deck and deal` |
| Crazy Cards: match colour/value, wild colour, skip, reverse (2p = skip), draw two, draw four, no stacking | `crazy cards matching`, `crazy cards special cards` |
| Crazy Cards: draw then play or pass, reshuffle, blocked end; last-card penalty, going out, placements by points | `crazy cards drawing and passing`, `crazy cards last card and winning` |
| Crazy Cards: own hand only, drawn card only to its player, hands at the end | `crazy cards views hide secrets` |
| Imposter: roles, 1 or 2 imposters, word, seeded clue order, rounds, timeouts | `imposter setup`, `imposter reveal and clues` |
| Imposter: vote validation, top-N accusation with ties, timeout votes; every outcome and side placements | `imposter vote`, `imposter outcomes` |
| Imposter: crew see the word, imposters/spectators do not, votes private until resolved | `imposter views hide secrets` |
| Werewolf: roles by table size, night actions and targets, doctor save, RNG tie, timeouts | `werewolf setup`, `werewolf night` |
| Werewolf: day ready, plurality lynch, ties, dead cannot act; village/wolf wins, draw after maxNights | `werewolf day and vote`, `werewolf endings` |
| Werewolf: own role only, wolves see wolves, seer log and doctor choice private, dead see all roles | `werewolf views hide secrets` |
| Charades: teams, solo, fair turn schedule, start/forfeit, got_it/skip, guesser rules, clock and card limits, placements | `charades setup`, `charades a turn`, `charades end and placements` |
| Charades: card visible only to the actor (act) or to everyone but the holder (heads-up) | `charades views hide the card` |
| Doodle Guess: choose, bounded strokes, undo/clear, canvas caps, speed scoring, close guesses, feed cap, turn and round order, placements | `doodle guess *` |
| Doodle Guess: word and choices hidden, hint mask, no RNG or reveal order | `doodle guess views hide the word` |
| All five: ticks only from the room; identical hash in the cross-runtime scenario | each engine validate tests; `pnpm test:determinism` (36 scenarios, Node) |
| Word packs: every entry passes the profanity check, no repeats | `word packs` |

## 3c. Spaces and live rooms (ADR-022)
| Rule | Test |
| --- | --- |
| A space seats its host, makes a readable `DY-XXXX` code and a waiting match; create is idempotent on the space id | `spaces.test.ts` creating a space |
| Seat fee is locked before the space exists (rolls back if the host cannot pay), taken on sitting down, returned on leaving, on removal, on close and on expiry; sitting down again pays again | `spaces.test.ts` Pool tests, `expectLedgerClean` after each |
| Friends-only vs code, blocks, full, started, removed people; two people racing for the last seat | `spaces.test.ts` joining |
| Host passes to the longest-seated person; an empty space closes | `spaces.test.ts` leaving |
| Start needs the host and the minimum; deals the engine; idempotent; starts itself when full; 2 players on 50/30/20 are paid 60/40; works when the game server is down and `connect` retries | `spaces.test.ts` starting |
| A move is validated by schema, version, turn and engine; two at once apply one; each seat sees only its own cards | `live-match.test.ts` moves |
| Turn clock plays for a silent seat; a move just before the clock does not get a second one | `live-match.test.ts` the turn clock |
| 60 s offline forfeits, coming back in time keeps the seat; join grace; one player left wins at once; the leaver finishes last and is played for; later forfeits rank higher | `live-match.test.ts` leaving |
| A whole game settles exactly once and its stored moves replay to the same state; settlement retries; an already-over match is settled on recovery | `live-match.test.ts` finishing |
| Real Colyseus + colyseus.js + PostgreSQL: auth and seat checks, signed internal call, replaced connection, a Free game to the end, a 3-player Pool game paid 50/30/20 with the escrow at zero, forfeit by leaving and by dropping, reconnect with the same cards, room rebuilt from the database | `apps/game-server/test/room.test.ts` |

## 3e. Social layer and what proves it (ADR-024)

`db/tests/progress.test.ts` (14), `db/tests/notifications.test.ts` (23), `db/tests/discovery.test.ts` (19), `src/notifications/push.test.ts` (7, drivers against recorded request shapes) and `packages/shared/src/notifications.test.ts` (text, quiet hours, schemas). What each covers is listed in `../Dyce/docs/TEST_PLAN.md`. Not proven: delivery through the real Expo Push API.

## 3f. Party rooms, Crazy Cards and quick match (ADR-025)

| Rule | Test |
| --- | --- |
| Registry: every game starts at every seat count it advertises; side games allow winner takes all only; options are validated and built; chat audiences per game and phase | `packages/games/src/live.test.ts` |
| Canvas deltas: a seat that follows every change always ends with exactly the server canvas over 600 random steps (draw, extend, undo, clear, new turn); nothing to send when nothing changed | `live.test.ts` canvas deltas |
| Clocks stay stopped until everyone has connected; absent seats forfeit after the join grace | `party-match.test.ts` starting |
| Ticks feed real elapsed time; only ticks that changed something are saved; a seat is only sent what changed; a seat can never tick; a Werewolf of silence is a draw by ticks alone | `party-match.test.ts` time |
| No `turnUserId`; each seat sees only its own role and word; night actors are not revealed | `party-match.test.ts` hidden information |
| A whole Imposter round settles the winning side; refusals for out-of-turn, bad votes and strangers | `party-match.test.ts` a 4-player Imposter round |
| Reconnect inside 60 s keeps the seat; leaving forfeits and ranks last; the clock skips ahead for a drawer who left; one left wins | `party-match.test.ts` leaving |
| Strokes: one batched write, coalesced broadcast, deltas, reset on undo / new turn / reconnect, a guess flushes the strokes before it, a failed batch is retried | `party-match.test.ts` streams |
| A move that cannot be saved is not applied; settlement retries then fails loudly; a match recovered from the database resumes | `party-match.test.ts` persistence failures |
| Table talk: audiences, rate limit, text cleaning, history only for those who could hear it; a seat flooding actions is refused | `party-match.test.ts` chat, flooding |
| Soak: 20 Doodle rooms x 8 seats, bytes, CPU and writes per second (loose guards) | `party-soak.test.ts` |
| Real Colyseus + colyseus.js + PostgreSQL, bots reading only their own view: Imposter (Pool, paid exactly, secrecy, a leaver, a dropped and a returning seat, chat), Werewolf (roles hidden, night chat, a draw by the clock with every stake refunded), Doodle Guess (Pool 50/30/20, canvas as messages, the drawer leaving), Charades (a draw refunds, only the actor sees the card), Crazy Cards (Pool 50/30/20 to the end, Free with version rules), the waiting gate, refused ticks and strangers, a replaced connection, a room rebuilt from the database | `apps/game-server/test/party-room.test.ts` |
| Space creation for the new games: seat limits, options, Pool schemes, the roles dealt, no turn stored for party rooms, a turn stored for Crazy Cards, seat fees back on close | `apps/api/db/tests/party-spaces.test.ts` |
| Quick match: pairing, level gap and widening, blocks, disabled, rematch window, one search per person, stakes at the match, decline and timeout refunds, a failed stake drops only that person, limits, strangers get no chat, concurrency, a crash repair | `apps/api/db/tests/quickmatch.test.ts` |
| The built API and game server as real processes over HTTP and WebSockets | `pnpm -F @dyce/game-server e2e` (`scripts/live-e2e.mjs`) |

Not proven: real devices and bad networks, a renderer drawing the canvas, several game-server processes, a long soak with real timers.

## 3h. Edge flows and what proves them (ADR-037)

| Behaviour | Test |
|---|---|
| Resign: Pool pot to the opponent and the stake lost, Free forfeit, retry is a no-op, only an active 1v1 match you play | `apps/api/db/tests/edge-flows.test.ts` |
| Disputes: one per player with a reference, idempotent, Pool-and-finished-and-in-window only, daily limit, no money moves, moderator view and `resolve_dispute` refused to the API role, a reversal needs its own reversal transaction | same |
| Account deletion: username must match, grace period and revoked sessions, a repeat keeps the date, cancel, nothing erased early, open Pool stakes refunded then the balance cleared with one balanced entry, anonymised profile, ties and sessions gone, history kept, idempotent second run, phone number freed, waiting space left first and a live one waits | same |
| Export: own data only, no phone number or hash, none of another person's messages or ids | same |
| Space exit: host closed, removed, left, timed out, with the refund; a stranger learns nothing; `space_full` carries the space's name | same |

## 3g. Phase 4 sports engines and what proves them (ADR-034)
| Rule | Test |
|---|---|
| `physics/angles`: integer-centidegree sin/cos exact at the axes, within 1e-12 of `Math.sin/cos` at all 36,000 angles, unit length, wraps | `physics/angles: deterministic sin/cos` |
| 8 Ball physics: pure, trace never changes the outcome, inputs untouched; lone ball stops, harder rolls further; cushion bounce and angle of reflection | `8 ball physics` |
| 8 Ball physics: stun / follow / draw off a head-on hit; side spin moves the cue ball oppositely after a cushion; all six pockets take a ball; no overlap at rest; break scatters the rack | `8 ball physics` |
| 8 Ball setup and input: seeded rack (8 centre, solid + stripe corners), turn, angle/power/spin ranges and spin circle, ball in hand (kitchen on the break, anywhere after a foul, overlaps and pockets refused), wire schema | `8 ball setup and input` |
| 8 Ball rules: group assignment on an open table, keep the turn on a legal pot, scratch / no contact / wrong first contact / hit the 8 first on an open table / no rail / bad break fouls with ball in hand, the 8 early / wrong pocket / with a scratch loses, a called legal 8 wins, re-rack on the break, shot limit | `8 ball rules` |
| Darts: ring and sector reading for all 20 numbers, regulation order; 501 countdown, turn of three, bust restores the turn start, double-out and bull's eye, equal turns, fewer darts wins, draw, round cap | `darts board reading`, `darts 501` |
| Darts: around the clock in order, any ring counts, bulls last, no extras, round cap by progress; seeded wobble and fixed RNG draws; wire schema | `darts around the clock`, `darts schema and config` |
| Basketball physics: pure; every rack has a swish; short, long, off-line miss; bank shot; rim turns a ball away; always ends | `basketball physics` |
| Basketball match: five racks of five, turn order, money rack worth 2, score equals the shot records, wobble seeded and bounded, draw, schema | `basketball match` |
| Archery physics: a full draw lands on the aim in still air, wind direction and size, short draw drops and drifts, pure | `archery arrow flight` |
| Archery match: ring and X scoring, three ends of three, first shooter alternates, same wind for both, future winds hidden, tie-breaks (Xs, then draw), tremor seeded | `archery scoring`, `archery match` |
| All four: random legal play terminates, replay gives the same hash, JSON round trip, views serialise, illegal actions rejected, `apply` does not mutate | `engine contract: darts / archery / basketball / eight-ball` (contract harness) |
| All four: identical hash in the cross-runtime scenario (outcome, and the animation trace for Basketball and 8 Ball) | `pnpm test:determinism` (Node only; Deno and Hermes not yet run) |

## 3g. Phase 4 word and arcade engines and what proves them (ADR-029 to ADR-033)
`packages/games/src/{anagrams,filler,wordtiles,minigolf,tanks}`, 138 tests in the package, all pure (no DB). Each engine runs the shared contract harness (random legal play terminates, replay gives the same hash, init is deterministic, views are JSON, illegal actions are rejected) plus its own rules:

| Engine | Proven by |
|---|---|
| Anagrams | letters deterministic per seed and always hold a 6-letter word and never spell it already; `canSpell` counts letters; start → submit once; bad / unspellable / duplicate words; scoring 1/2/4/10; hidden letters until `start`; others' words hidden until you finish; injected word list changes id and results; draw on equal scores |
| Filler | grid has no touching same colours and different start colours; banned colours; region recolour, swallow and chaining; win at once above 28 cells; exactly half is not a win; full board draw; turn cap; `fillerAutoAction` always legal and greedy |
| Word Tiles | premium layout symmetric in 8 ways with the counted squares; 102-tile bag dealt exactly once; first move must cover the star and be 2+ tiles; every illegal-play code (not in line, gap, not connected, taken, duplicate, off board, tiles not in rack, invalid word with the word listed); main + cross-word scoring with premiums only under new tiles; blank = 0 and lower case; bingo +30; hook plays; exchange (bag ≥ 7, reshuffle, rack kept full); pass streak ends the game; going out takes racks; injected word set decides words; `wordTilesPlays` plays all validate; **view secrecy:** only your rack, bag count not order, no RNG, exchanged letters not in the move record |
| Mini Golf | nine holes inside the field, walls ≥ 12 cm, mirroring exact; physics pure, no mutation, power-distance relation, hole in one, walls / bumpers / sand / edge; 400 random putts never end inside a wall or outside the field; a beam search proves every hole holeable in ≤ 5 strokes; whole-hole turns, 6-stroke cap, nine holes with 2/3/4 players, fewest strokes win, ties; **view secrecy:** other players' putts on the current hole hidden until you finish it, others' balls never shown; `miniGolfAutoAction` always legal |
| Tanks | trig table within 1e-12 of `Math.sin/cos`, symmetric; terrain deterministic with pads; crater carving; shell pure, wind direction, power range, off-map shot, self-hit, damage falloff, weapons, settling; turn order, ammo, kill / suicide / double-kill draw, shot cap by hp; view has no RNG; `tanksAutoAction` harmless on most seeds |

Determinism: `src/determinism/wordarcade.ts` adds `anagrams`, `filler`, `wordtiles`, `minigolf` and `tanks` scenarios x 4 seeds (20 hashes, in `GOLDEN`); the Mini Golf and Tanks hashes are the **physics outcome hashes** (every putt / shell of a full game). They match across two runs in Node; Deno and Hermes runs are still to do (`pnpm -F @dyce/games determinism`, the app's `_dev/determinism` screen).

Not proven: the dictionary beyond the small in-repo list (a larger list is a server load, ADR-031); renderers; the match-service wiring (registry entries, migration, timeout actions, `db/tests` for Word Tiles' server-side word check).

## 3h. Board game engines and what proves them (ADR-035)

All in `packages/games/src/<game>/engine.test.ts`, each with the contract harness (random legal play terminates, replay gives an identical hash, JSON round trip, views serialise, illegal actions are rejected not thrown).

| Rule | Test |
| --- | --- |
| Move generator is exact: perft of the start position (depth 1-4), Kiwipete, positions 3, 4, 5 and 6 | `chess` perft |
| Castling both ways, never out of, through or into check, never after the king or rook moved; a captured rook loses the right | `chess` special moves |
| En passant only on the next move and never if it exposes the king; promotion needs a piece, four choices, by capture, black side | `chess` special moves |
| SAN: captures, check, mate, castling, promotion, disambiguation by file, rank and both; the Opera Game to mate | `chess` notation, purity |
| Checkmate, stalemate, insufficient material (bare kings, lone minor, same-colour bishops, not B v N), threefold, 50-move, mate beats 50-move, resign | `chess` end of the game |
| Forced capture, multi-jump in one action, no longest-capture rule, crowning ends the jump, kings both ways, men never backwards | `checkers` capture rules, kings |
| No legal move loses; 40-move and threefold draws; resign | `checkers` end of the game |
| Sowing, relay, capture opposite on an own-side empty pit, no capture on the opponent side, 12+ seeds skip the origin, 25 wins, out of seeds, move cap, seeds conserved over 120 random games | `ayo` Ayo rules |
| Kalah: extra turn, store skipping, capture plus the capturing seed, empty side banks the rest, 25 ends it | `ayo` Kalah rules |
| An extra turn on every box, one line closing two boxes, chained boxes, draw on an equal split, sizes 3-8 | `dotsandboxes` |
| Seeded die in order; no move before a roll; six to leave; extra roll on a six; three sixes pass; exact finish; capture of every opponent on a square; safe squares; own tokens stack; home column safe | `ludo` turn flow, movement |
| Winning, ranking by progress, `rankAll`, resign order, finished players skipped, RNG never in `view()`, `ludoAutoAction` plays whole games legally | `ludo` winning, resigning, view, auto play |
| Placement checks (count, bounds, overlap), simultaneous placing, seeded first shooter, hit / miss / sunk, no extra shot, salvo counts, win | `seabattle` placement, firing, salvo |
| **Hidden information:** the opponent and spectators never get your fleet during the game (also before the battle), a sunk ship becomes public, everyone sees both after the game | `seabattle` hidden information |
| Cross-runtime: 8 scripted scenarios x 4 seeds (chess, checkers, ayo, kalah, dotsandboxes, ludo, seabattle, seasalvo) | `pnpm test:determinism` |

Not proven: Deno and Hermes determinism runs, real boards on a device, the Ayo local-rules choices (ADR) with the product owner, and the match service running Sea Battle's simultaneous placement.

## 3i. Phase 4 catalogue on the match service (ADR-036)

`apps/api/db/tests/game-catalogue.test.ts`, real PostgreSQL, the real `MatchesService` and the real `ENGINES` registry.

| Rule | Test |
| --- | --- |
| All 23 games of GAMES.md have a `games` row with the right Pool minimum (kobo) | "has a row for each of the 23 games" |
| The 15 new rows are disabled, async, and hidden from `GET /games` | "keeps every new game disabled and hidden" |
| A disabled game cannot be created (`game_not_found`) | "refuses to create a disabled game" |
| An enabled row with no registry entry cannot be created or listed | "refuses an enabled row that has no engine" |
| Every registry key equals its engine's `slug`; every new row has an entry | "registers each engine under its own slug" |
| An enabled game is listed with its `poolMinKobo` | "shows a game in the drawer" |
| The Pool stake must reach the higher of the platform and game minimum, on create and on a counter (0 = free allowed) | "asks for the higher of the platform minimum and the game minimum" |
| Each new game: create, accept, one illegal move (refused, version unchanged), one legal move (applied) | `every new game can be created, accepted and played` (15 cases) |
| Word Tiles refuses a word not in the injected dictionary and plays a real one; the word list loads from a file only when both settings are given | "Word Tiles dictionary check" |
| Anagrams: a submit later than 60 s plus grace is stored as an empty submit and scores 0 | "Anagrams clock (screenAction)" |

Not proven: the 15 new games with a real client, Pool played through to a payout for them (their rows keep `supports_pool = false`), Ludo 3-4 live, the match service running Sea Battle's simultaneous placement past the first move.

## 3j. Groups, bots and message actions (ADR-038)

`apps/api/db/tests/groups.test.ts` (47 tests), real PostgreSQL, the real `MessagesService`, `GroupsService` and `MessageActionsService`, a recording publisher, the bots with a zero delay and `bots.idle()`. `messages.test.ts` keeps proving the direct-chat rules (one test now reads tombstones).

| Rule | Test |
| --- | --- |
| A creator is admin, "created the group" is posted, members are told live | "makes you the admin and posts ..." |
| Two others needed; duplicates and yourself do not count; strangers refused with the ids; blocked people look absent; 10 a day and 50 members are config; the title has a DB CHECK | "creating a group" (6) |
| Create is idempotent on the id; another person's id or a direct chat's id is taken | "is idempotent on the id ..." |
| Group messages reach every member; retries store one; another group's id is taken; list row has sender name and unread (system lines do not count); no read receipts; typing goes to the others | "messaging in a group" (6) |
| Messages from someone you blocked are hidden, not pushed, and not counted | "hides messages from people you blocked ..." |
| Outsiders, removed members and direct-only actions (accept, games) cannot touch a group | "only lets members in" |
| Member list with roles and your relationship; only admins add (friends only); a new member sees only later history; the 50 limit holds under two racing adds; remove ends access and re-adding resets history; admins cannot remove admins; only an admin steps down (never the last); rename for admins; leaving promotes the longest-standing member and is idempotent; direct chats are not groups | "members and admins" (9) |
| Replies quote sender and text, survive deletion of the original, must point at a live message of the same conversation, work in direct chats | "replies" (3) |
| Reactions count per key, replace your own, can be taken back, are limited to the fixed set (CHECK), need access (outsiders, removed, system lines, deleted), work in friend chats and are refused in an unaccepted request or after a block | "reactions" (4) |
| Delete for me hides only for you; for everyone wipes and leaves a tombstone, tells everyone and is idempotent; only your own text or poll inside the window (config); cards cannot be wiped; deleted messages still count against the stranger cap | "deleting messages" (5) |
| Polls: tallies and your vote, change and retract, idempotent id, invalid option, groups only, members only, deleted polls lose their votes, shared schema limits | "polls" (5) |
| Bots: four listed in order, greeting once and already read, not in All until used; a message is answered once from the script and a retried send does not double it; the quiz keeps its state; bots are private; reactions and replies work | "bots" (4) |
| Strangers never land in Chat: cannot be added by a non-friend; groups are not Requests | "strangers never land in Chat" (2) |

Not proven: 50 real members' fan-out under load, the WebSocket path for the new events (the publisher is a recorder; `realtime.test.ts` still covers the socket and the typing list), an LLM bot, a real client's long-press.

## 3k. Integrity layer and what proves it (ADR-039)

`db/tests/integrity.test.ts` (real PostgreSQL, ledger invariants after every money test), `integrity-callsites.test.ts`, `rate-limits.test.ts`, `src/integrity/integrity.test.ts` and `src/common/throttle-tracker.test.ts` (pure logic), `scripts/integrity-e2e.mjs` (real HTTP), and one live-room test in `apps/game-server/test/room.test.ts`.

| Rule | Test |
| --- | --- |
| A clean Pool match, a Free match and a retried settle go through `settle_or_hold` exactly like `settle_match` | "settle_or_hold" (3) |
| Each signal fires on its pattern and not on its near miss: pair repeats, one-sided, shared phone (60) and connection (25) with the window, feeder account and network, cheat reports, timing and repeated input per game rule (previous / own basis), a failed device check | "collusion signals" (6), "impossible timing" (4), "the gate" |
| A hold stops the payout and moves nothing; is judged once; release, void and disqualify pay or refund exactly and leave the ledger whole; the same decision twice replays and a different one is `hold_resolved`; three moderators at once decide once; a lapsed hold releases; forfeits stay forfeits | "a payout hold" (9) |
| The real call sites hold: a final move and a resign through `MatchesService`, a live room's forfeit in the game server; a clean match still pays at once; the card and view show `disputed` with no payout | `integrity-callsites.test.ts`, game-server `room.test.ts` |
| Quick match never pairs a shared device in Pool, but does in Free; the Pool-entry check knows Pool from Free by body, match and space code | "quick match and Pool entry" (2) |
| The device gate: fingerprints are hashes and counted, open when not required, fails closed when required (no token, bad token, a verifier that throws, the production stub), nonces stable per window and person, fingerprints deleted with the account and pruned | "the device integrity gate" (9), unit "attestation" |
| Spam filter: new account + mass sending filters the eighth chat and the recipient is not told live; the filtered request opens, can be accepted (then ordinary and never judged again) or declined; sticky; old accounts need a report or declines; contacts and mutual friends and friends are never filtered; the pure scoring table | "the request spam filter" (9), unit "scoreRequest" (7) |
| Moderation: queue listing with the evidence snapshot, warn / dismiss tell the reporter once in neutral words, a named moderator is required, mute blocks messages, friend requests and money requests (not play) and ends by time or lift, suspend ends sessions and freezes Pool and lifting restores both (without unfreezing what something else froze), a suspended person cannot sign in, signals and disputes reviewed and audited | "the moderation queue" (12) |
| Who may call what: the API role cannot decide holds, act on reports or read the views; the moderator role cannot read tables or reach money functions; the audit log cannot be changed even by a superuser; admin tokens parse and match | "permissions" (4), unit "admin tokens" |
| Rate limits: money requests a day (cancelled ones count, per person, per Lagos day); strangers' codes a day (same code free, friends, contacts and your own never counted, paying counts, per person) | `rate-limits.test.ts` (6) |
| Rate limits count accounts, not addresses, and a forged token does not borrow an allowance | unit `throttleTracker` (3), e2e "per-account rate limits" |
| The moderation API is off without its role and tokens, 401 for a missing, wrong or user token, 409 / 422 for the right reasons, audited, and production refuses `INTEGRITY_DRIVER=dev` | `integrity-e2e.mjs`, `env.test.ts` |

Not proven: thresholds against real play (there is none yet), Play Integrity and App Attest (the production driver is a stub), the app sending device headers, many API instances behind one load balancer, a moderator working a real queue for a week.

## 3l. Operations and what proves them (ADR-040)

| Claim | Proven by |
|---|---|
| Phone numbers (E.164, formatted, Nigerian local), JWTs, bearer tokens, URL credentials and sensitive keys and query parameters never reach a log, an alert or a Sentry event; ids, timestamps and amounts are left alone | unit `ops/redact.test.ts` (the contract for `packages/shared/src/redact.ts`) |
| One JSON line per event with service, release and request id; levels honoured; hostile request ids replaced; the access line has the route pattern and no query string; healthy probes are not logged | unit `ops/logger.test.ts` |
| Sentry is a complete no-op without a DSN; events are scrubbed (request data, user fields, text, breadcrumbs) | unit `ops/sentry.test.ts`, game server `ops.test.ts` |
| A bug answers 500 and is logged redacted with its request id and reported; expected errors keep their own answer and are not reported (the catch-all does not shadow `DyceErrorFilter`) | `scripts/ops-check.mjs` (a real Nest app on the built code; Jest cannot load ESM-only Nest) |
| The built API boots with Sentry off and with a dummy DSN, answers `/health`, `/health/live`, `/health/ready` (release and schema), echoes `X-Request-Id`, writes JSON logs, flips to draining on SIGTERM and exits 0 | `scripts/smoke.mjs` (the SIGTERM leg runs on Linux: CI and Docker) |
| The nightly check records a clean run, finds a planted wallet mismatch, freezes Pool, alerts critically, records the run; one runner at a time; the history is append-only for the API role; a "clean" row cannot contradict itself | db `ops-ledger-check.test.ts` (5), unit `ops/ledger-check.test.ts` (runner, alert webhook never throws, launch-gate evaluation: 14 days, a problem resets it, a missed night resets it, a stopped job fails it) |
| `deploy/production.env.example` documents every variable the API reads, is a valid production config once filled, and holds no secret-looking value | unit `config/env-example.test.ts` |
| The images build, the stack comes up in order (Postgres, migrate, API, game server), both probes answer, a stop exits 0 after a drain | `docker compose up -d --wait` (CI job `docker`) |

Not proven: anything on a real platform; the alert webhook against a real Slack or Discord; Sentry delivery; behaviour under load; restoring a backup; two API instances (one instance by design).

## 4. App-side tests
Screens, the app's use of the contracts, Maestro flows and the device matrix are in `../Dyce/docs/TEST_PLAN.md`.

## 5. Status
See `docs/STATUS.md`.
