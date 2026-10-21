#!/usr/bin/env bash
set -Eeuo pipefail
export PLAYWRIGHT_BROWSERS_PATH=/tmp/phone-keyboard-browsers
export PHONE_TEST_ARTIFACTS=test-artifacts/operator-phone-keyboard-20261008
npm install --prefix /tmp/phone-keyboard-deps --no-audit --no-fund --ignore-scripts playwright@1.62.1
ln -s /tmp/phone-keyboard-deps/node_modules/playwright node_modules/playwright
ln -s /tmp/phone-keyboard-deps/node_modules/playwright-core node_modules/playwright-core
node /tmp/phone-keyboard-deps/node_modules/playwright/cli.js install-deps chromium
node /tmp/phone-keyboard-deps/node_modules/playwright/cli.js install chromium --only-shell
# Confirm the existing deployed assets reproduce the keypad regression.
if PHONE_TEST_SCENES=menu node test/dispatch/frontend/operator-phone.browser.test.mjs >"$PHONE_TEST_ARTIFACTS/before.log" 2>&1; then
  echo 'Expected the old phone keypad to fail its regression check.'
  exit 1
fi
grep -q 'keypad must not focus input' "$PHONE_TEST_ARTIFACTS/before.log"
cp -r /candidate-public/. public/
for file in operator.js operator-phone.js operator-order-keypad.js operator-display-settings.js service-worker.js; do node --check "public/$file"; done
node --test test/mbt/unit/operator-display-settings.test.js
node test/dispatch/frontend/operator-phone.browser.test.mjs
