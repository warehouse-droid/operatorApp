#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${server_root}"

files=(
  ../.github/workflows/driver-offline-stress.yml
  Dockerfile.test
  package.json
  eslint.driver-offline-stress.config.js
  public/driver.html
  public/driver-reset.html
  public/driver-service-worker.js
  public/driver.css
  public/i18n.css
  public/i18n.js
  public/driver-offline-db.js
  public/driver-photo-hash.js
  public/driver-offline-photos.js
  public/driver-offline-sync.js
  public/driver-bin-ui.js
  public/driver.js
  src/server.js
  src/driver-client-version.js
  src/driver-client-version-harness.js
  src/driver-offline-client-harness.js
  src/driver-offline-repository.js
  src/driver-photo-integrity-harness.js
  test/driver-offline-stress-evidence.md
  test/driver-offline-stress-remediation.md
  test/driver-offline-stress-spec.md
  test/driver-offline-soak.compose.yml
  test/driver-offline-stress.playwright.config.mjs
  test/driver-offline-stress/browser.spec.js
  test/driver-offline-stress/node-contract.test.js
  test/fixtures/driver-offline-stress-history.json
  test/mbt/property/driver-offline-stress-contract.test.js
  test/mbt/e2e/driver-pwa-cache-repair.spec.js
  test/mbt/integration/driver-pwa-site-reset-http.test.js
  test/mbt/unit/driver-pwa-cache-repair.test.js
  test/mbt/unit/driver-pwa-site-reset.test.js
  test/mbt/unit/driver-pwa-recovery-assets.test.js
  test/mbt/unit/driver-camera-ordinary-upload.test.js
  test/support/driver-offline-stress-artifacts.mjs
  test/support/driver-offline-soak-state.mjs
  test/support/driver-offline-stress-matrix.mjs
  test/support/driver-offline-stress-model.mjs
  test/support/run-driver-offline-soak.mjs
  test/support/run-driver-offline-stress-mutations.mjs
  test/support/run-driver-offline-stress.mjs
  test/support/validate-driver-offline-stress-matrix.mjs
  tools/driver-offline-stress-gauntlet.sh
  tools/driver-offline-stress-source-state.sh
)

for file in "${files[@]}"; do
  if [[ ! -f "${file}" || -L "${file}" ]]; then
    echo "Invalid Driver offline stress source-state input: ${file}" >&2
    exit 66
  fi
done

git -C "${server_root}/.." rev-parse HEAD
for file in "${files[@]}"; do
  sha256sum "${file}"
done | sha256sum
