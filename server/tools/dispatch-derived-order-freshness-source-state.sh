#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${server_root}"

files=(
  src/dispatch-delivery-group-repository.js
  src/dispatch-history-mode.js
  src/dispatch-order-catalog-repository.js
  src/dispatch-plan-repository.js
  src/dispatch-planner-performance.js
  src/dispatch-planner-v2-repository.js
  src/repair-dispatch-plan-267-rejected-readd.js
  src/server.js
  public/dispatch.html
  public/dispatch.js
  test/dispatch-co-authoritative-route-spec.md
  test/dispatch-plan-authoritative-projection-spec.md
  test/dispatch/frontend/dispatch-authoritative-retirement.red.test.js
  test/dispatch/frontend/dispatch-planner-performance.contract.test.js
  test/dispatch/integration/dispatch-co-snapshot-route-authority.red.test.js
  test/dispatch/integration/dispatch-derived-order-freshness.red.test.js
  test/dispatch/integration/dispatch-driver-completion-split-isolation.red.test.js
  test/dispatch/integration/dispatch-soa07894-event-replay.red.test.js
  test/dispatch/integration/dispatch-global-derived-order-pool.red.test.js
  test/dispatch/integration/dispatch-global-order-group-pool.red.test.js
  test/dispatch/property/dispatch-derived-order-freshness.property.test.js
  test/dispatch/unit/dispatch-performance-contract.test.js
  test/dispatch/concurrency/dispatch-derived-order-retirement-concurrency.red.test.js
  test/mbt/e2e/dispatch-soa07894-event-replay.spec.js
  test/mbt/e2e/dispatch-active-co-manifest-pickup.spec.js
  test/support/check-dispatch-derived-order-freshness-coverage.mjs
  test/support/run-dispatch-derived-order-freshness-baseline.mjs
  test/support/run-dispatch-derived-order-freshness-mutations.mjs
  tools/dispatch-derived-order-freshness-gauntlet.sh
  tools/dispatch-derived-order-freshness-source-state.sh
)

for file in "${files[@]}"; do
  if [[ ! -f "${file}" || -L "${file}" ]]; then
    echo "Invalid derived-order freshness source-state input: ${file}" >&2
    exit 66
  fi
done

git -C "${server_root}/.." rev-parse HEAD
for file in "${files[@]}"; do
  sha256sum "${file}"
done | sha256sum
