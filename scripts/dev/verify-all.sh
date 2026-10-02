#!/usr/bin/env bash
# Artflow unified verification entrypoint.
# Exit 0 only when every step succeeds.
set -uo pipefail

CORE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STUDIO="${ARTFLOW_STUDIO_DIR:-$CORE/../Artflow-studio}"
if [ ! -d "$STUDIO" ]; then
  echo "verify-all: studio checkout not found at $STUDIO (set ARTFLOW_STUDIO_DIR)" >&2
  exit 2
fi
STUDIO="$(cd "$STUDIO" && pwd)"
export ARTFLOW_STUDIO_DIR="$STUDIO"
LOG_DIR="${ARTFLOW_VERIFY_LOG_DIR:-$CORE/.artflow-dev/verify}"
SUMMARY_FILE="$LOG_DIR/verify-summary.txt"
mkdir -p "$LOG_DIR"

FAILED=0
declare -a STEPS=()

run_step() {
  local name="$1"
  shift
  echo ""
  echo "======== [$name] ========"
  local start
  start=$(date +%s)
  local rc=0
  if "$@"; then
    rc=0
  else
    rc=$?
  fi
  local end
  end=$(date +%s)
  local dur=$((end - start))
  if [ $rc -eq 0 ]; then
    echo "RESULT [$name] PASS (${dur}s)"
    STEPS+=("PASS  $name (${dur}s)")
  else
    echo "RESULT [$name] FAIL rc=$rc (${dur}s)"
    STEPS+=("FAIL  $name (${dur}s) rc=$rc")
    FAILED=1
  fi
  return $rc
}

# ---- helpers ----
core_npm_ci() {
  if [ ! -d "$CORE/node_modules" ] || [ "$CORE/package-lock.json" -nt "$CORE/node_modules/.package-lock.json" ]; then
    (cd "$CORE" && npm ci)
  else
    echo "core: node_modules up to date, skip npm ci"
  fi
}

studio_npm_ci() {
  if [ ! -d "$STUDIO/node_modules" ] || [ "$STUDIO/package-lock.json" -nt "$STUDIO/node_modules/.package-lock.json" ]; then
    (cd "$STUDIO" && npm ci)
  else
    echo "studio: node_modules up to date, skip npm ci"
  fi
}

echo "Artflow verify-all — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "CORE=$CORE"
echo "STUDIO=$STUDIO"

run_step "core:npm-ci" core_npm_ci
run_step "core:build" bash -c "cd '$CORE' && npm run build"
run_step "core:lint" bash -c "cd '$CORE' && npm run lint"
run_step "core:test:UTC" bash -c "cd '$CORE' && TZ=UTC npm test"
run_step "core:test:Asia/Shanghai" bash -c "cd '$CORE' && TZ=Asia/Shanghai npm test"

run_step "studio:npm-ci" studio_npm_ci
run_step "studio:build" bash -c "cd '$STUDIO' && npm run build"
run_step "studio:lint" bash -c "cd '$STUDIO' && npm run lint"
run_step "studio:test:UTC" bash -c "cd '$STUDIO' && TZ=UTC npx jest --ci"
run_step "studio:test:Asia/Shanghai" bash -c "cd '$STUDIO' && TZ=Asia/Shanghai npx jest --ci"

run_step "compose:validate" bash -c "if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then docker compose -f '$CORE/deploy/docker-compose.yml' config -q; else node '$CORE/scripts/dev/validate-compose.mjs'; fi"

run_step "e2e:playwright" bash -c "cd '$STUDIO' && ARTFLOW_FIXTURE_MODE=1 npx playwright test --project=chromium"

run_step "eval:ai" bash -c "cd '$CORE' && npm run eval:ai"
run_step "i18n:check" bash -c "cd '$STUDIO' && npm run check-translations"
run_step "secrets:scan" bash -c "node '$CORE/scripts/dev/scan-secrets.mjs'"

{
  echo "Artflow verify-all summary — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  for s in "${STEPS[@]}"; do
    echo "$s"
  done
  if [ $FAILED -eq 0 ]; then
    echo "OVERALL: PASS"
  else
    echo "OVERALL: FAIL"
  fi
} | tee "$SUMMARY_FILE"

echo ""
if [ $FAILED -eq 0 ]; then
  echo "verify-all: ALL GREEN"
  exit 0
fi
echo "verify-all: FAILURES PRESENT (see $SUMMARY_FILE)"
exit 1
