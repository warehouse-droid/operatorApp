#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
artifact="$repo_root/server/test-artifacts/delivery-transfer-orders-20261015"
mode="${1:-green}"
case "$mode" in red|baseline|green|focus|final) ;; *) exit 64 ;; esac
project=mbbs-delivery-transfer-orders-test
run="$artifact/$mode"
if [[ -f "$run/checks.log" ]]; then mv "$run" "$run-previous-$(date +%s)"; fi
mkdir -p "$run/results/delivery-requests-ui" "$run/results/delivery-requests"
compose=(docker compose --project-directory "$repo_root" -p "$project" -f "$repo_root/docker-compose.mbt-test.yml" -f "$run/compose.json")
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  "${compose[@]}" down --volumes --remove-orphans > "$run/teardown.log" 2>&1 || status=1
  docker ps --format '{{.Names}} {{.Status}}' > "$run/docker-ps.log"
  docker ps -a --format '{{.Names}} {{.Status}}' > "$run/docker-ps-a.log"
  for resource in containers networks volumes; do
    case "$resource" in
      containers) remaining="$(docker ps -a --filter "label=com.docker.compose.project=$project" --format '{{.ID}}')" ;;
      networks) remaining="$(docker network ls --filter "label=com.docker.compose.project=$project" --format '{{.ID}}')" ;;
      volumes) remaining="$(docker volume ls --filter "label=com.docker.compose.project=$project" --format '{{.Name}}')" ;;
    esac
    if [[ -n "$remaining" ]]; then status=1; fi
  done
  docker inspect --format '{{.Name}} {{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' mbbs-operator-app-app-1 mbbs-operator-app-db-1 mbbs-operator-app-webhook-worker-1 mbbs-operator-app-ollama-1 > "$run/production-health.log"
  curl --fail --silent http://127.0.0.1:3000/health > "$run/health.json" || status=1
  printf 'teardown_exit=%s\n' "$status" >> "$run/teardown.log"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
python3 - "$repo_root/server" "$artifact" "$run" "$mode" <<'PY'
import difflib,hashlib,json,pathlib,shutil,sys
server,artifact,run=map(pathlib.Path,sys.argv[1:4]);mode=sys.argv[4]
source=artifact/('baseline' if mode in ['red','baseline'] else 'candidate')
if mode not in ['red','baseline']:
    files=list(json.loads((artifact/'source-hashes.json').read_text()))
    hashes={};changed={};patch=''
    for name in files:
        before=artifact/'baseline'/name;after=server/name
        old=(before.read_text() if before.exists() else '').splitlines(True);new=after.read_text().splitlines(True)
        shutil.copy2(after,source/name);hashes[name]=hashlib.sha256(after.read_bytes()).hexdigest()
        changed[name]=[line+1 for tag,_,_,start,end in difflib.SequenceMatcher(a=old,b=new,autojunk=False).get_opcodes() if tag in ['replace','insert'] for line in range(start,end)]
        patch+=''.join(difflib.unified_diff(old,new,fromfile='a/'+name,tofile='b/'+name))
    (artifact/'source-hashes.json').write_text(json.dumps(hashes,indent=2)+'\n')
    (run/'results/source-hashes.json').write_text(json.dumps(hashes,indent=2)+'\n')
    (run/'results/changed-lines.json').write_text(json.dumps(changed,indent=2)+'\n')
    (artifact/'changes.patch').write_text(patch)
toolchain=server/'test-artifacts/mbr-contract'
volumes=[f'{source/name}:/app/{name}:ro' for name in ['src','public','migrations','package.json','package-lock.json']]
volumes += [f'{server/name}:/app/{name}:ro' for name in ['test','tools','contracts','eslint.mbt.config.js','tsconfig.mbt.json','.c8rc.json']]
volumes += [f'{toolchain}/toolchain/node_modules:/app/node_modules:ro',f'{toolchain}/playwright-browsers:/ms-playwright:ro',f'{run}/results:/app/test-artifacts']
settings={'image':'mbbs-operator-app:dispatch-editor-control-browser-test-20261015','user':'1000:1000','entrypoint':[],
  'working_dir':'/app','pull_policy':'never','labels':{'com.mbbs.lifecycle':'disposable-test'},'volumes':volumes,
  'environment':{'PLAYWRIGHT_BROWSERS_PATH':'/ms-playwright','DELIVERY_UI_COVERAGE':'1'}}
(run/'compose.json').write_text(json.dumps({'services':{'db':{'image':'postgres:18-alpine','pull_policy':'never','labels':{'com.mbbs.lifecycle':'disposable-test'}},'test':settings,'migrate':settings}},indent=2)+'\n')
PY
python3 "$repo_root/docker/verify-memory-limits.py" > "$run/memory-limits.log" 2>&1
"${compose[@]}" up -d --no-build --wait --wait-timeout 60 db > "$run/db-start.log" 2>&1
"${compose[@]}" run --rm --no-deps migrate > "$run/migrate.log" 2>&1
if [[ "$mode" == final ]]; then
  "${compose[@]}" run --rm --no-deps test node tools/delivery-request-quality.mjs versions > "$run/toolchain-versions.json" 2> "$run/versions-container.log"
  "${compose[@]}" run --rm --no-deps test node tools/delivery-transfer-orders-mutations.mjs > "$run/mutations.log" 2>&1
  "${compose[@]}" run --rm --no-deps test node node_modules/c8/bin/c8.js --config=tools/delivery-request-c8.json node tools/delivery-transfer-orders-checks.mjs green > "$run/checks.log" 2>&1
  "${compose[@]}" run --rm --no-deps test node tools/delivery-transfer-orders-coverage.mjs > "$run/coverage.log" 2>&1
else
  "${compose[@]}" run --rm --no-deps test node node_modules/c8/bin/c8.js --config=tools/delivery-request-c8.json node tools/delivery-transfer-orders-checks.mjs "$mode" > "$run/checks.log" 2>&1
fi
tail -35 "$run/checks.log"
