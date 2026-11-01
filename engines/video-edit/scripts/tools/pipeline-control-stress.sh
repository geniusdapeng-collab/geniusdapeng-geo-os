#!/bin/zsh
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NODE_BIN="${WORKLOOM_NODE_BIN:-$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node}"
PG_BIN="${WORKLOOM_PG_BIN:-$HOME/.local/pg17/bin}"
MODE="all"
PLANS="13"
CASES="64"

while (( $# > 0 )); do
  case "$1" in
    --mode) MODE="$2"; shift 2 ;;
    --plans) PLANS="$2"; shift 2 ;;
    --cases) CASES="$2"; shift 2 ;;
    *) print -u2 "unknown argument: $1"; exit 2 ;;
  esac
done

cd "$ROOT"
if [[ "$MODE" == "catalog" ]]; then
  exec "$NODE_BIN" --import tsx scripts/tools/pipeline-plan-stress.mts \
    --mode "$MODE" --plans "$PLANS" --cases "$CASES"
fi

[[ -x "$NODE_BIN" ]] || { print -u2 "Node runtime missing: $NODE_BIN"; exit 2; }
[[ -x "$PG_BIN/postgres" ]] || { print -u2 "PostgreSQL runtime missing: $PG_BIN"; exit 2; }

PG_ROOT="$(mktemp -d /tmp/pm-pipeline-control-stress.XXXXXX)"
PG_DATA="$PG_ROOT/data"
PG_SOCKET="$PG_ROOT/socket"
PORT=""

cleanup() {
  if [[ -f "$PG_DATA/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$PG_DATA" -m fast -w stop >/dev/null 2>&1 || true
  fi
  if [[ -d "$PG_ROOT" ]]; then
    find "$PG_ROOT" -xdev -depth -delete
  fi
}
trap cleanup EXIT INT TERM

for candidate in {55700..55780}; do
  if ! nc -z 127.0.0.1 "$candidate" >/dev/null 2>&1; then
    PORT="$candidate"
    break
  fi
done
[[ -n "$PORT" ]] || { print -u2 "No free PostgreSQL stress port"; exit 2; }

mkdir -p "$PG_SOCKET"
"$PG_BIN/initdb" -D "$PG_DATA" -U postgres --auth=trust --encoding=UTF8 --locale=C >/dev/null
"$PG_BIN/pg_ctl" -D "$PG_DATA" -l "$PG_ROOT/postgres.log" -w \
  -o "-p $PORT -h 127.0.0.1 -k $PG_SOCKET" start >/dev/null
"$PG_BIN/createdb" -h 127.0.0.1 -p "$PORT" -U postgres workloom_pipeline_stress

APP_PASSWORD="$(openssl rand -hex 18)"
GATEWAY_PASSWORD="$(openssl rand -hex 18)"
export DATABASE_URL="postgres://postgres@127.0.0.1:$PORT/workloom_pipeline_stress"
export DATABASE_APP_URL="postgres://workloom_app:$APP_PASSWORD@127.0.0.1:$PORT/workloom_pipeline_stress"
export DATABASE_GATEWAY_URL="postgres://workloom_gateway:$GATEWAY_PASSWORD@127.0.0.1:$PORT/workloom_pipeline_stress"
export APP_DB_PASSWORD="$APP_PASSWORD"
export GATEWAY_DB_PASSWORD="$GATEWAY_PASSWORD"
export WORKLOOM_TEST_ADMIN_URL="$DATABASE_URL"
export WORKLOOM_TEST_APP_PASSWORD="$APP_PASSWORD"
export WORKLOOM_TEST_GATEWAY_PASSWORD="$GATEWAY_PASSWORD"
export HR_WORK_DIR="$PG_ROOT/work"

unset VOLCENGINE_ARK_API_KEY SEEDANCE_ENDPOINT DEEPSEEK_API_KEY LLM_API_KEY

"$NODE_BIN" --import tsx scripts/migrate.ts >/dev/null
"$NODE_BIN" --import tsx scripts/tools/pipeline-plan-stress.mts \
  --mode "$MODE" --plans "$PLANS" --cases "$CASES"
PATH="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" \
  ./node_modules/.bin/vitest run --maxWorkers=1 --no-file-parallelism \
    packages/video-pipeline/src/test/catalog.test.ts \
    packages/pipeline-control/src/test/feature-flags.test.ts \
    apps/server/src/video/pipeline/control-mode.test.ts \
    apps/server/src/video/pipeline/pipeline-repository.pg.test.ts \
    apps/server/src/video/pipeline/pipeline-control-stress.pg.test.ts
PATH="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" \
  ./node_modules/.bin/tsc --noEmit -p packages/video-pipeline/tsconfig.json
PATH="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" \
  ./node_modules/.bin/tsc --noEmit -p packages/pipeline-control/tsconfig.json
PATH="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" \
  ./node_modules/.bin/tsc --noEmit -p apps/server/tsconfig.json
