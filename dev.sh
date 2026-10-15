#!/usr/bin/env bash
# Run the whole thing locally: Supabase, the worker and the web app, from one terminal. Ctrl-C stops all three.
#   ./dev.sh
set -euo pipefail
cd "$(dirname "$0")"

busy() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
if busy 3001 || busy 8000; then
  echo "Something already listens on 3001 or 8000 (the web app or the worker is running). Stop it first." >&2
  exit 1
fi

# Supabase: start it unless its API already answers.
if ! busy 56321; then
  supabase start -x edge-runtime,logflare,vector,realtime,imgproxy
fi

# The worker (FastAPI, reloads on edits) and the web app (Next.js) side by side, each line tagged.
( cd worker && uv run uvicorn app.main:app --reload --port 8000 2>&1 | sed -u 's/^/[worker] /' ) &
( cd web && pnpm dev --port 3001 2>&1 | sed -u 's/^/[web]    /' ) &
trap 'echo; echo "Stopping."; kill 0' INT TERM
wait
