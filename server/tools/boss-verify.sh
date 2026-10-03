#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
mkdir -p test-artifacts/boss-approvals
python3 tools/boss-changed-lines.py
if ! docker container inspect mbbs-boss-test-runner >/dev/null 2>&1; then
  bash tools/boss-test-env.sh start
  bash tools/boss-test-env.sh exec node src/migrate.js > test-artifacts/boss-approvals/final-migrations.log 2>&1
fi
status=0
bash tools/boss-test-env.sh exec node tools/boss-gauntlet.mjs || status=$?
bash tools/boss-test-env.sh exec node tools/boss-coverage.mjs || status=$?
bash tools/boss-test-env.sh exec node tools/boss-secrets.mjs || status=$?
bash tools/boss-test-env.sh exec tar -C /app/test-artifacts/boss-approvals -czf - . > test-artifacts/boss-approvals/final-artifacts.tgz
tar -xzf test-artifacts/boss-approvals/final-artifacts.tgz -C test-artifacts/boss-approvals
exit "$status"
