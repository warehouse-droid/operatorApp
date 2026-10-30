#!/usr/bin/env bash
set -Eeuo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -z "${MBBS_TEST_ARTIFACT_DIR:-}" ]]; then
  exec python3 "$repo_dir/docker/retention/retention.py" run -- bash "$0" "$@"
fi
export DISPATCH_SOURCE_SKIP_BUILD=1
export DISPATCH_SOURCE_MIGRATIONS="${DISPATCH_SOURCE_RUNTIME:-$repo_dir/server}/migrations"
export DISPATCH_SOURCE_BASELINE="$repo_dir/server/deployments/pallet-return-search-20261029/workspace-before"
bash "$repo_dir/docker/run-dispatch-source-tests.sh" node tools/pallet-return-search-checks.mjs
python3 - "$repo_dir" <<'PY'
import json, os, sys
from pathlib import Path
repo=Path(sys.argv[1])
report=json.loads((Path(os.environ['MBBS_TEST_ARTIFACT_DIR'])/'pallet-return-search-validation.json').read_text())
runtime=Path(os.environ.get('DISPATCH_SOURCE_RUNTIME', str(repo/'server')))
if runtime.name=='candidate':
    assert report['sourceHashes']==json.loads((runtime.parent/'prepared.json').read_text())['sourceHashes']
    target=runtime.parent/'validation.json'
else:
    target=repo/'server/test/pallet-return-search-validation.json'
target.write_text(json.dumps(report,indent=2)+'\n')
PY
