#!/usr/bin/env bash
set -Eeuo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -z "${MBBS_TEST_ARTIFACT_DIR:-}" ]]; then
  exec python3 "$repo_dir/docker/retention/retention.py" run -- bash "$0" "$@"
fi
cd "$repo_dir"
test_project="mbbs-retired-po-$$"
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
root=Path.cwd()/'server';artifact=Path(os.environ['MBBS_TEST_ARTIFACT_DIR']);stage=artifact/'candidate'
release=root/'deployments/scm-retired-po-search-20261028';files=json.loads((release/'files.json').read_text())
image=subprocess.check_output(['docker','inspect','--format','{{.Image}}','mbbs-operator-app-app-1'],text=True).strip()
stage.mkdir();artifact.chmod(0o777)
archive=subprocess.check_output(['docker','exec','mbbs-operator-app-app-1','tar','-C','/app','-cf','-','src','public','migrations','package.json','package-lock.json','netsuite-smart-scm-picking-ticket-restlet.js'])
with tarfile.open(fileobj=io.BytesIO(archive)) as data:data.extractall(stage,filter='data')
shutil.copytree(stage/'src',stage/'baseline/src')
shutil.copytree(stage/'public',stage/'baseline/public')
shutil.copy2(stage/'package.json',stage/'baseline/package.json')
(stage/'baseline/node_modules').symlink_to('/app/node_modules',target_is_directory=True)
patch=''
for name in files:
 before=release/'workspace-before'/name;live=release/'live-before'/name
 live.parent.mkdir(parents=True,exist_ok=True)
 if (stage/name).exists():shutil.copy2(stage/name,live)
 if before.exists():patch+=''.join(difflib.unified_diff(before.read_text().splitlines(True),(root/name).read_text().splitlines(True),fromfile='a/'+name,tofile='b/'+name))
 else:
  (stage/name).parent.mkdir(parents=True,exist_ok=True);shutil.copy2(root/name,stage/name)
if patch:
 command=['patch','--batch','--fuzz=0','-p1','-d',str(stage)]
 forward=subprocess.run([*command,'--forward','--dry-run'],input=patch,text=True,capture_output=True)
 if forward.returncode==0:subprocess.run([*command,'--forward'],input=patch,text=True,check=True)
 else:
  applied=subprocess.run([*command,'--reverse','--dry-run'],input=patch,text=True,capture_output=True)
  assert applied.returncode==0,'Task patch conflicts with current live source: '+forward.stdout+forward.stderr
  print('Task patch is already present in the live image; verifying it unchanged.',flush=True)
(release/'release.patch').write_text(patch)
for name in files:
 target=release/'candidate'/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(stage/name,target)
shutil.copytree(root/'test',stage/'test')
shutil.copytree(root/'test',stage/'baseline/test')
(stage/'baseline/test-artifacts').mkdir()
shutil.copy2(stage/'netsuite-smart-scm-picking-ticket-restlet.js',stage/'baseline/netsuite-smart-scm-picking-ticket-restlet.js')
for name in ['eslint.mbt.config.js','tools/scm-retired-po-search-checks.mjs','tools/scm-retired-po-search-eslint.config.mjs']:
 if (root/name).exists():
  target=stage/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(root/name,target)
(stage/'node_modules').symlink_to('/app/node_modules',target_is_directory=True)
(stage/'test-artifacts').mkdir()
for target in [stage,*stage.rglob('*')]:
 if not target.is_symlink():target.chmod(0o777 if target.is_dir() else 0o666)
changes={name:[i+1 for tag,a,b,c,d in difflib.SequenceMatcher(None,(stage/'baseline'/name).read_text().splitlines(),(stage/name).read_text().splitlines(),autojunk=False).get_opcodes() if tag!='equal' for i in range(c,d)] for name in files if name.endswith('.js')}
(stage/'test-artifacts/changed-lines.json').write_text(json.dumps(changes));(stage/'test-artifacts/changed-lines.json').chmod(0o666)
proof={'baseImage':image,'files':{name:hashlib.sha256((stage/name).read_bytes()).hexdigest() for name in files}}
(release/'tested-inputs.json').write_text(json.dumps(proof,indent=2)+'\n')
services={}
for name,tag in [('test','mbbs-mbt-p1-test-e2e:latest'),('migrate','mbbs-mbt-p1-test-test:latest')]:
 services[name]={'image':subprocess.check_output(['docker','image','inspect','--format','{{.Id}}',tag],text=True).strip(),'working_dir':'/app/test-artifacts/candidate','volumes':[{'type':'bind','source':str(artifact),'target':'/app/test-artifacts'}],
 'environment':{'PLAYWRIGHT_BROWSERS_PATH':'/ms-playwright','XDG_CONFIG_HOME':'/tmp/xdg-config','XDG_CACHE_HOME':'/tmp/xdg-cache'},'labels':{'com.mbbs.lifecycle':'disposable-test'}}
services['db']={'labels':{'com.mbbs.lifecycle':'disposable-test'},'networks':{'mbt_test_internal':{'aliases':['mbbs-retired-review-db']}}}
(artifact/'compose.json').write_text(json.dumps({'services':services}))
print(json.dumps({'baseImage':image,'files':files}),flush=True)
PY
"${compose[@]}" up -d --wait db > "$MBBS_TEST_ARTIFACT_DIR/setup.log" 2>&1
"${compose[@]}" run --rm --no-deps -T migrate >> "$MBBS_TEST_ARTIFACT_DIR/setup.log" 2>&1 || { tail -n 60 "$MBBS_TEST_ARTIFACT_DIR/setup.log"; exit 1; }
set +e
"${compose[@]}" run --rm --no-deps -T test node tools/scm-retired-po-search-checks.mjs "${1:-focused}" > "$MBBS_TEST_ARTIFACT_DIR/checks.log" 2>&1
status=$?
set -e
tail -n 100 "$MBBS_TEST_ARTIFACT_DIR/checks.log"
python3 - "${1:-focused}" "$status" <<'PY'
import json,os,sys
from pathlib import Path
stage=Path(os.environ['MBBS_TEST_ARTIFACT_DIR'])/'candidate';report=stage/'test-artifacts/report.json'
data=json.loads(report.read_text()) if report.exists() else {'passed':False,'exitCode':sys.argv[2]}
(Path('server/deployments/scm-retired-po-search-20261028')/(sys.argv[1]+'-result.json')).write_text(json.dumps(data,indent=2)+'\n')
PY
exit "$status"
