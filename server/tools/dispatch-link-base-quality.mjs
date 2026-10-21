import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import istanbulCoverage from 'istanbul-lib-coverage';
import { isolatedRun } from './dispatch-source-decision-checks.mjs';
const files=['src/dispatch-repository.js','src/order-dependency-repository.js','src/dispatch-po-route-projection.js','public/dispatch.js'];
const integration='test/dispatch/integration/dispatch-link-base.test.js';
const property='test/dispatch/property/dispatch-link-base.test.js';
const browser='test/dispatch/frontend/dispatch-link-base.browser.test.mjs';
const run=(args,name,options={})=>{
  const result=spawnSync('node',args,{encoding:'utf8',timeout:120000,maxBuffer:24*1024*1024,...options});
  writeFileSync(`test-artifacts/${name}.log`,result.stdout+result.stderr);return result;
};
const diagnostics=[];
for(const file of files) {
  assert.equal(run(['--check',file],`syntax-${file.replaceAll('/','-')}`).status,0);
  const args=['node_modules/eslint/bin/eslint.js','--config','tools/dispatch-link-base-eslint.config.mjs','--stdin','--stdin-filename',file,'--format','json'];
  const messages=[];
  for(const [mode,path] of [['before',`/workspace/server/deployments/dispatch-link-base-20261019/before/${file}`],['after',file]]) {
    const result=run(args,`lint-${mode}-${file.replaceAll('/','-')}`,{input:readFileSync(path,'utf8')});
    assert.ok([0,1].includes(result.status));
    messages.push(JSON.parse(result.stdout).flatMap(entry=>entry.messages.map(message=>JSON.stringify({rule:message.ruleId,message:message.message}))));
  }
  const remaining=[...messages[0]];
  for(const message of messages[1]) {const index=remaining.indexOf(message);assert.ok(index>=0,`New lint diagnostic in ${file}: ${message}`);remaining.splice(index,1);}
  diagnostics.push({file,baseline:messages[0].length,current:messages[1].length});
}
writeFileSync('test-artifacts/static.json',JSON.stringify({diagnostics,node:process.version,
  versions:Object.fromEntries(['eslint','c8','fast-check','pg','@playwright/test'].map(name=>[name,JSON.parse(readFileSync(`node_modules/${name}/package.json`,'utf8')).version])),
  types:'Changed runtime is JavaScript without type annotations; syntax, lint and executable contracts used.'},null,2));

assert.equal(run(['node_modules/c8/bin/c8.js','--all=false','--check-coverage=false',...files.filter(file=>file.startsWith('src/')).map(file=>`--include=${file}`),
  '--reporter=json','--report-dir=test-artifacts/base-coverage','--temp-directory=/tmp/base-link-coverage',
  'node','--test','--test-concurrency=1',integration,property],'base-coverage').status,0);
assert.equal(run(['--test',browser],'base-browser-coverage',{env:{...process.env,PO_COUNT_COVERAGE:'1'}}).status,0);
const changes=JSON.parse(readFileSync('test-artifacts/changed-lines.json','utf8'));
const coverage=[];
for(const file of files) {
  const report=file.startsWith('src/')?'base-coverage':'base-link-browser';
  const map=istanbulCoverage.createCoverageMap(JSON.parse(readFileSync(`test-artifacts/${report}/coverage-final.json`,'utf8')));
  const lines=map.fileCoverageFor(`/app/${file}`).getLineCoverage();
  const changed=changes[file].filter(line=>Object.hasOwn(lines,line));
  const covered=changed.filter(line=>lines[line]>0);
  const result={file,changedExecutableLines:changed.length,covered:covered.length,percent:100*covered.length/changed.length,uncovered:changed.filter(line=>!lines[line])};
  coverage.push(result);console.log(JSON.stringify(result));
}
writeFileSync('test-artifacts/changed-line-coverage.json',JSON.stringify(coverage,null,2));
assert.ok(coverage.every(result=>result.percent>=95),'Changed executable line coverage must reach 95%');

const mutants=[
  ['omit-derived-packing','src/dispatch-repository.js','dispatchLinkPhysicalQuantities(Number(quantities.salesQty), salesLine)','quantities',integration],
  ['use-target-packing-on-source','src/dispatch-po-route-projection.js','allocationDetails(allocation).quantityBasis !== "base"','true',property],
  ['ignore-base-uom','src/order-dependency-repository.js','text(unit).replace(/\\s+/gu, " ").toUpperCase()','""',integration],
  ['round-base-quantity','src/order-dependency-repository.js','quantity: Number(quantity.toFixed(6))','quantity: Math.round(quantity)',integration],
  ['ignore-existing-source-allocation','src/order-dependency-repository.js','existingAllocatedByItem.set(key, number(existingAllocatedByItem.get(key)) + number(line.allocated_quantity));','existingAllocatedByItem.set(key, 0);',integration],
  ['wrong-coverage-ratio','src/dispatch-po-route-projection.js','Math.max(number(quantity), 0) / total','Math.max(number(quantity), 0) / (total * 2)',property],
  ['edit-pieces-instead-of-base','public/dispatch.js','[["salesQty", `Base qty (${unit})`, quantity]]','[["pieces", "PCS", quantity]]',browser]
];
const killed=[];
for(const [name,file,before,after,test] of mutants) {
  const source=readFileSync(file,'utf8');assert.equal(source.split(before).length,2,`Unique mutant ${name}`);
  const root=`/tmp/link-base-mutant-${name}`;
  try {
    mkdirSync(root,{recursive:true});cpSync('src',`${root}/src`,{recursive:true});cpSync('public',`${root}/public`,{recursive:true});
    cpSync('package.json',`${root}/package.json`);symlinkSync('/app/node_modules',`${root}/node_modules`,'dir');
    mkdirSync(`${root}/${test.slice(0,test.lastIndexOf('/'))}`,{recursive:true});cpSync(test,`${root}/${test}`);
    writeFileSync(`${root}/${file}`,source.replace(before,after));
    const result=await isolatedRun(test,{cwd:root,prefix:name});
    assert.equal(result.exit,1,`Mutant ${name} survives`);assert.ok(result.failures.length);
    assert.ok(result.failures.every(failure=>!failure.includes('.test.js')),`Mutant ${name} must reach assertions`);
    killed.push({name,...result});console.log(JSON.stringify({mutation:name,...result}));
  } finally {rmSync(root,{recursive:true,force:true});}
}
writeFileSync('test-artifacts/mutations.json',JSON.stringify(killed,null,2));
console.log(JSON.stringify({qualityPassed:true,mutantsKilled:killed.length,coverage}));
