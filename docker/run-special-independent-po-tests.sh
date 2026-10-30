#!/usr/bin/env bash
# Bounded, isolated browser/database checks with unconditional retention cleanup.
set -Eeuo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -z "${MBBS_TEST_ARTIFACT_DIR:-}" ]]; then
  exec python3 "$repo_dir/docker/retention/retention.py" run -- bash "$0" "$@"
fi
project="mbbs-independent-po-$$"
override="$MBBS_TEST_ARTIFACT_DIR/compose.json"
compose=(docker compose -p "$project" -f "$repo_dir/docker-compose.mbt-test.yml" -f "$override")
finish() {
  result=$?
  trap - EXIT INT TERM
  "${compose[@]}" down --volumes --remove-orphans || result=1
  docker image rm "$project:latest" >/dev/null 2>&1 || true
  docker ps --format '{{.Names}} {{.Status}}'
  docker ps -a --format '{{.Names}} {{.Status}}'
  for resource in container volume network; do
    if [[ -n "$(docker "$resource" ls -q --filter "label=com.docker.compose.project=$project")" ]]; then result=1; fi
  done
  curl --max-time 15 --retry 3 --retry-all-errors --retry-delay 1 -fsS -o /dev/null http://127.0.0.1:3000/health || result=1
  exit "$result"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
python3 - "$override" "$project" "$repo_dir" <<'PY'
import json,os,sys
from pathlib import Path
path,project,root=sys.argv[1:]
server=Path(root)/'server'
runtime=Path(os.environ.get('MBBS_SPECIAL_RUNTIME_DIR',str(server))).resolve()
assert runtime==server or runtime==server/'deployments/special-independent-po-20261029/candidate'
# Explicit source-only mounts: never mount .env, data, artifacts or deployments.
sources=[server/name for name in ('src','public','test','migrations','contracts')]
sources+=list(server.glob('*.js'))+[server/'.c8rc.json',server/'tsconfig.mbt.json']
sources+=list((server/'tools').glob('*.mjs'))
volumes=[{'type':'bind','source':str(p),'target':'/app/'+str(p.relative_to(server)),'read_only':True} for p in sources]
for volume in volumes:
 if volume['target'] in ('/app/src','/app/public','/app/migrations'):
  volume['source']=str(runtime/volume['target'].removeprefix('/app/'))
baseline=os.environ.get('MBBS_SPECIAL_BASELINE_DIR')
if baseline:
 assert Path(baseline).resolve()==Path('/tmp/mbbs-special-independent-po-baseline')
 volumes.append({'type':'bind','source':baseline,'target':'/baseline','read_only':True})
service={'image':project+':latest','build':{'target':'playwright-dependencies'},'user':'1000:1000',
 'environment':{'PLAYWRIGHT_BROWSERS_PATH':'/ms-playwright','XDG_CONFIG_HOME':'/tmp/po-browser-config','XDG_CACHE_HOME':'/tmp/po-browser-cache'},
 'volumes':volumes+[{'type':'bind','source':os.environ['MBBS_TEST_ARTIFACT_DIR'],'target':'/app/test-artifacts'}],
 'labels':{'com.mbbs.lifecycle':'disposable-test'}}
with open(path,'w') as f:json.dump({'services':{'test':service,'migrate':service,'db':{'labels':{'com.mbbs.lifecycle':'disposable-test'}}}},f)
PY
chmod 0777 "$MBBS_TEST_ARTIFACT_DIR"
cd "$repo_dir"
python3 docker/verify-memory-limits.py
"${compose[@]}" build test >"$MBBS_TEST_ARTIFACT_DIR/build.log" 2>&1 || { tail -n 60 "$MBBS_TEST_ARTIFACT_DIR/build.log"; exit 1; }
"${compose[@]}" up -d --wait db
"${compose[@]}" run --rm --no-deps -T migrate >"$MBBS_TEST_ARTIFACT_DIR/migrate.log" 2>&1 || { tail -n 60 "$MBBS_TEST_ARTIFACT_DIR/migrate.log"; exit 1; }
if (( $# == 0 )); then set -- node tools/special-independent-po-gauntlet.mjs; fi
"${compose[@]}" run --rm --no-deps -T test "$@"
