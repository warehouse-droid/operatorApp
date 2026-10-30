#!/usr/bin/env bash
set -Eeuo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -z "${MBBS_TEST_ARTIFACT_DIR:-}" ]]; then
  exec python3 "$repo_dir/docker/retention/retention.py" run -- bash "$0" "$@"
fi
export DISPATCH_SOURCE_SKIP_BUILD=1
export DISPATCH_SOURCE_MIGRATIONS="${DISPATCH_SOURCE_RUNTIME:-$repo_dir/server}/migrations"
export DISPATCH_SOURCE_BASELINE="$repo_dir/server/deployments/mbr-aggregate-planning-20261023/workspace-before"
result=0
bash "$repo_dir/docker/run-dispatch-source-tests.sh" node tools/mbr-aggregate-gauntlet.mjs || result=$?
# A concise source-hashed verification record is an operational audit record.
# Raw logs, databases, coverage and browser files remain in the disposable directory.
python3 - "$repo_dir" <<'PY'
import json,os,sys
from pathlib import Path
repo=Path(sys.argv[1]);artifact=Path(os.environ['MBBS_TEST_ARTIFACT_DIR'])
report=artifact/'mbr-aggregate-gauntlet.json'
if report.exists():
    result=json.loads(report.read_text());out=repo/'server/deployments/mbr-aggregate-planning-20261023'
    result['runtime']=os.environ.get('DISPATCH_SOURCE_RUNTIME',str(repo/'server'))
    if result['runtime']==str(out/'candidate'):
        expected=json.loads((out/'prepared.json').read_text())['sourceHashes']
        assert result['sourceHashes']==expected,'Candidate validation source mismatch'
        (out/'validation.json').write_text(json.dumps(result,indent=2)+'\n')
    else:
        (out/'workspace-validation.json').write_text(json.dumps(result,indent=2)+'\n')
PY
exit "$result"
