#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${server_root}"

files=(
  .env.example
  package.json
  migrations/172_dispatch_planner_indexed_pool_checkpoints.sql
  public/dispatch.js
  public/dispatch-snapshot.js
  src/config.js
  src/dispatch-order-catalog-repository.js
  src/dispatch-planner-optimization.js
  src/dispatch-planner-performance.js
  src/dispatch-planner-replay.js
  src/dispatch-planner-v2-repository.js
  src/server.js
  test/dispatch-planner-optimization-spec.md
  test/dispatch/adversarial/dispatch-planner-history-replay.test.js
  test/dispatch/frontend/dispatch-planner-performance.contract.test.js
  test/dispatch/integration/dispatch-order-catalog.red.test.js
  test/dispatch/integration/dispatch-planner-compact-command.red.test.js
  test/dispatch/property/dispatch-planner-delta.property.test.js
  test/dispatch/unit/dispatch-planner-optimization.red.test.js
  test/support/run-dispatch-planner-optimization-mutations.mjs
  test/support/validate-dispatch-planner-replay-artifact.mjs
  tools/dispatch-performance-gauntlet.sh
  tools/dispatch-planner-history-replay.mjs
  tools/dispatch-planner-optimization-source-state.sh
)

for file in "${files[@]}"; do
  if [[ ! -f "${file}" || -L "${file}" ]]; then
    echo "Invalid Dispatch planner optimization source-state input: ${file}" >&2
    exit 66
  fi
done

if ! grep -Eq '^DISPATCH_PLANNER_ORDER_POOL_MODE=off$' .env.example; then
  echo "Dispatch indexed order-pool mode must default to off." >&2
  exit 65
fi
if ! grep -Eq '^DISPATCH_PLANNER_COMMAND_MODE=off$' .env.example; then
  echo "Dispatch compact-command mode must default to off." >&2
  exit 65
fi
if grep -Eiq 'indexedDB|driver-service-worker|driver-offline-db|cacheStorage' \
  migrations/172_dispatch_planner_indexed_pool_checkpoints.sql \
  src/dispatch-order-catalog-repository.js \
  src/dispatch-planner-optimization.js \
  src/dispatch-planner-replay.js; then
  echo "Dispatch optimization source crossed the Driver PWA storage/cache boundary." >&2
  exit 65
fi
if grep -Eiq '(^|[[:space:]])(DROP|TRUNCATE)[[:space:]]' \
  migrations/172_dispatch_planner_indexed_pool_checkpoints.sql; then
  echo "Dispatch optimization migration must remain additive." >&2
  exit 65
fi

for file in "${files[@]}"; do
  sha256sum "${file}"
done | sha256sum
