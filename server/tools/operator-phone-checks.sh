#!/usr/bin/env bash
set -Eeuo pipefail
cd /app
export NODE_ENV=test
export PLAYWRIGHT_BROWSERS_PATH=/tmp/operator-phone-browsers
mkdir -p /tmp/operator-phone-public/vendor/quagga2 /tmp/operator-phone-public/vendor/qr-scanner
cp -r public/. /tmp/operator-phone-public/
cp node_modules/@ericblade/quagga2/dist/quagga.min.js /tmp/operator-phone-public/vendor/quagga2/
cp node_modules/qr-scanner/qr-scanner.umd.min.js node_modules/qr-scanner/qr-scanner-worker.min.js /tmp/operator-phone-public/vendor/qr-scanner/
export OPERATOR_ANDROID_PUBLIC=/tmp/operator-phone-public
npm install --prefix /tmp/operator-phone-deps --no-audit --no-fund --ignore-scripts playwright@1.62.1 fast-check@4.9.0
ln -s /tmp/operator-phone-deps/node_modules/playwright node_modules/playwright
ln -s /tmp/operator-phone-deps/node_modules/playwright-core node_modules/playwright-core
ln -s /tmp/operator-phone-deps/node_modules/fast-check node_modules/fast-check
node /tmp/operator-phone-deps/node_modules/playwright/cli.js install-deps chromium
node /tmp/operator-phone-deps/node_modules/playwright/cli.js install chromium --only-shell
node --check public/operator.js
node --check public/operator-phone.js
node --check public/service-worker.js
run_checks() {
  local result=0
  cp -r public/. /tmp/operator-phone-public/
  node --test --test-concurrency=1 test/mbt/unit/operator-native-camera.test.js test/mbt/unit/feature-gate-catalog.test.js test/mbt/unit/operator-phone-policy.test.js test/dispatch/frontend/operator-android-camera-release.browser.test.mjs || result=1
  node test/dispatch/frontend/operator-phone.browser.test.mjs || result=1
  return "$result"
}
run_checks
