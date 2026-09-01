#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${server_root}"

files=(
  package.json
  public/dispatch-scm.html
  public/dispatch-scm.js
  src/dispatch-repository.js
  src/scm-purchase-order-catalog-repository.js
  test/scm-po-split-live-schedule-parity-spec.md
  test/scm-po-split-live-schedule-parity-evidence.md
  test/dispatch/frontend/scm-po-split-ui.test.js
  test/dispatch/integration/scm-po-split-status-consistency.red.test.js
  test/mbt/integration/scm-schedule-status-concurrency.test.js
  test/support/check-scm-po-split-live-schedule-coverage.mjs
  test/support/run-scm-po-split-live-schedule-mutations.mjs
  test/support/run-scm-po-split-status-consistency-mutations.mjs
  test/support/run-scm-po-split-ui-mutations.mjs
  tools/scm-po-split-live-schedule-gauntlet.sh
  tools/scm-po-split-live-schedule-source-state.sh
)

for file in "${files[@]}"; do
  if [[ ! -f "${file}" || -L "${file}" ]]; then
    echo "Invalid PO Split live-schedule source-state input: ${file}" >&2
    exit 66
  fi
done

if command -v git >/dev/null 2>&1; then
  git -C "${server_root}/.." rev-parse HEAD
else
  echo "git-head-unavailable-in-isolated-image"
fi
for file in "${files[@]}"; do
  sha256sum "${file}"
done | sha256sum
