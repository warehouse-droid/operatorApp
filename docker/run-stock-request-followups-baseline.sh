#!/usr/bin/env bash
set -Eeuo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -z "${MBBS_TEST_ARTIFACT_DIR:-}" ]]; then
  exec python3 "$repo_dir/docker/retention/retention.py" run --root /tmp/stock-request-followups-baseline -- bash "$0"
fi
export DISPATCH_SOURCE_SKIP_BUILD=1
export DISPATCH_SOURCE_RUNTIME="$repo_dir/server/deployments/stock-request-followups-20261027/live-before"
export DISPATCH_SOURCE_MIGRATIONS="$DISPATCH_SOURCE_RUNTIME/migrations"
result=0
bash "$repo_dir/docker/run-dispatch-source-tests.sh" env RECEIPT_BASELINE_CAPTURE=1 node --require ./tools/stock-request-followups-browser-env.cjs tools/stock-request-followups-report.mjs test/mbt/unit/backorder-pending-po.test.js test/mbt/integration/backorder-pending-po.test.js test/mbt/integration/backorder-already-ordered-browser.test.js test/mbt/integration/regular-stock-resolution-browser.test.js test/mbt/integration/regular-waitlist-http-browser.test.js test/mbt/integration/stocking-line-actions-browser.test.js > "$MBBS_TEST_ARTIFACT_DIR/baseline-console.log" 2>&1 || result=$?
python3 - "$repo_dir" <<'PY'
import json,os,sys
from pathlib import Path
root=Path(sys.argv[1]);result=json.loads((Path(os.environ['MBBS_TEST_ARTIFACT_DIR'])/'mbt-uat-results.json').read_text())
evidence={key:result[key] for key in ['startedAt','finishedAt','sourceHashes','tests','pass','fail','fileCount']}
evidence['runtime']='Captured unchanged live source and migrations before this task'
evidence['files']=[{key:row[key] for key in ['file','tests','pass','fail','failedNames']} for row in result['files']]
evidence['reason']='Pre-existing pending-PO/Already Ordered expectations, notification modal interference, and obsolete line-reply selectors reproduced against unchanged live source. Exact failure names must match the candidate.'
(root/'server/tools/stock-request-followups-baseline.json').write_text(json.dumps(evidence,indent=2)+'\n')
print(json.dumps({key:evidence[key] for key in ['runtime','tests','pass','fail','fileCount','reason']},indent=2))
PY
exit "$result"
