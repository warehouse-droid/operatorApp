#!/usr/bin/env bash
set -Eeuo pipefail
server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$server_root"
mode=current
if [[ -n "${SOR_CANDIDATE_ROOT:-}" ]]; then mode=candidate; fi
created=false
if ! docker container inspect mbbs-sor-rentals-test-db >/dev/null 2>&1; then
  bash tools/sor-rentals-test-env.sh start
  created=true
fi
cleanup() { if [[ "$created" == true ]]; then bash tools/sor-rentals-test-env.sh stop; fi; }
trap cleanup EXIT
mkdir -p test-artifacts/sor-feature-gate
bash tools/sor-rentals-test-env.sh run "$mode" node src/migrate.js > test-artifacts/sor-feature-gate/gauntlet-migrations.log
bash tools/sor-rentals-test-env.sh run "$mode" node tools/sor-feature-gate-checks.mjs > test-artifacts/sor-feature-gate/final-focused.log 2>&1
bash tools/sor-rentals-test-env.sh run "$mode" node tools/sor-feature-gate-browser.mjs > test-artifacts/sor-feature-gate/browser.log 2>&1
python3 tools/sor-feature-gate-quality.py static
python3 tools/sor-feature-gate-quality.py mutations
