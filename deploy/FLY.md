# Deploying the backend to Fly.io

Two Fly apps per environment from this repository. **Production:** `dyce-backend` (the API, `apps/api/fly.toml`) and `dyce-game-server` (live rooms, `apps/game-server/fly.toml`). **Staging:** `dyce-backend-staging` and `dyce-game-server-staging` (`fly.staging.toml` next to each). Merges deploy them from GitHub (section 7); the commands below are the by-hand route. PostgreSQL is **not** run by these files: use a managed PostgreSQL 17 with point-in-time recovery in the
same region (`SETUP_GUIDE.md` section 3 in the app repo). Written 2026-11-25; **nothing here has been deployed yet**, so the first
deploy is also the test of this file (section 8).

## 1. What was wrong with the generated files (2026-11-16)

`fly launch` assumed a single-package project and generated `apps/api/fly.toml` plus a Dockerfile that built from `apps/api` alone. This is
a pnpm workspace: the API needs `packages/shared` and `packages/games`, so the **build context has to be the repository root**. Also:
the port was 8080 while the API listens on `PORT` (3000); `memory` and `memory_mb` contradicted each other (`memory_mb` is not a
documented key); `auto_stop_machines = 'stop'` with `min_machines_running = 0` would stop the API, which runs the nightly ledger check
and holds the live chat in memory; there was no health check, no graceful-shutdown signal (Fly's default SIGINT with 5 seconds cuts the
drain off), and `processes = ['app']` named a process group that does not exist.

## 2. One-time setup

```bash
fly auth login                                  # as the account that will own the apps
fly apps create dyce-backend --org <your-org>   # skip if `fly launch` already created it
fly apps create dyce-game-server --org <your-org>
fly apps create dyce-backend-staging --org <your-org>        # staging: the same again, with the secrets of the staging database
fly apps create dyce-game-server-staging --org <your-org>
```

Choose the region once (`primary_region = 'ams'` in both files) and keep it next to the database. Fly has no Lagos region; Amsterdam,
London and Madrid are the nearest European ones. If the database host is elsewhere, change both files to match it.

## 3. Secrets (never in a file)

Names are the ones in `deploy/production.env.example`; the comments there say which service reads which.

```bash
# API
fly secrets set --app dyce-backend \
  DATABASE_URL='postgres://<dyce_api login>@<host>/dyce' \
  MIGRATION_DATABASE_URL='postgres://<owner login>@<host>/dyce' \
  JWT_SECRET='<48+ random chars>' PHONE_HASH_SALT='<48+ random chars>' INTERNAL_SECRET='<48+ random chars>' \
  TERMII_API_KEY='...' TERMII_SENDER_ID='Dyce' \
  TWILIO_ACCOUNT_SID='...' TWILIO_AUTH_TOKEN='...' TWILIO_MESSAGING_SERVICE_SID='...' \
  RESEND_API_KEY='re_...' EMAIL_FROM='Dyce <login@mail.dyce.games>' \
  SENTRY_DSN='...' ALERT_WEBHOOK_URL='...'
# optional: EXPO_ACCESS_TOKEN, ADMIN_DATABASE_URL + ADMIN_TOKENS, LEDGER_CHECK_HEARTBEAT_URL, REVIEW_LOGINS (App Review demo accounts)

# Game server (the SAME INTERNAL_SECRET and JWT_SECRET as the API)
fly secrets set --app dyce-game-server \
  DATABASE_URL='postgres://<dyce_api login>@<host>/dyce' \
  JWT_SECRET='<same as the API>' INTERNAL_SECRET='<same as the API>' SENTRY_DSN='...'
```

`fly secrets set` restarts the app. Setting the secrets before the first deploy avoids a pointless restart. The API **refuses to start** in
production if anything required is missing (the message names the variable). Generate secrets with
`node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` and keep `PHONE_HASH_SALT` backed up separately.

## 4. Deploy

Run from the **repository root**. Deploy the **game server first** (the API only needs its address), the API second.

```bash
fly deploy --config apps/game-server/fly.toml --dockerfile apps/game-server/Dockerfile --remote-only \
           --build-arg RELEASE=$(git rev-parse --short=12 HEAD)
fly deploy --config apps/api/fly.toml --dockerfile apps/api/Dockerfile --remote-only \
           --build-arg RELEASE=$(git rev-parse --short=12 HEAD)
```

Check: `fly status --app dyce-backend`, then `curl https://dyce-backend.fly.dev/health/ready` (and the same for `dyce-game-server`).
Restarting the game server **forfeits every live Pool match** (`RUNBOOK.md` section 8 in the app repo): deploy it when few rooms are open.

## 5. Migrations (a deliberate step in production; automatic in staging)

Staging applies them by itself on every deploy (section 7). Production does not: this is the by-hand procedure, and what the deploy workflow waits for.

Before a deploy that carries a migration: take a database backup point, then run the migrations with the **owner** role, from the image that
is about to run (expand and contract rules: `RUNBOOK.md` section 4):

```bash
fly ssh console --app dyce-backend -C "node db/migrate.ts"
```

`db/migrate.ts` uses `MIGRATION_DATABASE_URL` (the owner role) when it is set and `DATABASE_URL` otherwise, and the machine carries both secrets. Deploy the new image **after** the migration for an
expand step, and the migration **after** the deploy for a contract step. To run migrations automatically on every deploy instead (staging),
copy the `[deploy]` block from `apps/api/fly.staging.toml` into `apps/api/fly.toml` (the deploy workflow's production guard then becomes redundant, not wrong).

## 6. Domains and certificates

```bash
fly certs add api.dyce.games  --app dyce-backend
fly certs add game.dyce.games --app dyce-game-server
```

Create the DNS records Fly prints (`SETUP_GUIDE.md` section 1), then `fly certs check <name>`. The app's `eas.json` already points
production at `https://api.dyce.games` and `wss://game.dyce.games`.

## 7. Deploying from GitHub (`.github/workflows/deploy-fly.yml`)

Two branches, two environments, the same model as the app (`Dyce/docs/CI_CD.md`):

| Merge into | Deploys                                                 | Approval                                                    | Migrations                                                                                                                                                                                                                                                              |
| ---------- | ------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `staging`  | `dyce-game-server-staging`, then `dyce-backend-staging` | none                                                        | **automatic**: Fly's `release_command` (`node db/migrate.ts`) runs before the new machine takes traffic; a failed migration stops the deploy                                                                                                                            |
| `main`     | `dyce-game-server`, then `dyce-backend`                 | **a person approves** (the `production` GitHub environment) | **never automatic**: the workflow **refuses** a release that adds a file under `apps/api/db/migrations` until you have taken a backup point and run them (section 5), then use _Run workflow_ on `main` with `environment = production` and `migrations_applied` ticked |

A merge runs CI first (`ci.yml`, called by the deploy workflow), then deploys the **game server first**, then the API. After each deploy the workflow
polls the app's `/health/ready` (up to 4 minutes) and fails unless it reports **this commit** (and, for the API, `"db":"up"`), so a rollback to the
old machine because of a failed health check shows up as a red run, not a green one. _Run workflow_ also lets you redeploy one service (`api` or `game-server`)
or deploy `main` to staging.

**Set it up once:**

1. Create the four Fly apps (section 2) and set their secrets (section 3; staging uses the staging database). Both API apps also need `MIGRATION_DATABASE_URL`
   (the owner role of that environment's database): staging uses it in the release command, production for the by-hand migrations.
2. Create deploy tokens, **one per app** (they cannot touch other apps): `fly tokens create deploy --app dyce-backend-staging` and the same for the other three.
3. In GitHub (Settings > Environments) create **`staging`** and **`production`**. On `production` add **required reviewers** (not only the person who merges).
   Add the environment secrets: `FLY_API_TOKEN_API` (the API app's token) and `FLY_API_TOKEN_GAME` (the game server's token), different values in each environment.
4. Set the repository variable **`FLY_DEPLOY` = `true`**. Until then the deploy jobs are skipped (CI still runs), so it is safe to merge before the accounts exist.
5. Protect `staging` and `main` and require the CI checks, as in the app's `CI_CD.md` section 5.

Deploying the game server restarts it and **forfeits every live Pool match** (`RUNBOOK.md` section 8): approve a production run when few rooms are open.

## 8. Limits, scaling and rollback

- **Exactly one machine per app** (`min_machines_running = 1`, auto-stop off). Do not run `fly scale count 2`: the chat hub and the rooms are in
  memory (`RUNBOOK.md` section 12). Vertical size is in the `[[vm]]` block; a file with `[[vm]]` resets any `fly scale vm` on the next deploy.
- **Roll back** by deploying the previous commit's image: `fly releases --app dyce-backend`, then
  `fly deploy --app dyce-backend --image registry.fly.io/dyce-backend:<previous deployment tag>`. A migration is never rolled back by this.
- The images can also be built by GitHub (`release-images.yml`, on a `v*` tag, to ghcr.io) and deployed with `--image`; that path is not wired up.
- Request concurrency limits (`soft_limit 200`, `hard_limit 400`) are a first guess: **to measure** with `scripts/load/`.

## 9. Not verified

- **The GitHub workflow has never run**, nor has any deploy, and `fly config validate` has not been run (flyctl is not installed on the machine this was written on).
  Run `fly config validate --config apps/api/fly.toml` and the same for the game server before the first deploy.
- **WebSockets through `[http_service]`**: Fly's HTTP proxy is documented as passing upgrades, but the pages read for this change did not say so.
  Test a live room through `wss://dyce-game-server.fly.dev` before pointing the domain at it.
- **Private-network address** `dyce-game-server.internal:2567`: Fly's internal DNS, same organisation; confirm with `fly ssh console` and a `curl`.
- **`kill_timeout`** is capped by Fly (300 s) and described as best-effort; 40 s is above the app's own 30 s shutdown budget.
- **Whether Fly is the right host** is not decided here: the same images run anywhere that runs Docker (`RUNBOOK.md` section 3).
