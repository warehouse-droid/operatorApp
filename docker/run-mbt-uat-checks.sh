#!/usr/bin/env bash
set -Eeuo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -z "${MBBS_TEST_ARTIFACT_DIR:-}" ]]; then
  exec python3 "$repo_dir/docker/retention/retention.py" run -- bash "$0" "$@"
fi
: "${DISPATCH_SOURCE_RUNTIME:?Point DISPATCH_SOURCE_RUNTIME at the runtime being verified}"
export DISPATCH_SOURCE_MIGRATIONS="$DISPATCH_SOURCE_RUNTIME/migrations"
result=0
bash "$repo_dir/docker/run-dispatch-source-tests.sh" node tools/mbt-uat-checks.mjs "$@" || result=$?
python3 - "$repo_dir" <<'PY'
import json, os, sys
from pathlib import Path
report = Path(os.environ['MBBS_TEST_ARTIFACT_DIR']) / 'mbt-uat-results.json'
if report.exists():
    data = json.loads(report.read_text())
    data['runtime'] = os.environ['DISPATCH_SOURCE_RUNTIME']
    audit = Path(sys.argv[1]) / 'server/test/uat-audits'
    audit.mkdir(exist_ok=True)
    stamp = data['startedAt'].replace(':', '').replace('.', '')
    destination = audit / f'mbt-uat-{stamp}.json'
    destination.write_text(json.dumps(data, indent=2) + '\n')
    print(f'Concise UAT evidence: {destination}')
PY
exit "$result"
