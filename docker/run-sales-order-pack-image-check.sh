#!/usr/bin/env bash
set -Eeuo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -z "${MBBS_TEST_ARTIFACT_DIR:-}" ]]; then
  exec python3 "$repo_dir/docker/retention/retention.py" run -- bash "$0" "$@"
fi
release_dir="$repo_dir/server/deployments/sob123453-null-packs-20261026"
check_name="mbbs-so-packs-image-$$"
cleanup() {
  result=$?
  trap - EXIT INT TERM
  docker rm -fv "$check_name" >/dev/null 2>&1 || true
  docker ps --format '{{.Names}} {{.Status}}'
  docker ps -a --format '{{.Names}} {{.Status}}'
  curl -fsS -o /dev/null http://127.0.0.1:3000/health || result=1
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
python3 "$repo_dir/docker/verify-memory-limits.py"
image_id="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["candidateImageId"])' "$release_dir/manifest.json")"
docker run --rm --name "$check_name" --init --network none --read-only \
  --label com.mbbs.lifecycle=disposable-test --cgroup-parent=mbbs-tests.slice \
  --memory=512m --memory-swap=512m --cpus=0.5 --pids-limit=128 \
  --tmpfs /tmp:uid=1000,gid=1000,mode=1777,size=32m \
  --tmpfs /app/data:uid=1000,gid=1000,mode=0700,size=16m \
  --env NODE_ENV=test --env MBBS_ENV_FILE=/nonexistent --env NETSUITE_DIRECT_ACCESS_ENABLED=false \
  --env NETSUITE_MIRROR_ROLE=disabled \
  --mount "type=bind,src=$release_dir/manifest.json,dst=/release-manifest.json,readonly" \
  -i "$image_id" node --input-type=module > "$MBBS_TEST_ARTIFACT_DIR/image-check.log" 2>&1 <<'NODE'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
const manifest=JSON.parse(fs.readFileSync('/release-manifest.json')),actual={};
function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
  const name=dir+'/'+entry.name;
  if(entry.isDirectory())walk(name);else if(entry.isFile())actual[name]=crypto.createHash('sha256').update(fs.readFileSync(name)).digest('hex');
}}
for(const dir of ['src','public','migrations'])walk(dir);
assert.deepEqual(actual,manifest.candidateTree);
for(const [name,hash] of Object.entries(manifest.packages))assert.equal(crypto.createHash('sha256').update(fs.readFileSync(name)).digest('hex'),hash);
await import('./src/server.js');
const ns=await import('./src/netsuite.js');
const p={item:{items:[{item:{id:'2055'},quantity:41.04,rate:8.39,custcol_lyr:4,custcol_plt:0,custcol_sec:0,custcol_pcs:0}]}};
let called=false;
await ns.createSalesOrderInNetSuite(p,{mutate:run=>run(),rest:async(path,options)=>{
  called=true;assert.equal(path,'/record/v1/salesOrder');
  assert.deepEqual(options.body.item.items[0],{...p.item.items[0],custcol_plt:null,custcol_sec:null,custcol_pcs:null});
  return {id:99};
}});
assert(called);
console.log(JSON.stringify({passed:true,imageId:manifest.candidateImageId,runtimeFilesVerified:Object.keys(actual).length,packagesPreserved:true,serverImport:true,soTransport:true}));
process.exit(0);
NODE
python3 - "$MBBS_TEST_ARTIFACT_DIR/image-check.log" "$release_dir/image-check.json" <<'PY'
import json,sys
from pathlib import Path
result=json.loads(Path(sys.argv[1]).read_text().splitlines()[-1])
assert result['passed']
Path(sys.argv[2]).write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result))
PY
