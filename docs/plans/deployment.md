# Run and deploy (no Docker)

> Part of [PLAN.md](../PLAN.md) §5 (resolution R1) · Related: [tech-stack](./tech-stack.md) · [database](./database.md) · [auth-security](./auth-security.md)

Everything runs natively. Locally it is Node + pnpm. On a VPS it is Node + systemd + Caddy. No containers, no database server.

## Processes and ports

| Process                | Port          | Binds     | Notes                                                                                      |
| ---------------------- | ------------- | --------- | ------------------------------------------------------------------------------------------ |
| `apps/server` (NestJS) | 4000 (`PORT`) | 127.0.0.1 | REST, WebSocket `/ws`, SSE `/api/chat`; owns the SQLite file; ingestion in a worker thread |
| `apps/web` (Next.js)   | 3000          | 127.0.0.1 | Client-only editor                                                                         |
| Caddy (VPS only)       | 80 / 443      | public    | TLS, basic auth, routes `/ws*` and `/api/*` to :4000, everything else to :3000             |

Dev: the browser at `http://localhost:3000` calls the server at `NEXT_PUBLIC_API_BASE=http://localhost:4000` (cross-origin; the server allows `PUBLIC_ORIGIN`). Production: one origin through Caddy, `NEXT_PUBLIC_API_BASE` empty.

## Configuration (`deploy/.env.example`)

| Key                                                    | Default                                                   | Meaning                                               |
| ------------------------------------------------------ | --------------------------------------------------------- | ----------------------------------------------------- |
| `OPENROUTER_API_KEY`                                   | –                                                         | Server only. Never in the browser, repo, logs or chat |
| `TUTOR_MODEL` · `TUTOR_MODEL_AR` · `TUTOR_FALLBACK_MODEL` · `REVIEWER_MODEL` | `anthropic/claude-haiku-5.5` · `google/gemini-3.8-flash` · the other tutor · `anthropic/claude-sonnet-5.5` | S3: English / Arabic / retry / optional reviewer |
| `CHEAP_MODEL`                                          | `anthropic/claude-haiku-5.5`                              | Summaries, rolling memory, TOC inference              |
| `VISION_MODEL`                                         | `google/gemini-3.8-flash`                                 | Page transcription (rung R4)                          |
| `EMBED_MODEL` · `EMBED_DIMS`                           | `baai/bge-m3` · `1024`                                    | Fixed per book once indexed                           |
| `DATA_DIR`                                             | `./data` (VPS: `/var/lib/whiteboard`)                     | SQLite file, blobs, backups                           |
| `PORT`                                                 | `4000`                                                    | Server port                                           |
| `PUBLIC_ORIGIN`                                        | `http://localhost:3000` (VPS: `https://<domain>`)         | Allowed Origin for WebSocket and non-GET requests     |
| `MAX_STEPS` · `MAX_TURN_COST_USD` · `DAILY_BUDGET_USD` | `12` · `0.50` · `5`                                       | Tutor caps                                            |
| `CHAPTER_STUFF_MAX_TOKENS`                             | `60000`                                                   | Whole-chapter scope pack limit                        |
| `TUTOR_STUB`                                           | `0`                                                       | `1` replays scripted tool calls (tests)               |

Web-only: `NEXT_PUBLIC_API_BASE` (in `apps/web/.env.local`).

## Local

Prerequisites: Node 22+, pnpm 12 (`corepack enable`), an OpenRouter key. Nothing else.

```
pnpm install
cp deploy/.env.example .env      # set OPENROUTER_API_KEY
pnpm dev                         # web :3000, server :4000, data in ./data
```

"Prod-like" on the laptop: `pnpm build && pnpm start`. Both processes bind 127.0.0.1; no gate.

## VPS (Debian 12+/Ubuntu 24.04 LTS, glibc)

Size: 1 vCPU / 2 GB is enough for one student; 2 vCPU / 4 GB is comfortable for large ingests [estimate].

1. **User and dirs:** `adduser --system --group --home /opt/whiteboard whiteboard`; `mkdir -p /var/lib/whiteboard /etc/whiteboard`; `chown whiteboard: /var/lib/whiteboard`.
2. **Node + pnpm:** Node 22 LTS (NodeSource apt repo or `fnm`), then `corepack enable` (pnpm version comes from `packageManager`).
3. **Code:** `git clone` into `/opt/whiteboard`; as the `whiteboard` user `pnpm install --frozen-lockfile && pnpm build`.
4. **Env:** `/etc/whiteboard/env` (mode 0640, owner root:whiteboard) from `.env.example` with `DATA_DIR=/var/lib/whiteboard`, `PUBLIC_ORIGIN=https://<domain>`.
5. **Units:** copy `deploy/whiteboard-server.service` and `whiteboard-web.service` to `/etc/systemd/system/`; `systemctl enable --now` both.
6. **Caddy:** install from Caddy's official apt repository; put the Caddyfile at `/etc/caddy/Caddyfile`; `systemctl reload caddy`.
7. **Firewall:** `ufw allow 22,80,443/tcp`; nothing else. 3000/4000 stay on loopback.
8. **Backups:** enable `whiteboard-backup.timer` (below).

### systemd unit (server; the web unit is the same shape)

```
[Unit]
Description=Whiteboard AI server
After=network.target

[Service]
User=whiteboard
WorkingDirectory=/opt/whiteboard/apps/server
EnvironmentFile=/etc/whiteboard/env
ExecStart=/usr/bin/node dist/main.js
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/whiteboard
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

Web unit: `WorkingDirectory=/opt/whiteboard/apps/web`, `ExecStart=` runs `next start -H 127.0.0.1 -p 3000` from the workspace's `node_modules/.bin` **[verify path in S5]**.

### Caddyfile (template; replace placeholders on the server)

```
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

`deploy/deploy.sh`, run from the laptop:

```
ssh <vps> 'cd /opt/whiteboard && git pull --ff-only \
  && pnpm install --frozen-lockfile && pnpm build \
  && sudo systemctl restart whiteboard-server whiteboard-web'
```

On start the server runs pending migrations after copying the DB to `DATA_DIR/backups/pre-migrate-<version>.db`. Rollback = `git checkout <tag>`, rebuild, restart; if a migration ran, restore the pre-migrate copy (migrations are forward-only).

## Backups

- `whiteboard-backup.timer` (daily 03:00) runs `deploy/backup.sh`: an online SQLite backup via better-sqlite3's `backup()` to `DATA_DIR/backups/whiteboard-<date>.db` (keep 14), then `rclone sync` of `blobs/` and `backups/` to an off-box remote.
- Restore drill (do once in M7): stop both units → replace `whiteboard.db` → restore `blobs/` → start → open an old board and a book.
- Book originals are in `blobs/`, so extracted text, chunks and summaries can be rebuilt; boards and chats exist only in the DB. The DB backup is the one that matters.

## Operations

- Logs: `journalctl -u whiteboard-server -f`. Logs never contain keys, prompts or book text (see [auth-security](./auth-security.md)).
- Health: `GET /api/health` (DB open, migrations current, OpenRouter key present).
- Disk: watch `blobs/` (context pictures and page rasters accumulate; no garbage collection in v1, add a cleanup script when it passes ~5 GB).
- Upgrading Node: install the new LTS, `pnpm install --frozen-lockfile` (native modules re-fetch prebuilt binaries), restart.

## Open items

- Static export / Vite SPA to remove the `web` unit: decide in M0 (S5 dry-run shows how much it saves).
- WebSocket through basic auth: browsers should resend cached credentials on same-origin handshakes. **[spike S5]** If not, fall back to Tailscale-only access or a signed cookie issued after the basic-auth page load.
