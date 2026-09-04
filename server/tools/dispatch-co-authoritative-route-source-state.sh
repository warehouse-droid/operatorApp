#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${server_root}"

files=(
  public/dispatch.html
  public/dispatch.js
  src/dispatch-co-lifecycle.js
  test/dispatch-co-authoritative-route-spec.md
  test/dispatch/frontend/dispatch-completion-ui.test.js
  test/dispatch/frontend/dispatch-planner-performance.contract.test.js
  test/dispatch/frontend/dispatch-po-ref-link-search.test.js
  test/dispatch/frontend/dispatch-unplan-freshness.red.test.js
  test/dispatch/integration/dispatch-co-snapshot-route-authority.red.test.js
  test/dispatch/property/dispatch-co-authoritative-route-merge.property.test.js
  test/dispatch/property/dispatch-co-snapshot-route-authority.property.test.js
  test/support/run-dispatch-co-authoritative-route-mutations.mjs
  test/support/run-dispatch-co-snapshot-route-mutations.mjs
  tools/dispatch-co-authoritative-route-gauntlet.sh
  tools/dispatch-co-authoritative-route-source-state.sh
)

for file in "${files[@]}"; do
  if [[ ! -f "${file}" || -L "${file}" ]]; then
    echo "Invalid CO authoritative-route source-state input: ${file}" >&2
    exit 66
  fi
done

git -C "${server_root}/.." rev-parse HEAD
for file in "${files[@]}"; do
  sha256sum "${file}"
done | sha256sum
