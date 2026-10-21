#!/usr/bin/env bash
set -Eeuo pipefail
export PLAYWRIGHT_BROWSERS_PATH=/tmp/phone-keyboard-browsers
export PHONE_TEST_ARTIFACTS=test-artifacts/operator-input-font-20261008
npm install --prefix /tmp/phone-keyboard-deps --no-audit --no-fund --ignore-scripts playwright@1.62.1
ln -s /tmp/phone-keyboard-deps/node_modules/playwright node_modules/playwright
ln -s /tmp/phone-keyboard-deps/node_modules/playwright-core node_modules/playwright-core
node /tmp/phone-keyboard-deps/node_modules/playwright/cli.js install-deps chromium
node /tmp/phone-keyboard-deps/node_modules/playwright/cli.js install chromium --only-shell
cp -r /candidate-public/. public/
for file in operator.js operator-phone.js operator-order-keypad.js operator-display-settings.js service-worker.js; do node --check "public/$file"; done
node --test test/mbt/unit/operator-display-settings.test.js
node test/dispatch/frontend/operator-phone.browser.test.mjs
