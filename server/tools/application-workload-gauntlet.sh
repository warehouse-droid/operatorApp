#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${MBT_TEST_ISOLATED:-}" != "1" ]]; then
  echo "Application workload gauntlet requires MBT_TEST_ISOLATED=1." >&2
  exit 70
fi

echo "[application-workload] behavior, queue, read-model, retention, and UI contracts"
npm run test:application-workload

echo "[application-workload] 1,000-plan-date anonymized replay and latency gate"
npm run replay:application-workload

echo "[application-workload] syntax and focused lint"
node --check src/application-workload-replay.js
node --check src/netsuite-order-webhook-queue-policy.js
node --check src/netsuite-order-webhook-queue-repository.js
node --check src/netsuite-order-webhook-worker-service.js
node --check src/netsuite-order-webhook-worker.js
node --check src/scm-purchase-order-catalog-repository.js
node --check src/dispatch-order-catalog-repository.js
node --check tools/application-workload-gauntlet.mjs
node --check public/dispatch-scm.js
eslint --config eslint.mbt.config.js --max-warnings=0 \
  src/application-workload-replay.js \
  src/netsuite-order-webhook-queue-policy.js \
  src/netsuite-order-webhook-queue-repository.js \
  src/netsuite-order-webhook-worker-service.js \
  src/scm-purchase-order-catalog-repository.js \
  test/workload

echo "[application-workload] complete"
