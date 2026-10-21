import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { describeIsolatedTestDatabase, isolatedTestDatabaseName } from '../../test/support/test-database-isolation.mjs';
assert.equal(process.env.MBT_TEST_ISOLATED,'1');
assert.equal(new URL(process.env.DATABASE_URL).hostname,'db');
assert.equal(process.env.NETSUITE_DIRECT_ACCESS_ENABLED,'false');
const mode=process.argv.at(-1),task='tools/split-allocation-guard-20261015',out='test-artifacts/split-allocation-guard-20261015';
const primary=['test/dispatch/integration/sales-split-allocation-unsplit.test.js'];
const regressions=[
 'test/dispatch/unit/unfinished-sales-resplit.test.js','test/dispatch/unit/sales-unsplit.test.js',
 'test/dispatch/integration/unfinished-sales-resplit.test.js','test/dispatch/integration/unfinished-sales-resplit-http.test.js',
 'test/dispatch/integration/sales-unsplit.test.js','test/dispatch/integration/sales-unsplit-http.test.js',
 'test/dispatch/frontend/unfinished-sales-resplit.browser.test.mjs',
 'test/dispatch/integration/local-reopen-workflows.test.js','test/dispatch/frontend/local-reopen-actions.test.js',
 'test/dispatch/integration/billed-order-reopen.test.js','test/dispatch/frontend/billed-order-po-link.test.js',
 'test/dispatch/integration/dispatch-po-split-link-target.test.js','test/dispatch/integration/scm-dependency-preview-blockers.red.test.js',
 'test/dispatch/integration/dispatch-fulfilled-so-planning.test.js','test/dispatch/unit/dispatch-fulfilled-so-policy.test.js'
];
mkdirSync(out,{recursive:true});
function run(label,args,env=process.env){
 const file=`${out}/${label}.log`,fd=openSync(file,'w');let result;
 try{result=spawnSync(process.execPath,args,{env,timeout:300_000,stdio:['ignore',fd,fd]});}finally{closeSync(fd);}
 const log=readFileSync(file,'utf8');
 const record={label,exit:result.status,...Object.fromEntries(['tests','pass','fail','skipped'].map(key=>[key,Number(log.match(new RegExp(`^# ${key} (\\d+)$`,'m'))?.[1]||0)])),
  failures:[...log.matchAll(/^not ok \d+ - (.+)$/gm)].map(m=>m[1])};
 writeFileSync(`${out}/${label}.json`,JSON.stringify(record,null,2)+'\n');console.log(JSON.stringify(record));
 if(result.status)console.log(log.slice(-2500));
 return record;
}
const runtime=JSON.parse(readFileSync(task+'/files.json','utf8'));
const files=mode==='baseline'?regressions:['red','green'].includes(mode)?primary:[...primary,...regressions];
const args=['--test','--test-concurrency=1',...files];
const boundary=describeIsolatedTestDatabase(process.env.DATABASE_URL);
const admin=new pg.Client({connectionString:boundary.adminUrl});
const template=isolatedTestDatabaseName('split-guard-pristine-'+process.pid,0);
const resets=[];
async function resetDatabase(label){
 await admin.query('DROP DATABASE "mbt_test" WITH (FORCE)');
 await admin.query(`CREATE DATABASE "mbt_test" TEMPLATE "${template}"`);
 resets.push(label);writeFileSync(`${out}/database-resets.json`,JSON.stringify(resets,null,2)+'\n');
}
await admin.connect();
try {
 if(mode==='final')await admin.query(`CREATE DATABASE "${template}" TEMPLATE "mbt_test"`);
const result=run(mode,mode==='final'?['node_modules/c8/bin/c8.js','--all=false','--check-coverage=false',
 ...runtime.map(file=>'--include='+file),'--temp-directory=/tmp/split-guard-c8',`--report-dir=${out}/coverage`,'--reporter=json','--reporter=text-summary',process.execPath,...args]:args);
if(mode==='red'){assert.equal(result.tests,14);assert.ok(result.fail>=8);}
else if(mode==='baseline'){assert.ok(result.tests>0 && result.exit!==null);}
else if(mode==='green'){assert.equal(result.exit,0);assert.equal(result.tests,14);}
else {
 const baseline=JSON.parse(readFileSync(`${out}/baseline.json`,'utf8'));
 assert.equal(result.exit,0);assert.deepEqual(result.failures,baseline.failures);assert.equal(result.tests,baseline.tests+14);
 for(const file of runtime)assert.equal(run('syntax-'+file.replaceAll('/','_'),['--check',file]).exit,0);
 assert.equal(run('static-runner',[task+'/static.mjs']).exit,0);
 await resetDatabase('before-mutants');
 const mutations=run('mutations-runner',[task+'/mutations.mjs']);
 assert.equal(mutations.exit,0);
 // Node sorts multiple CLI file arguments. Run each file explicitly to ensure
 // actual reverse order. Some legacy fixtures require the exact mbt_test name,
 // so recreate only that strictly validated disposable DB from a clean template.
 const health={label:'suite-health',exit:0,tests:0,pass:0,fail:0,skipped:0,failures:[],files:[]};
 for(const [index,file] of [...files].sort().reverse().entries()){
  await resetDatabase('suite-health-'+index);
  const row=run('suite-health-'+index,['--test','--test-concurrency=1',file]);
  health.files.push({file,...row});
  for(const key of ['tests','pass','fail','skipped'])health[key]+=row[key];
  health.failures.push(...row.failures);if(row.exit!==0)health.exit=1;
 }
 writeFileSync(`${out}/suite-health.json`,JSON.stringify(health,null,2)+'\n');
 assert.equal(health.exit,0);
 assert.deepEqual([...health.failures].sort(),[...baseline.failures].sort());assert.equal(health.tests,result.tests);
 const hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
 writeFileSync(`${out}/summary.json`,JSON.stringify({...result,baselineFailures:baseline.failures,newFailures:[],
  hashes:Object.fromEntries([...runtime,...files].map(file=>[file,hash(file)])),
  tools:Object.fromEntries(['typescript','eslint','c8','fast-check','playwright'].map(name=>[name,JSON.parse(readFileSync(`node_modules/${name}/package.json`,'utf8')).version])),
  node:process.version},null,2)+'\n');
}
} finally {
 try {if(mode==='final')await admin.query(`DROP DATABASE IF EXISTS "${template}" WITH (FORCE)`);}
 finally {await admin.end();}
}
