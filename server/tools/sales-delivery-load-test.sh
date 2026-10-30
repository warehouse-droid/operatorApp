#!/usr/bin/env bash
set -Eeuo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ -z "${MBBS_TEST_ARTIFACT_DIR:-}" ]]; then
  exec python3 "$repo_dir/docker/retention/retention.py" run -- bash "$0" "$@"
fi
project="mbbs-so-load-test-$$"
overlay="$MBBS_TEST_ARTIFACT_DIR/compose.json"
compose=(docker compose -p "$project" -f "$repo_dir/docker-compose.mbt-test.yml" -f "$overlay")
cleanup() {
  result=$?
  trap - EXIT INT TERM
  if [[ -f "$overlay" ]]; then "${compose[@]}" down --volumes --remove-orphans || result=1; fi
  if docker container inspect "$project-deps" >/dev/null 2>&1; then docker rm -f "$project-deps" || result=1; fi
  docker ps --format '{{.Names}} {{.Status}}'
  docker ps -a --format '{{.Names}} {{.Status}}'
  if [[ -n "$(docker ps -aq --filter "label=com.docker.compose.project=$project")" ||
        -n "$(docker volume ls -q --filter "label=com.docker.compose.project=$project")" ||
        -n "$(docker network ls -q --filter "label=com.docker.compose.project=$project")" ]]; then result=1; fi
  curl -fsS -o /dev/null http://127.0.0.1:3000/health || result=1
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
cd "$repo_dir"
python3 docker/verify-memory-limits.py
chmod 0777 "$MBBS_TEST_ARTIFACT_DIR"
mkdir -p "$MBBS_TEST_ARTIFACT_DIR/deps"
cp server/package.json server/package-lock.json "$MBBS_TEST_ARTIFACT_DIR/deps/"
python3 - "$MBBS_TEST_ARTIFACT_DIR" <<'PY'
import difflib, json, pathlib, subprocess, sys
artifact=pathlib.Path(sys.argv[1]); root=pathlib.Path('server')
files=['src/sales-order-auto-fulfillment-loads.js','src/sales-order-auto-fulfillment-repository.js',
       'src/sales-order-auto-fulfillment-service.js','src/operator-netsuite-posting-admission.js',
       'src/operator-netsuite-posting-targets.js','src/movement-record-evidence.js','src/mbt/feature-gate-catalog.js']
changed={}
for name in files:
    current=(root/name).read_text()
    if name.endswith('sales-order-auto-fulfillment-loads.js'): before=''
    elif name.endswith('sales-order-auto-fulfillment-service.js'):
        before=current.replace('candidate.isSplit || candidate.operatorLoadRecordId','candidate.isSplit')
    elif name.endswith('operator-netsuite-posting-targets.js'):
        before=current.replace('(root.order_type === "sales_order" ? "sales_load_background" : "driver_completion")','"driver_completion"')
    elif name.endswith('feature-gate-catalog.js'):
        before=current.replace('${yard.yardCode} Operator loaded Delivery SO → IF','${yard.yardCode} completed Delivery SO → IF').replace(
          'Queue a Sales Order Item Fulfillment for the exact lines and quantities loaded by Operator at yard ${yard.yardCode}. Driver completion is delivery evidence only.',
          'After an accepted Driver customer drop or audited manual Dispatch completion from yard ${yard.yardCode}, create one verified Sales Order Item Fulfillment for the conserved Operator residual plus completed direct PO/TO supply.')
    else: before=subprocess.check_output(['git','show',f'HEAD:server/{name}'],text=True)
    target=artifact/'before'/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_text(before)
    changed[name]=[line+1 for op,_,_,start,end in difflib.SequenceMatcher(None,before.splitlines(),current.splitlines()).get_opcodes()
                   if op in ('insert','replace') for line in range(start,end)]
(artifact/'changed-lines.json').write_text(json.dumps(changed))
PY
docker run --rm --name "$project-deps" --init --cgroup-parent=mbbs-tests.slice \
  --label com.mbbs.lifecycle=disposable-test --memory=2g --memory-swap=2g --cpus=2 --pids-limit=512 \
  --tmpfs /tmp:rw,size=512m --mount "type=bind,src=$MBBS_TEST_ARTIFACT_DIR/deps,dst=/deps" \
  --workdir /deps --env PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
  node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 \
  npm ci --cache /deps/.npm --no-audit --no-fund > "$MBBS_TEST_ARTIFACT_DIR/dependencies.log" 2>&1 || { cat "$MBBS_TEST_ARTIFACT_DIR/dependencies.log"; exit 1; }
python3 - "$repo_dir" "$overlay" <<'PY'
import json, os, sys
root, target = sys.argv[1:]
mounts = [f'{root}/server/{name}:/app/{name}:ro' for name in
          ['src','test','public','migrations','contracts','package.json',
           '.env.example','eslint.mbt.config.js','tsconfig.mbt.json','.c8rc.json',
           'netsuite-ifir-posting-restlet.js']]
mounts += [f'{root}/server/tools/sales-delivery-load-checks.mjs:/app/tools/sales-delivery-load-checks.mjs:ro',
           f'{os.environ["MBBS_TEST_ARTIFACT_DIR"]}/deps/node_modules:/app/node_modules:ro',
           f'{os.environ["MBBS_TEST_ARTIFACT_DIR"]}:/app/test-artifacts']
service = {'image':'sha256:1d6fcfd7a6ed365fce656983bf7dcaad4d5ec7b5fe725ea3fe559d2e25b5b006',
           'working_dir':'/app','user':'1000:1000', 'volumes':mounts,
           'labels':{'com.mbbs.lifecycle':'disposable-test'}}
with open(target, 'w') as output:
    json.dump({'services':{'test':service,'migrate':service,
              'db':{'labels':{'com.mbbs.lifecycle':'disposable-test'}}}},output)
PY
"${compose[@]}" up -d --wait db
"${compose[@]}" run --rm --no-deps -T migrate npm run migrate > "$MBBS_TEST_ARTIFACT_DIR/migrate.log" 2>&1 || { cat "$MBBS_TEST_ARTIFACT_DIR/migrate.log"; exit 1; }
if (( $# == 0 )); then set -- node tools/sales-delivery-load-checks.mjs; fi
"${compose[@]}" run --rm --no-deps -T test "$@"
