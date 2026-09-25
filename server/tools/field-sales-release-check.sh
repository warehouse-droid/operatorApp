#!/usr/bin/env bash
set -Eeuo pipefail
field_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
field_release="$field_root/test-artifacts/field-sales/deployment"
field_tag="field-sales-release-check-$$"
field_image="mbbs-operator-app:field-sales-20260918-v1"
field_test_image="${FIELD_SALES_TEST_IMAGE:-field-sales-check-2941306}"
field_artifacts="$field_release/checks"
mkdir -p "$field_artifacts"
cleanup() {
  docker rm -f "$field_tag-runner" "$field_tag-app" "$field_tag-db" >/dev/null 2>&1 || true
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
# Migrations execute from the actual production image, with no host source override.
docker run --rm --network "$field_tag" "${field_env[@]}" --entrypoint node "$field_image" src/migrate.js > "$field_artifacts/migrations.log" 2>&1
field_mounts=()
for field_dir in src public migrations; do
  field_mounts+=(-v "$field_release/candidate/$field_dir:/app/$field_dir:ro")
done
for field_dir in test tools contracts; do
  field_mounts+=(-v "$field_root/$field_dir:/app/$field_dir:ro")
done
for field_file in "$field_root"/*.js "$field_root"/*.json "$field_root"/Dockerfile "$field_root"/Dockerfile.test; do
  field_mounts+=(-v "$field_file:/app/$(basename "$field_file"):ro")
done
docker run -d --name "$field_tag-runner" --network "$field_tag" --shm-size=512m --user root \
  "${field_env[@]}" -e FIELD_SALES_ARTIFACT_DIR=/artifacts "${field_mounts[@]}" -v "$field_artifacts:/artifacts" \
  --entrypoint sleep "$field_test_image" infinity >/dev/null
docker exec "$field_tag-runner" node --test --test-concurrency=1 $(cd "$field_root" && rg --files test/field-sales -g '*.test.js' | sort) > "$field_artifacts/focused.log" 2>&1
docker exec "$field_tag-runner" node tools/field-sales-browser.mjs > "$field_artifacts/browser.log" 2>&1
docker exec "$field_tag-runner" node tools/field-sales-smoke.mjs > "$field_artifacts/server-smoke.log" 2>&1
docker exec "$field_tag-runner" node --test --test-name-pattern='production roots stay frozen|main sidebar modules follow' \
  test/mbt/infrastructure/production-runtime-contract.test.js test/mbt/unit/operations-navigation-enhancements.test.js > "$field_artifacts/integration-contracts.log" 2>&1
# Rehearse the exact activation operation without production credentials or network access.
docker run --rm -i --network "$field_tag" "${field_env[@]}" -e FIELD_SALES_RELEASE_ACTIVATION=1 \
  --entrypoint node "$field_image" --input-type=module < "$field_root/tools/field-sales-activate.mjs" > "$field_artifacts/activation.log" 2>&1
docker exec "$field_tag-db" psql -U mbt_test -d mbt_test_field_sales -c "UPDATE field_sales_settings SET data=data||'{\"importsEnabled\":false}'::jsonb;" > /dev/null
docker run -d --name "$field_tag-app" --network "$field_tag" "${field_env[@]}" "$field_image" > /dev/null
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
import {closeDb} from './src/db.js';
const base='http://127.0.0.1:3000';
try{
 for(const route of ['/field-sales/','/driver','/sales','/operator']){assert.equal((await fetch(base+route)).status,200,route);}
 assert.equal((await fetch(base+'/api/field-sales/jobsites')).status,401);
 const username='release-'+randomUUID(),password=randomUUID();
 await createOperator({username,password,displayName:'Isolated deployment test',role:'field_sales'});
 const login=await loginOperator(username,password);assert.equal(login.operator.homeRoute,'/field-sales/');
 const headers={Authorization:`Bearer ${login.token}`};
 for(const route of ['/status','/jobsites','/routes','/catalog','/imports']){assert.equal((await fetch(base+'/api/field-sales'+route,{headers})).status,200,route);}
 console.log(JSON.stringify({passed:true,productionImage:true,entrypoints:4,authenticatedEndpoints:5,anonymousDenied:true}));
}finally{await closeDb();}
JS
python3 - "$field_release" "$field_tag-app" <<'PY'
import hashlib,json,subprocess,sys
from pathlib import Path
r=Path(sys.argv[1]); manifest=json.loads((r/'manifest.json').read_text()); checks=r/'checks'
browser=json.loads((checks/'browser-results.json').read_text()); assert browser['passed']==5 and browser['errors']==[]
text=(checks/'focused.log').read_text(); assert '# tests 65' in text and '# fail 0' in text and '# skipped 0' in text
actual=json.loads(subprocess.check_output(['docker','inspect',sys.argv[2]]))[0]
assert actual['Image']==manifest['candidateImageId'] and actual['RestartCount']==0
result={'passed':True,'imageId':manifest['candidateImageId'],'focusedTests':65,'browserScenarios':5,
 'migrationAndActivationRehearsed':True,'productionImageStartup':True,'imageSmoke':json.loads((checks/'image-smoke.log').read_text()),
 'artifacts':{str(p.relative_to(r)):hashlib.sha256(p.read_bytes()).hexdigest() for p in checks.rglob('*') if p.is_file()}}
(r/'candidate-checks.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({k:v for k,v in result.items() if k!='artifacts'}))
PY
