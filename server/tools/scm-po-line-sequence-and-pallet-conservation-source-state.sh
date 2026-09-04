#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${server_root}"

files=(
  public/dispatch-scm.html
  public/dispatch-scm.js
  public/dispatch.css
  src/dispatch-repository.js
  src/netsuite.js
  src/scm-reconciliation-repository.js
  src/scm-reconciliation-service.js
  test/scm-po-line-sequence-and-pallet-conservation-spec.md
  test/scm-po-line-sequence-and-pallet-conservation-evidence.md
  test/dispatch/frontend/scm-po-line-sequence.red.test.js
  test/dispatch/frontend/scm-po-split-ui.test.js
  test/dispatch/integration/scm-po-stale-line-pallet-conservation.red.test.js
  test/dispatch/unit/scm-po-netsuite-line-sequence.contract.test.js
  test/support/run-scm-po-line-sequence-and-pallet-conservation-mutations.mjs
  test/support/run-scm-po-split-ui-mutations.mjs
  tools/scm-po-line-sequence-and-pallet-conservation-gauntlet.sh
  tools/scm-po-line-sequence-and-pallet-conservation-source-state.sh
)

for file in "${files[@]}"; do
  if [[ ! -f "${file}" || -L "${file}" ]]; then
    echo "Invalid PO line sequence/conservation source-state input: ${file}" >&2
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
