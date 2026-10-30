#!/usr/bin/env bash
set -Eeuo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -z "${MBBS_TEST_ARTIFACT_DIR:-}" ]]; then
  exec python3 "$repo_dir/docker/retention/retention.py" run -- bash "$0" "$@"
fi
cd "$repo_dir"
test_project="mbbs-dependency-cache-$$"
override="$MBBS_TEST_ARTIFACT_DIR/compose.json"
compose=(docker compose -p "$test_project" -f docker-compose.mbt-test.yml -f "$override")
cleanup() {
  result=$?
  trap - EXIT INT TERM
  if [[ -f "$override" ]]; then
    "${compose[@]}" down --volumes --remove-orphans > "$MBBS_TEST_ARTIFACT_DIR/cleanup.log" 2>&1 || result=1
  fi
  docker ps --format '{{.Names}} {{.Status}}'
  docker ps -a --format '{{.Names}} {{.Status}}'
  [[ -z "$(docker ps -aq --filter "label=com.docker.compose.project=$test_project")" ]] || result=1
  [[ -z "$(docker volume ls -q --filter "label=com.docker.compose.project=$test_project")" ]] || result=1
  [[ -z "$(docker network ls -q --filter "label=com.docker.compose.project=$test_project")" ]] || result=1
  curl -fsS --max-time 5 --retry 5 --retry-connrefused -o /dev/null http://127.0.0.1:3000/health || result=1
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
python3 docker/verify-memory-limits.py
python3 - <<'PY'
import difflib, hashlib, json, os, shutil, subprocess
from pathlib import Path
artifact=Path(os.environ['MBBS_TEST_ARTIFACT_DIR'])
candidate=artifact/'candidate'; candidate.mkdir()
app='mbbs-operator-app-app-1'
base_image=subprocess.check_output(['docker','inspect','--format','{{.Image}}',app],text=True).strip()
runtime=subprocess.check_output(['docker','exec',app,'tar','-C','/app','-cf','-','src','public','migrations','package.json','package-lock.json'])
subprocess.run(['tar','--no-same-owner','-xf','-','-C',str(candidate)],input=runtime,check=True)
inputs={'baseImage':base_image,'sourceRevision':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),'files':{},'baselineFiles':{},'changedLines':{}}
patch=''
for file in ['src/dispatch-plan-order-projection.js','src/order-dependency-repository.js','src/dispatch-order-catalog-repository.js','public/dispatch.js','public/dispatch.html','public/mbt-planning.html']:
    path=candidate/file; old=path.read_text(); new=(Path('server')/file).read_text()
    baseline=candidate/'baseline'/file; baseline.parent.mkdir(parents=True,exist_ok=True);baseline.write_text(old)
    inputs['baselineFiles'][file]=hashlib.sha256(old.encode()).hexdigest()
    path.write_text(new);inputs['files'][file]=hashlib.sha256(new.encode()).hexdigest()
    patch+=''.join(difflib.unified_diff(old.splitlines(True),new.splitlines(True),fromfile='a/'+file,tofile='b/'+file,n=0))
    inputs['changedLines'][file]=[line+1 for tag,a,b,c,d in difflib.SequenceMatcher(None,old.splitlines(),new.splitlines(),autojunk=False).get_opcodes() if tag!='equal' for line in range(c,d)]
shutil.copytree('server/test',candidate/'test')
(candidate/'tools').mkdir()
shutil.copy2('server/tools/dependency-cache-gauntlet.mjs',candidate/'tools/dependency-cache-gauntlet.mjs')
shutil.copy2('server/eslint.mbt.config.js',candidate/'eslint.mbt.config.js')
(candidate/'test-artifacts').mkdir()
(candidate/'test-artifacts/inputs.json').write_text(json.dumps(inputs))
(candidate/'test-artifacts/runtime.patch').write_text(patch)
(candidate/'node_modules').symlink_to('/app/node_modules')
for path in artifact.rglob('*'):
    if not path.is_symlink(): path.chmod(0o777 if path.is_dir() else 0o666)
artifact.chmod(0o777)
services={name:{'labels':{'com.mbbs.lifecycle':'disposable-test'},'volumes':[{'type':'bind','source':str(artifact),'target':'/app/test-artifacts'}]} for name in ['test','migrate']}
services['migrate']['volumes'].append({'type':'bind','source':str(candidate/'migrations'),'target':'/app/migrations','read_only':True})
services['test'].update({'image':'mbbs-mbt-p1-test-e2e:latest','environment':{'PLAYWRIGHT_BROWSERS_PATH':'/ms-playwright'}})
services['db']={'labels':{'com.mbbs.lifecycle':'disposable-test'}}
(artifact/'compose.json').write_text(json.dumps({'services':services}))
PY
"${compose[@]}" up -d --wait db > "$MBBS_TEST_ARTIFACT_DIR/setup.log" 2>&1
if ! "${compose[@]}" run --rm --no-deps -T migrate >> "$MBBS_TEST_ARTIFACT_DIR/setup.log" 2>&1; then
  tail -n 60 "$MBBS_TEST_ARTIFACT_DIR/setup.log"; exit 1
fi
if (( $# == 0 )); then set -- node tools/dependency-cache-gauntlet.mjs; fi
set +e
"${compose[@]}" run --rm --no-deps -T test bash -c 'cd /app/test-artifacts/candidate; exec "$@"' -- "$@" > "$MBBS_TEST_ARTIFACT_DIR/checks.log" 2>&1
result=$?
set -e
tail -n 110 "$MBBS_TEST_ARTIFACT_DIR/checks.log"
if [[ -f "$MBBS_TEST_ARTIFACT_DIR/candidate/test-artifacts/dependency-cache-evidence.json" ]]; then
  cp "$MBBS_TEST_ARTIFACT_DIR/candidate/test-artifacts/dependency-cache-evidence.json" server/test/dependency-cache-evidence.json
fi
exit "$result"
