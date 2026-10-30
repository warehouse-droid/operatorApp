#!/usr/bin/env bash
set -Eeuo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -z "${MBBS_TEST_ARTIFACT_DIR:-}" ]]; then
  exec python3 "$repo_dir/docker/retention/retention.py" run -- bash "$0" "$@"
fi
export DISPATCH_SOURCE_SKIP_BUILD=1
export DISPATCH_SOURCE_RUNTIME="$repo_dir/server/deployments/regular-stock-add-items-20261027/live-before"
export DISPATCH_SOURCE_MIGRATIONS="$DISPATCH_SOURCE_RUNTIME/migrations"
result=0
bash "$repo_dir/docker/run-dispatch-source-tests.sh" node tools/regular-stock-add-items-baseline.mjs || result=$?
python3 - "$repo_dir" <<'PY'
import json, os, sys
from pathlib import Path
report = json.loads((Path(os.environ['MBBS_TEST_ARTIFACT_DIR']) / 'mbt-uat-results.json').read_text())
out = Path(sys.argv[1]) / 'server/tools/regular-stock-add-items-baseline.json'
out.write_text(json.dumps({'source': 'Unchanged live image mbbs-operator-app:backorder-po-alerts-20261027',
    'sourceHashes': report['sourceHashes'], 'files': [row for row in report['files'] if row['fail']]}, indent=2) + '\n')
PY
exit "$result"
