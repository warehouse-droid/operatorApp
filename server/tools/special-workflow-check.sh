#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
rm -f test-artifacts/special-workflow-review/cleanup.txt test-artifacts/special-workflow-review/python-version.txt
sudo -n docker exec \
  -e DATABASE_URL=postgres://mbt_test:special_review_only@mbbs-special-review-db:5432/mbt_verify \
  mbbs-special-review-runner node tools/special-workflow-gauntlet.mjs
python3 test/special-workflow-cleanup.test.py > test-artifacts/special-workflow-review/cleanup.txt 2>&1
python3 --version > test-artifacts/special-workflow-review/python-version.txt
cat test-artifacts/special-workflow-review/cleanup.txt
