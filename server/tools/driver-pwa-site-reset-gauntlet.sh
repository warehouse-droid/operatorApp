#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "${server_root}/.." && pwd)"
compose_file="${repo_root}/docker-compose.mbt-test.yml"
test_project="mbbs-driver-site-reset-test"
compose=(docker compose -p "${test_project}" -f "${compose_file}")

cleanup() {
  "${compose[@]}" --profile tools --profile runtime --profile e2e down --volumes --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT
cd "${repo_root}"

cleanup
"${compose[@]}" --profile tools --profile runtime --profile e2e build test mutation app e2e
"${compose[@]}" up -d --wait db
"${compose[@]}" --profile tools run --rm migrate
"${compose[@]}" --profile tools run --rm test npm run test:driver-pwa-site-reset
"${compose[@]}" --profile tools run --rm test node src/driver-client-version-harness.js
"${compose[@]}" --profile tools run --rm test node src/driver-offline-client-harness.js
"${compose[@]}" --profile tools run --rm test node src/driver-photo-integrity-harness.js
"${compose[@]}" --profile tools run --rm test npm run lint:driver-pwa-site-reset
"${compose[@]}" --profile tools run --rm test npm run syntax:legacy
"${compose[@]}" --profile tools run --rm test npx tsc --noEmit --allowJs --checkJs --target es2022 --module nodenext --moduleResolution nodenext --types node --skipLibCheck test/support/run-driver-pwa-site-reset-mutations.mjs
"${compose[@]}" --profile tools run --rm -e MBT_MUTATION_EPHEMERAL=1 mutation npm run mutate:driver-pwa-site-reset
"${compose[@]}" --profile runtime up -d --wait app
"${compose[@]}" --profile runtime --profile e2e run --rm e2e npx playwright test --config test/playwright.config.mjs driver-pwa-cache-repair.spec.js --project=webkit-mobile
"${compose[@]}" --profile tools run --rm test npm run secrets:driver-pwa-site-reset

echo "Driver PWA site-reset gauntlet complete."
