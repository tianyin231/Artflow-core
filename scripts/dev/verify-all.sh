#!/usr/bin/env bash
# Artflow unified verification entrypoint. Every required step must succeed.
set -uo pipefail

CORE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STUDIO="${ARTFLOW_STUDIO_DIR:-$CORE/../Artflow-studio}"
if [ ! -d "$STUDIO" ]; then
  echo "verify-all: studio checkout not found at $STUDIO (set ARTFLOW_STUDIO_DIR)" >&2
  exit 2
fi
STUDIO="$(cd "$STUDIO" && pwd)"
export ARTFLOW_STUDIO_DIR="$STUDIO"
export ARTFLOW_CORE_DIR="$CORE"
LOG_DIR="${ARTFLOW_VERIFY_LOG_DIR:-$CORE/.artflow-dev/verify}"
SUMMARY_FILE="$LOG_DIR/verify-summary.txt"
mkdir -p "$LOG_DIR" || exit 2

FAILED=0
STEPS=()

run_step() {
  local name="$1"
  shift
  echo ""
  echo "======== [$name] ========"
  local start end rc log
  start=$(date +%s)
  log="${name//[:\/]/-}.log"
  "$@" 2>&1 | tee "$LOG_DIR/$log"
  rc=$?
  end=$(date +%s)
  if [ "$rc" -eq 0 ]; then
    echo "RESULT [$name] PASS ($((end - start))s)"
    STEPS+=("PASS  $name ($((end - start))s)")
  else
    echo "RESULT [$name] FAIL rc=$rc ($((end - start))s)"
    STEPS+=("FAIL  $name ($((end - start))s) rc=$rc")
    FAILED=1
  fi
  return "$rc"
}

in_repo() {
  local repo="$1"
  shift
  (cd "$repo" && "$@")
}

npm_ci() {
  local repo="$1"
  if [ ! -d "$repo/node_modules" ] || [ ! -f "$repo/node_modules/.package-lock.json" ] || [ "$repo/package-lock.json" -nt "$repo/node_modules/.package-lock.json" ]; then
    in_repo "$repo" npm ci
  else
    echo "$repo: node_modules up to date, skip npm ci"
  fi
}

validate_compose() {
  # Always check service/build inputs; compose config alone accepts missing files.
  node "$CORE/scripts/dev/validate-compose.mjs" || return $?
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    docker compose -f "$CORE/deploy/docker-compose.yml" config -q
  fi
}

echo "Artflow verify-all — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "CORE=$CORE"
echo "STUDIO=$STUDIO"

run_step "core:npm-ci" npm_ci "$CORE"
run_step "core:build" in_repo "$CORE" npm run build
run_step "core:lint" in_repo "$CORE" npm run lint
# Isolate native better-sqlite3 state: Jest runInBand can abort on Node 24 when
# database suites share the same process; fresh workers also bound memory use.
run_step "core:test:UTC" in_repo "$CORE" env TZ=UTC npm exec -- jest --ci --maxWorkers=2 --workerIdleMemoryLimit=128MB
run_step "core:test:Asia/Shanghai" in_repo "$CORE" env TZ=Asia/Shanghai npm exec -- jest --ci --maxWorkers=2 --workerIdleMemoryLimit=128MB
run_step "core:tooling" in_repo "$CORE" node --test scripts/dev/__tests__/tooling.test.mjs

run_step "studio:npm-ci" npm_ci "$STUDIO"
run_step "studio:build" in_repo "$STUDIO" npm run build
run_step "studio:lint" in_repo "$STUDIO" npm run lint
run_step "studio:test:UTC" in_repo "$STUDIO" env TZ=UTC npm test -- --ci --runInBand
run_step "studio:test:Asia/Shanghai" in_repo "$STUDIO" env TZ=Asia/Shanghai npm test -- --ci --runInBand

run_step "compose:validate" validate_compose
run_step "e2e:playwright" in_repo "$STUDIO" env ARTFLOW_FIXTURE_MODE=1 npm run test:e2e -- --project=chromium
run_step "eval:ai" in_repo "$CORE" npm run eval:ai
run_step "i18n:check" in_repo "$STUDIO" npm run check-translations
run_step "secrets:scan" node "$CORE/scripts/dev/scan-secrets.mjs"

{
  echo "Artflow verify-all summary — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  for s in "${STEPS[@]}"; do echo "$s"; done
  if [ "$FAILED" -eq 0 ]; then echo "OVERALL: PASS"; else echo "OVERALL: FAIL"; fi
} | tee "$SUMMARY_FILE"
if [ "$FAILED" -eq 0 ]; then
  echo "verify-all: ALL GREEN"
  exit 0
fi
echo "verify-all: FAILURES PRESENT (see $SUMMARY_FILE)"
exit 1
