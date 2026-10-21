#!/usr/bin/env bash
set -Eeuo pipefail
history_server="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$history_server/.."
history_artifact="$history_server/test-artifacts/dispatch-all-history-20261002"
history_environment="$history_server/tools/dispatch-all-history-environment.sh"
test -s "$history_artifact/source.dump"
if [[ ! -d "$history_artifact/final-source" ]]; then bash "$history_environment" freeze; fi
export DISPATCH_ALL_HISTORY_SOURCE_ROOT="$history_artifact/final-source"
export DISPATCH_ALL_HISTORY_IMAGE=mbbs-regular-v2:e2e
test -d "$history_artifact/workspace-baseline/src"
export DISPATCH_ALL_HISTORY_BASELINE_ROOT="$history_artifact/workspace-baseline"

# Baseline failures are recorded for comparison, never replaced with skips.
bash "$history_environment" baseline-exec node tools/dispatch-all-history-bounded-command.mjs npm test > "$history_artifact/full-workspace-baseline.log" 2>&1 || true
bash "$history_environment" candidate-exec node tools/dispatch-all-history-bounded-command.mjs npm test > "$history_artifact/full-candidate.log" 2>&1 || true
for history_kind in baseline candidate; do
  bash "$history_environment" "$history_kind-exec" node tools/dispatch-all-history-bounded-command.mjs node test/support/run-dispatch-performance-tests.mjs \
    unit property adversarial frontend integration concurrency > "$history_artifact/dispatch-$history_kind.log" 2>&1 || true
  bash "$history_environment" "$history_kind-exec" npm run typecheck:mbt > "$history_artifact/types-$history_kind.log" 2>&1 || true
done
mv "$history_artifact/dispatch-baseline.log" "$history_artifact/dispatch-workspace-baseline.log"
bash "$history_environment" baseline-exec ./node_modules/.bin/eslint --config tools/dispatch-all-history-eslint.config.mjs --format json \
  src/dispatch-history-mode.js src/dispatch-load-assignment.js src/dispatch-pickup-visits.js \
  src/order-dependency-repository.js src/scm-dependency-preview-service.js src/dispatch-planner-v2-repository.js \
  test/mbt/integration/link-to-fix.test.js test/dispatch/integration/scm-to-untouched-lines.test.js \
  test/dispatch/integration/scm-dependency-preview-blockers.red.test.js test/dispatch/integration/transfer-completed-unlink.test.js \
  > "$history_artifact/lint-baseline.json" 2> "$history_artifact/lint-baseline.log" || true
bash "$history_environment" candidate-exec ./node_modules/.bin/eslint --config tools/dispatch-all-history-eslint.config.mjs --format json \
  src/dispatch-history-mode.js src/dispatch-load-assignment.js src/dispatch-pickup-visits.js \
  src/order-dependency-repository.js src/scm-dependency-preview-service.js src/dispatch-planner-v2-repository.js \
  src/dispatch-historical-order-snapshots.js test/dispatch/integration/to-dependency-packing-independent.test.js \
  test/dispatch/integration/retained-history-save.test.js test/dispatch/integration/historical-missing-order-snapshot.test.js \
  test/dispatch/unit/executed-prefix-historical-reflexivity.test.js test/dispatch/unit/historical-group-pickups.test.js \
  test/dispatch/unit/historical-replay-fixture-classification.test.js test/dispatch/property/historical-planning-safety.property.test.js \
  test/mbt/integration/link-to-fix.test.js test/dispatch/integration/scm-to-untouched-lines.test.js \
  test/dispatch/integration/scm-dependency-preview-blockers.red.test.js test/dispatch/integration/transfer-completed-unlink.test.js \
  'tools/dispatch-all-history-*.mjs' > "$history_artifact/lint-candidate.json" 2> "$history_artifact/lint-candidate.log" || true
bash "$history_environment" candidate-exec ./node_modules/.bin/eslint --config tools/dispatch-all-history-eslint.config.mjs \
  --rule 'complexity: [error, 12]' --format json src/dispatch-historical-order-snapshots.js \
  > "$history_artifact/complexity.json" 2> "$history_artifact/complexity.log"
DISPATCH_ALL_HISTORY_DATABASE=mbt_history_focus bash "$history_environment" candidate-exec node tools/dispatch-all-history-mutations.mjs > "$history_artifact/mutations.log" 2>&1
bash "$history_environment" candidate-exec node tools/dispatch-all-history-suite-health.mjs > "$history_artifact/suite-health.log" 2>&1
bash "$history_environment" candidate-exec node tools/dispatch-all-history-secrets.mjs > "$history_artifact/secrets-reviewed.log" 2>&1
bash "$history_server/tools/dispatch-all-history-camera-recheck.sh"

# Reproduction has separate reports so the original fix/stop checkpoints survive.
history_run="$(date -u +%Y%m%dT%H%M%S)-$$"
export DISPATCH_HISTORY_REPORT_DIRECTORY="test-artifacts/dispatch-all-history-20261002/reproduction/$history_run"
for history_pass in 1 2; do
  bash "$history_environment" reset
  bash "$history_environment" history-exec ./node_modules/.bin/c8 --all=false --check-coverage=false \
    --include=src/dispatch-history-mode.js --include=src/dispatch-load-assignment.js \
    --include=src/dispatch-pickup-visits.js --include=src/dispatch-planner-v2-repository.js \
    --include=src/order-dependency-repository.js --include=src/scm-dependency-preview-service.js \
    --include=src/dispatch-historical-order-snapshots.js \
    --temp-directory=test-artifacts/dispatch-all-history-20261002/coverage-tmp \
    --report-dir=test-artifacts/dispatch-all-history-20261002/coverage --reporter=json --reporter=json-summary \
    node tools/dispatch-all-history-replay.mjs "$history_pass" > "$history_artifact/reproduction-pass-$history_pass.log" 2>&1
done
python3 "$history_server/tools/dispatch-all-history-evidence.py" --reports "$history_server/$DISPATCH_HISTORY_REPORT_DIRECTORY"
