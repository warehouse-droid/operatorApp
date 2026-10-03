#!/usr/bin/env bash
# Reproduce the isolated checks. Never points at the production database.
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
if ! docker inspect mbbs-boss-test-runner >/dev/null 2>&1; then
  bash tools/boss-test-env.sh start
  bash tools/boss-test-env.sh exec node src/migrate.js
fi
bash tools/boss-test-env.sh exec node tools/staff-reset-gauntlet.mjs
bash tools/boss-test-env.sh exec node tools/staff-reset-coverage.mjs
bash tools/boss-test-env.sh exec node tools/staff-reset-secrets.mjs
docker exec mbbs-boss-test-runner tar -C /app/test-artifacts -cf - staff-login-reset-20261003 boss-approvals/browser | tar -C test-artifacts -xf -
