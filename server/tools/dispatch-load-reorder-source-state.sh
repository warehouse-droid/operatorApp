#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${server_root}"

files=(
  package.json
  public/dispatch.html
  public/dispatch.js
  src/dispatch-driver-order-harness.js
  test/dispatch/frontend/dispatch-completion-ui.test.js
  test/dispatch-load-reorder-spec.md
  test/dispatch/frontend/dispatch-load-reorder-position.red.test.js
  test/mbt/e2e/dispatch-load-reorder-position.spec.js
  test/mbt/unit/delivery-instruction-contract.test.js
  test/support/run-dispatch-load-reorder-mutations.mjs
  tools/dispatch-load-reorder-gauntlet.sh
  tools/dispatch-load-reorder-source-state.sh
)

for file in "${files[@]}"; do
  if [[ ! -f "${file}" || -L "${file}" ]]; then
    echo "Invalid Dispatch load-reorder source-state input: ${file}" >&2
    exit 66
  fi
done

git -C "${server_root}/.." rev-parse HEAD
for file in "${files[@]}"; do
  sha256sum "${file}"
done | sha256sum
