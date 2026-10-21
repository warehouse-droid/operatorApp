#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
git diff --unified=0 -- src/special-stock-request-netsuite.js src/special-stock-netsuite-adapter.js src/special-stock-quantity-adapter.js |
  sudo -n docker exec -i -w /app mbbs-special-review-runner sh -c 'cat > test-artifacts/special-workflow-review/rest-units/runtime.diff'
sudo -n docker exec -w /app \
  -e MBT_TEST_ISOLATED=1 \
  -e DATABASE_URL=postgres://mbt_test:special_review_only@mbbs-special-review-db:5432/mbt_verify \
  -e SPECIAL_UNITS_DIFF=test-artifacts/special-workflow-review/rest-units/runtime.diff \
  mbbs-special-review-runner node tools/special-stock-units-check.mjs
python3 -m py_compile tools/special-stock-units-deploy.py
git diff --check -- src/special-stock-request-netsuite.js src/special-stock-netsuite-adapter.js src/special-stock-quantity-adapter.js
