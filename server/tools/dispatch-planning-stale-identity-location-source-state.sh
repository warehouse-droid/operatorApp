#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${server_root}"

fixed_files=(
  src/dispatch-custom-order-harness.js
  src/dispatch-custom-order-repository.js
  src/netsuite-order-webhook-queue-repository.js
  test/dispatch-planning-stale-identity-location-spec.md
  test/mbt/infrastructure/p3-gauntlet-contract.test.js
  test/mbt/integration/migration-upgrade.test.js
  test/mbt/integration/p3-predeploy-readiness.test.js
  test/support/c8.dispatch-planning-stale-identity-location.json
  test/support/check-dispatch-planning-stale-identity-location-coverage.mjs
  test/support/p3-mutation-manifest.mjs
  test/support/run-dispatch-planning-stale-identity-location-mutations.mjs
  test/workload/integration/netsuite-order-webhook-queue.red.test.js
  tools/dispatch-planning-stale-identity-location-gauntlet.sh
  tools/dispatch-planning-stale-identity-location-source-state.sh
  tools/mbt-predeploy-readiness.mjs
)

for file in "${fixed_files[@]}"; do
  if [[ ! -f "${file}" || -L "${file}" ]]; then
    echo "Invalid Dispatch stale identity/location source-state input: ${file}" >&2
    exit 66
  fi
done

if git -C "${server_root}/.." rev-parse HEAD >/dev/null 2>&1; then
  git -C "${server_root}/.." rev-parse HEAD
else
  echo "git-head-unavailable-in-isolated-image"
fi
for file in "${fixed_files[@]}"; do
  sha256sum "${file}"
done | sha256sum
