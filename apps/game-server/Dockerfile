# syntax=docker/dockerfile:1.7
#
# dyce-game-server production image (Colyseus, one room per live match). Build context is the REPOSITORY ROOT:
#
#   docker build -f apps/game-server/Dockerfile -t dyce-game-server --build-arg RELEASE=$(git rev-parse --short HEAD) .
#
# Run ONE instance until rooms are placed by a matchmaker (Dyce docs/RUNBOOK.md section 12): a room lives in one
# process's memory, and the API addresses the game server by a single URL.

ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN printf '\nsupportedArchitectures:\n  os: [linux]\n  cpu: [x64, arm64]\n  libc: [glibc]\n' >> pnpm-workspace.yaml
COPY packages/shared/package.json packages/shared/
COPY packages/games/package.json packages/games/
COPY apps/api/package.json apps/api/
COPY apps/game-server/package.json apps/game-server/

FROM base AS prod-deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    CI=true pnpm install --frozen-lockfile --ignore-scripts --prod --filter "@dyce/game-server..."

FROM base AS build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/game-server apps/game-server
RUN pnpm --filter "@dyce/game-server..." build

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ARG RELEASE=unknown
ENV NODE_ENV=production \
    RELEASE=${RELEASE} \
    PORT=2567
WORKDIR /app
COPY --from=prod-deps --chown=node:node /repo/node_modules ./node_modules
# pnpm puts the workspace links (@dyce/shared, @dyce/games) in the app's own node_modules.
COPY --from=prod-deps --chown=node:node /repo/apps/game-server/node_modules ./apps/game-server/node_modules
COPY --from=build --chown=node:node /repo/packages/shared/package.json ./packages/shared/package.json
COPY --from=build --chown=node:node /repo/packages/shared/dist ./packages/shared/dist
COPY --from=build --chown=node:node /repo/packages/games/package.json ./packages/games/package.json
COPY --from=build --chown=node:node /repo/packages/games/dist ./packages/games/dist
COPY --from=build --chown=node:node /repo/apps/game-server/package.json ./apps/game-server/package.json
COPY --from=build --chown=node:node /repo/apps/game-server/dist ./apps/game-server/dist
WORKDIR /app/apps/game-server
USER node
EXPOSE 2567
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||2567)+'/health/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/main.js"]
