#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${server_root}"

fixed_files=(
  package.json
  public/dispatch.html
  public/dispatch.js
  src/dispatch-load-assignment.js
  src/dispatch-driver-order-harness.js
  src/dispatch-po-multi-drop-harness.js
  src/dispatch-planner-v2-repository.js
  src/dispatch-po-route-projection.js
  src/dispatch-repository.js
  src/driver-repository.js
  src/scm-dependency-command-service.js
  src/scm-dependency-plan-reconciler.js
  test/dispatch-po-direct-ship-residual-evidence.md
  test/dispatch-po-direct-ship-residual-spec.md
  test/dispatch/adversarial/dispatch-po-route-residual-adversarial.test.js
  test/dispatch/frontend/dispatch-po-route-residual-ui.red.test.js
  test/dispatch/integration/dispatch-po-split-link-target.test.js
  test/dispatch/property/dispatch-po-route-residual.property.test.js
  test/dispatch/unit/dispatch-po-route-residual.red.test.js
  test/mbt/unit/scm-dependency-command-service.red.test.js
  test/support/run-dispatch-po-route-residual-mutations.mjs
  tools/dispatch-po-route-residual-gauntlet.sh
  tools/dispatch-po-route-residual-source-state.sh
)

for file in "${fixed_files[@]}"; do
  if [[ ! -f "${file}" || -L "${file}" ]]; then
    echo "Invalid Dispatch PO residual source-state input: ${file}" >&2
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
