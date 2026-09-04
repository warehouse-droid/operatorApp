#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${server_root}"

files=(
  package.json
  migrations/193_dispatch_assignment_projection_invariant.sql
  src/dispatch-order-catalog-repository.js
  src/dispatch-plan-repository.js
  src/dispatch-planner-v2-repository.js
  src/dispatch-repository.js
  src/server.js
  test/dispatch-po-ref-projection-consistency-spec.md
  test/dispatch/integration/dispatch-assignment-readiness-invariant.red.test.js
  test/dispatch/integration/dispatch-po-ref-projection-consistency.red.test.js
  test/dispatch/unit/dispatch-assignment-projection-self-heal.contract.test.js
  test/mbt/integration/migration-upgrade.test.js
  test/mbt/integration/p3-predeploy-readiness.test.js
  test/support/check-dispatch-po-ref-projection-coverage.mjs
  test/support/check-dispatch-po-ref-projection-types.mjs
  test/support/run-dispatch-po-ref-projection-tests.mjs
  test/support/run-dispatch-po-ref-projection-mutations.mjs
  tools/dispatch-po-ref-projection-gauntlet.sh
  tools/dispatch-po-ref-projection-source-state.sh
  tools/mbt-predeploy-readiness.mjs
)

for file in "${files[@]}"; do
  if [[ ! -f "${file}" || -L "${file}" ]]; then
    echo "Invalid source-state input: ${file}" >&2
    exit 66
  fi
done

git -C "${server_root}/.." rev-parse HEAD
for file in "${files[@]}"; do
  sha256sum "${file}"
done | sha256sum
