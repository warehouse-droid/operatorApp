#!/usr/bin/env bash
set -Eeuo pipefail
task_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$task_root"
artifact=server/test-artifacts/receiving-followup
mkdir -p "$artifact/baseline/src" "$artifact/baseline/public"
mkdir -p "$artifact/baseline/test/mbt/unit"
cp server/src/receiving-repository.js server/src/operator-netsuite-posting-targets.js "$artifact/baseline/src/"
cp server/public/operator.js server/public/operator.html server/public/service-worker.js "$artifact/baseline/public/"
for file in operations-navigation-enhancements.test.js operator-customer-pickup-photo-gate-ui.contract.test.js operator-page-confirm-ui.contract.test.js operator-yard-assets.test.js; do
  cp "server/test/mbt/unit/$file" "$artifact/baseline/test/mbt/unit/"
done
patch --batch -p1 -d "$artifact/baseline" < server/test/support/receiving-followup-baseline.patch
if RECEIVING_FOLLOWUP_BASELINE=1 bash server/tools/receiving-followup-test.sh node --test test/mbt/integration/receiving-followup.test.js > "$artifact/red.log" 2>&1; then
  echo 'Expected the old receiving behavior to fail the regression tests' >&2
  exit 1
fi
RECEIVING_FOLLOWUP_BASELINE=1 bash server/tools/receiving-followup-test.sh node tools/receiving-followup-checks.mjs baseline
RECEIVING_FOLLOWUP_BASELINE=1 bash server/tools/receiving-followup-test.sh node tools/receiving-followup-full.mjs baseline > "$artifact/full-baseline.log" 2>&1 || true
bash server/tools/receiving-followup-test.sh sh -c 'node tools/receiving-followup-checks.mjs suite && node tools/receiving-followup-checks.mjs coverage && node tools/receiving-followup-checks.mjs mutations && node tools/receiving-followup-checks.mjs property-mutations && node tools/receiving-followup-checks.mjs shuffle'
bash server/tools/receiving-followup-test.sh node tools/receiving-followup-supplement.mjs
bash server/tools/receiving-followup-test.sh node tools/receiving-followup-full.mjs > "$artifact/full-candidate.log" 2>&1 || true
bash server/tools/receiving-followup-test.sh node tools/receiving-followup-checks.mjs cache-contracts
python3 server/tools/receiving-followup-full-compare.py
RECEIVING_FOLLOWUP_TEST_IMAGE=mbbs-mbt-p1-test-e2e:latest bash server/tools/receiving-followup-test.sh node tools/receiving-followup-browser.mjs
