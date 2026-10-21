import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { openSync, closeSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import pg from "pg";
import { describeIsolatedTestDatabase, isolatedTestDatabaseName } from "../../test/support/test-database-isolation.mjs";
assert.equal(process.env.MBT_TEST_ISOLATED,"1");
assert.equal(new URL(process.env.DATABASE_URL).hostname,"db");
const mode=process.argv.at(-1),task="tools/som06964-release-20261015",out="test-artifacts/som06964-release-20261015";
const regressions=["test/dispatch/frontend/billed-order-po-link.test.js","test/dispatch/frontend/dispatch-fulfilled-so-ui.test.js","test/dispatch/frontend/local-reopen-actions.test.js","test/dispatch/unit/dispatch-fulfilled-so-policy.test.js","test/dispatch/integration/dispatch-fulfilled-so-planning.test.js","test/dispatch/integration/dispatch-po-split-link-target.test.js","test/dispatch/integration/scm-dependency-preview-blockers.red.test.js","test/dispatch/integration/sales-split-allocation-unsplit.test.js"];
const primary=["test/dispatch/frontend/dispatch-status-independence.test.js","test/dispatch/integration/dispatch-status-independence.test.js","test/dispatch/integration/sales-line-sync-hold.test.js"];
mkdirSync(out,{recursive:true});
function run(label,args){const fd=openSync(`${out}/${label}.log`,"w");let r;try{r=spawnSync(process.execPath,args,{env:process.env,timeout:300000,stdio:["ignore",fd,fd]});}finally{closeSync(fd);}const log=readFileSync(`${out}/${label}.log`,"utf8");const result={exit:r.status,...Object.fromEntries(["tests","pass","fail","skipped"].map(k=>[k,Number(log.match(new RegExp(`^# ${k} (\\d+)$`,"m"))?.[1]||0)])),failures:[...log.matchAll(/^not ok \d+ - (.+)$/gm)].map(m=>m[1])};writeFileSync(`${out}/${label}.json`,JSON.stringify(result,null,2));console.log(JSON.stringify({label,...result}));if(r.status)console.log(log.slice(-2800));return result;}
const selected=mode==="hold-red"?["test/dispatch/integration/sales-line-sync-hold.test.js"]:mode==="baseline"?regressions:mode==="red"||mode==="green"?primary:[...primary,...regressions];
const args=["--test","--test-concurrency=1",...selected];
const boundary=describeIsolatedTestDatabase(process.env.DATABASE_URL);
const admin=new pg.Client({connectionString:boundary.adminUrl});
const template=isolatedTestDatabaseName('dispatch-status-pristine-'+process.pid,0);
const resets=[];
async function resetDatabase(label){
 await admin.query('DROP DATABASE "mbt_test" WITH (FORCE)');
 await admin.query(`CREATE DATABASE "mbt_test" TEMPLATE "${template}"`);
 resets.push(label);writeFileSync(`${out}/database-resets.json`,JSON.stringify(resets,null,2));
}
await admin.connect();
try {
 if(mode==="final")await admin.query(`CREATE DATABASE "${template}" TEMPLATE "mbt_test"`);
const result=run(mode,mode==="final"?["node_modules/c8/bin/c8.js","--all=false","--check-coverage=false","--include=src/dispatch-fulfilled-so-policy.js","--include=src/scm-dependency-preview-service.js","--include=public/dispatch.js","--temp-directory=/tmp/dispatch-independence-c8",`--report-dir=${out}/coverage`,"--reporter=json","--reporter=text-summary",process.execPath,...args]:args);
if(mode==="red" || mode==="hold-red")assert.ok(result.fail>=2,"New behavior must fail on original runtime");else assert.equal(result.exit,0,JSON.stringify(result));
if(mode==="final"){
 for(const entry of ["static.mjs","mutations.mjs","hold-mutations.mjs"]){
  if(entry!=="static.mjs")await resetDatabase('before-'+entry);
  assert.equal(run(entry,[`${task}/${entry}`]).exit,0);
 }
 const health={tests:0,pass:0,fail:0,files:[]};
 for(const [index,file] of [...regressions,...primary].sort().reverse().entries()){
  await resetDatabase('suite-health-'+index);
  const row=run('health-'+file.replaceAll("/","_"),["--test",file]);
  health.files.push({file,...row});for(const key of ['tests','pass','fail'])health[key]+=row[key];
  assert.equal(row.exit,0);
 }
 writeFileSync(`${out}/suite-health.json`,JSON.stringify(health,null,2));
 assert.equal(health.tests,result.tests);assert.equal(health.fail,0);
 const files=[...JSON.parse(readFileSync(`${task}/files.json`)),...primary,...regressions];
 const hashes=Object.fromEntries(files.map(f=>[f,createHash("sha256").update(readFileSync(f)).digest("hex")]));
 writeFileSync(`${out}/summary.json`,JSON.stringify({...result,hashes,newFailures:[],baselineFailures:[],node:process.version,tools:Object.fromEntries(["c8","typescript","eslint","fast-check","playwright"].map(n=>[n,JSON.parse(readFileSync(`node_modules/${n}/package.json`)).version]))},null,2));
}

} finally {
 try{if(mode==="final")await admin.query(`DROP DATABASE IF EXISTS "${template}" WITH (FORCE)`);}
 finally{await admin.end();}
}
