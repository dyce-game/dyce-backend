# dyce-backend — project rules for Claude Code

This is the **backend** of Dyce, a chat-first mobile app for playing games with friends, family and strangers (Nigeria first; every user starts with **₦200k Dyce Cash**, virtual). The Expo app lives in the sibling repo `../Dyce`; product docs, the build plan and the design are there too.

Source of truth, in this order (read the relevant ones before changing anything):

1. `../Dyce/docs/SPEC.md` — what the product does (features, rules, copy).
2. `docs/ARCHITECTURE.md` — stack, repo layout, data model, realtime, game engine contract.
3. `docs/WALLET_AND_QR.md` — ledger, Pool money rules, QR request/scan-to-pay.
4. `../Dyce/docs/GAMES.md` — game catalogue and per-game rules.
5. `docs/DECISIONS.md` — backend ADRs. `../Dyce/docs/BUILD_PLAN.md` and `../Dyce/docs/STATUS.md` — phases and where we are.

If the docs and the design disagree, the docs win. If the docs are silent, pick the simplest option, write it down in `docs/DECISIONS.md` (ADR style, one paragraph), and continue.

## What is in this repo
```
apps/api            NestJS API (REST + WebSocket /realtime) on PostgreSQL. SQL migrations in db/migrations, tests in db/tests
apps/game-server    Colyseus realtime game server: one room per live match (Whot! first, ADR-022)
packages/shared     zod schemas, money + formatting utils, query keys, config. Linked by the app
packages/games      Pure TypeScript rules engines + the GameEngine contract. Linked by the app
```
pnpm workspaces + Turborepo. Node 22+. **`packages/shared` and `packages/games` are consumed by the Expo app as source, by path** (`link:../dyce-backend/packages/*`, ADR-011). A change there changes the app too: keep them free of Node, DOM and React Native APIs, keep relative imports ending in `.ts` (ADR-005), and say in the commit message when an app change is needed.

## Stack (do not swap without an ADR)
- **API (ADR-004):** NestJS on **plain PostgreSQL** with **plain SQL migrations**. No Supabase. NestJS owns auth (phone OTP via Termii/Twilio, JWT access + refresh), contact matching, messaging, moves for async games, QR requests, invites and push. Money and game moves only change through Postgres functions called by NestJS services; the API role has no direct write access to ledger tables.
- **Realtime chat:** a `ws` endpoint on the same HTTP server (ADR-010). **Realtime games:** Colyseus (separate app) verifying the NestJS-issued JWT.
- **Validation:** zod schemas in `packages/shared`, used by the API and the app.
- **Quality:** Jest (+ real PostgreSQL for `db/tests`), fast-check for engines, ESLint, Prettier.
- Nest services that hold logic are plain classes (no Nest imports) so they are tested without Nest; controllers, guards and modules stay thin.

## Non-negotiables
- **Money is integer kobo** (`bigint` in Postgres, `number` safe-range in TS via the `Kobo` branded type). Never floats. Display through `formatNaira()` in `packages/shared`.
- **Every money movement is a double-entry ledger transaction** created by a Postgres function with an idempotency key. Balances can never go negative. The API role never writes ledger tables directly.
- **Dyce Cash is virtual and cannot be withdrawn or bought.** No cash-out, card payments or real-money top-ups. If a task seems to need one, stop and raise it.
- **Game outcomes are decided by the server.** The client renders and predicts; the server validates every move with `packages/games`, and physics games re-simulate from the submitted input and the match seed.
- **Strangers never land in Chat.** Anything from someone who isn't a friend goes to Requests until accepted (ADR-010).
- Privacy: phone numbers are stored only as salted (keyed) hashes for contact matching (E.164 via libphonenumber-js before hashing); never log them. Follow the Nigeria Data Protection Act 2023 notes in the SPEC.
- Anything that moves money, changes match state or decides who can see what needs tests for success, the failure paths, idempotent retry, and concurrency.

## Conventions
- Migrations: one per change, numbered, never edited after merge. Constraints and functions are the last line of defence; services check membership, blocks and limits first.
- Errors: expected failures are `AuthError`-style typed errors `{ code, message }`; add the code, its HTTP status and the app's copy together.
- Commits: Conventional Commits. Small PRs, one feature per branch.
- Tests: money functions need success, insufficient funds, idempotent retry and concurrent double-spend. Engines need a unit test per rule and a property test.

## Commands
```
pnpm install
pnpm -F @dyce/api db:dev       # embedded PostgreSQL on :54329 with migrations applied (no Docker)
pnpm -F @dyce/api dev          # build + run the API (see apps/api/.env.example)
pnpm test                      # unit tests (shared, games, api)
pnpm test:db                   # database integration tests on a real PostgreSQL (embedded unless TEST_DATABASE_ADMIN_URL is set)
pnpm e2e                       # whole HTTP + WebSocket journey against the built API
pnpm lint && pnpm typecheck && pnpm format:check
```

## How to work here
- Before a task: read the doc sections it touches. After: run lint, typecheck and the tests for the area, then update `docs/` (and `../Dyce/docs/STATUS.md` if behaviour changed).
- If a task needs an app change, describe it (or make it in `../Dyce` as a separate commit); never leave the app broken by a contract change.
- The agents in `.claude/agents/` are the same roles as in the app repo; each owns an area.
- When unsure whether something is in scope, check the SPEC. If it isn't there, it's out of scope: add it to `docs/BACKLOG.md`.
