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

## 4. App-side tests
Screens, the app's use of the contracts, Maestro flows and the device matrix are in `../Dyce/docs/TEST_PLAN.md`.

## 5. Status
See `docs/STATUS.md`.
