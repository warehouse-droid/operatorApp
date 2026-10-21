#!/usr/bin/env bash
# Run from a checkout with the recorded mbbs-regular-v2:e2e test toolchain image.
set -Eeuo pipefail
count_verify_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$count_verify_root"
python3 tools/count-sheet-refresh-diff.py
bash tools/count-sheet-refresh-env.sh start
trap 'bash tools/count-sheet-refresh-env.sh stop' EXIT
bash tools/count-sheet-refresh-env.sh exec node src/migrate.js
docker exec -e DATABASE_URL=postgres://mbt_test:mbt_test_password@db:5432/mbt_test_file_000000000000_focus \
  -w /app mbbs-count-refresh-test-runner node tools/count-sheet-refresh-checks.mjs
