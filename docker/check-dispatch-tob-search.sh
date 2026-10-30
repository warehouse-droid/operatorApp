#!/usr/bin/env bash
set -Eeuo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -z "${MBBS_TEST_ARTIFACT_DIR:-}" ]]; then
  exec python3 "$repo_dir/docker/retention/retention.py" run -- bash "$0" "$@"
fi
cd "$repo_dir"
test_project="mbbs-tob-check-$$"
export MBBS_TOB_SOURCE_CONTAINER="$test_project-source"
override="$MBBS_TEST_ARTIFACT_DIR/compose.json"
compose=(docker compose -p "$test_project" -f docker-compose.mbt-test.yml -f "$override" --profile tools --profile e2e --profile runtime)
cleanup() {
  result=$?
  trap - EXIT INT TERM
  docker rm -f "$MBBS_TOB_SOURCE_CONTAINER" > /dev/null 2>&1 || true
  if [[ -f "$override" ]]; then
    "${compose[@]}" down --volumes --remove-orphans > "$MBBS_TEST_ARTIFACT_DIR/cleanup.log" 2>&1 || result=1
  fi
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
import os,json,shutil,subprocess,hashlib,difflib
from pathlib import Path
artifact=Path(os.environ['MBBS_TEST_ARTIFACT_DIR']); candidate=artifact/'candidate'; candidate.mkdir()
files=json.loads(Path('server/tools/dispatch-tob-search-files.json').read_text())
source_image=os.environ.get('MBBS_TOB_TEST_BASE_IMAGE')
if source_image:
    image=subprocess.check_output(['docker','image','inspect','--format','{{.Id}}',source_image],text=True).strip()
    runtime=subprocess.check_output(['docker','run','--rm','--name',os.environ['MBBS_TOB_SOURCE_CONTAINER'],
        '--init','--network=none','--cgroup-parent=mbbs-tests.slice','--memory=256m','--memory-swap=256m',
        '--cpus=0.5','--pids-limit=64','--read-only','--tmpfs','/tmp:rw,size=16m',
        '--label','com.mbbs.lifecycle=disposable-test','--entrypoint','tar',source_image,
        '-C','/app','-cf','-','src','public','migrations','package.json','package-lock.json'])
else:
    image=subprocess.check_output(['docker','inspect','--format','{{.Image}}','mbbs-operator-app-app-1'],text=True).strip()
    runtime=subprocess.check_output(['docker','exec','mbbs-operator-app-app-1','tar','-C','/app','-cf','-','src','public','migrations','package.json','package-lock.json'])
subprocess.run(['tar','--no-same-owner','-xf','-','-C',str(candidate)],input=runtime,check=True)
shutil.copytree('server/test',candidate/'test')
(candidate/'tools').mkdir()
for path in Path('server/tools').glob('dispatch-tob-search-*'):
    if path.is_file(): shutil.copy2(path,candidate/'tools'/path.name)
shutil.copy2('server/tools/linked-po-pickup-repair.mjs',candidate/'tools/linked-po-pickup-repair.mjs')
shutil.copy2('server/eslint.mbt.config.js',candidate/'eslint.mbt.config.js')
inputs={'baseImage':image,'files':{},'changedLines':{},'baselineFiles':{}}
release=Path('server/deployments/dispatch-tob-search-20261028')
for name in files:
    old=(candidate/name).read_text() if (candidate/name).exists() else ''
    expected=release/'live-before'/name
    assert old==(expected.read_text() if expected.exists() else ''), 'Live file changed: '+name
    baseline=candidate/'baseline'/name;baseline.parent.mkdir(parents=True,exist_ok=True);baseline.write_text(old)
    fresh=Path('server')/name
    shutil.copy2(fresh,candidate/name)
    inputs['files'][name]=hashlib.sha256(fresh.read_bytes()).hexdigest()
    inputs['baselineFiles'][name]=hashlib.sha256(old.encode()).hexdigest()
    inputs['changedLines'][name]=[line+1 for tag,a,b,c,d in difflib.SequenceMatcher(None,old.splitlines(),fresh.read_text().splitlines(),autojunk=False).get_opcodes() if tag!='equal' for line in range(c,d)]
(candidate/'test-artifacts').mkdir()
(candidate/'test-artifacts/inputs.json').write_text(json.dumps(inputs))
(artifact/'live-image.txt').write_text(image+'\n')
for name in ['dispatch-edit-activity.js','dispatch-auth.js','dispatch-address-guard.js']:
    shutil.copy2(candidate/'public'/name,artifact/name)
services={name:{'labels':{'com.mbbs.lifecycle':'disposable-test'},'volumes':[{'type':'bind','source':str(artifact),'target':'/app/test-artifacts'}]} for name in ['test','migrate','e2e']}
services['db']={'labels':{'com.mbbs.lifecycle':'disposable-test'}}
(artifact/'compose.json').write_text(json.dumps({'services':services}))
for path in artifact.rglob('*'):
    path.chmod(0o777 if path.is_dir() else 0o666)
artifact.chmod(0o777)
PY
"${compose[@]}" up -d --wait db > "$MBBS_TEST_ARTIFACT_DIR/setup.log" 2>&1
"${compose[@]}" run --rm --no-deps -T migrate >> "$MBBS_TEST_ARTIFACT_DIR/setup.log" 2>&1
if (( $# == 0 )); then set -- node tools/dispatch-tob-search-checks.mjs; fi
set +e
"${compose[@]}" run --rm --no-deps -T test bash -c 'cd /app/test-artifacts/candidate; ln -s /app/node_modules node_modules; exec "$@"' -- "$@" > "$MBBS_TEST_ARTIFACT_DIR/checks.log" 2>&1
result=$?
set -e
tail -n 80 "$MBBS_TEST_ARTIFACT_DIR/checks.log"
if [[ -f "$MBBS_TEST_ARTIFACT_DIR/candidate/test-artifacts/report.json" ]]; then
  cp "$MBBS_TEST_ARTIFACT_DIR/candidate/test-artifacts/report.json" server/test/dispatch-tob-search-fix-evidence.json
fi
if (( result == 0 )); then
  "${compose[@]}" run --rm --no-deps -T -e MBBS_TOB_BROWSER_SOURCE=/app/test-artifacts/candidate/public/dispatch.js e2e bash -c 'cd /app/test-artifacts/candidate; exec node tools/dispatch-tob-search-browser-checks.mjs'
  cp "$MBBS_TEST_ARTIFACT_DIR/browser-checks.json" server/test/dispatch-tob-search-browser-20261028.json
fi
exit "$result"
