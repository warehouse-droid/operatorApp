#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${server_root}"

files=(
  package.json
  public/dispatch.css
  public/dispatch.html
  public/dispatch.js
  src/dispatch-load-assignment.js
  src/dispatch-driver-order-harness.js
  src/dispatch-pickup-visits.js
  src/dispatch-plan-repository.js
  src/dispatch-planner-performance.js
  src/dispatch-planner-replay.js
  src/dispatch-planner-v2-repository.js
  src/dispatch-statistics-repository.js
  src/driver-repository.js
  src/order-dependency-repository.js
  src/server.js
  test/dispatch-repeat-pickup-visits-evidence.md
  test/dispatch-repeat-pickup-visits-spec.md
  test/dispatch/adversarial/dispatch-planner-history-replay.test.js
  test/dispatch/adversarial/dispatch-repeat-pickup-visits.adversarial.test.js
  test/dispatch/concurrency/dispatch-repeat-pickup-command.red.test.js
  test/dispatch/frontend/dispatch-completion-ui.test.js
  test/dispatch/frontend/dispatch-po-ref-link-search.test.js
  test/dispatch/frontend/dispatch-repeat-pickup-visits.red.test.js
  test/dispatch/frontend/dispatch-unplan-freshness.red.test.js
  test/dispatch/property/dispatch-repeat-pickup-visits.property.test.js
  test/dispatch/unit/dispatch-repeat-pickup-visits.red.test.js
  test/mbt/e2e/dispatch-repeat-pickup-visits.spec.js
  test/mbt/infrastructure/p3-gauntlet-contract.test.js
  test/mbt/integration/delivery-instruction-http.test.js
  test/mbt/integration/special-stock-request-http.red.test.js
  test/mbt/unit/delivery-instruction-contract.test.js
  test/mbt/unit/driver-repeat-pickup-visits.red.test.js
  test/support/p3-mutation-manifest.mjs
  test/support/run-dispatch-repeat-pickup-mutations.mjs
  test/support/run-dispatch-unplan-freshness-mutations.mjs
  tools/dispatch-planner-history-offline-replay.mjs
  tools/dispatch-planner-history-replay.mjs
  tools/dispatch-repeat-pickup-gauntlet.sh
  tools/dispatch-repeat-pickup-source-state.sh
)

for file in "${files[@]}"; do
  if [[ ! -f "${file}" || -L "${file}" ]]; then
    echo "Invalid repeat-pickup source-state input: ${file}" >&2
    exit 66
  fi
done

git -C "${server_root}/.." rev-parse HEAD
for file in "${files[@]}"; do
  sha256sum "${file}"
done | sha256sum
