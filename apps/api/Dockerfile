# syntax=docker/dockerfile:1.7
#
# dyce-api production image. The build context is the REPOSITORY ROOT:
#
#   docker build -f apps/api/Dockerfile -t dyce-api --build-arg RELEASE=$(git rev-parse --short HEAD) .
#
# The same image runs three things (override the command):
#   node dist/main.js                       the API (default)
#   node db/migrate.ts                      apply migrations (needs the OWNER role's URL as DATABASE_URL)
#   node db/ledger-gate.ts                  is the "ledger clean for 14 days" launch gate met?
#
# Node >= 22.18 strips TypeScript types natively, which is how db/*.ts runs without a build step.

ARG NODE_VERSION=22

# ---- base: node + pnpm at the version pinned by package.json ("packageManager") ---------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
# Linux images only need Linux binaries. Without this pnpm also downloads the Windows and macOS builds of
# embedded-postgres and turbo (large, and never used here). The workspace file itself stays untouched for developers.
RUN printf '\nsupportedArchitectures:\n  os: [linux]\n  cpu: [x64, arm64]\n  libc: [glibc]\n' >> pnpm-workspace.yaml
COPY packages/shared/package.json packages/shared/
COPY packages/games/package.json packages/games/
COPY apps/api/package.json apps/api/
COPY apps/game-server/package.json apps/game-server/

# ---- prod-deps: runtime dependencies only. Depends on the manifests alone, so a source change never redoes it ----
FROM base AS prod-deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    CI=true pnpm install --frozen-lockfile --ignore-scripts --prod --filter "@dyce/api..."

# ---- build: all dependencies, then compile shared, games and the api ---------------------------------------------
FROM base AS build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/api apps/api
RUN pnpm --filter "@dyce/api..." build

# ---- runtime: node_modules from prod-deps, compiled code from build ---------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ARG RELEASE=unknown
ENV NODE_ENV=production \
    RELEASE=${RELEASE} \
    PORT=3000 \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning
WORKDIR /app
# The workspace packages are linked by relative symlinks, so they go at the same relative paths as in the repository.
COPY --from=prod-deps --chown=node:node /repo/node_modules ./node_modules
# pnpm puts the workspace links (@dyce/shared, @dyce/games) in the app's own node_modules.
COPY --from=prod-deps --chown=node:node /repo/apps/api/node_modules ./apps/api/node_modules
COPY --from=build --chown=node:node /repo/packages/shared/package.json ./packages/shared/package.json
COPY --from=build --chown=node:node /repo/packages/shared/dist ./packages/shared/dist
COPY --from=build --chown=node:node /repo/packages/games/package.json ./packages/games/package.json
COPY --from=build --chown=node:node /repo/packages/games/dist ./packages/games/dist
COPY --from=build --chown=node:node /repo/apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=node:node /repo/apps/api/dist ./apps/api/dist
COPY --from=build --chown=node:node /repo/apps/api/db ./apps/api/db
WORKDIR /app/apps/api
USER node
EXPOSE 3000
# Liveness only (never the database): restarting the API cannot fix a database outage.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/main.js"]
