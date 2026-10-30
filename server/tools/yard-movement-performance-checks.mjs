import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mutants} from '../test/support/yard-movement-performance-mutations.mjs';
const out='test-artifacts/yard-performance';mkdirSync(out,{recursive:true});
const tests=['test/yard-movement-performance.test.js','test/yard-movement-performance-browser.test.js','test/yard-movement-requests.test.js','test/mbt/integration/yard-movement-po-search.test.js','test/mbt/integration/movement-document-history.test.js'];
const source=['src/yard-movement-repository.js','public/control.js','public/dispatch-loaded-export.js','public/yard-movement-requests.js','public/control.html','public/admin.html','public/dispatch-loaded-export.html'];
const counts=output=>Object.fromEntries([...output.matchAll(/^# (tests|pass|fail|cancelled|skipped) (\d+)$/gm)].map(m=>[m[1],Number(m[2])]));
function run(name,args,{env={},failure=false,timeout=300000}={}){
  const result=spawnSync(process.execPath,args,{env:{...process.env,...env},encoding:'utf8',maxBuffer:30*1024*1024,timeout});
  const output=(result.stdout||'')+(result.stderr||'');writeFileSync(`${out}/${name}.log`,output);
  console.log(JSON.stringify({stage:name,exit:result.status,...counts(output)}));
  if(result.status!==0&&!failure) console.log(output.split('\n').filter(line=>line.startsWith('not ok ')||line.includes('YARD_BROWSER_TIMING')).join('\n'));
  if(!failure) assert.equal(result.status,0,output.slice(-11000));
  return {...result,output};
}
for(const file of source.filter(f=>f.endsWith('.js'))) run('syntax-'+file.split('/').at(-1),['--check',file]);
run('static',['tools/yard-movement-performance-static.mjs']);
const baseline=run('old-po-fixture',['--loader','./test/support/yard-movement-performance-mutations.mjs','--test','test/mbt/integration/yard-movement-po-search.test.js'],{env:{YARD_PERF_OLD_FIXTURE:'1'},failure:true});
assert.equal(counts(baseline.output).fail,3);assert.ok(baseline.output.includes('null value in column "dispatch_order_ref"'));
const regression=run('regressions',['node_modules/c8/bin/c8.js','--all=false','--check-coverage=false','--include=src/yard-movement-repository.js',`--temp-directory=${out}/v8`,`--report-dir=${out}/coverage`,'--reporter=json','--reporter=json-summary',process.execPath,'--test','--test-concurrency=1',...tests]);
const timings=JSON.parse(readFileSync('test-artifacts/yard-performance-browser-metrics.json'));
run('photo-hydration',['--test','--test-name-pattern=incremental detail renders','test/mbt/unit/control-yard-photo-thumbnail.test.js']);
run('yard-history',['src/yard-movement-integration-harness.js']);
run('reload-history',['src/sales-order-reload-yard-history-harness.js']);
run('changed-coverage',['tools/yard-movement-performance-coverage.mjs']);
const mutations=[];
for(const [name,[file]] of Object.entries(mutants)){
  const args=file.startsWith('public/')?['--test','test/yard-movement-requests.test.js']:['--loader','./test/support/yard-movement-performance-mutations.mjs','--test',`--test-name-pattern=${name==='aliasIndex'?'P2: global':name==='allHistory'?'P2: a selected':'P1/A1:'}`,'test/yard-movement-performance.test.js'];
  const result=run('mutant-'+name,args,{env:{YARD_PERF_MUTANT:name},failure:true});
  assert.ok(result.output.includes('YARD_PERF_MUTATION:'+name)&&counts(result.output).fail>0&&result.status!==0,'Surviving mutant '+name);mutations.push(name);
}
run('reordered',['--test','--test-concurrency=1','test/yard-movement-requests.test.js','test/yard-movement-performance.test.js','test/yard-movement-performance-browser.test.js'],{env:{YARD_PERF_SAMPLES:'1'}});
run('secrets',['test/support/scan-diff-secrets.mjs',...source,...tests]);
const versions=Object.fromEntries(['@playwright/test','fast-check','c8','eslint','typescript'].map(name=>[name,JSON.parse(readFileSync(`node_modules/${name}/package.json`)).version]));
const hashes=Object.fromEntries([...source,...tests].map(file=>[file,createHash('sha256').update(readFileSync(file)).digest('hex')]));
const evidence={passed:true,tests:counts(regression.output),mutants:mutations,versions,node:process.version,hashes,changedCoverage:JSON.parse(readFileSync(`${out}/changed-coverage.json`)),static:JSON.parse(readFileSync(`${out}/static.json`)),timings};
writeFileSync(`${out}/evidence.json`,JSON.stringify(evidence,null,2));console.log(JSON.stringify({...evidence,hashes:undefined}));
