import {spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
const mode=process.argv[2]||'full',out='test-artifacts/unified-stock-status';
const coverage='/tmp/unified-stock-status-v8';
mkdirSync(out,{recursive:true});
assert.equal(process.env.MBT_TEST_ISOLATED,'1');assert.equal(new URL(process.env.DATABASE_URL).hostname,'db');
const results=[],databaseFailures=[];
function run(name,args,env={},baselineFailures=[]){
  const started=Date.now(),result=spawnSync(process.execPath,args,{env:{...process.env,...env},encoding:'utf8',maxBuffer:24*1024*1024,timeout:300000});
  const log=(result.stdout||'')+(result.stderr||'');writeFileSync(`${out}/${name}.log`,log);
  const failures=[...log.matchAll(/^not ok \d+ - (.+)$/gm)].map(match=>match[1]).sort();
  const baselineOnly=result.status===1&&failures.length>0&&JSON.stringify(failures)===JSON.stringify(baselineFailures);
  const record={name,exit:result.status,baselineOnly,durationMs:Date.now()-started,tests:Number(log.match(/^# tests (\d+)$/m)?.[1]||0),passed:Number(log.match(/^# pass (\d+)$/m)?.[1]||0),failed:Number(log.match(/^# fail (\d+)$/m)?.[1]||0)};
  results.push(record);writeFileSync(`${out}/results-${mode}.json`,JSON.stringify(results,null,2));console.log(JSON.stringify(record));
  if(result.status!==0&&!baselineOnly)console.log(log.slice(-7000));
  assert(result.status===0||baselineOnly,`${name} failed`);
  return record;
}
const unitFiles=['unit','property'].flatMap(folder=>readdirSync(`test/mbt/${folder}`).filter(file=>/^(regular-stock|regular-waitlist|backorder|stock-request|stocking|special-supply)/.test(file)&&file.endsWith('.test.js')).sort().map(file=>`test/mbt/${folder}/${file}`));
if(['full','checks'].includes(mode)){
  rmSync(coverage,{recursive:true,force:true});mkdirSync(coverage,{recursive:true});
  process.env.NODE_V8_COVERAGE=coverage;
  run('static',['tools/unified-stock-status-static.mjs']);
  run('baseline-contract',['tools/unified-stock-status-baseline.mjs']);
  const baselineFailures=JSON.parse(readFileSync(`${out}/baseline-ui-failures.json`,'utf8'));
  run('unit-properties',['--test','--test-concurrency=1',...unitFiles],{},baselineFailures);
  run('mutations',['tools/unified-stock-status-mutations.mjs'],{NODE_V8_COVERAGE:''});
  // Fixed alternate file order verifies the suite has no inter-file ordering dependency.
  run('suite-order',['--test','--test-concurrency=1',...unitFiles.toReversed()],{},baselineFailures);
}
if(mode!=='checks'){
const url=new URL(process.env.DATABASE_URL);url.pathname='/postgres';
const admin=new pg.Client({connectionString:url.href});await admin.connect();
let sequence=0;
async function databaseTest(name,files,{snapshot=false,baselineFailures=[],env={},testArgs=[]}={}){
  const database=`mbt_test_file_${randomBytes(6).toString('hex')}_${sequence++}`;
  await admin.query(`CREATE DATABASE ${database} TEMPLATE mbt_test`);
  const testUrl=new URL(process.env.DATABASE_URL);testUrl.pathname='/'+database;
  try{return run(name,snapshot?['tools/unified-stock-status-snapshot.mjs',...files]:['--test','--test-concurrency=1',...testArgs,...files],{DATABASE_URL:testUrl.href,...env},baselineFailures);}
  finally{await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);}
}
try{
  if(mode==='full'){
    const expected=['SCM Waitlist closed history has the shared status and no rejection control',
      'Pickup, Delivery, Stocking Purchase and Waitlist detail headers use the same main-status vocabulary',
      'SCM transfer controls remain available from unified statuses and terminal transfers cannot be rejected'].sort();
    const mutant=await databaseTest('ui-mutation',['test/mbt/integration/regular-stock-status.test.js'],{
      env:{UNIFIED_STATUS_UI_MUTANT:'1',NODE_V8_COVERAGE:''},testArgs:['--test-name-pattern','SCM Waitlist closed history|detail headers use|SCM transfer controls'],baselineFailures:expected});
    assert.equal(mutant.failed,3,'All three added browser scenarios must detect removal of the shared status renderer');
  }
  const known={
    'regular-stock-target-yard-access':['SQL lists and detail authorization agree across yards, methods and versions'],
    'backorder-already-ordered-browser':['All Already Ordered request shows Completed and no remaining SO/PO steps','Completing the last material after a PO was linked removes its remaining planning prompt'],
    'regular-waitlist-http-browser':['SCM finds an existing PO, opens its item pool, releases a mature hold and acknowledges returned stock'],
    'stocking-line-actions-browser':['SCM Purchase actions send only the clicked material even when other materials are pending','Transfer Stocking reply and Resolve controls belong to the individual material','Sales can reply only in the instructed material card and sends its line ID']
  };
  const files=mode==='baseline-checks'?Object.keys(known):['regular-stock-status',...(mode==='acceptance'?['regular-stock-resolution-browser']:[]),...(mode==='full'?[
    'stock-request-repository','stock-request-search-across-statuses','stock-request-yard-selection',
    'regular-stock-request','regular-stock-http','regular-stock-stocking','regular-stock-pickup',
    'regular-stock-purchase','regular-stock-resolution-http','regular-stock-delivery-simple-http',
    'regular-stock-delivery-progress-http','regular-stock-target-yard-access',
    'regular-waitlist-repository','regular-waitlist-enhancements','regular-waitlist-legacy-guards',
    'backorder-requests','backorder-routing','backorder-already-ordered',
    'stocking-line-actions','stocking-replies-http',
    'backorder-already-ordered-browser','regular-waitlist-http-browser',
    'regular-stock-resolution-browser','stocking-line-actions-browser'
  ]:[])];
  for(const file of files){
    try{
      const baselineFailures=(known[file]||[]).toSorted();
      if(baselineFailures.length){
        const baseline=await databaseTest('baseline-'+file,[`test/mbt/integration/${file}.test.js`],{snapshot:true,baselineFailures});
        assert.equal(baseline.failed,baselineFailures.length,'Expected legacy failures must first reproduce against the saved pre-change source');
      }
      if(mode!=='baseline-checks')await databaseTest(file,[`test/mbt/integration/${file}.test.js`],{baselineFailures});
    }
    catch(error){databaseFailures.push({file,error:error.message});}
  }
}finally{await admin.end();}
}
if(['full','checks'].includes(mode)){
  delete process.env.NODE_V8_COVERAGE;
  const runtime=JSON.parse(readFileSync('tools/unified-stock-status-files.json','utf8')).filter(file=>file.endsWith('.js'));
  run('coverage',['node_modules/c8/bin/c8.js','report',`--temp-directory=${coverage}`,`--report-dir=${out}/coverage`,'--reporter=text','--reporter=json','--reporter=json-summary',...runtime.map(file=>`--include=${file}`)]);
  run('changed-coverage',['tools/unified-stock-status-coverage.mjs']);
}
writeFileSync(`${out}/versions.json`,JSON.stringify({node:process.version,...Object.fromEntries(['typescript','eslint','c8','fast-check','@playwright/test','pg'].map(name=>[name,JSON.parse(readFileSync(`node_modules/${name}/package.json`,'utf8')).version]))},null,2));
assert.deepEqual(databaseFailures,[],'Database/browser regressions failed');
