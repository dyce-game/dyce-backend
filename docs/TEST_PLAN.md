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
| Realtime hub and WebSocket server (auth frame, token expiry, typing, limits) | Jest + real sockets | `apps/api/src/chat/realtime.test.ts` | `pnpm test` |
| Auth + contacts + friends + messaging (incl. a live WebSocket) over real HTTP (whole journey, throttling, production-safety) | script | `apps/api/scripts/auth-e2e.mjs` | `pnpm -F @dyce/api e2e` |
| SMS providers, env validation, tokens, hashing | Jest | `apps/api/src/**/*.test.ts` | `pnpm test` |
| Money utils, config, phone/username/onboarding rules | Jest | `packages/shared/src/*.test.ts` | `pnpm test` |
| Engine contract + rules + RNG | Jest + fast-check | `packages/games/src/**` | `pnpm test` |
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
| Nightly invariant check finds a planted mismatch | `database-level safety › the invariant check finds a planted mismatch` |
| App role cannot write money tables or call admin functions | `database-level safety › the app role cannot…` |
| Ledger is append-only; unbalanced commit rejected; balance never negative | `database-level safety › …` |

## 4. App-side tests
Screens, the app's use of the contracts, Maestro flows and the device matrix are in `../Dyce/docs/TEST_PLAN.md`.

## 5. Status
See `docs/STATUS.md`.
