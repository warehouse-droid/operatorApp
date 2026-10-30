#!/usr/bin/env bash
set -Eeuo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -z "${MBBS_TEST_ARTIFACT_DIR:-}" ]]; then
  exec python3 "$repo_dir/docker/retention/retention.py" run --root /tmp/frontdesk-current-actions-tests -- bash "$0" "$@"
fi
export DISPATCH_SOURCE_SKIP_BUILD=1
export DISPATCH_SOURCE_RUNTIME="$repo_dir/server/deployments/frontdesk-current-actions-20261026/candidate"
export DISPATCH_SOURCE_MIGRATIONS="$DISPATCH_SOURCE_RUNTIME/migrations"
result=0
bash "$repo_dir/docker/run-dispatch-source-tests.sh" node tools/frontdesk-current-actions-checks.mjs || result=$?
python3 - "$repo_dir" <<'PY'
import json,os,sys
from pathlib import Path
out=Path(sys.argv[1])/'server/deployments/frontdesk-current-actions-20261026'
report=Path(os.environ['MBBS_TEST_ARTIFACT_DIR'])/'frontdesk-current-actions-validation.json'
if report.exists():
    data=json.loads(report.read_text())
    assert data['sourceHashes']==json.loads((out/'prepared.json').read_text())['sourceHashes']
    (out/'validation.json').write_text(json.dumps(data,indent=2)+'\n')
PY
exit "$result"
