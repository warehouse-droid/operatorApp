#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${server_root}"

files=(
  package.json
  src/dispatch-plan-repository.js
  src/dispatch-planner-v2-repository.js
  src/server.js
  test/dispatch-v2-summary-marker-spec.md
  test/dispatch/integration/dispatch-v2-summary-marker.red.test.js
  test/dispatch/property/dispatch-v2-summary-marker.property.test.js
  test/dispatch/unit/dispatch-v2-summary-marker-wiring.test.js
  test/support/check-dispatch-v2-summary-marker-coverage.mjs
  test/support/run-dispatch-v2-summary-marker-mutations.mjs
  tools/dispatch-v2-summary-marker-gauntlet.sh
  tools/dispatch-v2-summary-marker-source-state.sh
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
