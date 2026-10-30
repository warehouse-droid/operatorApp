import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mutants} from '../test/support/count-sheet-adjustments-mutation-loader.mjs';
const out='test-artifacts/count-adjustments';
mkdirSync(out,{recursive:true});
const tests=['test/count-sheet-adjustments.test.js','test/count-sheet-adjustments-browser.test.js','test/count-sheet-refresh.test.js','test/count-sheet-refresh-browser.test.js','test/count-sheet-reconstruction.test.js','test/inventory-packed-count.test.js','test/inventory-count-review-browser.test.js','test/cycle-count-refresh-http.test.js',...['domain','adapter','photos','count','damage','http','browser'].map(name=>`test/operator-inventory-${name}.test.js`)];
const source=['src/count-sheet-adjustments.js','src/count-sheet-repository.js','src/count-sheet-reconstruction.js','src/operator-inventory-router.js','public/control-count-sheets.js','public/control-count-sheets.css','public/control.html','public/i18n.js','migrations/302_count_sheet_adjusting.sql','migrations/303_count_sheet_variance.sql'];
const hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
const counts=output=>Object.fromEntries([...output.matchAll(/^# (tests|pass|fail|cancelled|skipped) (\d+)$/gm)].map(m=>[m[1],Number(m[2])]));
function run(name,args,{env={},failure=false,timeout=300000}={}) {
  const result=spawnSync(process.execPath,args,{env:{...process.env,...env},encoding:'utf8',maxBuffer:30*1024*1024,timeout});
  const output=(result.stdout || '')+(result.stderr || '');
  writeFileSync(`${out}/${name}.log`,output);
  console.log(JSON.stringify({stage:name,exit:result.status,...counts(output)}));
  if (!failure) {assert.equal(result.status,0,output.slice(-9000));}
  return {...result,output};
}
for (const file of source.filter(f=>f.endsWith('.js'))) {run('syntax-'+file.split('/').at(-1),['--check',file]);}
run('lint',['node_modules/eslint/bin/eslint.js','--config','tools/count-sheet-adjustments-eslint.config.mjs','--max-warnings=0',...source.filter(f=>f.endsWith('.js') && f!=='public/i18n.js'),...tests.slice(0,2),'test/support/count-sheet-adjustments-mutation-loader.mjs','tools/count-sheet-adjustments-checks.mjs']);
run('types',['node_modules/typescript/bin/tsc','--allowJs','--checkJs','--noEmit','--skipLibCheck','--target','es2022','--module','nodenext','src/count-sheet-adjustments.js']);
const regression=run('inventory-regressions',['node_modules/c8/bin/c8.js','--all=false','--check-coverage=false','--include=src/count-sheet-adjustments.js','--include=src/count-sheet-repository.js','--include=src/count-sheet-reconstruction.js','--include=src/operator-inventory-router.js',`--temp-directory=${out}/v8`,`--report-dir=${out}/coverage`,'--reporter=json','--reporter=json-summary','--reporter=text',process.execPath,'--test','--test-concurrency=1',...tests]);
run('changed-coverage',['tools/count-sheet-adjustments-coverage.mjs']);
const mutations=[];
for (const name of Object.keys(mutants)) {
  const result=run('mutant-'+name,['--loader','./test/support/count-sheet-adjustments-mutation-loader.mjs','--test','test/count-sheet-adjustments.test.js'],{env:{COUNT_ADJUSTMENTS_MUTANT:name},failure:true});
  assert.ok(result.output.includes('COUNT_ADJUSTMENTS_MUTATION:'+name));
  assert.ok(counts(result.output).fail>0 && result.status!==0,'Surviving mutant: '+name);
  mutations.push(name);
}
const property=run('property-sign-mutant',['--loader','./test/support/count-sheet-adjustments-mutation-loader.mjs','--test','--test-name-pattern=generated signed decimal','test/count-sheet-adjustments.test.js'],{env:{COUNT_ADJUSTMENTS_MUTANT:'sign'},failure:true});
assert.ok(counts(property.output).fail>0);
run('reordered',['--test','--test-concurrency=1',...tests.slice(0,2).reverse()]);
run('secrets',['test/support/scan-diff-secrets.mjs',...source,...tests.slice(0,2)]);
const versions=Object.fromEntries(['@playwright/test','fast-check','c8','eslint','typescript'].map(name=>[name,JSON.parse(readFileSync(`node_modules/${name}/package.json`)).version]));
const evidence={passed:true,tests:counts(regression.output),mutants:mutations,versions,node:process.version,hashes:Object.fromEntries([...source,...tests].map(f=>[f,hash(f)])),changedCoverage:JSON.parse(readFileSync(`${out}/changed-coverage.json`)),coverage:JSON.parse(readFileSync(`${out}/coverage/coverage-summary.json`))};
writeFileSync(`${out}/evidence.json`,JSON.stringify(evidence,null,2));
console.log(JSON.stringify({...evidence,hashes:undefined,sourceTreeHash:createHash('sha256').update(JSON.stringify(evidence.hashes)).digest('hex')}));
