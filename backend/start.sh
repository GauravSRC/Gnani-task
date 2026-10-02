#!/usr/bin/env bash
# Production entry point on Render. The free tier has no free background
# workers, so the API and the worker run as two processes in one service.
# They share nothing except Postgres and the storage bucket.
set -uo pipefail

python -m app.worker &
worker=$!

uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-10000}" &
api=$!

# On shutdown (a deploy, a restart, the free instance going to sleep), pass the
# signal on and wait, so the worker can finish its part and requeue its job.
trap 'kill -TERM "$worker" "$api" 2>/dev/null; wait' TERM INT

# If either process dies on its own, stop the other and exit, so Render
# restarts the whole service instead of leaving it half-alive.
wait -n
status=$?
kill -TERM "$worker" "$api" 2>/dev/null
wait
exit "$status"