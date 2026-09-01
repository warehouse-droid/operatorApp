#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${server_root}"

files=(
  Dockerfile
  migrations/191_driver_completed_co_lifecycle.sql
  package.json
  public/dispatch.js
  src/dispatch-co-lifecycle.js
  src/dispatch-co-recovery.js
  src/dispatch-plan-repository.js
  src/dispatch-planner-performance.js
  src/dispatch-planner-v2-repository.js
  src/dispatch-repository.js
  src/receiving-repository.js
  src/server.js
  test/dispatch-co-global-lifecycle-evidence.md
  test/dispatch-co-global-lifecycle-spec.md
  test/dispatch/frontend/dispatch-co-global-lifecycle.contract.test.js
  test/dispatch/integration/dispatch-co-global-lifecycle.red.test.js
  test/dispatch/integration/dispatch-co-driver-completion-lifecycle.red.test.js
  test/dispatch/integration/dispatch-co-recovery.test.js
  test/mbt/integration/migration-upgrade.test.js
  test/mbt/integration/p3-predeploy-readiness.test.js
  test/dispatch/property/dispatch-performance-command.property.test.js
  test/dispatch/unit/dispatch-co-lifecycle-wiring.test.js
  test/dispatch/unit/dispatch-performance-contract.test.js
  test/support/check-dispatch-co-lifecycle-coverage.mjs
  test/support/run-dispatch-co-lifecycle-mutations.mjs
  tools/dispatch-co-lifecycle-gauntlet.sh
  tools/dispatch-co-lifecycle-source-state.sh
  tools/mbt-predeploy-readiness.mjs
  tools/recover-co-goa-3464-3470-6922.js
)

for file in "${files[@]}"; do
  if [[ ! -f "${file}" || -L "${file}" ]]; then
    echo "Invalid Dispatch CO source-state input: ${file}" >&2
    exit 66
  fi
done

git -C "${server_root}/.." rev-parse HEAD
for file in "${files[@]}"; do
  sha256sum "${file}"
done | sha256sum
