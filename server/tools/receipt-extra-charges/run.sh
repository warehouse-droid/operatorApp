#!/usr/bin/env bash
set -Eeuo pipefail
cd /home/ubuntu/apps/operatorApp
mode=${1:-red}
evidence="$PWD/server/artifacts/receipt-extra-charges-20261019"
mkdir -p "$evidence"
override="$evidence/compose-${mode}.json"
compose=(docker compose -p mbbs-receipt-extra-charges-test -f docker-compose.mbt-test.yml -f "$override")
cleanup() {
  "${compose[@]}" down --volumes --remove-orphans > "$evidence/${mode}-teardown.log" 2>&1 || true
  docker ps --format '{{.Names}} {{.Status}}' > "$evidence/${mode}-containers-running.txt"
  docker ps -a --format '{{.Names}} {{.Status}}' > "$evidence/${mode}-containers-all.txt"
}
trap cleanup EXIT INT TERM
python3 - "$PWD" "$override" "$mode" <<'PY'
import json,sys,shutil
from pathlib import Path
root=Path(sys.argv[1]); mode=sys.argv[3]
release=root/'server/deployments/receipt-extra-charges-20261019'
tree=release/('before' if mode in ['baseline','red','red-integration'] else 'candidate')
src=tree/'src'
if mode in ['red','red-integration']:
 src=root/'server/artifacts/receipt-extra-charges-20261019/red-runtime/src'
 shutil.copytree(tree/'src',src,dirs_exist_ok=True)
 shutil.copy2(root/'server/src/operator-netsuite-receipt-charges.js',src/'operator-netsuite-receipt-charges.js')
mounts=[f'{src}:/app/src:ro',f'{tree}/public:/app/public:ro',f'{tree}/migrations:/app/migrations:ro',
 f'{root}/server/test:/app/test:ro',f'{root}/server/contracts:/app/contracts:ro',
 f'{root}/server/tools/receipt-extra-charges:/app/tools/receipt-extra-charges:ro',
 f'{root}/server/test-artifacts/operator-to-yard-flow-tooling/node_modules:/app/node_modules:ro',
 f'{root}/server/eslint.mbt.config.js:/app/eslint.mbt.config.js:ro',
 f'{root}/server/tsconfig.mbt.json:/app/tsconfig.mbt.json:ro',
 f'{root}/server/artifacts/receipt-extra-charges-20261019:/evidence']
image=json.loads((release/'capture.json').read_text())['app']['imageId']
data={'services':{'migrate':{'image':image,'labels':{'com.mbbs.lifecycle':'disposable-test'},'volumes':mounts},
 'test':{'image':image,'labels':{'com.mbbs.lifecycle':'disposable-test'},'volumes':mounts,
 'command':['node','tools/receipt-extra-charges/suite.mjs',mode]},
 'db':{'labels':{'com.mbbs.lifecycle':'disposable-test'}}}}
Path(sys.argv[2]).write_text(json.dumps(data))
PY
chmod 777 "$evidence"
"${compose[@]}" up -d --wait db > "$evidence/${mode}-db.log" 2>&1
"${compose[@]}" run --rm --no-deps -T migrate > "$evidence/${mode}-migrate.log" 2>&1
"${compose[@]}" run --rm --no-deps -T test > "$evidence/${mode}-suite.log" 2>&1
tail -12 "$evidence/${mode}-suite.log"
