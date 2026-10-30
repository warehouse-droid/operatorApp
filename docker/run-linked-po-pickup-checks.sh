#!/usr/bin/env bash
set -Eeuo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -z "${MBBS_TEST_ARTIFACT_DIR:-}" ]]; then
  exec python3 "$repo_dir/docker/retention/retention.py" run -- bash "$0" "$@"
fi
cd "$repo_dir"
test_project="mbbs-linked-po-$$"
export MBBS_LINKED_PO_SOURCE_CONTAINER="$test_project-source"
override="$MBBS_TEST_ARTIFACT_DIR/compose.json"
compose=(docker compose -p "$test_project" -f docker-compose.mbt-test.yml -f "$override")
cleanup() {
  result=$?
  trap - EXIT INT TERM
  docker rm -f "$MBBS_LINKED_PO_SOURCE_CONTAINER" > /dev/null 2>&1 || true
  "${compose[@]}" down --volumes --remove-orphans > "$MBBS_TEST_ARTIFACT_DIR/cleanup.log" 2>&1 || result=1
  docker ps --format '{{.Names}} {{.Status}}'
  docker ps -a --format '{{.Names}} {{.Status}}'
  [[ -z "$(docker ps -aq --filter "label=com.docker.compose.project=$test_project")" ]] || result=1
  [[ -z "$(docker volume ls -q --filter "label=com.docker.compose.project=$test_project")" ]] || result=1
  [[ -z "$(docker network ls -q --filter "label=com.docker.compose.project=$test_project")" ]] || result=1
  curl -fsS -o /dev/null http://127.0.0.1:3000/health || result=1
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
python3 docker/verify-memory-limits.py
python3 - <<'PY'
import os,json,shutil,subprocess,hashlib,difflib,importlib.util,sys
from pathlib import Path
sys.dont_write_bytecode=True
artifact=Path(os.environ['MBBS_TEST_ARTIFACT_DIR']); candidate=artifact/'candidate'; candidate.mkdir()
files=json.loads(Path('server/tools/linked-po-pickup-files.json').read_text())
spec=importlib.util.spec_from_file_location('linked_po_source','server/tools/linked-po-pickup-source.py')
scoped=importlib.util.module_from_spec(spec);spec.loader.exec_module(scoped)
source_image=os.environ.get('MBBS_LINKED_PO_BASE_IMAGE')
if source_image:
    base_image=subprocess.check_output(['docker','image','inspect','--format','{{.Id}}',source_image],text=True).strip()
    runtime=subprocess.check_output(['docker','run','--rm','--name',os.environ['MBBS_LINKED_PO_SOURCE_CONTAINER'],
        '--init','--network=none','--cgroup-parent=mbbs-tests.slice','--memory=256m','--memory-swap=256m',
        '--cpus=0.5','--pids-limit=64','--read-only','--tmpfs','/tmp:rw,size=16m',
        '--label','com.mbbs.lifecycle=disposable-test','--entrypoint','tar',source_image,
        '-C','/app','-cf','-','src','public','migrations','package.json','package-lock.json'])
else:
    base_image=subprocess.check_output(['docker','inspect','--format','{{.Image}}','mbbs-operator-app-app-1'],text=True).strip()
    runtime=subprocess.check_output(['docker','exec','mbbs-operator-app-app-1','tar','-C','/app','-cf','-','src','public','migrations','package.json','package-lock.json'])
subprocess.run(['tar','--no-same-owner','-xf','-','-C',str(candidate)],input=runtime,check=True)
shutil.copytree(Path('server/test'),candidate/'test')
inputs={'baseImage':base_image,'files':{},'changedLines':{}}
for file in files:
    baseline=candidate/'baseline'/file;baseline.parent.mkdir(parents=True,exist_ok=True)
    shutil.copy2(candidate/file,baseline)
    expected=Path('server/deployments/linked-po-pickup-20261028/live-before')/file
    assert baseline.read_bytes()==expected.read_bytes(),f'Live source changed: {file}'
    (candidate/file).write_text(scoped.candidate_source(Path('server'),file,baseline.read_text()))
    inputs['files'][file]=hashlib.sha256((candidate/file).read_bytes()).hexdigest()
    old=baseline.read_text().splitlines();new=(candidate/file).read_text().splitlines()
    inputs['changedLines'][file]=[line+1 for tag,a,b,c,d in difflib.SequenceMatcher(None,old,new,autojunk=False).get_opcodes() if tag!='equal' for line in range(c,d)]
(candidate/'tools').mkdir()
for path in Path('server/tools').glob('linked-po-pickup-*'):
    if path.is_file(): shutil.copy2(path,candidate/'tools'/path.name)
shutil.copy2('server/tools/dispatch-history-cargo-oracle.mjs',candidate/'tools/dispatch-history-cargo-oracle.mjs')
for file in ['package.json','eslint.mbt.config.js']:
    shutil.copy2(Path('server')/file,candidate/file)
(candidate/'test-artifacts').mkdir()
inputs['verificationSources']={str(path):hashlib.sha256(path.read_bytes()).hexdigest() for folder in ['server/tools','server/test/dispatch/unit','server/test/dispatch/integration','server/test/dispatch/fixtures'] for path in Path(folder).glob('linked-po-pickup-*') if path.is_file()}
inputs['verificationSources']['docker/run-linked-po-pickup-checks.sh']=hashlib.sha256(Path('docker/run-linked-po-pickup-checks.sh').read_bytes()).hexdigest()
(candidate/'test-artifacts/inputs.json').write_text(json.dumps(inputs))
for path in artifact.rglob('*'):
    path.chmod(0o777 if path.is_dir() else 0o666)
artifact.chmod(0o777)
services={n:{'labels':{'com.mbbs.lifecycle':'disposable-test'},'volumes':[{'type':'bind','source':str(artifact),'target':'/app/test-artifacts'}]} for n in ['test','migrate']}
services['db']={'labels':{'com.mbbs.lifecycle':'disposable-test'}}
(artifact/'compose.json').write_text(json.dumps({'services':services}))
PY
"${compose[@]}" up -d --wait db > "$MBBS_TEST_ARTIFACT_DIR/setup.log" 2>&1
"${compose[@]}" run --rm --no-deps -T migrate >> "$MBBS_TEST_ARTIFACT_DIR/setup.log" 2>&1
if (( $# == 0 )); then set -- node --test --test-concurrency=1 test/dispatch/unit/linked-po-pickup-20261028.test.js test/dispatch/integration/linked-po-pickup-feed-20261028.test.js; fi
set +e
"${compose[@]}" run --rm --no-deps -T test bash -c 'cd /app/test-artifacts/candidate; ln -s /app/node_modules node_modules; exec "$@"' -- "$@" > "$MBBS_TEST_ARTIFACT_DIR/checks.log" 2>&1
result=$?
set -e
tail -n 95 "$MBBS_TEST_ARTIFACT_DIR/checks.log"
if [[ -f "$MBBS_TEST_ARTIFACT_DIR/candidate/test-artifacts/linked-po-pickup-report.json" ]]; then
  cp "$MBBS_TEST_ARTIFACT_DIR/candidate/test-artifacts/linked-po-pickup-report.json" server/test/linked-po-pickup-20261028-evidence.json
fi
exit "$result"
