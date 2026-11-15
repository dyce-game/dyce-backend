# dyce-backend

The backend of [Dyce](../Dyce): a NestJS API on PostgreSQL, plus the two packages the app and the server must agree on.

```
apps/api            REST + WebSocket API, SQL migrations, database tests
packages/shared     zod schemas, money and formatting, config (the app links this)
packages/games      game rules engines, deterministic and pure (the app links this)
docs/               architecture, wallet and ledger, backend decisions, test plan, status
```

## Run it
```
pnpm install
pnpm -F @dyce/api db:dev                # embedded PostgreSQL on :54329 (no Docker needed)
cp apps/api/.env.example apps/api/.env  # set DATABASE_URL=postgres://dyce_app:dyce_app@localhost:54329/dyce,
                                        # OTP_TEST_CODE=424242 and CORS_ORIGINS=http://localhost:8081
pnpm -F @dyce/api dev
```

## Check it
```
pnpm test && pnpm test:db && pnpm e2e
pnpm lint && pnpm typecheck && pnpm format:check
```

## Working with the app
The Expo app is the sibling repo `../Dyce`. It depends on `packages/shared` and `packages/games` through `link:../dyce-backend/packages/*`, so **keep both folders side by side**. Run `pnpm install` here before `pnpm install` there, and read ADR-011 in `docs/DECISIONS.md`.

See `CLAUDE.md` for the rules, `docs/STATUS.md` for where things stand.
