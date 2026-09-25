#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
sudo -n docker exec -e DATABASE_URL=postgres://mbt_test:special_review_only@mbbs-special-review-db:5432/mbt_verify mbbs-special-review-runner node tools/special-workflow-pricing-migrate.mjs
sudo -n docker exec -e DATABASE_URL=postgres://mbt_test:special_review_only@mbbs-special-review-db:5432/mbt_verify -e MBT_ENABLED=true -e SPECIAL_WORKFLOW_OUTPUT=test-artifacts/special-workflow-pricing/final mbbs-special-review-runner node tools/special-workflow-pricing-gauntlet.mjs
