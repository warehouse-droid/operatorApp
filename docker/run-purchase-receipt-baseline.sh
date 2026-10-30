#!/usr/bin/env bash
set -Eeuo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -z "${MBBS_TEST_ARTIFACT_DIR:-}" ]]; then
  exec python3 "$repo_dir/docker/retention/retention.py" run --root /tmp/purchase-receipt-baseline -- bash "$0"
fi
export DISPATCH_SOURCE_SKIP_BUILD=1
export DISPATCH_SOURCE_RUNTIME="$repo_dir/server/deployments/backorder-po-receipts-20261027/live-before"
export DISPATCH_SOURCE_MIGRATIONS="$DISPATCH_SOURCE_RUNTIME/migrations"
result=0
bash "$repo_dir/docker/run-dispatch-source-tests.sh" env RECEIPT_BASELINE_CAPTURE=1 node tools/purchase-receipt-test-report.mjs test/mbt/integration/direct-po-materialized-split-range.test.js test/mbt/integration/direct-po-materialized-split.test.js > "$MBBS_TEST_ARTIFACT_DIR/baseline-console.log" 2>&1 || result=$?
python3 - "$repo_dir" <<'PY'
import json,os,sys
from pathlib import Path
root=Path(sys.argv[1]);result=json.loads((Path(os.environ['MBBS_TEST_ARTIFACT_DIR'])/'mbt-uat-results.json').read_text())
evidence={key:result[key] for key in ['startedAt','finishedAt','sourceHashes','tests','pass','fail','fileCount']}
evidence['runtime']='Captured unchanged live source and migrations before this task'
evidence['files']=[{key:row[key] for key in ['file','tests','pass','fail','failedNames']} for row in result['files']]
evidence['reason']='Existing direct-PO materialized split tests expect migration 291_direct_po_materialized_split_status.sql and behaviors absent from the captured live release.'
(root/'server/tools/purchase-receipt-baseline.json').write_text(json.dumps(evidence,indent=2)+'\n')
print(json.dumps({key:evidence[key] for key in ['runtime','tests','pass','fail','fileCount','reason']},indent=2))
PY
exit "$result"
