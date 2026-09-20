# syntax=docker/dockerfile:1.7
#
# Bullpane — one image, two targets.
#
#   docker build -t bullpane .                       # dashboard (default target: runner)
#   docker build -t bullpane-sim --target simulator . # demo traffic generator
#
# Workspace packages (shared, redis-inspector) are consumed as TypeScript source
# and the inspector loads its .lua files from disk, so the server runs through
# `tsx` at runtime instead of a bundled dist. tsx + typescript therefore stay in
# the runner image on purpose. Only the web UI is pre-built (static files).

ARG NODE_IMAGE=node:22-alpine
ARG PNPM_VERSION=10.4.1

# ---------------------------------------------------------------------------
# base: node + pnpm via corepack
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /app

# ---------------------------------------------------------------------------
# deps: install the whole workspace (dev deps included — needed to build web)
# ---------------------------------------------------------------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/server/package.json   apps/server/
COPY apps/web/package.json      apps/web/
COPY apps/simulator/package.json apps/simulator/
COPY packages/shared/package.json          packages/shared/
COPY packages/redis-inspector/package.json packages/redis-inspector/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# build: compile the React UI to static files
# ---------------------------------------------------------------------------
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/web ./apps/web
RUN pnpm --filter @bullpane/web build

# ---------------------------------------------------------------------------
# runner: server + built UI. Web's build-time deps (vite, react, tailwind) are
# left out by filtering the install; tsx/typescript stay (see header).
# ---------------------------------------------------------------------------
FROM base AS runner
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    WEB_DIST=/app/apps/web/dist
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY apps/server/package.json    apps/server/
COPY apps/web/package.json       apps/web/
COPY apps/simulator/package.json apps/simulator/
COPY packages/shared/package.json          packages/shared/
COPY packages/redis-inspector/package.json packages/redis-inspector/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter '!@bullpane/web' --filter '!@bullpane/simulator'
COPY packages ./packages
COPY apps/server ./apps/server
COPY --from=build /app/apps/web/dist ./apps/web/dist
RUN addgroup -S bullpane && adduser -S bullpane -G bullpane && chown -R bullpane:bullpane /app
USER bullpane
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=5 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" >/dev/null || exit 1
CMD ["pnpm", "--filter", "@bullpane/server", "start"]

# ---------------------------------------------------------------------------
# simulator: demo traffic generator (no MySQL, no UI — just bullmq + ioredis)
# ---------------------------------------------------------------------------
FROM base AS simulator
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY apps/server/package.json    apps/server/
COPY apps/web/package.json       apps/web/
COPY apps/simulator/package.json apps/simulator/
COPY packages/shared/package.json          packages/shared/
COPY packages/redis-inspector/package.json packages/redis-inspector/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @bullpane/simulator...
COPY apps/simulator ./apps/simulator
RUN addgroup -S bullpane && adduser -S bullpane -G bullpane && chown -R bullpane:bullpane /app
USER bullpane
CMD ["pnpm", "--filter", "@bullpane/simulator", "start"]
