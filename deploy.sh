#!/usr/bin/env bash
# Agent Fleet — deploy (runs on the server, invoked over SSH by the Deploy
# workflow). Fleet convention: repo-root deploy.sh. Builds the web + worker
# images from this repo, then (re)starts both containers.
#
# Deviates from the repo's docker-compose.yml on purpose: on this host the web
# app is NOT published on a host port — it joins the shared `traefik-net`
# network and is routed by the fleet's Traefik instance, which terminates TLS
# with the wildcard *.jolifox.com origin certificate. The worker keeps its
# persistent workspaces volume exactly as compose defines it.
#
# The git sync is done by the workflow BEFORE this runs, so this tracked script
# isn't rewritten mid-execution. Secrets come from .env on disk (untracked).
set -euo pipefail

APP_DIR="/home/ubuntu/agents"
NETWORK="traefik-net"
DOMAIN="agents.jolifox.com"
ROUTER="agents"

WEB_IMAGE="agents-web";       WEB_CONTAINER="agents-web"
WORKER_IMAGE="agents-worker"; WORKER_CONTAINER="agents-worker"
WORKSPACES_VOLUME="agents-workspaces"

# --- failure diagnostics -----------------------------------------------------
# On ANY error (set -e) dump enough context to root-cause the failure straight
# from the CI log: which command/line failed, host memory & disk (the Next.js
# build can OOM/fill disk on this VPS), docker state, and recent logs.
dump_diagnostics() {
  local rc="$1" line="$2" cmd="$3"
  {
    echo ""
    echo "=================================================================="
    echo "!! DEPLOY FAILED — rc=${rc} at line ${line}"
    echo "!! last command: ${cmd}"
    echo "------------------------------------------------------------------"
    echo "== memory (free -m) =="; free -m || true
    echo "== disk (df -h /) ==";   df -h / || true
    echo "== docker disk usage =="; docker system df || true
    echo "== containers =="; docker ps -a --format 'table {{.Names}}\t{{.Status}}' || true
    echo "== web logs (tail 60) =="; docker logs --tail 60 "$WEB_CONTAINER" 2>&1 || true
    echo "== worker logs (tail 60) =="; docker logs --tail 60 "$WORKER_CONTAINER" 2>&1 || true
    echo "=================================================================="
  } >&2
}
trap 'dump_diagnostics "$?" "$LINENO" "$BASH_COMMAND"' ERR
# -----------------------------------------------------------------------------

cd "$APP_DIR"
SHA="$(git rev-parse --short HEAD)"

# --- env ---------------------------------------------------------------------
if [[ ! -f "$APP_DIR/.env" ]]; then
  echo "==> FAILED — $APP_DIR/.env is missing. Copy .env.example and fill it in." >&2
  exit 1
fi

# The NEXT_PUBLIC_* values are inlined into the client bundle at BUILD time, so
# they have to be read here and passed as --build-arg. Everything else is
# runtime-only and reaches the containers via --env-file.
# shellcheck disable=SC1091
set -a; . "$APP_DIR/.env"; set +a

for var in NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY \
           SUPABASE_SERVICE_ROLE_KEY ANTHROPIC_API_KEY; do
  if [[ -z "${!var:-}" ]]; then
    echo "==> FAILED — required variable $var is empty in $APP_DIR/.env" >&2
    exit 1
  fi
done

# --- build -------------------------------------------------------------------
# This host runs docker.io without the buildx plugin, so builds use the legacy
# builder. The Dockerfiles were adjusted accordingly (no `--mount=type=cache`);
# forcing DOCKER_BUILDKIT=1 here would fail with "buildx component is missing".
echo "==> [${SHA}] building web image..."
docker build \
  -f infra/web.Dockerfile \
  --build-arg "NEXT_PUBLIC_SUPABASE_URL=${NEXT_PUBLIC_SUPABASE_URL}" \
  --build-arg "NEXT_PUBLIC_SUPABASE_ANON_KEY=${NEXT_PUBLIC_SUPABASE_ANON_KEY}" \
  -t "$WEB_IMAGE" .

echo "==> [${SHA}] building worker image..."
docker build -f infra/worker.Dockerfile -t "$WORKER_IMAGE" .

# --- run ---------------------------------------------------------------------
echo "==> (re)starting web container behind Traefik..."
docker rm -f "$WEB_CONTAINER" 2>/dev/null || true
docker run -d \
  --name "$WEB_CONTAINER" --restart unless-stopped --network "$NETWORK" \
  --env-file "$APP_DIR/.env" \
  --label "traefik.enable=true" \
  --label "traefik.docker.network=${NETWORK}" \
  --label "traefik.http.routers.${ROUTER}.rule=Host(\`${DOMAIN}\`)" \
  --label "traefik.http.routers.${ROUTER}.entrypoints=web,websecure" \
  --label "traefik.http.routers.${ROUTER}.tls=true" \
  --label "traefik.http.services.${ROUTER}.loadbalancer.server.port=3000" \
  "$WEB_IMAGE"

echo "==> (re)starting worker container..."
docker rm -f "$WORKER_CONTAINER" 2>/dev/null || true
# Cloned workspace repos live in a NAMED volume (not a host bind mount): a fresh
# named volume inherits the image directory's ownership (node:node), so the
# unprivileged container user can write it. Same contract as docker-compose.yml.
docker run -d \
  --name "$WORKER_CONTAINER" --restart unless-stopped --network "$NETWORK" \
  --env-file "$APP_DIR/.env" \
  -e WORKSPACES_ROOT=/data/workspaces \
  -v "${WORKSPACES_VOLUME}:/data/workspaces" \
  "$WORKER_IMAGE"

# --- verify ------------------------------------------------------------------
echo "==> waiting for web readiness ..."
ok=""
for i in $(seq 1 90); do
  code="$(curl -sk -m 5 -o /dev/null -w '%{http_code}' -H "Host: ${DOMAIN}" https://127.0.0.1/ || true)"
  # Next.js serves the app (/ redirects to /login when signed out); any
  # non-5xx/000 response means the server is up and Traefik is routing to it.
  if [ -n "$code" ] && [ "$code" != "000" ] && [ "$code" -lt 500 ]; then
    ok=1; echo "==> web up after ${i}s (HTTP ${code})"; break
  fi
  sleep 1
done

if [ -z "$ok" ]; then
  echo "==> FAILED — web not responding after 90s." >&2
  dump_diagnostics 1 "$LINENO" "web readiness check timed out after 90s"
  exit 1
fi

# The worker has no HTTP surface — it consumes the Supabase task queue. A crash
# loop shows up as a non-running state within the first few seconds.
sleep 5
worker_state="$(docker inspect -f '{{.State.Status}}' "$WORKER_CONTAINER" 2>/dev/null || echo unknown)"
if [ "$worker_state" != "running" ]; then
  echo "==> FAILED — worker is '${worker_state}', expected 'running'." >&2
  dump_diagnostics 1 "$LINENO" "worker container not running after start"
  exit 1
fi
echo "==> worker status: ${worker_state}"

docker image prune -f >/dev/null 2>&1 || true
echo "==> OK — agents @ ${SHA} deployed (web @ https://${DOMAIN} + worker)."
