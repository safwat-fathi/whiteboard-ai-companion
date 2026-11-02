#!/usr/bin/env bash
set -euo pipefail

TARGET="${1:-${DEPLOY_HOST:-}}"
if [[ -z "${TARGET}" ]]; then
  echo "Usage: $0 <user@host> (or set DEPLOY_HOST)" >&2
  exit 1
fi

ssh "${TARGET}" 'cd /opt/whiteboard && git pull --ff-only \
  && pnpm install --frozen-lockfile && pnpm build \
  && sudo systemctl restart whiteboard-server whiteboard-web'
