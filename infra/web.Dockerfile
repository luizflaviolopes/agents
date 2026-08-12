# syntax=docker/dockerfile:1

# =============================================================================
# Agent Fleet — @agent-fleet/web (Next.js 15)
#
# Multi-stage build:
#   base    -> node:22-slim with pnpm 9.15.0 activated via corepack
#   deps    -> installs workspace dependencies (manifests only => cached layer)
#   build   -> runs `next build`, then produces a pruned production bundle
#              with `pnpm deploy` (app + production node_modules only)
#   runtime -> slim image that just runs `next start` as a non-root user
#
# Build from the REPO ROOT so the whole pnpm workspace is in context:
#   docker build -f infra/web.Dockerfile \
#     --build-arg NEXT_PUBLIC_SUPABASE_URL=... \
#     --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=... .
# (docker-compose.yml wires the build args from .env automatically.)
#
# RUNTIME env: the container also needs SUPABASE_SERVICE_ROLE_KEY (and
# ANTHROPIC_API_KEY for the agent-builder route) at RUNTIME — the web
# server's API routes perform all data access with the service-role key.
# docker-compose passes these via `env_file: .env`; they are NOT build args
# and are never baked into the client bundle.
# =============================================================================

# ---- base: Node 22 + pnpm via corepack --------------------------------------
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
# corepack reads `"packageManager": "pnpm@9.15.0"` from package.json; prepare
# the exact version now so later stages never bootstrap pnpm off the network.
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

# ---- deps: install node_modules from manifests only -------------------------
FROM base AS deps
# Copy manifests first: this layer is only invalidated when dependencies
# change, not on every source edit.
COPY package.json pnpm-workspace.yaml ./
# Glob tolerates a missing lockfile (handled explicitly below).
COPY pnpm-lock.yaml* ./
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
# Install the web app plus everything it depends on ("..." = with workspace
# dependencies, i.e. @agent-fleet/shared). Prefer a reproducible frozen
# install; fall back to a plain install if the lockfile has not been
# committed yet (see README — commit pnpm-lock.yaml for reproducible builds).
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && \
    if [ -f pnpm-lock.yaml ]; then \
      pnpm install --frozen-lockfile --filter "@agent-fleet/web..."; \
    else \
      echo "WARNING: pnpm-lock.yaml missing — running a non-reproducible install" && \
      pnpm install --filter "@agent-fleet/web..."; \
    fi

# ---- build: compile the app and prune to a production bundle ----------------
FROM deps AS build
# NEXT_PUBLIC_* values are inlined into the client JS bundle at BUILD time,
# so they must arrive as build args (not just runtime env).
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
    NEXT_TELEMETRY_DISABLED=1
COPY turbo.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN pnpm --filter @agent-fleet/web build
# `pnpm deploy` writes a self-contained copy of the app to /out with ONLY its
# production dependencies; workspace deps (@agent-fleet/shared) are packed in
# as real packages. Assumes apps/web/package.json has no restrictive "files"
# field, so next.config.*, public/, etc. are all included by default rules.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter @agent-fleet/web deploy --prod /out
# .next/ is a build artifact (gitignored / not packed) — copy the freshly
# built one into the bundle explicitly so packing rules can't drop it.
RUN rm -rf /out/.next && cp -R apps/web/.next /out/.next

# ---- runtime: minimal image, non-root ---------------------------------------
FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /out .
# "node" is the unprivileged user that ships with the official image.
USER node
EXPOSE 3000
# Contract with @agent-fleet/web: "start" runs `next start` (binds 0.0.0.0:3000).
# npm ships with the base image, so no corepack needed at runtime.
CMD ["npm", "run", "start"]
