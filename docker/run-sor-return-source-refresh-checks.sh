#!/usr/bin/env bash
set -Eeuo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -z "${MBBS_TEST_ARTIFACT_DIR:-}" ]]; then
  exec python3 "$repo_dir/docker/retention/retention.py" run -- bash "$0" "$@"
fi
cd "$repo_dir"
python3 - <<'PY'
import difflib,io,json,os,shutil,subprocess,tarfile
from pathlib import Path
root=Path.cwd()/'server'
candidate=Path(os.environ['MBBS_TEST_ARTIFACT_DIR'])/'sor-candidate'
candidate.mkdir()
app='mbbs-operator-app-app-1'
image=subprocess.check_output(['docker','inspect','--format','{{.Image}}',app],text=True).strip()
archive=subprocess.check_output(['docker','exec',app,'tar','-C','/app','-cf','-','src','public','migrations','package.json'])
with tarfile.open(fileobj=io.BytesIO(archive)) as data:
    data.extractall(candidate,filter='data')
files=json.loads((root/'tools/sor-return-source-refresh-files.json').read_text())
changes={}
(candidate/'test-artifacts/source-before').mkdir(parents=True)
for name in files:
    target=candidate/name
    before=target.read_text().splitlines() if target.exists() else []
    if target.exists():
        saved=candidate/'test-artifacts/source-before'/name
        saved.parent.mkdir(parents=True,exist_ok=True)
        shutil.copy2(target,saved)
    after=(root/name).read_text().splitlines()
    changes[name]=[line+1 for tag,a,b,c,d in difflib.SequenceMatcher(None,before,after).get_opcodes()
                   if tag in ('replace','insert') for line in range(c,d)]
    shutil.copy2(root/name,target)
shutil.copytree(root/'test',candidate/'test')
(candidate/'tools').mkdir()
shutil.copy2(root/'tools/sor-return-source-refresh-checks.mjs',candidate/'tools/sor-return-source-refresh-checks.mjs')
(candidate/'test-artifacts').mkdir(exist_ok=True)
(candidate/'test-artifacts/source-changes.json').write_text(json.dumps({'imageId':image,'changedLines':changes}))
assert subprocess.check_output(['docker','inspect','--format','{{.Image}}',app],text=True).strip()==image
print(json.dumps({'candidateBaseImage':image,'overlayFiles':files}),flush=True)
PY
set +e
bash docker/run-isolated-tests.sh bash -c 'cd /app/test-artifacts/sor-candidate; ln -s /app/node_modules node_modules; node tools/sor-return-source-refresh-checks.mjs "$1"' -- "${1:-all}" > "$MBBS_TEST_ARTIFACT_DIR/runner.log" 2>&1
test_status=$?
set -e
tail -n 75 "$MBBS_TEST_ARTIFACT_DIR/runner.log"
python3 - <<'PY'
import json,os
from pathlib import Path
root=Path(os.environ['MBBS_TEST_ARTIFACT_DIR'])/'sor-candidate/test-artifacts'
path=root/'sor-return-source-refresh/report.json'
if path.exists():
    report=json.loads(path.read_text())
    report['runtimeBaseImage']=json.loads((root/'source-changes.json').read_text())['imageId']
    # Concise reproducible evidence is retained; raw logs, coverage and runtime
    # copies are removed by the outer retention runner after Compose teardown.
    Path('server/test/sor-return-source-refresh-evidence.json').write_text(json.dumps(report,indent=2)+'\n')
PY
exit "$test_status"
