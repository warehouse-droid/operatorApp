import {readFileSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
assert.equal(process.env.MBT_TEST_ISOLATED,'1');
const pkg=JSON.parse(readFileSync('package.json'));
export const suites=[...pkg.scripts['test:delivery-instructions'].split(' ').filter(x=>x.endsWith('.js')),
 'test/mbt/unit/delivery-instruction-translation.test.js','test/mbt/unit/delivery-instruction-netsuite.test.js',
 'test/mbt/property/delivery-instruction-netsuite.property.test.js','test/mbt/integration/delivery-instruction-netsuite.test.js',
 'test/mbt/integration/delivery-instruction-netsuite-http.test.js','test/mbt/unit/special-fulfillment-adapter.test.js',
 'test/mbt/unit/driver-consolidated-physical-visit.test.js','src/sync-shape-harness.js','src/driver-photo-integrity-harness.js'];
export async function prepareRegressionFixture(){
 const {query,closeDb}=await import('../src/db.js');
 await query("INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,active) VALUES('di-netsuite-regression','di-netsuite-regression','Isolated regression operator','harness','harness','admin',ARRAY['admin'],true) ON CONFLICT(id)DO NOTHING");
 await closeDb();
}
if(process.argv[1]?.endsWith('/delivery-instruction-netsuite-tests.mjs')){
 await prepareRegressionFixture();
 const result=spawnSync(process.execPath,['--test','--test-concurrency=1',...suites],{encoding:'utf8',maxBuffer:30_000_000});
 const text=result.stdout+result.stderr;writeFileSync('test-artifacts/delivery-instruction-netsuite/regressions.tap',text);
 const counts=Object.fromEntries(['tests','pass','fail','skipped'].map(key=>[key,Number(new RegExp(`^# ${key} (\\d+)`,'m').exec(text)?.[1]||0)]));
 const known=JSON.parse(readFileSync('tools/delivery-instruction-netsuite-known-failures.json'));
 const failures=[...text.matchAll(/^not ok \d+ - (.+)$/gm)].map(m=>m[1]);
 const newFailures=failures.filter(name=>!known[name]||!text.includes(known[name]));
 counts.knownFailures=failures.length-newFailures.length;
 writeFileSync('test-artifacts/delivery-instruction-netsuite/tests.json',JSON.stringify({...counts,exitCode:result.status},null,2));console.log(JSON.stringify(counts));
 assert.deepEqual(newFailures,[],text);assert(result.status===0 || result.status===1&&failures.length>0,text);
}
