# Run and deploy (pnpm & Docker)

> Part of [PLAN.md](../PLAN.md) §5 (resolution R1) · Related: [tech-stack](./tech-stack.md) · [database](./database.md) · [auth-security](./auth-security.md)

The application can be run and deployed using either **pnpm scripts** (natively on Node.js) or **Docker Compose** (`compose.yaml`). Both paths avoid external database servers by utilizing SQLite in WAL mode.

## Processes and ports

| Process                 | Port          | Binds     | Notes                                                                                      |
| ----------------------- | ------------- | --------- | ------------------------------------------------------------------------------------------ |
| `apps/server` (Node.js) | 4000 (`PORT`) | 127.0.0.1 | REST, WebSocket `/ws`, SSE `/api/chat`; owns the SQLite file; ingestion in a worker thread |
| `apps/web` (Next.js)    | 3000          | 127.0.0.1 | Client-only editor                                                                         |
| Caddy (VPS only)        | 80 / 443      | public    | TLS, basic auth, routes `/ws*` and `/api/*` to :4000, everything else to :3000             |

Dev: the browser at `http://localhost:3000` calls the server at `NEXT_PUBLIC_API_BASE=http://localhost:4000` (cross-origin; the server allows `PUBLIC_ORIGIN`). Production: one origin through Caddy, `NEXT_PUBLIC_API_BASE` set to the empty string at build time (`deploy.sh` does this; unset would mean offline mode). In Docker, `compose.yaml` pins `HOST`, `PORT` and `DATA_DIR` for the container (they beat a copied `.env`), and `PUBLIC_ORIGIN` / `NEXT_PUBLIC_API_BASE` can be overridden from the shell for a domain (rebuild after changing the latter). Ports bind loopback only (`127.0.0.1:4000` and `127.0.0.1:3000`), safe behind Caddy or for local use.

## Configuration (`.env.example` at repo root)

| Key                                                                          | Default                                                                    | Meaning                                                                                                                                                                                            |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MODEL_API_KEY`                                                              | –                                                                          | Meta Model API key (all LLM/vision calls). Server only. Never in the browser, repo, logs or chat                                                                                                   |
| `META_API_BASE_URL`                                                          | `https://api.meta.ai/v1`                                                   | Meta OpenAI-compatible API endpoint                                                                                                                                                                |
| `OPENROUTER_API_KEY`                                                         | –                                                                          | Used exclusively for `baai/bge-m3` embeddings (`POST /api/v1/embeddings`) and M0 spike benchmarks                                                                                                  |
| `TUTOR_MODEL` · `TUTOR_MODEL_AR` · `TUTOR_FALLBACK_MODEL` · `REVIEWER_MODEL` | `muse-spark-1.3` · `muse-spark-1.3` · `muse-spark-1.3` · `muse-wonder-1.0` | Active Meta Model API models (open-weights Llama 4 supported via OpenRouter). _(S3 OpenRouter baseline: `anthropic/claude-haiku-5.5` · `google/gemini-3.8-flash` · `anthropic/claude-sonnet-5.5`)_ |
| `CHEAP_MODEL`                                                                | `muse-spark-1.3`                                                           | Summaries, rolling memory, TOC inference _(S3 baseline: `anthropic/claude-haiku-5.5`)_                                                                                                             |
| `VISION_MODEL`                                                               | `muse-spark-1.3`                                                           | Page transcription & canvas inspection _(S2 baseline: `google/gemini-3.8-flash`)_                                                                                                                  |
| `SNAPSHOT_ADAPTER`                                                           | `follow-up-user`                                                           | Delivery adapter for snapshots (`follow-up-user` required for Meta Model API; `tool-result-image` on OpenRouter)                                                                                   |
| `EMBED_MODEL` · `EMBED_DIMS`                                                 | `baai/bge-m3` · `1024`                                                     | Fixed per book once indexed (via OpenRouter `/api/v1/embeddings`)                                                                                                                                  |
| `DATA_DIR`                                                                   | `./data` (Docker: `/data`, VPS native: `/var/lib/whiteboard`)              | SQLite file, blobs, backups                                                                                                                                                                        |
| `PORT`                                                                       | `4000`                                                                     | Server port                                                                                                                                                                                        |
| `PUBLIC_ORIGIN`                                                              | `http://localhost:3000` (VPS: `https://<domain>`)                          | Allowed Origin for WebSocket and non-GET requests                                                                                                                                                  |
| `MAX_STEPS` · `MAX_TURN_COST_USD` · `DAILY_BUDGET_USD`                       | `12` · `0.50` · `5`                                                        | Tutor caps                                                                                                                                                                                         |
| `CHAPTER_STUFF_MAX_TOKENS`                                                   | `60000`                                                                    | Whole-chapter scope pack limit                                                                                                                                                                     |
| `TUTOR_STUB`                                                                 | `0`                                                                        | `1` replays scripted tool calls (tests)                                                                                                                                                            |

Web-only: `NEXT_PUBLIC_API_BASE` (in `apps/web/.env.local` or Docker build arg).

## Local Development

### Method A: pnpm scripts (native Node.js)

Prerequisites: Node 22+, pnpm 12 (`corepack enable`), a Meta API key (`MODEL_API_KEY`), and an OpenRouter key (`OPENROUTER_API_KEY`, for `baai/bge-m3` embeddings).

```bash
pnpm install
cp apps/server/.env.example apps/server/.env      # set MODEL_API_KEY and OPENROUTER_API_KEY
cp apps/web/.env.example apps/web/.env.local      # NEXT_PUBLIC_API_BASE=http://localhost:4000
pnpm dev                                         # web :3000, server :4000, data in ./data
```

Granular pnpm commands:
- `pnpm dev:web`: editor at `http://localhost:3000` (browser-only, persists in IndexedDB).
- `pnpm dev:server`: server on `:4000` (REST, WebSocket, SSE).
- "Prod-like" on the laptop: `pnpm build && pnpm start` (runs both `start` scripts; the web build needs `NEXT_PUBLIC_API_BASE` set in `apps/web/.env.local`). Both processes bind 127.0.0.1; no gate.

### Method B: Docker Compose

Prerequisites: Docker and Docker Compose.

```bash
cp apps/server/.env.example apps/server/.env      # set API keys
docker compose up --build                       # web on :3000, server on :4000, data in `whiteboard-data` volume
```

`NEXT_PUBLIC_API_BASE` is passed into the web build at build time (`compose.yaml`). Data persists inside the named volume `whiteboard-data` mapped to `/data`.

## VPS Deployment (Debian 12+/Ubuntu 24.04 LTS, glibc)

Size: 1 vCPU / 2 GB is enough for one student; 2 vCPU / 4 GB is comfortable for large ingests [estimate].

### Option 1: Native Node + systemd + Caddy

1. **User and dirs:** `adduser --system --group --home /opt/whiteboard whiteboard`; `mkdir -p /var/lib/whiteboard /etc/whiteboard`; `apt install sqlite3 rclone` (backup.sh needs the `sqlite3` CLI; `rclone` only for off-box copies); `chown whiteboard: /var/lib/whiteboard`.
2. **Node + pnpm:** Node 22 LTS (NodeSource apt repo or `fnm`), then `corepack enable` (pnpm version comes from `packageManager`).
3. **Code:** `git clone` into `/opt/whiteboard`; as the `whiteboard` user `pnpm install --frozen-lockfile && NEXT_PUBLIC_API_BASE= pnpm build` (the empty value makes the web client use the same origin).
4. **Env:** `/etc/whiteboard/env` (mode 0640, owner root:whiteboard) from `apps/server/.env.example` with `DATA_DIR=/var/lib/whiteboard`, `PUBLIC_ORIGIN=https://<domain>`.
5. **Units:** copy `deploy/whiteboard-server.service`, `whiteboard-web.service`, `whiteboard-backup.service` and `whiteboard-backup.timer` to `/etc/systemd/system/`; `systemctl enable --now` the two services and the timer.
6. **Caddy:** install from Caddy's official apt repository; put the Caddyfile at `/etc/caddy/Caddyfile`; `systemctl reload caddy`.
7. **Firewall:** `ufw allow 22,80,443/tcp`; nothing else. 3000/4000 stay on loopback.
8. **Backups:** `systemctl enable --now whiteboard-backup.timer` (see Backups below).

#### systemd unit (server; the web unit is the same shape)

```ini
[Unit]
Description=Whiteboard AI Companion server
After=network.target

[Service]
User=whiteboard
WorkingDirectory=/opt/whiteboard/apps/server
EnvironmentFile=/etc/whiteboard/env
ExecStart=/opt/whiteboard/apps/server/node_modules/.bin/tsx src/main.ts
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/whiteboard
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

Web unit: `WorkingDirectory=/opt/whiteboard/apps/web`, `ExecStart=/opt/whiteboard/apps/web/node_modules/.bin/next start -H 127.0.0.1 -p 3000`, plus `ReadWritePaths=/opt/whiteboard/apps/web/.next` (Next writes its cache there). The server runs from TypeScript through `tsx` (there is no `dist/`).

### Option 2: Docker Compose + Caddy

1. **Docker & Caddy:** Install Docker, Docker Compose, and Caddy via official packages.
2. **Code:** Clone into `/opt/whiteboard`.
3. **Env:** Configure `apps/server/.env` with your API keys, and export `PUBLIC_ORIGIN=https://<domain>` and `NEXT_PUBLIC_API_BASE=` (empty) in the shell before `docker compose up --build`; compose reads both from the shell.
4. **Run containers:**
   ```bash
   docker compose up -d --build
   ```
   Containers publish `127.0.0.1:4000` and `127.0.0.1:3000`.
5. **Caddy:** Place the Caddyfile template at `/etc/caddy/Caddyfile` (identical proxying to `127.0.0.1:4000` and `127.0.0.1:3000`), reload Caddy.
6. **Firewall:** `ufw allow 22,80,443/tcp`.

### Caddyfile (template; replace placeholders on the server)

```caddy
<domain> {
	basic_auth {
		<user> <bcrypt-hash>      # from `caddy hash-password`
	}
	handle /ws* {
		reverse_proxy 127.0.0.1:4000
	}
	handle /api/* {
		reverse_proxy 127.0.0.1:4000 {
			flush_interval -1     # never buffer the SSE chat stream
		}
	}
	handle {
		encode zstd gzip
		reverse_proxy 127.0.0.1:3000
	}
}
```

Caddy gets certificates automatically once DNS points at the VPS. Uploads are not size-limited by Caddy; the app enforces 200 MB.

## Deploying an update

### For native pnpm deployments:
`deploy/deploy.sh`, run from the laptop:

```bash
ssh <vps> 'cd /opt/whiteboard && git pull --ff-only \
  && pnpm install --frozen-lockfile && pnpm build \
  && sudo systemctl restart whiteboard-server whiteboard-web'
```

### For Docker Compose deployments:

```bash
ssh <vps> 'cd /opt/whiteboard && git pull --ff-only \
  && docker compose up -d --build'
```

On start the server runs pending migrations after performing an online backup of the DB via `VACUUM INTO 'DATA_DIR/backups/pre-migrate-<version>-<timestamp>.db'`. Rollback = `git checkout <tag>`, rebuild, restart; if a migration ran, restore the pre-migrate copy (migrations are forward-only).

## Backups

- `whiteboard-backup.timer` (daily 03:00) runs `deploy/backup.sh`: an online SQLite backup via `VACUUM INTO` to `DATA_DIR/backups/whiteboard-<date>.db` (keep 14), then `rclone copy` of `blobs/` (so deletions are not propagated) and `rclone sync` of `backups/` to an off-box remote (if `RCLONE_REMOTE` is set). For Docker, backup targets the `/data` volume directory or runs against the `whiteboard-data` volume.
- Restore drill (do once in M7): stop both units / containers → replace `whiteboard.db` → restore `blobs/` → start → open an old board and a book.
- Book originals are in `blobs/`, so extracted text, chunks and summaries can be rebuilt; boards and chats exist only in the DB. The DB backup is the one that matters.

## Operations

- Logs: `journalctl -u whiteboard-server -f` (systemd) or `docker compose logs -f server` (Docker). Logs never contain keys, prompts or book text (see [auth-security](./auth-security.md)).
- Health: `GET /api/health` (DB open, migrations current, `MODEL_API_KEY` and `OPENROUTER_API_KEY` present).
- Disk: watch `blobs/` (context pictures and page rasters accumulate; no garbage collection in v1, add a cleanup script when it passes ~5 GB).
- Upgrading Node (native): install the new LTS, `pnpm install --frozen-lockfile` (native modules re-fetch prebuilt binaries), restart.

## Open items

- Static export / Vite SPA to remove the `web` unit: decide in M0 (S5 dry-run shows how much it saves).
- WebSocket through basic auth: browsers should resend cached credentials on same-origin handshakes. **[spike S5]** If not, fall back to Tailscale-only access or a signed cookie issued after the basic-auth page load.
