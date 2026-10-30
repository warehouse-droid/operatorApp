#!/usr/bin/env bash
set -Eeuo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -z "${MBBS_TEST_ARTIFACT_DIR:-}" ]]; then
  exec python3 "$repo_dir/docker/retention/retention.py" run -- bash "$0" "$@"
fi
python3 - "$repo_dir" "$MBBS_TEST_ARTIFACT_DIR" <<'PY'
import shutil, sys, json, difflib, os
from pathlib import Path
repo, artifact = map(Path,sys.argv[1:])
baseline = repo/'server/deployments/bin-final-collection-gate-20261023/workspace-before'
if os.environ.get('DISPATCH_SOURCE_RUNTIME'):
    baseline = repo/'server/deployments/bin-final-collection-gate-20261023/live-before'
if baseline.exists():
    shutil.copytree(baseline,artifact/'bin-selection-baseline',dirs_exist_ok=True)
    # The live source copy can retain owner-only directory modes. The isolated
    # test user needs read access to this disposable comparison copy.
    copied=artifact/'bin-selection-baseline'
    for path in [copied,*copied.rglob('*')]:
        path.chmod(path.stat().st_mode | (0o555 if path.is_dir() else 0o444))
runtime=Path(os.environ.get('DISPATCH_SOURCE_RUNTIME',str(repo/'server')))
changed={}
for file in json.loads((repo/'server/tools/bin-final-collection-files.json').read_text()):
    before=(baseline/file).read_text().splitlines() if (baseline/file).exists() else []
    after=(runtime/file).read_text().splitlines() if (runtime/file).exists() else []
    lines=[]
    for tag,a,b,c,d in difflib.SequenceMatcher(None,before,after,autojunk=False).get_opcodes():
        if tag in ('insert','replace'): lines.extend(range(c+1,d+1))
    if lines: changed[file]=lines
(artifact/'bin-selection-changed-lines.json').write_text(json.dumps(changed))
PY
if (( $# == 0 )); then set -- node tools/bin-final-collection-gauntlet.mjs; fi
set +e
bash "$repo_dir/docker/run-dispatch-source-tests.sh" "$@"
result=$?
set -e
if [[ -n "${MBBS_BIN_SELECTION_EVIDENCE_PATH:-}" ]]; then
  python3 - "$MBBS_TEST_ARTIFACT_DIR" "$MBBS_BIN_SELECTION_EVIDENCE_PATH" "$result" <<'PY_AUDIT'
import json,sys
from pathlib import Path
artifact,target=map(Path,sys.argv[1:3]);status=int(sys.argv[3])
report={"passed":status==0,"runnerExitCode":status,"cleanupVerified":status==0}
for name in ["gauntlet","static","mutations","changed-coverage"]:
    file=artifact/('bin-selection-'+name+'.json')
    if file.exists(): report[name]=json.loads(file.read_text())
if 'gauntlet' in report: report['sourceHashes']=report['gauntlet']['sourceHashes']
target.parent.mkdir(parents=True,exist_ok=True)
target.write_text(json.dumps(report,indent=2)+'\n')
PY_AUDIT
fi
exit "$result"
