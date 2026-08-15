#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${server_root}"

files=(
  package-lock.json
  package.json
  public/dispatch.html
  public/dispatch.js
  public/service-worker.js
  src/dispatch-driver-order-harness.js
  test/dispatch/frontend/dispatch-completion-ui.test.js
  test/dispatch/frontend/dispatch-planner-performance.contract.test.js
  test/dispatch/frontend/dispatch-runtime-resilience.red.test.js
  test/dispatch/property/dispatch-edit-lease-session.property.test.js
  test/dispatch/specs/dispatch-runtime-resilience.md
  test/mbt/e2e/dispatch-edit-lease-resume.spec.js
  test/mbt/e2e/dispatch-popup-render-boundary.spec.js
  test/mbt/infrastructure/p3-gauntlet-contract.test.js
  test/support/p3-mutation-manifest.mjs
  test/support/run-dispatch-runtime-resilience-mutations.mjs
  tools/dispatch-runtime-resilience-gauntlet.sh
  tools/dispatch-runtime-resilience-source-state.sh
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
