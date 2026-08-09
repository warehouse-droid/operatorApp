#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${server_root}"

files=(
  package.json
  public/dispatch.js
  src/dispatch-plan-repository.js
  src/dispatch-planner-v2-repository.js
  src/dispatch-save-coordination-harness.js
  src/scm-reconciliation-server-integration-harness.js
  src/server.js
  test/baseline-harnesses.json
  test/dispatch/concurrency/dispatch-save-recovery-concurrency.red.test.js
  test/dispatch/integration/dispatch-save-recovery.red.test.js
  test/dispatch/integration/dispatch-v2-retention-outbox.red.test.js
  test/dispatch/integration/dispatch-v2-command-flow.red.test.js
  test/support/check-dispatch-save-recovery-coverage.mjs
  test/support/run-dispatch-save-recovery-mutations.mjs
  tools/dispatch-save-recovery-gauntlet.sh
  tools/dispatch-save-recovery-source-state.sh
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
