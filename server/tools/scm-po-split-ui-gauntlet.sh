#!/usr/bin/env bash
set -euo pipefail

SCM_PO_SPLIT_UI_C8_BIN="${SCM_PO_SPLIT_UI_C8_BIN:-./node_modules/.bin/c8}"
SCM_PO_SPLIT_UI_ESLINT_BIN="${SCM_PO_SPLIT_UI_ESLINT_BIN:-./node_modules/.bin/eslint}"
SCM_PO_SPLIT_UI_COVERAGE_DIR="${SCM_PO_SPLIT_UI_COVERAGE_DIR:-/tmp/scm-po-split-ui-coverage}"

"${SCM_PO_SPLIT_UI_C8_BIN}" \
  --all=false \
  --check-coverage=false \
  --include=public/dispatch-scm.js \
  --temp-directory=/tmp/scm-po-split-ui-c8 \
  --report-dir="${SCM_PO_SPLIT_UI_COVERAGE_DIR}" \
  --reporter=text \
  --reporter=json \
  node --test test/dispatch/frontend/scm-po-split-ui.test.js

node test/support/check-scm-po-split-ui-coverage.mjs \
  "${SCM_PO_SPLIT_UI_COVERAGE_DIR}/coverage-final.json"

node --test \
  test/dispatch/frontend/scm-po-split-ui.test.js \
  src/scm-po-split-filter-harness.js \
  src/scm-weight-schedule-harness.js

node --check public/dispatch-scm.js
node test/support/check-legacy-public-syntax.mjs

"${SCM_PO_SPLIT_UI_ESLINT_BIN}" \
  --config eslint.mbt.config.js \
  --max-warnings=0 \
  test/dispatch/frontend/scm-po-split-ui.test.js \
  test/support/check-scm-po-split-ui-coverage.mjs \
  test/support/run-scm-po-split-ui-mutations.mjs

node test/support/run-scm-po-split-ui-mutations.mjs
