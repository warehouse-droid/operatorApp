#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${server_root}"

fixed_files=(
  eslint.mbt.config.js
  package.json
  tsconfig.mbt.json
  migrations/178_operator_netsuite_posting_gates.sql
  public/mbt-gates.html
  public/mbt-gates.js
  public/mbt-shell.css
  public/operator.js
  src/mbt/feature-gate-catalog.js
  src/mbt/router.js
  src/netsuite.js
  src/netsuite-closed-order-repository-harness.js
  src/server.js
  src/delivery-repository.js
  src/receiving-repository.js
  src/operator-netsuite-posting-adapter.js
  src/operator-netsuite-posting-admission.js
  src/operator-netsuite-posting-controller.js
  src/operator-netsuite-posting-domain.js
  src/operator-netsuite-posting-finalizer.js
  src/operator-netsuite-posting-netsuite-adapter.js
  src/operator-netsuite-posting-policy-repository.js
  src/operator-netsuite-posting-policy.js
  src/operator-netsuite-posting-repository.js
  src/operator-netsuite-posting-runtime.js
  src/operator-netsuite-posting-service.js
  src/operator-netsuite-posting-targets.js
  test/operator-netsuite-posting-gates-spec.md
  test/operator-netsuite-line-mapping-spec.md
  test/mbt/operator-netsuite-posting-gates-evidence.md
  test/mbt/adversarial/operator-netsuite-posting-adversarial.test.js
  test/mbt/concurrency/operator-netsuite-posting-concurrency.test.js
  test/mbt/e2e/operator-netsuite-posting-gates.spec.js
  test/mbt/e2e/operator-customer-pickup-photo-gate.spec.js
  test/mbt/integration/operator-netsuite-posting-migration.test.js
  test/mbt/integration/operator-netsuite-posting-policy-repository.red.test.js
  test/mbt/integration/operator-netsuite-posting-repository.red.test.js
  test/mbt/property/operator-netsuite-posting.property.test.js
  test/mbt/unit/operator-netsuite-posting-admission.red.test.js
  test/mbt/unit/operator-netsuite-posting-domain.red.test.js
  test/mbt/unit/operator-netsuite-posting-policy.red.test.js
  test/mbt/unit/operator-netsuite-posting-route-freeze.red.test.js
  test/mbt/unit/operator-netsuite-posting-runtime-adapters.red.test.js
  test/mbt/unit/operator-netsuite-posting-runtime.red.test.js
  test/mbt/unit/operator-netsuite-posting-schema.red.test.js
  test/mbt/unit/operator-netsuite-posting-service.red.test.js
  test/mbt/unit/operator-netsuite-posting-targets.red.test.js
  test/mbt/unit/operator-netsuite-posting-ui.red.test.js
  test/support/run-operator-netsuite-posting-mutations.mjs
  tools/operator-netsuite-posting-gauntlet.sh
  tools/operator-netsuite-posting-source-state.sh
)

for file in "${fixed_files[@]}"; do
  if [[ ! -f "${file}" || -L "${file}" ]]; then
    echo "Invalid Operator posting source-state input: ${file}" >&2
    exit 66
  fi
done

git -C "${server_root}/.." rev-parse HEAD
for file in "${fixed_files[@]}"; do
  sha256sum "${file}"
done | sha256sum
