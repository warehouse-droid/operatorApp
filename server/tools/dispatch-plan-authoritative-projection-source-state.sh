#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${server_root}"

files=(
  src/dispatch-plan-order-projection.js
  src/dispatch-plan-repository.js
  src/repair-dispatch-plan-267-authoritative-projection.js
  src/server.js
  test/dispatch-plan-authoritative-projection-spec.md
  test/dispatch/adversarial/dispatch-plan-authoritative-projection.adversarial.test.js
  test/dispatch/concurrency/dispatch-plan-authoritative-projection-concurrency.red.test.js
  test/dispatch/integration/dispatch-plan-authoritative-projection.red.test.js
  test/dispatch/property/dispatch-plan-authoritative-projection.property.test.js
  test/mbt/unit/dispatch-plan-authoritative-projection.red.test.js
  test/mbt/unit/dispatch-plan-authoritative-projection-wiring.contract.test.js
  test/support/run-dispatch-plan-authoritative-projection-mutations.mjs
  tools/dispatch-plan-authoritative-projection-gauntlet.sh
  tools/dispatch-plan-authoritative-projection-source-state.sh
)

for file in "${files[@]}"; do
  if [[ ! -f "${file}" || -L "${file}" ]]; then
    echo "Invalid authoritative-projection source-state input: ${file}" >&2
    exit 66
  fi
done

git -C "${server_root}/.." rev-parse HEAD
for file in "${files[@]}"; do
  sha256sum "${file}"
done | sha256sum
