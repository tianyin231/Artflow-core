#!/usr/bin/env bash
# Local process orchestration (no docker). Fail-fast + process-group cleanup.
set -euo pipefail
set -m  # job control so we can kill the process group

# Repo-relative: this script lives in Artflow-core/scripts/dev/.
CORE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# Studio checkout: $ARTFLOW_STUDIO_DIR, defaults to sibling ../Artflow-studio
STUDIO="${ARTFLOW_STUDIO_DIR:-$CORE/../Artflow-studio}"
# Local state (fixture data, logs); gitignored
DEV_DIR="${ARTFLOW_DEV_DIR:-$CORE/.artflow-dev}"
if [ ! -d "$STUDIO" ]; then
  echo "[dev-stack] ERROR: studio checkout not found at $STUDIO (set ARTFLOW_STUDIO_DIR)" >&2
  exit 1
fi
STUDIO="$(cd "$STUDIO" && pwd)"
FIXTURE=0
PROD=0
MOCK_PORT=3302
CORE_PORT=3300
STUDIO_PORT=5373

while [[ $# -gt 0 ]]; do
  case "$1" in
    --fixture) FIXTURE=1; shift ;;
    --prod) PROD=1; shift ;;
    --mock-port) MOCK_PORT="$2"; shift 2 ;;
    --core-port) CORE_PORT="$2"; shift 2 ;;
    --studio-port) STUDIO_PORT="$2"; shift 2 ;;
    *) echo "unknown arg $1"; exit 2 ;;
  esac
done

export HOST=127.0.0.1
export ARTFLOW_HOST=127.0.0.1

# Each background job runs in its own process group (set -m); remember the
# group leaders so cleanup can terminate the whole tree (node children included).
PIDS=()
cleanup() {
  trap - EXIT INT TERM
  echo ""
  echo "[dev-stack] cleanup (${#PIDS[@]} process groups)"
  for pid in "${PIDS[@]}"; do
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  done
  sleep 1
  for pid in "${PIDS[@]}"; do
    kill -KILL -- "-$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT INT TERM

port_busy() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltn "sport = :$port" 2>/dev/null | grep -q LISTEN
  else
    (echo >/dev/tcp/127.0.0.1/"$port") >/dev/null 2>&1
  fi
}

for p in "$MOCK_PORT" "$CORE_PORT" "$STUDIO_PORT"; do
  if port_busy "$p"; then
    echo "[dev-stack] ERROR: port $p already in use" >&2
    exit 1
  fi
done

if [ "$FIXTURE" = "1" ]; then
  export ARTFLOW_FIXTURE_MODE=1
  export ARTFLOW_PIXIV_PROVIDER=fixture
  export ARTFLOW_SKIP_EXTERNAL_BGM=1
  export ARTFLOW_DATA_DIR="${ARTFLOW_DATA_DIR:-$DEV_DIR/fixture-data}"
  # Python with moviepy for the moviepy renderer; optional (fast renderer needs only ffmpeg)
  if [ -z "${ARTFLOW_PYTHON:-}" ] && [ -x "$CORE/.venv/bin/python" ]; then
    export ARTFLOW_PYTHON="$CORE/.venv/bin/python"
  fi
  export ARTFLOW_LLM_BASE_URL="http://127.0.0.1:${MOCK_PORT}"
  export ARTFLOW_PIXIV_OAUTH_BASE_URL="http://127.0.0.1:${MOCK_PORT}"
  mkdir -p "$ARTFLOW_DATA_DIR"
fi

echo "[dev-stack] mock-servers :${MOCK_PORT}"
node "$CORE/test/mock-servers/index.mjs" --port "$MOCK_PORT" &
MOCK_PID=$!
PIDS+=("$MOCK_PID")
sleep 0.3
if ! kill -0 "$MOCK_PID" 2>/dev/null; then
  echo "[dev-stack] ERROR: mock server failed to start" >&2
  exit 1
fi

echo "[dev-stack] building core"
(cd "$CORE" && npm run build) || exit 1

export PORT="$CORE_PORT"
export ARTFLOW_CORE_PORT="$CORE_PORT"
export ARTFLOW_CONFIG="${ARTFLOW_CONFIG:-$ARTFLOW_DATA_DIR/config/standalone.config.json}"
if [ "$FIXTURE" = "1" ]; then
  mkdir -p "$(dirname "$ARTFLOW_CONFIG")"
  if [ ! -f "$ARTFLOW_CONFIG" ]; then
    cat > "$ARTFLOW_CONFIG" <<CFG
{
  "pixiv": {
    "clientId": "fixture", "clientSecret": "fixture", "deviceToken": "fixture",
    "refreshToken": "", "userAgent": "ArtflowFixture/1.0", "provider": "fixture"
  },
  "targets": [],
  "runtime": { "fixtureMode": true, "python": null, "timezone": "Asia/Tokyo" },
  "storage": {
    "downloadDirectory": "$ARTFLOW_DATA_DIR/downloads",
    "illustrationDirectory": "$ARTFLOW_DATA_DIR/downloads/illustrations",
    "novelDirectory": "$ARTFLOW_DATA_DIR/downloads/novels",
    "databasePath": "$ARTFLOW_DATA_DIR/artflow.db"
  }
}
CFG
  fi
fi

echo "[dev-stack] core :${CORE_PORT}"
(cd "$CORE" && node dist/webui/index.js) &
CORE_PID=$!
PIDS+=("$CORE_PID")
sleep 0.5
if ! kill -0 "$CORE_PID" 2>/dev/null; then
  echo "[dev-stack] ERROR: core failed to start" >&2
  exit 1
fi

if [ "$PROD" = "1" ]; then
  echo "[dev-stack] studio preview :${STUDIO_PORT}"
  (cd "$STUDIO" && npm run build && VITE_DEV_API_PORT="$CORE_PORT" VITE_DEV_API_HOST=127.0.0.1 npx vite preview --port "$STUDIO_PORT" --host 127.0.0.1 --strictPort) &
else
  echo "[dev-stack] studio dev :${STUDIO_PORT}"
  (cd "$STUDIO" && VITE_DEV_API_PORT="$CORE_PORT" VITE_DEV_API_HOST=127.0.0.1 npx vite --port "$STUDIO_PORT" --host 127.0.0.1 --strictPort) &
fi
STUDIO_PID=$!
PIDS+=("$STUDIO_PID")
sleep 1
if ! kill -0 "$STUDIO_PID" 2>/dev/null; then
  echo "[dev-stack] ERROR: studio failed to start" >&2
  exit 1
fi

node "$CORE/scripts/dev/wait-healthy.mjs" \
  --core "http://127.0.0.1:${CORE_PORT}" \
  --studio "http://127.0.0.1:${STUDIO_PORT}" \
  --timeout 60 || exit 1

echo "[dev-stack] ready: core=127.0.0.1:${CORE_PORT} studio=127.0.0.1:${STUDIO_PORT} mock=127.0.0.1:${MOCK_PORT}"
# Keep foreground
wait
