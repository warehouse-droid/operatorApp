#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${server_root}"

files=(
  package.json
  migrations/188_scm_schedule_loading_read_path.sql
  src/dispatch-repository.js
  src/dispatch-planner-v2-repository.js
  src/netsuite-order-webhook-queue-repository.js
  src/netsuite-closed-order-repository-harness.js
  src/server.js
  test/scm-schedule-loading-performance-spec.md
  test/scm-schedule-loading-performance-evidence.md
  test/dispatch/integration/scm-schedule-loading-performance.red.test.js
  test/dispatch/integration/scm-po-split-schedule-remaining.test.js
  test/dispatch/integration/scm-po-split-editing.test.js
  test/dispatch/integration/dispatch-po-split-link-target.test.js
  test/mbt/integration/scm-split-receipt-allocation.red.test.js
  test/mbt/integration/migration-upgrade.test.js
  test/mbt/infrastructure/test-foundation.test.js
  test/mbt/infrastructure/p3-gauntlet-contract.test.js
  test/baseline-harnesses.json
  test/mbt/integration/p3-predeploy-readiness.test.js
  test/mbt/unit/smart-scm-vendor-po-live-sync.test.js
  test/mbt/unit/special-stock-request-domain.red.test.js
  test/support/p3-mutation-manifest.mjs
  test/support/check-scm-schedule-loading-coverage.mjs
  test/support/run-scm-schedule-loading-mutations.mjs
  tools/scm-schedule-loading-benchmark.mjs
  tools/scm-schedule-loading-gauntlet.sh
  tools/scm-schedule-loading-source-state.sh
  tools/mbt-predeploy-readiness.mjs
)

for file in "${files[@]}"; do
  if [[ ! -f "${file}" || -L "${file}" ]]; then
    echo "Invalid SCM schedule loading source-state input: ${file}" >&2
    exit 66
  fi
done

if grep -Eiq '(^|[[:space:]])(DROP|TRUNCATE)[[:space:]]' migrations/188_scm_schedule_loading_read_path.sql; then
  echo "SCM schedule loading migration must not drop or truncate data." >&2
  exit 65
fi
if ! grep -Fq "dispatch_plan_order_assignments" migrations/188_scm_schedule_loading_read_path.sql; then
  echo "SCM schedule loading migration is missing its assignment projection index." >&2
  exit 65
fi
if ! grep -Fq "dispatch_plan_projection_state" migrations/188_scm_schedule_loading_read_path.sql; then
  echo "SCM schedule loading migration must invalidate projection readiness for startup backfill." >&2
  exit 65
fi

for file in "${files[@]}"; do
  sha256sum "${file}"
done | sha256sum
