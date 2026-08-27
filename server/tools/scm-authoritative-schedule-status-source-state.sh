#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${server_root}"

fixed_files=(
  migrations/183_scm_authoritative_schedule_status.sql
  package.json
  src/dispatch-repository.js
  src/driver-repository.js
  src/netsuite-closed-order-policy.js
  src/netsuite-delayed-status-refresh-policy.js
  src/netsuite-delayed-status-refresh-repository.js
  src/netsuite-delayed-status-refresh-service.js
  src/order-sync-repository.js
  src/scm-reconciliation.js
  src/scm-schedule-status-refresh.js
  src/scm-schedule-status-refresh-repository.js
  src/server.js
  test/scm-authoritative-schedule-status-evidence.md
  test/scm-authoritative-schedule-status-spec.md
  test/mbt/integration/migration-upgrade.test.js
  test/mbt/integration/netsuite-delayed-status-refresh-repository.red.test.js
  test/mbt/integration/scm-authoritative-schedule-status.red.test.js
  test/mbt/integration/scm-schedule-status-refresh-repository.red.test.js
  test/mbt/property/netsuite-delayed-status-refresh.property.test.js
  test/mbt/unit/netsuite-delayed-status-refresh-policy.red.test.js
  test/mbt/unit/netsuite-delayed-status-refresh-service.red.test.js
  test/mbt/unit/netsuite-delayed-status-refresh-wiring.contract.test.js
  test/mbt/unit/scm-authoritative-schedule-status.red.test.js
  test/mbt/unit/scm-schedule-status-refresh.red.test.js
  test/support/run-scm-authoritative-schedule-status-mutations.mjs
  tools/scm-authoritative-schedule-status-gauntlet.sh
  tools/scm-authoritative-schedule-status-source-state.sh
)

for file in "${fixed_files[@]}"; do
  if [[ ! -f "${file}" || -L "${file}" ]]; then
    echo "Invalid SCM authoritative status source-state input: ${file}" >&2
    exit 66
  fi
done

if command -v git >/dev/null 2>&1; then
  git -C "${server_root}/.." rev-parse HEAD
else
  echo "git-head-unavailable-in-isolated-image"
fi
for file in "${fixed_files[@]}"; do
  sha256sum "${file}"
done | sha256sum
