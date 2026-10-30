#!/usr/bin/env bash
set -Eeuo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -z "${MBBS_TEST_ARTIFACT_DIR:-}" ]]; then
  exec python3 "$repo_dir/docker/retention/retention.py" run -- bash "$0" "$@"
fi
cd "$repo_dir"
test_project="mbbs-scm-search-$$"
compose=(docker compose -p "$test_project" -f "$repo_dir/docker-compose.mbt-test.yml" -f "$MBBS_TEST_ARTIFACT_DIR/compose.json")
cleanup() {
  result=$?
  trap - EXIT INT TERM
  if [[ -f "$MBBS_TEST_ARTIFACT_DIR/compose.json" ]]; then "${compose[@]}" down --volumes --remove-orphans || result=1; fi
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
import difflib,json,os,shutil,subprocess
from pathlib import Path
root=Path.cwd()/'server'; artifact=Path(os.environ['MBBS_TEST_ARTIFACT_DIR']); stage=artifact/'candidate'
stage.mkdir(); artifact.chmod(0o777)
for name in ['src','migrations','public','test']:
    shutil.copytree(root/name,stage/name)
for name in ['package.json','package-lock.json','eslint.mbt.config.js','tsconfig.mbt.json']:
    shutil.copy2(root/name,stage/name)
shutil.copytree(root/'tools',stage/'tools',ignore=shutil.ignore_patterns('candidate*','baseline*','workspace-*','original-*'))
for source in root.glob('*.js'): shutil.copy2(source,stage/source.name)
(stage/'node_modules').symlink_to('/app/node_modules',target_is_directory=True)
(stage/'test-artifacts').mkdir()
before=root/'deployments/scm-po-search-20261029/workspace-before'
changes={}
for source in (before/'src').glob('*.js'):
    name='src/'+source.name
    changes[name]=[i+1 for tag,a,b,c,d in difflib.SequenceMatcher(None,source.read_text().splitlines(),(stage/name).read_text().splitlines(),autojunk=False).get_opcodes() if tag!='equal' for i in range(c,d)]
    target=stage/'test-artifacts/before'/name; target.parent.mkdir(parents=True,exist_ok=True); shutil.copy2(source,target)
(stage/'test-artifacts/changed-lines.json').write_text(json.dumps(changes))
for target in [stage,*stage.rglob('*')]:
    if not target.is_symlink(): target.chmod(0o777 if target.is_dir() else 0o666)
image=subprocess.check_output(['docker','image','inspect','--format','{{.Id}}','mbbs-mbt-p1-test-e2e:latest'],text=True).strip()
services={name:{'image':image,'working_dir':'/app/test-artifacts/candidate','volumes':[{'type':'bind','source':str(artifact),'target':'/app/test-artifacts'}],
    'environment':{'PLAYWRIGHT_BROWSERS_PATH':'/ms-playwright'},'labels':{'com.mbbs.lifecycle':'disposable-test'}} for name in ['test','migrate']}
services['db']={'labels':{'com.mbbs.lifecycle':'disposable-test'}}
(artifact/'compose.json').write_text(json.dumps({'services':services}))
PY
"${compose[@]}" up -d --wait db > "$MBBS_TEST_ARTIFACT_DIR/setup.log" 2>&1
"${compose[@]}" run --rm --no-deps -T migrate >> "$MBBS_TEST_ARTIFACT_DIR/setup.log" 2>&1 || { tail -n 40 "$MBBS_TEST_ARTIFACT_DIR/setup.log"; exit 1; }
if (( $# == 0 )); then set -- node --test --test-concurrency=1 test/dispatch/integration/scm-po-search-recovery.test.js; fi
set +e
"${compose[@]}" run --rm --no-deps -T test "$@" > "$MBBS_TEST_ARTIFACT_DIR/checks.log" 2>&1
result=$?
set -e
tail -n 100 "$MBBS_TEST_ARTIFACT_DIR/checks.log"
if [[ -f "$MBBS_TEST_ARTIFACT_DIR/candidate/test-artifacts/scm-po-search-report.json" ]]; then
  cp "$MBBS_TEST_ARTIFACT_DIR/candidate/test-artifacts/scm-po-search-report.json" "$repo_dir/server/deployments/scm-po-search-20261029/checks.json"
fi
exit "$result"
