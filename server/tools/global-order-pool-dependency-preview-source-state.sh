#!/usr/bin/env bash
set -Eeuo pipefail

files=(
  migrations/190_dispatch_global_order_groups.sql
  public/dispatch.js
  src/dispatch-delivery-group-repository.js
  src/dispatch-order-catalog-repository.js
  src/dispatch-planner-optimization.js
  src/scm-dependency-preview-service.js
  test/dispatch/integration/dispatch-global-order-group-pool.red.test.js
  test/dispatch/integration/scm-dependency-preview-blockers.red.test.js
  test/dispatch/property/dispatch-global-order-group-pool.property.test.js
  test/dispatch-global-order-pool-dependency-preview-spec.md
  test/mbt/infrastructure/p3-gauntlet-contract.test.js
  test/support/check-global-order-pool-dependency-preview-coverage.mjs
  test/support/p3-mutation-manifest.mjs
  test/support/run-global-order-pool-dependency-preview-mutations.mjs
)

for file in "${files[@]}"; do
  test -f "${file}"
done

grep -Fq "dependency.status NOT IN ('active', 'attention', 'cancelled')" src/scm-dependency-preview-service.js
grep -Fq "dispatch_global_order_groups" src/dispatch-order-catalog-repository.js
grep -Fq "pg_advisory_xact_lock" src/dispatch-delivery-group-repository.js
grep -Fq "globalGroupDefinition" public/dispatch.js

if grep -Eiq '(^|[[:space:]])(DROP|TRUNCATE)[[:space:]]' migrations/190_dispatch_global_order_groups.sql; then
  echo "Migration 190 must remain additive." >&2
  exit 1
fi

sha256sum "${files[@]}"
