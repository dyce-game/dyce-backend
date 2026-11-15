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

## 4. App-side tests
Screens, the app's use of the contracts, Maestro flows and the device matrix are in `../Dyce/docs/TEST_PLAN.md`.

## 5. Status
See `docs/STATUS.md`.
