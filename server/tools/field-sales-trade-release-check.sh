#!/usr/bin/env bash
set -Eeuo pipefail
field_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
field_release="$field_root/test-artifacts/field-sales/trade-deployment-20260919"
field_tag="field-sales-trade-release-check-$$"
field_image="mbbs-operator-app:field-sales-trade-20260919-v5"
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

const base='http://127.0.0.1:3000';
try {
 await query(`UPDATE field_sales_settings SET data=data||'{"enabled":true,"importsEnabled":false,"postingEnabled":false}'::jsonb`);

 for(const route of ['/field-sales/','/driver','/sales','/operator']){assert.equal((await fetch(base+route)).status,200,route);}
 assert.equal((await fetch(base+'/api/field-sales/jobsites')).status,401);
 const username='recent-release-'+randomUUID(),password=randomUUID();
 await createOperator({username,password,displayName:'Isolated deployment test',role:'field_sales'});
 const login=await loginOperator(username,password),headers={Authorization:`Bearer ${login.token}`};assert.equal(login.operator.homeRoute,'/field-sales/');
 async function get(path,filter={}){const r=await fetch(base+'/api/field-sales'+path+'?'+new URLSearchParams(filter),{headers});assert.equal(r.status,200,path);return r.json();}
 const companies=['MBBS','MBR','MBT'];
 await query(`INSERT INTO field_sales_catalog(company,item_id,sku,description,unit,unit_rate) VALUES('MBBS','1','Block','Block','Each','19.99'),('MBR','2','Rental','Rental','Day','50'),('MBT','3','Bin','Bin','Each','100')`);
 const command=async(kind,payload)=>{const response=await fetch(base+'/api/field-sales/commands',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({id:randomUUID(),kind,payload})});assert.equal(response.status,200,await response.clone().text());return response.json();};
 const site=(await command('jobsite.save',{id:randomUUID(),address:'90 Trade Release Road'})).jobsite;
 const quote=(await command('quote.save',{id:randomUUID(),jobsiteId:site.id,customerName:'Isolated Three Company Builder',lines:companies.map((company,index)=>({id:company,company,itemId:String(index+1),description:company,quantity:index===0?'3':index===1?'1':'2',unitRate:index===0?'19.99':index===1?'50':'100'}))})).quote;
 assert.equal(quote.snapshot.totalMinor,35027);assert.deepEqual(Object.keys(quote.snapshot.companies).sort(),companies.sort());
 for(const suffix of ['', '?company=MBR']){const r=await fetch(base+'/api/field-sales/quotes/'+quote.id+'/pdf'+suffix,{headers});assert.equal(r.status,200);assert.equal(Buffer.from(await r.arrayBuffer()).subarray(0,5).toString(),'%PDF-');}
 for(const company of companies){assert.equal((await get('/catalog',{company})).items.length,1);}
 const missing=await fetch(base+'/api/field-sales/catalog/price',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({company:'MBR',itemId:'2'})});assert.equal(missing.status,409);assert.match((await missing.json()).error,/Configure/);
 const status=await get('/status');assert.equal(status.settings.data.postingEnabled,false);assert.equal(status.postingAvailable,false);
 for(const route of ['/status','/routes','/catalog','/imports']){await get(route);}

 console.log(JSON.stringify({passed:true,productionImage:true,entrypoints:4,authenticatedEndpoints:6,anonymousDenied:true,threeCompanyQuotesAndPdf:true,missingPriceConfigurationFailsClosed:true}));
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
