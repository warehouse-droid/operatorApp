#!/usr/bin/env bash
set -euo pipefail

npm run test:scm-po-group-rollup-recovery
npm run coverage:scm-po-group-rollup-recovery
npm run mutate:scm-po-group-rollup-recovery
npm run lint:scm-po-group-rollup-recovery
npm run secrets:scm-po-group-rollup-recovery
node src/scm-po-group-rollup-recovery-harness.js
node src/grouped-po-reconciliation-integration-harness.js
