#!/usr/bin/env bash
set -Eeuo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -z "${MBBS_TEST_ARTIFACT_DIR:-}" ]]; then
  exec python3 "$repo_dir/docker/retention/retention.py" run -- bash "$0" "$@"
fi
cd "$repo_dir"
test_project="mbbs-stock-hourly-$$"
compose=(docker compose -p "$test_project" -f "$repo_dir/docker-compose.mbt-test.yml" -f "$MBBS_TEST_ARTIFACT_DIR/compose.json")
cleanup() {
  status=$?
  trap - EXIT INT TERM
  if [[ -f "$MBBS_TEST_ARTIFACT_DIR/compose.json" ]]; then "${compose[@]}" down --volumes --remove-orphans || status=1; fi
  docker ps --format '{{.Names}} {{.Status}}'
  docker ps -a --format '{{.Names}} {{.Status}}'
  [[ -z "$(docker ps -aq --filter "label=com.docker.compose.project=$test_project")" ]] || status=1
  [[ -z "$(docker volume ls -q --filter "label=com.docker.compose.project=$test_project")" ]] || status=1
  [[ -z "$(docker network ls -q --filter "label=com.docker.compose.project=$test_project")" ]] || status=1
  curl -fsS -o /dev/null http://127.0.0.1:3000/health || status=1
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
python3 docker/verify-memory-limits.py
python3 - <<'PY'
import difflib,hashlib,io,json,os,shutil,subprocess,tarfile
from pathlib import Path
root=Path.cwd()/'server'; artifact=Path(os.environ['MBBS_TEST_ARTIFACT_DIR']); stage=artifact/'candidate'
release=root/'deployments/stock-request-hourly-refresh-20261028'
files=['src/server.js', 'public/regular-stock-status.js', 'public/regular-stock-status-ui.js', 'public/regular-stock-ui.js', 'public/sales-stock-requests.html', 'public/scm-stock-requests.html', 'src/stock-request-so-refresh-domain.js', 'src/stock-request-so-refresh-repository.js', 'src/stock-request-so-refresh.js']
existing=[name for name in files if (release/'workspace-before'/name).exists()]
image=subprocess.check_output(['docker','inspect','--format','{{.Image}}','mbbs-operator-app-app-1'],text=True).strip()
stage.mkdir();artifact.chmod(0o777)
archive=subprocess.check_output(['docker','exec','mbbs-operator-app-app-1','tar','-C','/app','-cf','-','src','public','migrations','package.json','package-lock.json'])
with tarfile.open(fileobj=io.BytesIO(archive)) as data:data.extractall(stage,filter='data')
patch=''.join(''.join(difflib.unified_diff((release/'workspace-before'/name).read_text().splitlines(True),(root/name).read_text().splitlines(True),fromfile='a/'+name,tofile='b/'+name)) for name in existing)
deployed=release/'deployment-result.json'
recheck=deployed.exists() and json.loads(deployed.read_text())['imageId']==image
for name in files:
 target=stage/'baseline'/name;target.parent.mkdir(parents=True,exist_ok=True)
 
 if name not in existing:
  target.write_text('export {};\n');shutil.copy2(root/name,stage/name);continue
 shutil.copy2(release/'live-before'/name if recheck else stage/name,target)
 if not recheck:
  target=release/'live-before'/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(stage/name,target)
if recheck:
 assert patch==(release/'release.patch').read_text(),'Task source changed after deployment; prepare a new release'
else:
 if patch:subprocess.run(['patch','--batch','--forward','--fuzz=0','-p1','-d',str(stage)],input=patch,text=True,check=True)
(release/'release.patch').write_text(patch)
for name in files:
 target=release/'candidate'/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(stage/name,target)
shutil.copytree(root/'test',stage/'test')
(stage/'tools').mkdir();shutil.copy2(root/'tools/stock-request-hourly-checks.mjs',stage/'tools/stock-request-hourly-checks.mjs')
shutil.copy2(root/'eslint.mbt.config.js',stage/'eslint.mbt.config.js')
if (release/'baseline-result.json').exists():shutil.copy2(release/'baseline-result.json',stage/'baseline-result.json')
(stage/'node_modules').symlink_to('/app/node_modules',target_is_directory=True)
(stage/'test-artifacts').mkdir()
for target in [stage,*stage.rglob('*')]:
 if not target.is_symlink():target.chmod(0o777 if target.is_dir() else 0o666)
changes={name:[i+1 for tag,a,b,c,d in difflib.SequenceMatcher(None,(stage/'baseline'/name).read_text().splitlines(),(stage/name).read_text().splitlines(),autojunk=False).get_opcodes() if tag!='equal' for i in range(c,d)] for name in files}
proof={'baseImage':image,'files':{name:hashlib.sha256((stage/name).read_bytes()).hexdigest() for name in files},'changedLines':changes}
(stage/'test-artifacts/inputs.json').write_text(json.dumps(proof));(stage/'test-artifacts/inputs.json').chmod(0o666)
(release/'tested-inputs.json').write_text(json.dumps(proof,indent=2)+'\n')
services={}
for name,tag in [('test','mbbs-mbt-p1-test-e2e:latest'),('migrate','mbbs-mbt-p1-test-test:latest')]:
 services[name]={'image':subprocess.check_output(['docker','image','inspect','--format','{{.Id}}',tag],text=True).strip(),'volumes':[{'type':'bind','source':str(artifact),'target':'/app/test-artifacts'}],
 'environment':{'PLAYWRIGHT_BROWSERS_PATH':'/ms-playwright','XDG_CONFIG_HOME':'/tmp/xdg-config','XDG_CACHE_HOME':'/tmp/xdg-cache'},'labels':{'com.mbbs.lifecycle':'disposable-test'}}
services['db']={'labels':{'com.mbbs.lifecycle':'disposable-test'},'networks':{'mbt_test_internal':{'aliases':['mbbs-special-review-db']}}}
(artifact/'compose.json').write_text(json.dumps({'services':services}))
print(json.dumps({'baseImage':image,'files':files}),flush=True)
PY
"${compose[@]}" up -d --wait db > "$MBBS_TEST_ARTIFACT_DIR/setup.log" 2>&1
"${compose[@]}" run --rm --no-deps -T migrate >> "$MBBS_TEST_ARTIFACT_DIR/setup.log" 2>&1
set +e
"${compose[@]}" run --rm --no-deps -T test bash -c 'cd /app/test-artifacts/candidate; node tools/stock-request-hourly-checks.mjs "$1"' -- "${1:-focused}" > "$MBBS_TEST_ARTIFACT_DIR/checks.log" 2>&1
status=$?
set -e
tail -n 110 "$MBBS_TEST_ARTIFACT_DIR/checks.log"
python3 - "${1:-focused}" "$status" <<'PY'
import json,os,sys
from pathlib import Path
stage=Path(os.environ['MBBS_TEST_ARTIFACT_DIR'])/'candidate'
release=Path('server/deployments/stock-request-hourly-refresh-20261028')
report=stage/'test-artifacts/report.json'
data=json.loads(report.read_text()) if report.exists() else {'passed':False,'exitCode':sys.argv[2]}
(release/(sys.argv[1]+'-result.json')).write_text(json.dumps(data,indent=2)+'\n')
PY
exit "$status"
