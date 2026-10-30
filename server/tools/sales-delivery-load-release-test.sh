#!/usr/bin/env bash
set -Eeuo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ -z "${MBBS_TEST_ARTIFACT_DIR:-}" ]]; then
  exec python3 "$repo_dir/docker/retention/retention.py" run -- bash "$0"
fi
release="$repo_dir/server/deployments/sales-delivery-load-20261021"
project="mbbs-so-load-release-$$"
overlay="$MBBS_TEST_ARTIFACT_DIR/compose.json"
compose=(docker compose -p "$project" -f "$repo_dir/docker-compose.mbt-test.yml" -f "$overlay")
cleanup() {
  result=$?
  trap - EXIT INT TERM
  if [[ -f "$overlay" ]]; then "${compose[@]}" down --volumes --remove-orphans || result=1; fi
  for name in "$project-deps" "$project-image"; do
    if docker container inspect "$name" >/dev/null 2>&1; then docker rm -fv "$name" || result=1; fi
  done
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
docker run --rm --name "$project-deps" --init --cgroup-parent=mbbs-tests.slice \
  --label com.mbbs.lifecycle=disposable-test --memory=2g --memory-swap=2g --cpus=2 --pids-limit=512 \
  --tmpfs /tmp:rw,size=512m --mount "type=bind,src=$MBBS_TEST_ARTIFACT_DIR/deps,dst=/deps" \
  --workdir /deps --env PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
  node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 \
  npm ci --cache /deps/.npm --no-audit --no-fund > "$MBBS_TEST_ARTIFACT_DIR/dependencies.log" 2>&1 || { cat "$MBBS_TEST_ARTIFACT_DIR/dependencies.log"; exit 1; }
python3 - "$repo_dir" "$release" "$overlay" "$project" <<'PY'
import importlib.util,json,os,pathlib,subprocess,sys
root,release,target,project=sys.argv[1:]; root=pathlib.Path(root); release=pathlib.Path(release)
spec=importlib.util.spec_from_file_location('so_release',root/'server/tools/sales-delivery-load-release.py')
r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
data=json.loads((release/'manifest.json').read_text());r.current(data)
# Check the actual built image without mounts or production credentials.
actual=json.loads(r.core.bounded(data['candidateImageId'],project+'-image','node','-e',r.core.HASH_SCRIPT))
assert actual==data['candidateTree']
output=pathlib.Path(os.environ['MBBS_TEST_ARTIFACT_DIR'])
(output/'import.log').write_bytes(r.core.bounded(data['candidateImageId'],project+'-image','node','--input-type=module','-e',
    "await import('./src/server.js');console.log('import OK');process.exit(0)"))
(output/'expected-runtime.json').write_text(json.dumps(actual))
mounts=[f'{root}/server/{name}:/app/{name}:ro' for name in ['test','contracts','.env.example','netsuite-ifir-posting-restlet.js']]
mounts += [f'{output}/deps/node_modules:/app/node_modules:ro',f'{output}:/app/test-artifacts']
service={'image':data['candidateImageId'],'working_dir':'/app','user':'1000:1000','volumes':mounts,
         'labels':{'com.mbbs.lifecycle':'disposable-test'}}
pathlib.Path(target).write_text(json.dumps({'services':{'test':service,'migrate':service,
  'db':{'labels':{'com.mbbs.lifecycle':'disposable-test'}}}}))
source=(root/'server/tools/sales-delivery-load-checks.mjs').read_text()
selection=source[source.index('const primary='):source.index('const report=')]
(output/'release-check.mjs').write_text("import fs from 'node:fs';import {spawnSync} from 'node:child_process';import assert from 'node:assert/strict';\n"+selection+"""
const result=spawnSync(process.execPath,['--test','--test-concurrency=1',...tests],{encoding:'utf8',timeout:240000,maxBuffer:64*1024*1024});
const text=(result.stdout||'')+(result.stderr||'');fs.writeFileSync('test-artifacts/tests.log',text);
const summary={exit:result.status,tests:Number(text.match(/# tests (\\d+)/)?.[1]||0),passed:Number(text.match(/# pass (\\d+)/)?.[1]||0),failed:Number(text.match(/# fail (\\d+)/)?.[1]||0)};
console.log(JSON.stringify(summary));if(result.status!==0)console.log(text.slice(-20000));
assert.equal(result.status,0);assert.ok(summary.tests>=349);assert.equal(summary.failed,0);
fs.writeFileSync('test-artifacts/summary.json',JSON.stringify(summary));
""")
PY
"${compose[@]}" up -d --wait db
"${compose[@]}" run --rm --no-deps -T migrate npm run migrate > "$MBBS_TEST_ARTIFACT_DIR/migrate.log" 2>&1 || { cat "$MBBS_TEST_ARTIFACT_DIR/migrate.log"; exit 1; }
"${compose[@]}" run --rm --no-deps -T test node test-artifacts/release-check.mjs
python3 - "$release" "$MBBS_TEST_ARTIFACT_DIR" <<'PY'
import datetime,json,pathlib,sys
release,output=map(pathlib.Path,sys.argv[1:]);data=json.loads((release/'manifest.json').read_text())
summary=json.loads((output/'summary.json').read_text())
record={'passed':True,'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'candidateTreeHash':data['candidateTreeHash'],'imageId':data['candidateImageId'],
        'runtimeFilesVerified':len(data['candidateTree']),'serverImport':True,'tests':summary}
(release/'validation-passed.json').write_text(json.dumps(record,indent=2)+'\n')
print(json.dumps(record))
PY
