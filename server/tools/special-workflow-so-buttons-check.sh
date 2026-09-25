#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
sudo -n docker exec -e DATABASE_URL=postgres://mbt_test:special_review_only@mbbs-special-review-db:5432/mbt_verify -e MBT_ENABLED=true mbbs-special-review-runner node tools/special-workflow-so-buttons-check.mjs
