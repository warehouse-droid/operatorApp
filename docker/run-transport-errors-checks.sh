#!/usr/bin/env bash
set -Eeuo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -z "${MBBS_TEST_ARTIFACT_DIR:-}" ]]; then
  exec python3 "$repo_dir/docker/retention/retention.py" run -- bash "$0" "$@"
fi
export DISPATCH_SOURCE_SKIP_BUILD=1
export DISPATCH_SOURCE_MIGRATIONS="${DISPATCH_SOURCE_RUNTIME:-$repo_dir/server}/migrations"
export DISPATCH_SOURCE_BASELINE="$repo_dir/server/deployments/transport-errors-20261024/workspace-before"
result=0
bash "$repo_dir/docker/run-dispatch-source-tests.sh" node tools/transport-errors-checks.mjs || result=$?
python3 - "$repo_dir" <<'PY'
import json,os,sys
from pathlib import Path
repo=Path(sys.argv[1]);report=Path(os.environ['MBBS_TEST_ARTIFACT_DIR'])/'transport-errors-validation.json'
if report.exists():
    result=json.loads(report.read_text());out=repo/'server/deployments/transport-errors-20261024'
    result['runtime']=os.environ.get('DISPATCH_SOURCE_RUNTIME',str(repo/'server'))
    assert result['runtime']==str(out/'candidate'),'Validate the prepared candidate'
    assert result['sourceHashes']==json.loads((out/'prepared.json').read_text())['sourceHashes']
    (out/'validation.json').write_text(json.dumps(result,indent=2)+'\n')
PY
exit "$result"
