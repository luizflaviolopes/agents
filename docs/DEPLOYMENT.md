# Deploying Agent Fleet on a VPS

This guide walks through a production deploy on a fresh **Ubuntu 24.04** VPS
(any provider — Hetzner, DigitalOcean, Lightsail, etc.). 2 vCPU / 4 GB RAM is
a comfortable starting point; the worker's memory use scales with how many
agents run concurrently and how big the cloned repos are.

Prerequisite: you have already created the Supabase project and applied
`supabase/migrations/0001_init.sql` (see the [README](../README.md#setup) —
steps 1–4). Supabase is cloud-hosted; nothing database-related runs on the
VPS.

## 1. Install Docker

Use Docker's official apt repository (Ubuntu's `docker.io` package lags
behind):

```bash
# Docker's official install script (inspect it first if you prefer)
curl -fsSL https://get.docker.com | sudo sh

# let your user run docker without sudo (log out/in afterwards)
sudo usermod -aG docker $USER
```

Verify: `docker --version` and `docker compose version` (Compose v2 ships
with the Docker package as a plugin).

## 2. Clone and configure

```bash
git clone <your-fork-or-repo-url> agent-fleet
cd agent-fleet
cp .env.example .env
nano .env
```

Fill in every value (each is documented inline in `.env.example`). Two things
worth double-checking:

- `WEB_URL` should be the public URL users will reach the web app at
  (e.g. `https://fleet.example.com` once the reverse proxy below is set up).
  It's reserved for future use (links in Telegram messages) — nothing reads
  it yet, but keeping it accurate costs nothing.
- `WORKSPACES_ROOT` can stay at its local-dev default; docker-compose
  overrides it to `/data/workspaces` inside the worker container.

## 3. Build and start

```bash
docker compose up -d --build
```

First build takes a few minutes (dependency install + Next.js build). Then:

```bash
docker compose ps           # both services should be "running"
curl -I localhost:3000      # web should answer
```

Note: the `NEXT_PUBLIC_*` variables are baked into the web image at **build**
time. If you ever change them in `.env`, re-run with `--build`.

## 4. Updating

```bash
cd agent-fleet
git pull
docker compose build
docker compose up -d
```

Compose replaces only containers whose image changed. The `workspaces-data`
volume is untouched by rebuilds, so cloned repos survive updates. Database
schema changes ship as new files in `supabase/migrations/` — apply them with
`npx supabase db push` (or paste them into the SQL editor) **before** starting
the new containers.

## 5. Logs

```bash
docker compose logs -f worker      # agent runs, queue claims, Telegram, cloning
docker compose logs -f web         # Next.js server
docker compose logs -f --tail=200  # both, last 200 lines
```

The worker's stdout is operational logging only — the authoritative record of
what each agent did is the `run_logs` table in Supabase (browsable per run in
the web UI's log viewer).

## 6. Backups

- **Database (Supabase-managed):** all durable state — projects, agents,
  tasks, runs, logs, messages — lives in Supabase Postgres. Supabase takes
  daily backups on paid plans; check **Database → Backups** in the dashboard
  and consider enabling point-in-time recovery for anything you care about.
  Nothing on the VPS needs to be in a backup rotation.
- **Workspaces volume (disposable):** `workspaces-data` is a cache of
  `git clone`s. If it's lost, repos are simply re-cloned; don't bother
  backing it up. To wipe it deliberately:
  `docker compose down && docker volume rm agent-fleet_workspaces-data`
  (the prefix is the compose project name — check `docker volume ls`).
- **The `.env` file** is the one thing on the VPS worth keeping a secure
  copy of (it holds your keys and isn't in git).

## 7. Optional: HTTPS reverse proxy with Caddy

Point a DNS A record (e.g. `fleet.example.com`) at the VPS, then:

```bash
sudo apt install -y caddy
```

`/etc/caddy/Caddyfile`:

```caddyfile
fleet.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

```bash
sudo systemctl reload caddy
```

Caddy obtains and renews the Let's Encrypt certificate automatically. Two
follow-ups:

1. In `docker-compose.yml`, change the web port mapping to
   `"127.0.0.1:3000:3000"` so the app is only reachable through the proxy,
   and re-run `docker compose up -d`.
2. Set `WEB_URL=https://fleet.example.com` in `.env` (reserved for future
   Telegram links — nothing reads it yet, so no restart is needed).
3. Update the Site URL / redirect URLs in Supabase **Authentication → URL
   Configuration** to the new domain so auth emails and redirects work.

A basic firewall to finish:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

(Heads-up: Docker's published ports bypass ufw — that's another reason to
bind the web port to `127.0.0.1` once the proxy is in place. The worker
publishes no ports at all.)

## Security reminders

- The `service_role` key in `.env` bypasses RLS — the VPS is exactly as
  sensitive as your database. Restrict SSH (keys only), keep the system
  patched (`unattended-upgrades`), and don't run untrusted workloads next to
  the worker.
- Agents inside the worker container run with bypassed permission prompts.
  Treat the box as a trusted execution environment; a later hardening step is
  restricting the worker's outbound traffic to Anthropic, Supabase, GitHub,
  and Telegram.
