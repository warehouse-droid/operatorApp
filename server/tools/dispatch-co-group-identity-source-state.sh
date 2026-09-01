#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${server_root}"

files=(
  package.json
  public/dispatch.js
  src/dispatch-co-group-identity.js
  src/dispatch-co-group-identity-repository.js
  src/dispatch-co-lifecycle.js
  src/dispatch-custom-order-repository.js
  src/dispatch-plan-repository.js
  src/dispatch-planner-performance.js
  src/dispatch-planner-v2-repository.js
  src/dispatch-repository.js
  src/mirror-dispatch-plan.js
  src/server.js
  test/dispatch-co-group-identity-evidence.md
  test/dispatch-co-group-identity-spec.md
  test/dispatch/frontend/dispatch-runtime-resilience.red.test.js
  test/dispatch/integration/dispatch-co-driver-completion-lifecycle.red.test.js
  test/dispatch/integration/dispatch-co-group-identity-repair.red.test.js
  test/dispatch/property/dispatch-co-group-identity.property.test.js
  test/dispatch/unit/dispatch-co-group-identity.red.test.js
  test/mbt/infrastructure/p3-gauntlet-contract.test.js
  test/support/p3-mutation-manifest.mjs
  test/support/run-dispatch-co-group-identity-mutations.mjs
  tools/dispatch-co-group-identity-gauntlet.sh
  tools/dispatch-co-group-identity-source-state.sh
)

for file in "${files[@]}"; do
  if [[ ! -f "${file}" || -L "${file}" ]]; then
    echo "Invalid Dispatch CO group identity source-state input: ${file}" >&2
    exit 66
  fi
done

git -C "${server_root}/.." rev-parse HEAD
for file in "${files[@]}"; do
  sha256sum "${file}"
done | sha256sum
