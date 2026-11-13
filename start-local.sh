#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22.16+ or 24+ is required. Install Node.js, then run this file again." >&2
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm is required but was not found on PATH. Install pnpm, then run this file again." >&2
  exit 1
fi

exec node "$SCRIPT_DIR/scripts/dev-local.mjs" "$@"
