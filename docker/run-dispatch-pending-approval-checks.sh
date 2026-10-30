#!/usr/bin/env bash
set -Eeuo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -z "${MBBS_TEST_ARTIFACT_DIR:-}" ]]; then
  exec python3 "$repo_dir/docker/retention/retention.py" run -- bash "$0" "$@"
fi
cd "$repo_dir"
python3 - <<'PY'
import difflib, hashlib, io, json, os, shutil, subprocess, tarfile
from pathlib import Path
root=Path.cwd()/'server'
release=root/'deployments/dispatch-pending-approval-20261027'
candidate=Path(os.environ['MBBS_TEST_ARTIFACT_DIR'])/'candidate'
candidate.mkdir()
candidate.chmod(0o777)
files=['src/dispatch-repository.js','src/server.js']
image=subprocess.check_output(['docker','inspect','--format','{{.Image}}','mbbs-operator-app-app-1'],text=True).strip()
archive=subprocess.check_output(['docker','exec','mbbs-operator-app-app-1','tar','-C','/app','-cf','-','src','public','migrations','package.json','package-lock.json'])
with tarfile.open(fileobj=io.BytesIO(archive)) as data:
    data.extractall(candidate,filter='data')
patch=''.join(''.join(difflib.unified_diff(
    (release/'workspace-before'/name).read_text().splitlines(True),
    (root/name).read_text().splitlines(True),fromfile='a/'+name,tofile='b/'+name)) for name in files)
assert patch, 'Expected the requested message patch'
for name in files:
    saved=release/'live-before'/name
    saved.parent.mkdir(parents=True,exist_ok=True)
    shutil.copy2(candidate/name,saved)
subprocess.run(['patch','--batch','--fuzz=0','-p1','-d',str(candidate)],input=patch,text=True,check=True)
(release/'release.patch').write_text(patch)
for name in files:
    saved=release/'candidate'/name
    saved.parent.mkdir(parents=True,exist_ok=True)
    shutil.copy2(candidate/name,saved)
for name in ['dispatch/integration/dispatch-pending-approval-message.test.js',
             'dispatch/support/dispatch-v2-fixture.js','dispatch/support/fulfilled-so-fixture.js']:
    target=candidate/'test'/name
    target.parent.mkdir(parents=True,exist_ok=True)
    shutil.copy2(root/'test'/name,target)
# The live image owns some source files as node with mode 0600. Extraction on
# the host changes their owner, so make this credential-free test copy readable.
for target in candidate.rglob('*'):
    target.chmod(0o755 if target.is_dir() else 0o644)
proof={'baseImage':image,'files':{name:hashlib.sha256((candidate/name).read_bytes()).hexdigest() for name in files}}
assert subprocess.check_output(['docker','inspect','--format','{{.Image}}','mbbs-operator-app-app-1'],text=True).strip()==image
(release/'tested-inputs.json').write_text(json.dumps(proof,indent=2)+'\n')
print(json.dumps(proof),flush=True)
PY
set +e
bash docker/run-isolated-tests.sh bash -c 'set -e; cd /app/test-artifacts/candidate; ln -s /app/node_modules node_modules; node --check src/dispatch-repository.js; node --check src/server.js; node --test test/dispatch/integration/dispatch-pending-approval-message.test.js' > "$MBBS_TEST_ARTIFACT_DIR/runner.log" 2>&1
test_status=$?
set -e
tail -n 100 "$MBBS_TEST_ARTIFACT_DIR/runner.log"
python3 - "$test_status" <<'PY'
import json,sys
from pathlib import Path
release=Path('server/deployments/dispatch-pending-approval-20261027')
proof=json.loads((release/'tested-inputs.json').read_text())
proof['passed']=sys.argv[1]=='0'
(release/'verified.json').write_text(json.dumps(proof,indent=2)+'\n')
PY
exit "$test_status"
