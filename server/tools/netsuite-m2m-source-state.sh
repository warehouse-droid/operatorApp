#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${server_root}"

files=(
  .env.example
  Dockerfile
  Dockerfile.test
  eslint.mbt.config.js
  package.json
  public/control.css
  public/control.html
  public/control.js
  src/config.js
  src/netsuite.js
  src/netsuite-m2m-auth.js
  src/netsuite-m2m-runtime.js
  src/netsuite-m2m-settings.js
  src/pending-approval-reconciliation.js
  src/pending-approval-reconciliation-repository.js
  src/server.js
  test/mbt/concurrency/netsuite-m2m-token-races.test.js
  test/mbt/e2e/netsuite-m2m-admin.spec.js
  test/mbt/integration/netsuite-m2m-admin-http.test.js
  test/mbt/integration/pending-approval-reconciliation-repository.red.test.js
  test/mbt/property/netsuite-m2m-auth.property.test.js
  test/mbt/property/pending-approval-reconciliation.property.test.js
  test/mbt/unit/netsuite-m2m-admin-ui.contract.test.js
  test/mbt/unit/netsuite-m2m-auth.red.test.js
  test/mbt/unit/netsuite-m2m-runtime.red.test.js
  test/mbt/unit/netsuite-m2m-settings.red.test.js
  test/mbt/unit/netsuite-m2m-wiring.contract.test.js
  test/mbt/unit/netsuite-pending-approval-batch.red.test.js
  test/mbt/unit/pending-approval-reconciliation.red.test.js
  test/support/run-netsuite-m2m-mutations.mjs
  tools/netsuite-m2m-gauntlet.sh
  tools/netsuite-m2m-source-state.sh
)

for file in "${files[@]}"; do
  if [[ ! -f "${file}" || -L "${file}" ]]; then
    echo "Invalid NetSuite M2M source-state input: ${file}" >&2
    exit 66
  fi
done

git -C "${server_root}/.." rev-parse HEAD
for file in "${files[@]}"; do
  sha256sum "${file}"
done | sha256sum
