import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,readdirSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {production,tests} from './operator-inventory-files.mjs';
const folder='test-artifacts/operator-inventory';mkdirSync(folder,{recursive:true});
const json=file=>JSON.parse(readFileSync(file,'utf8'));
const write=(name,value)=>writeFileSync(`${folder}/${name}.json`,JSON.stringify(value,null,2));
function source() {
  const files=[...production,...tests,'test/mbt/integration/aggregate-request-browser.test.js','package.json','test/operator-inventory-spec.md','test/support/operator-inventory-baseline.json','test/support/operator-inventory-concurrent-baseline.json',
    'test/support/operator-inventory-mutation-loader.mjs',...readdirSync('tools').filter(name=>name.startsWith('operator-inventory-')).map(name=>`tools/${name}`)];
  write('source',Object.fromEntries(files.map(file=>[file,createHash('sha256').update(readFileSync(file)).digest('hex')])));
  console.log(JSON.stringify({files:files.length,node:process.version,tools:Object.fromEntries(['@playwright/test','fast-check','c8','eslint','typescript'].map(name=>[name,json(`node_modules/${name}/package.json`).version]))}));
}
function compare() {
  const prior=json('test/support/operator-inventory-baseline.json');
  const log=readFileSync(`${folder}/full.log`,'utf8');
  assert.match(log,/Isolated MBT main run (?:passed|failed)/,'The full suite did not complete');
  const names=[...new Set(log.split('\n').filter(line=>line.startsWith('✖ ') && line!=='✖ failing tests:').map(line=>line.slice(2).replace(/ \([0-9.]+ms\)$/u,'')))].sort();
  let unexpected=names.filter(name=>!prior.failedTests.includes(name));
  const concurrentReceiving={
    'receiving: renders the NetSuite stage before awaiting submission':'test/mbt/unit/operator-direct-orderline-client.test.js',
    'receiving: native and local posting submit identities without waiting for photo network traffic':'test/mbt/unit/operator-posting-photo-client.test.js',
    'Back to Receiving clears search and invalidates stale requests before reloading':'test/mbt/unit/operator-receiving-return.test.js'
  };
  const reruns=[];
  // These fixtures were updated by separate Receiving work during the long run.
  // Only a fresh, fully passing file can supersede its earlier failure.
  for(const name of [...unexpected]) {
    const file=concurrentReceiving[name];
    if(!file) {continue;}
    const rerun=spawnSync(process.execPath,['--test',file],{encoding:'utf8',timeout:60000});
    const output=rerun.stdout+rerun.stderr;
    writeFileSync(`${folder}/${file.split('/').at(-1)}.rerun.log`,output);
    reruns.push({name,file,status:rerun.status});
    if(rerun.status===0 && /# fail 0\b/.test(output)) {unexpected=unexpected.filter(value=>value!==name);}
  }
  const concurrentFailures=[];
  if(unexpected.length && existsSync('test/support/operator-inventory-concurrent-baseline.json')) {
    const proof=json('test/support/operator-inventory-concurrent-baseline.json');
    assert.equal(proof.inventoryChangesRemoved,true);
    assert.equal(createHash('sha256').update(readFileSync('public/operator.js')).digest('hex'),proof.workspaceSha256,'Concurrent baseline is stale');
    for(const name of [...unexpected]) {
      if(proof.failedTests.includes(name)) {concurrentFailures.push(name);unexpected=unexpected.filter(value=>value!==name);}
    }
  }
  const counts=[...log.matchAll(/ℹ (tests|pass|fail|skipped) (\d+)/gu)].reduce((result,match)=>{result[match[1]]=(result[match[1]] || 0)+Number(match[2]);return result;},{});
  const result={counts,baselineFailureNames:prior.failedTests.length,currentFailureNames:names.length,reruns,concurrentFailures,unexpected};write('comparison',result);console.log(JSON.stringify(result));
  assert.deepEqual(unexpected,[],'New regression failures');
}
function types() {
  const result=spawnSync('node_modules/.bin/tsc',['--project','tsconfig.mbt.json','--pretty','false'],{encoding:'utf8',maxBuffer:8*1024*1024});
  const diagnostics=[...new Set((result.stdout+result.stderr).split('\n').filter(line=>line.includes('error TS')).map(line=>line.replace(/\(\d+,\d+\)/gu,'')))];
  const prior=json('test/support/operator-inventory-baseline.json').diagnostics;
  const unexpected=diagnostics.filter(line=>!prior.includes(line));write('types',{baseline:prior.length,current:diagnostics.length,unexpected});
  assert.deepEqual(unexpected,[],'New project type diagnostics');console.log(JSON.stringify({baseline:prior.length,current:diagnostics.length,newDiagnostics:0}));
}
function shuffle() {
  const order=[tests[4],tests[0],tests[5],tests[2],tests[1],tests[3],tests[6]];
  const log=[];
  for(const file of order) {
    const result=spawnSync(process.execPath,['--test',file],{encoding:'utf8',timeout:90000,maxBuffer:4*1024*1024});
    log.push(result.stdout+result.stderr);assert.equal(result.status,0,file+'\n'+result.stdout+result.stderr);
  }
  writeFileSync(`${folder}/shuffle.log`,log.join('\n'));console.log(JSON.stringify({reorderedFiles:order,passed:true}));
}
({source,compare,types,shuffle})[process.argv[2]]();
