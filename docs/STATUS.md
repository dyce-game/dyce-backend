# Status: backend

Last updated: 2026-11-15, at the split from the original monorepo (ADR-011). Program-level status and the phase plan are in `../Dyce/docs/STATUS.md` and `../Dyce/docs/BUILD_PLAN.md`.

## Done and verified (all run in this repo on its own)
- **Unit tests: 142** (unchanged by wallet; its tests are in the database suite). `@dyce/shared` 72 (money, `formatNaira`, payouts, config, phone, username, auth, onboarding, contacts, friends, messages schemas), `@dyce/games` 18 (engine contract, seeded RNG, example engine, contract harness; determinism script passes), `@dyce/api` 52 (SMS providers, env validation, tokens, hashing, error mapping, realtime hub and WebSocket server).
- **Database: 11 migrations, 269 integration tests** on real PostgreSQL as the restricted app role: ledger and Pool money rules (57), OTP/sessions (31), profile/onboarding/age gate (23), contacts and friend requests (27), friends list/accept/ignore/remove (27), messaging (45), wallet (36), block and report (23).
- **HTTP journey** (`pnpm e2e`): sign-in, username, contacts, friends, a real chat over a real WebSocket, onboarding, refresh rotation, logout, throttling, and "no phone number in the log". **Boot smoke** (`/health`) passes.
- **Wallet API (ADR-012):** `/wallet` summary, top-up, send, requests by code, pay, cancel, history, receipts, plus money cards in chats. 32 DB tests: balance and limits, send (card posted once, idempotent retry, key scoping, friends/contacts/accepted chats only, blocked, insufficient funds, over limits, two spends of the last naira), requests (QR vs chat expiry, server-side Pay view, stranger pays into Requests, paid/cancelled/expired, paying twice, two payers racing, any-amount rules, not-for-you, 10-open cap, blocked looks missing), history filters and paging, receipt privacy, ledger invariants after it all. The HTTP e2e runs send, request, pay and receipts for real.
- **Block and report (ADR-013):** `/blocks` (list, block, unblock) and `/reports`. 23 DB tests: block is silent, idempotent and one-way in effect; it removes the friendship and pending requests and unblocking doesn't restore them; it hides the chat and stops messages, money, friend requests and typing; unblock brings the chat back once friends again; reports with the conversation attached store the latest 20 messages as a snapshot that survives deletion, refuse conversations that aren't yours or messages from another chat, are deduplicated within 24 hours, are rate limited per day, and survive the reported person being disabled or blocking the reporter. The HTTP e2e runs report, block, "blocked person can't reach you", list and unblock.
- Auth + OTP (ADR-007), contacts matching (ADR-008), friends (ADR-009), messaging and realtime (ADR-010): details, limits and what was checked are in those ADRs and in `../Dyce/docs/STATUS.md`.
- Lint, Prettier, typecheck and builds are clean.

## Written but not verified
- **SMS delivery.** Termii and Twilio adapters are unit-tested for request shape only; neither has sent a real SMS.
- **The realtime hub is single-process.** More than one API instance needs Redis pub/sub first (ADR-010).
- GitHub Actions workflow (never run; there is no remote yet).
- Nothing here has been run against a hosted PostgreSQL or behind a real load balancer (`TRUST_PROXY_HOPS`).

## Not done
- Block/report: a moderation queue and any action on a report, outcome notifications, a Pool hold on a report, game moves as evidence, spam filtering of requests from reported users.
- Wallet: biometric/PIN confirmation, a per-day cap on resolving strangers' codes, personal "My code" and paying it, a scheduled expiry job, push for money, disputes; push registration and dispatch; account deletion; SMS invites and invite links.
- `apps/game-server` (Colyseus); matches and async game moves in the API; physics determinism spike and ADR; Deno and Hermes determinism runs.
- Messaging beyond 1:1 text (groups, bots, reactions, replies, deletes, voice, photos): see `docs/BACKLOG.md`.
- Seeds from `Dyce/assets/avatar-profiles`; Sentry and structured logging.

## Dev notes
- No Docker needed: `pnpm -F @dyce/api db:dev` starts an embedded Postgres on :54329 with migrations applied. Then `cp apps/api/.env.example apps/api/.env`, set `DATABASE_URL=postgres://dyce_app:dyce_app@localhost:54329/dyce`, `OTP_TEST_CODE=424242` and `CORS_ORIGINS` to the app's web origin, and run `pnpm -F @dyce/api dev`.
- pnpm 11 reads its settings from `pnpm-workspace.yaml` (hoisted linker, `verifyDepsBeforeRun: false`, `allowBuilds`).
- If `embedded-postgres` can't download its binary on a flaky network, fetch the tarball directly and extract it into `node_modules/@embedded-postgres/windows-x64`, or set `TEST_DATABASE_ADMIN_URL` to any local Postgres.

## Next
Whatever the lead picks from `../Dyce/docs/BUILD_PLAN.md`; the server-side candidates are the wallet endpoints, block/report, and push.
