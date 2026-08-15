# syntax=docker/dockerfile:1

# =============================================================================
# Agent Fleet — @agent-fleet/worker (Node 22 service)
#
# Runs the task-queue consumer, the Claude Agent SDK runtime, the Telegram
# bot, and repo cloning. The Claude Agent SDK is a normal npm dependency
# (@anthropic-ai/claude-agent-sdk) bundled via node_modules — no Claude Code
# CLI install is required — but agents DO shell out to `git` and `ripgrep`,
# so those are installed in the runtime image.
#
# Multi-stage build:
#   base    -> node:22-slim with pnpm 9.15.0 activated via corepack
#   deps    -> installs workspace dependencies (manifests only => cached layer)
#   build   -> runs the worker build (tsc, as a compile gate), then produces a
#              pruned production bundle with `pnpm deploy`
#   runtime -> node:22-slim + git/ripgrep/ca-certificates, non-root
#
# NOTE: @agent-fleet/shared ships raw .ts via its package exports, so the
# runtime executes the worker with tsx over source (`tsx src/index.ts`)
# rather than plain `node dist/index.js` — tsx is a production dependency.
#
# Build from the REPO ROOT so the whole pnpm workspace is in context:
#   docker build -f infra/worker.Dockerfile .
# =============================================================================

# ---- base: Node 22 + pnpm via corepack --------------------------------------
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

# ---- deps: install node_modules from manifests only -------------------------
FROM base AS deps
COPY package.json pnpm-workspace.yaml ./
# Glob tolerates a missing lockfile (handled explicitly below).
COPY pnpm-lock.yaml* ./
COPY apps/worker/package.json apps/worker/
COPY packages/shared/package.json packages/shared/
# Install the worker plus its workspace dependencies (@agent-fleet/shared).
# NOTE: no `--mount=type=cache` for the pnpm store — the production host builds
# with the legacy (non-BuildKit) builder, which rejects cache mounts. The store
# lives in the image layer instead; the layer itself is still cached, so a build
# that doesn't touch the manifests reuses it.
RUN pnpm config set store-dir /pnpm/store && \
    if [ -f pnpm-lock.yaml ]; then \
      pnpm install --frozen-lockfile --filter "@agent-fleet/worker..."; \
    else \
      echo "WARNING: pnpm-lock.yaml missing — running a non-reproducible install" && \
      pnpm install --filter "@agent-fleet/worker..."; \
    fi

# ---- build: compile TS and prune to a production bundle ---------------------
FROM deps AS build
COPY turbo.json ./
COPY packages/shared packages/shared
COPY apps/worker apps/worker
# Contract with @agent-fleet/worker: "build" runs tsc. The compiled dist/ is
# not shipped — this step is kept purely as a compile/typecheck gate so a
# broken worker fails the image build instead of failing at container start.
RUN pnpm --filter @agent-fleet/worker build
# Self-contained production bundle: worker package + production node_modules
# (including @anthropic-ai/claude-agent-sdk, tsx, and the packed
# @agent-fleet/shared — whose raw .ts sources tsx executes directly).
RUN pnpm --filter @agent-fleet/worker deploy --prod /out
# Make sure the worker's TypeScript sources are present in the bundle — the
# runtime runs tsx over src/, not a compiled dist/.
RUN rm -rf /out/src && cp -R apps/worker/src /out/src

# ---- runtime: slim + git/ripgrep, non-root ----------------------------------
FROM node:22-slim AS runtime
# Tools the agent runtime shells out to:
#   git             — cloning workspace repos + agents working in them
#   ripgrep         — fast code search used by Claude Agent SDK sessions
#   ca-certificates — TLS for git-over-HTTPS and outbound API calls
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ripgrep ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    # Where workspace repos live; docker-compose mounts a named volume here.
    WORKSPACES_ROOT=/data/workspaces \
    # Never let git hang waiting for interactive credentials inside the
    # container — private repos must authenticate via GITHUB_TOKEN.
    GIT_TERMINAL_PROMPT=0
WORKDIR /app
# Pre-create the workspaces root owned by the runtime user. On first use the
# named volume is initialized from this directory, so ownership carries over.
RUN mkdir -p /data/workspaces && chown -R node:node /data/workspaces
COPY --from=build --chown=node:node /out .
USER node
# Contract with @agent-fleet/worker: "start" runs `tsx src/index.ts`.
CMD ["npm", "run", "start"]
