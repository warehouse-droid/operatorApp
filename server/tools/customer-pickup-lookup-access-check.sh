#!/usr/bin/env bash
set -Eeuo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo"
state=/home/ubuntu/operatorapp-deploy-backups/operator-pack-quantities-20261010
artifact="$repo/server/test-artifacts/customer-pickup-lookup-access"
mkdir -p "$artifact"
set +e
TO_YARD_CANDIDATE_ROOT="$state/baseline/app" bash server/tools/operator-to-yard-flow-test.sh \
  env PICKUP_LOOKUP_RUN=before-fix node --test --test-concurrency=1 \
  test/mbt/integration/customer-pickup-lookup-access.browser.test.mjs > "$artifact/before-fix.log" 2>&1
baseline_status=$?
set -e
[[ "$baseline_status" == 1 ]]
python3 - "$artifact/before-fix.log" <<'PY'
import json, pathlib, re, sys
log = pathlib.Path(sys.argv[1]).read_text()
assert re.search(r'^# tests 5$', log, re.M)
assert re.search(r'^# fail 4$', log, re.M)
assert len(re.findall(r'^not ok \d+ - L1 L2 ', log, re.M)) == 4
evidence = list(pathlib.Path(sys.argv[1]).parent.glob('before-fix-SOA*-*.json'))
assert len(evidence) == 4
assert all(json.loads(p.read_text())['status'] == 403 and json.loads(p.read_text())['resetToYard'] for p in evidence)
PY
TO_YARD_CANDIDATE_ROOT="$state/candidate" bash server/tools/operator-to-yard-flow-test.sh \
  node tools/customer-pickup-lookup-access-checks.mjs > "$artifact/final-checks.log" 2>&1
python3 server/tools/customer-pickup-lookup-access-release.py
