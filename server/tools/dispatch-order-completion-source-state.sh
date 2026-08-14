#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${server_root}"

files=(
  package.json
  migrations/159_dispatch_order_completion_status.sql
  public/dispatch.html
  public/dispatch.js
  src/dispatch-completion-repository.js
  src/mbt/mbbs-billing-candidate-service.js
  src/server.js
  test/dispatch/frontend/dispatch-completion-ui.test.js
  test/mbt/adversarial/dispatch-completion-repository-adversarial.test.js
  test/mbt/concurrency/dispatch-completion-races.test.js
  test/mbt/integration/dispatch-completion-http.red.test.js
  test/mbt/integration/dispatch-completion-migration.test.js
  test/mbt/integration/dispatch-completion-status.red.test.js
  test/mbt/infrastructure/p3-gauntlet-contract.test.js
  test/mbt/specs/dispatch-completion-status.md
  test/support/p3-mutation-manifest.mjs
  test/support/run-dispatch-order-completion-mutations.mjs
  tools/dispatch-order-completion-gauntlet.sh
  tools/dispatch-order-completion-source-state.sh
  tools/mbt-predeploy-readiness.mjs
)

for file in "${files[@]}"; do
  if [[ ! -f "${file}" || -L "${file}" ]]; then
    echo "Invalid Dispatch order-completion source-state input: ${file}" >&2
    exit 66
  fi
done

git -C "${server_root}/.." rev-parse HEAD
for file in "${files[@]}"; do
  sha256sum "${file}"
done | sha256sum
