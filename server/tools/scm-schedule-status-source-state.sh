#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${server_root}"

files=(
  package.json
  public/dispatch-scm.html
  public/dispatch-scm.js
  public/scm-schedule.html
  public/scm-schedule.js
  src/dispatch-repository.js
  src/operator-camera-schedule-harness.js
  src/scm-po-split-filter-harness.js
  src/scm-reconciliation-ui-harness.js
  src/scm-schedule-row-refresh-harness.js
  src/scm-schedule-preference-harness.js
  src/scm-status-precedence-mutation-harness.js
  src/scm-weight-schedule-harness.js
  src/server.js
  test/dispatch/frontend/scm-po-split-ui.test.js
  test/dispatch/frontend/scm-schedule-status-save.test.js
  test/mbt/integration/scm-po-split-ref-reuse.test.js
  test/mbt/infrastructure/p3-gauntlet-contract.test.js
  test/mbt/integration/scm-schedule-status-concurrency.test.js
  test/mbt/integration/scm-schedule-status-http.test.js
  test/support/check-scm-po-split-ui-coverage.mjs
  test/support/check-scm-schedule-status-coverage.mjs
  test/support/p3-mutation-manifest.mjs
  test/support/run-scm-po-split-ui-mutations.mjs
  test/support/run-scm-schedule-status-mutations.mjs
  tools/scm-po-split-ui-gauntlet.sh
  tools/scm-schedule-status-gauntlet.sh
  tools/scm-schedule-status-source-state.sh
)

for file in "${files[@]}"; do
  if [[ ! -f "${file}" || -L "${file}" ]]; then
    echo "Invalid SCM schedule-status source-state input: ${file}" >&2
    exit 66
  fi
done

git -C "${server_root}/.." rev-parse HEAD
for file in "${files[@]}"; do
  sha256sum "${file}"
done | sha256sum
