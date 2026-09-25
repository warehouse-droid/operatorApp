#!/usr/bin/env bash
set -Eeuo pipefail
field_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
field_release="$field_root/test-artifacts/field-sales/recent-deployment-20260919"
field_tag="field-sales-recent-release-check-$$"
field_image="mbbs-operator-app:field-sales-recent-20260919-v3"
field_artifacts="$field_release/checks"
mkdir -p "$field_artifacts"
cleanup() {
  docker rm -f "$field_tag-app" "$field_tag-db" >/dev/null 2>&1 || true
  docker network rm "$field_tag" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker network create --internal "$field_tag" >/dev/null
docker run -d --name "$field_tag-db" --network "$field_tag" --network-alias db --tmpfs /var/lib/postgresql \
  -e POSTGRES_USER=mbt_test -e POSTGRES_PASSWORD=field_sales_test_only -e POSTGRES_DB=mbt_test_field_sales postgres:18-alpine >/dev/null
for field_attempt in $(seq 1 60); do
  if docker exec "$field_tag-db" pg_isready -U mbt_test -d mbt_test_field_sales >/dev/null 2>&1; then break; fi
  sleep 1
done
field_env=(-e NODE_ENV=test -e MBT_TEST_ISOLATED=1 -e MBBS_ENV_FILE=/nonexistent \
  -e DATABASE_URL=postgres://mbt_test:field_sales_test_only@db:5432/mbt_test_field_sales \
  -e NETSUITE_DIRECT_ACCESS_ENABLED=false -e NETSUITE_MIRROR_ROLE=disabled -e SAMSARA_WRITES_ENABLED=false \
  -e SMART_SCM_LIVE_EXECUTION_ENABLED=false -e MBT_NETSUITE_WRITES_ENABLED=false -e FIELD_SALES_NETSUITE_WRITES_ENABLED=false)
docker run --rm --network "$field_tag" "${field_env[@]}" --entrypoint node "$field_image" src/migrate.js > "$field_artifacts/migrations.log" 2>&1
# Runtime files are all from the packaged image; only the isolated fixture is mounted.
docker run -d --name "$field_tag-app" --network "$field_tag" "${field_env[@]}" \
  -v "$field_root/test/field-sales:/app/test/field-sales:ro" "$field_image" >/dev/null
field_ready=false
for field_attempt in $(seq 1 50); do
  if docker exec "$field_tag-app" node -e "fetch('http://127.0.0.1:3000/health').then(async r=>{if(!r.ok||(await r.json()).ok!==true)process.exit(1)}).catch(()=>process.exit(1))" >/dev/null 2>&1; then field_ready=true; break; fi
  sleep 1
done
docker logs "$field_tag-app" > "$field_artifacts/image-startup.log" 2>&1
test "$field_ready" = true
docker exec -i "$field_tag-app" node --input-type=module > "$field_artifacts/image-smoke.log" <<'JS'
import assert from 'node:assert/strict';
import {createOperator,loginOperator} from './src/auth-repository.js';
import {randomUUID} from 'node:crypto';
import {query,closeDb} from './src/db.js';
import {seedRecent} from './test/field-sales/recent-fixture.js';
const base='http://127.0.0.1:3000';
try {
 await query(`UPDATE field_sales_settings SET data=data||'{"enabled":true,"importsEnabled":false,"postingEnabled":false}'::jsonb`);
 const fixture=await seedRecent();
 for(const route of ['/field-sales/','/driver','/sales','/operator']){assert.equal((await fetch(base+route)).status,200,route);}
 assert.equal((await fetch(base+'/api/field-sales/jobsites')).status,401);
 const username='recent-release-'+randomUUID(),password=randomUUID();
 await createOperator({username,password,displayName:'Isolated deployment test',role:'field_sales'});
 const login=await loginOperator(username,password),headers={Authorization:`Bearer ${login.token}`};assert.equal(login.operator.homeRoute,'/field-sales/');
 async function get(path,filter={}){const r=await fetch(base+'/api/field-sales'+path+'?'+new URLSearchParams(filter),{headers});assert.equal(r.status,200,path);return r.json();}
 const filter={source:'recommended',recencyMonths:'12',search:fixture.prefix};
 const list=await get('/jobsites',filter);assert.ok(list.items.some(s=>s.id===fixture.ids.house));assert.ok(!list.items.some(s=>s.id===fixture.ids.oldDrain));
 const map=await get('/map',filter);assert.equal(map.items.reduce((sum,p)=>sum+p.count,0),list.total);
 const planning=await get('/jobsites',{...filter,source:'planning',milestone:'Notice of Complete Application Issued'});assert.deepEqual(planning.items.map(s=>s.id),[fixture.ids.complete]);
 const old=await get('/jobsites',{...filter,source:'permit',recencyMonths:'all',includeMinor:'true'});assert.ok(old.items.some(s=>s.id===fixture.ids.oldDrain));
 for(const route of ['/status','/routes','/catalog','/imports']){await get(route);}
 console.log(JSON.stringify({passed:true,productionImage:true,entrypoints:4,authenticatedEndpoints:6,anonymousDenied:true,recencyMapMilestoneAndHistory:true}));
}finally{await closeDb();}
JS
python3 - "$field_release" "$field_tag-app" <<'PY'
import json,subprocess,sys
from pathlib import Path
r=Path(sys.argv[1]); manifest=json.loads((r/'manifest.json').read_text())
actual=json.loads(subprocess.check_output(['docker','inspect',sys.argv[2]]))[0]
assert actual['Image']==manifest['candidateImageId'] and actual['RestartCount']==0
checks=json.loads((r/'checks/image-smoke.log').read_text()); assert checks['passed']
result={'passed':True,'imageId':manifest['candidateImageId'],'productionImageStartup':True,'checks':checks}
(r/'candidate-checks.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result))
PY
