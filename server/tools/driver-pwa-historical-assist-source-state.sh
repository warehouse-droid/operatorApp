#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${server_root}"

files=(
  eslint.mbt.config.js
  package.json
  migrations/174_driver_pwa_historical_assist.sql
  public/app-sidebar.js
  public/dispatch-offline-review.css
  public/dispatch-offline-review.html
  public/dispatch-offline-review.js
  src/driver-historical-assist-policy.js
  src/driver-historical-assist-evidence.js
  src/driver-historical-assist-repository.js
  src/driver-repository.js
  src/server.js
  test/driver-pwa-historical-assist-spec.md
  test/mbt/adversarial/driver-pwa-historical-assist-adversarial.test.js
  test/mbt/concurrency/driver-pwa-historical-assist-concurrency.test.js
  test/mbt/e2e/driver-pwa-historical-assist.spec.js
  test/mbt/integration/driver-pwa-historical-assist-migration.test.js
  test/mbt/property/driver-pwa-historical-assist.property.test.js
  test/mbt/unit/driver-pwa-historical-assist-policy.red.test.js
  test/mbt/unit/driver-pwa-historical-assist-wiring.contract.test.js
  test/support/run-driver-pwa-historical-assist-mutations.mjs
  tools/driver-pwa-historical-assist-gauntlet.sh
  tools/driver-pwa-historical-assist-source-state.sh
  tsconfig.mbt.json
)

for file in "${files[@]}"; do
  if [[ ! -f "${file}" || -L "${file}" ]]; then
    echo "Invalid Historical completion source-state input: ${file}" >&2
    exit 66
  fi
done

if grep -Eiq '(^|[[:space:]])(DROP[[:space:]]+TABLE|TRUNCATE)[[:space:]]' migrations/174_driver_pwa_historical_assist.sql; then
  echo "Historical completion migration must remain additive." >&2
  exit 65
fi
if grep -Eiq 'indexedDB|DriverOfflineDB' public/dispatch-offline-review.js; then
  echo "Historical completion must not add Dispatch evidence to Driver IndexedDB." >&2
  exit 65
fi

git -C "${server_root}/.." rev-parse HEAD
for file in "${files[@]}"; do
  sha256sum "${file}"
done | sha256sum
