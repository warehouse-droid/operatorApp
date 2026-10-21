import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {cpSync,mkdirSync,readFileSync,writeFileSync,mkdtempSync,symlinkSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {ESLint} from 'eslint';

assert.equal(process.env.MBT_TEST_ISOLATED,'1');
assert.equal(new URL(process.env.DATABASE_URL).hostname,'mbbs-special-review-db');
const out=resolve('test-artifacts/special-po-pallet-routing');mkdirSync(out,{recursive:true});
const files=JSON.parse(readFileSync('tools/special-po-pallet-routing-files.json'));
const js=files.filter(file=>file.endsWith('.js'));
const own=['test/mbt/unit/special-po-pallet.test.js','test/mbt/unit/special-po-routing.test.js',
  'test/mbt/integration/special-po-pallet.test.js','test/mbt/integration/special-po-routing-browser.test.js'];
const existing=['test/mbt/unit/special-po-line-discount.test.js','test/mbt/unit/special-workflow-review.test.js',
  'test/mbt/integration/special-workflow-review.test.js','test/mbt/integration/special-batch-browser.test.js',
  'test/mbt/integration/special-standalone-po.test.js'];
const sha=source=>createHash('sha256').update(source).digest('hex');
const hashes=Object.fromEntries(files.map(file=>[file,sha(readFileSync(file))]));
const failures=log=>[...log.matchAll(/^not ok \d+ - (.+)$/gm)].map(match=>match[1]);
const counts=log=>Object.fromEntries(['tests','pass','fail','skipped'].map(key=>[key,Number(log.match(new RegExp(`^# ${key} (\\d+)$`,'m'))?.[1]||0)]));
function run(label,command,args,{cwd=process.cwd(),allowFailure=false}={}) {
  const r=spawnSync(command,args,{cwd,encoding:'utf8',timeout:180000,maxBuffer:30000000,
    env:{...process.env,SPECIAL_BATCH_BROWSER_OUTPUT:out+'/browser-'+label}});
  const log=(r.stdout||'')+(r.stderr||'');writeFileSync(`${out}/${label}.log`,log);
  assert.ok(r.status===0 || allowFailure && [1,2].includes(r.status),`${label}: ${log.slice(-4000)}`);
  console.log(JSON.stringify({label,exitCode:r.status,...counts(log)}));return {log,status:r.status};
}
function tree() {
  const root=mkdtempSync('/tmp/po-pallet-check-');
  for(const folder of ['src','public','migrations','test','tools'])cpSync(folder,root+'/'+folder,{recursive:true});
  for(const file of ['package.json','netsuite-smart-scm-picking-ticket-restlet.js'])cpSync(file,root+'/'+file);
  symlinkSync(resolve('node_modules'),root+'/node_modules','dir');return root;
}
const baseline=tree();
let previous;
try {
  for(const file of files) {
    const before='test-artifacts/special-po-pallet-routing/before/'+file;
    if(['public/special-stock-po-routing.js','public/special-stock-po-routing.css','migrations/246_special_po_pallet.sql'].includes(file))continue;
    cpSync(before,baseline+'/'+file);
  }
  previous=run('baseline-final',process.execPath,['--test','--test-concurrency=1',...existing],{cwd:baseline,allowFailure:true});
  for(const file of js)run('syntax-'+file.split('/').at(-1),process.execPath,['--check',file]);
  const typeArgs=['--noEmit','--allowJs','--checkJs','--skipLibCheck','--types','node','--target','ES2022','--module','NodeNext',...js];
  const diagnostics=(r)=>r.log.split('\n').filter(line=>/error TS\d+/.test(line)).map(line=>line.replace(/\(\d+,\d+\)/g,'(location)')).sort();
  const oldTypes=diagnostics(run('types-baseline',resolve('node_modules/.bin/tsc'),typeArgs,{cwd:baseline,allowFailure:true}));
  const newTypes=diagnostics(run('types-current',resolve('node_modules/.bin/tsc'),typeArgs,{allowFailure:true}));
  const remaining=[...oldTypes],added=newTypes.filter(line=>{const i=remaining.indexOf(line);if(i<0)return true;remaining.splice(i,1);return false;});
  assert.deepEqual(added,[],'No new type errors');
  run('types-new-module',resolve('node_modules/.bin/tsc'),['--noEmit','--allowJs','--checkJs','--skipLibCheck','--target','ES2022','--module','NodeNext','public/special-stock-po-routing.js','public/special-stock-purchase-pricing.js']);
  const lint=new ESLint({overrideConfigFile:resolve('tools/stock-request-layout-eslint.config.mjs')});
  const messages=async(source,file)=>(await lint.lintText(source,{filePath:file}))[0].messages.map(({ruleId,severity,message})=>({ruleId,severity,message}));
  for(const file of js) {
    const current=await messages(readFileSync(file,'utf8'),file);
    if(file==='public/special-stock-po-routing.js')assert.deepEqual(current,[]);
    else assert.deepEqual(current,await messages(readFileSync(baseline+'/'+file,'utf8'),file));
  }
  run('lint-tests',resolve('node_modules/.bin/eslint'),['--config','tools/stock-request-layout-eslint.config.mjs','--max-warnings=0',...own,'tools/special-po-pallet-routing-check.mjs']);
} finally {rmSync(baseline,{recursive:true,force:true});}

rmSync(out+'/browser-final',{recursive:true,force:true});mkdirSync(out+'/browser-final',{recursive:true});
const final=run('final',resolve('node_modules/.bin/c8'),['--all=false','--check-coverage=false',...js.map(file=>'--include='+file),
  '--temp-directory='+out+'/c8','--report-dir='+out+'/coverage','--reporter=json',process.execPath,'--test','--test-concurrency=1',...existing,...own],{allowFailure:true});
assert.ok(counts(final.log).tests>=43);
assert.deepEqual(failures(final.log).filter(name=>!failures(previous.log).includes(name)),[],'No new regressions');
run('suite-health',process.execPath,['--test','--test-concurrency=1',...own.toReversed()]);
const mutantRoot=tree();
const mutants=[
  ['omit-pallet','public/special-stock-purchase-pricing.js','if (quantity === 0) return null;','return null;',[own[0]],true],
  ['wrong-pallet-rate','public/special-stock-purchase-pricing.js',"uom:'EACH',unitPurchaseCost};","uom:'EACH',unitPurchaseCost:40};",[own[0]],true],
  ['discount-pallet','src/special-stock-request-netsuite.js','lines.filter(line => !line.ancillary && Number(line.itemId) !== 1784)','lines',[own[0]],true],
  ['do-not-save-pallet','src/special-stock-request-repository.js','if (pallet) {','if (false) {',[own[2]],false],
  ['omit-browser-pallet','public/scm-special-stock-requests.js','payload.pallet = purchasePalletReview(form);','payload.pallet = {quantity:0,unitPurchaseCost:0};',[own[3]],false],
  ['stale-case-accepted','src/special-stock-request-repository.js',"const special = await lockCase(id, input.expectedRevision);\n    assertNoSpecialQuantityReview(special);\n    const ownUnsubmittedRetry", "const special = await selectCaseRow(id, {forUpdate:true});\n    assertNoSpecialQuantityReview(special);\n    const ownUnsubmittedRetry",[own[2]],false]
];
try {
  for(const [name,file,before,after,tests,property] of mutants) {
    const path=mutantRoot+'/'+file,source=readFileSync(path,'utf8');assert.equal(source.split(before).length,2,name);
    try {
      writeFileSync(path,source.replace(before,after));
      const result=run('mutant-'+name,process.execPath,['--test','--test-concurrency=1',...(property?['--test-name-pattern=^property:']:[]),...tests],{cwd:mutantRoot,allowFailure:true});
      assert.equal(result.status,1,name+' survived');assert.ok(failures(result.log).length,name+' did not fail assertions');
    } finally {writeFileSync(path,source);}
  }
} finally {rmSync(mutantRoot,{recursive:true,force:true});}
run('secrets',process.execPath,['test/support/scan-diff-secrets.mjs',...files,...own,'tools/special-po-pallet-routing-check.mjs']);
assert.deepEqual(Object.fromEntries(files.map(file=>[file,sha(readFileSync(file))])),hashes);
const result={completed:true,...counts(final.log),baselineFailures:failures(previous.log),newFailures:[],
  mutantsKilled:mutants.length,propertyMutantsKilled:3,sourceHashes:hashes,
  tools:{node:process.version,...Object.fromEntries(['typescript','eslint','c8','fast-check','@playwright/test'].map(name=>[name,JSON.parse(readFileSync('node_modules/'+name+'/package.json')).version]))}};
writeFileSync(out+'/checks.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
