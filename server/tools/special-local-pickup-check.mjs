import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,cpSync,mkdtempSync,symlinkSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
assert.equal(process.env.MBT_TEST_ISOLATED,'1');assert.ok(process.env.DATABASE_URL.endsWith('/mbt_verify'));
const out='test-artifacts/special-workflow-review/local-pickup-20260928';
const runtime=JSON.parse(readFileSync(out+'/runtime-files.json'));
const suiteFiles=['unit/special-local-pickup','integration/special-approval-fulfillment','unit/special-fulfillment-adapter','integration/special-approval-http','unit/special-approval-fulfillment','integration/special-workflow-description-race'].map(n=>'test/mbt/'+n+'.test.js');
function run(name,command,args,{failure=false,cwd=process.cwd()}={}) {
 const result=spawnSync(command,args,{cwd,encoding:'utf8',timeout:60000,maxBuffer:20*1024*1024});
 const log=(result.stdout||'')+(result.stderr||'');writeFileSync(out+'/'+name+'.log',log);
 if(failure) assert.ok(result.status!==0 && /^not ok /m.test(log),name+' survived');
 else assert.equal(result.status,0,name+': '+log.slice(-4000));
 console.log(JSON.stringify({check:name,passed:true}));return log;
}
for(const file of runtime)run('syntax-'+file.split('/').at(-1),process.execPath,['--check',file]);
run('types','node_modules/.bin/tsc',['--noEmit','--allowJs','--checkJs','--skipLibCheck','--types','node','--target','ES2022','--module','NodeNext','src/special-stock-fulfillment-policy.js']);
run('lint','node_modules/.bin/eslint',['--config','tools/stock-request-layout-eslint.config.mjs','--max-warnings=0',...runtime,'test/mbt/unit/special-local-pickup.test.js','test/mbt/integration/special-approval-fulfillment.test.js','tools/special-local-pickup-check.mjs']);
for(const dir of ['c8','coverage'])rmSync(out+'/'+dir,{recursive:true,force:true});
const suite=run('feature-final','node_modules/.bin/c8',['--all=false','--check-coverage=false',...runtime.map(f=>'--include='+f),'--temp-directory='+out+'/c8','--report-dir='+out+'/coverage','--reporter=json',process.execPath,'--test','--test-concurrency=1',...suiteFiles]);
run('suite-health',process.execPath,['--test','--test-concurrency=1',...suiteFiles.toReversed()]);
const root=mkdtempSync('/tmp/special-local-pickup-mutants-');
for(const folder of ['src','public','test/mbt'])cpSync(folder,root+'/'+folder,{recursive:true});
cpSync('package.json',root+'/package.json');symlinkSync(resolve('node_modules'),root+'/node_modules','dir');
const mutants=[
 ['src/special-stock-fulfillment-policy.js','!savedPlan && pickup(fromMethod)','pickup(fromMethod)','unit/special-local-pickup'],
 ['src/special-stock-fulfillment-policy.js','pickup(fromMethod) && pickup(toMethod)','(pickup(fromMethod) || pickup(toMethod))','unit/special-local-pickup'],
 ['src/special-stock-fulfillment.js','detail.salesOrderId && !isLocalPickupChange(detail.fulfillmentMethod,change.target.fulfillmentMethod,detail.fulfillmentChangePlan)','detail.salesOrderId','integration/special-approval-fulfillment'],
 ['src/special-stock-request-repository.js','if (!localPickup) {','if (true) {','integration/special-approval-fulfillment'],
 ['src/special-stock-request-repository.js','await assertFulfillmentUnplanned(special);\n    const localPickup=','const localPickup=','integration/special-approval-fulfillment']
];
try {
 for(const [index,[file,old,replacement,tests]] of mutants.entries()) {
  const path=root+'/'+file,source=readFileSync(path,'utf8');assert.equal(source.split(old).length,2);
  try {writeFileSync(path,source.replace(old,replacement));run('mutant-'+(index+1),process.execPath,['--test','test/mbt/'+tests+'.test.js'],{failure:true,cwd:root});}
  finally {writeFileSync(path,source);}
  assert.equal(readFileSync(file,'utf8'),source,'Source drift');
 }
} finally {rmSync(root,{recursive:true,force:true});}
run('secrets',process.execPath,['test/support/scan-diff-secrets.mjs',...runtime,'test/mbt/unit/special-local-pickup.test.js','test/mbt/integration/special-approval-fulfillment.test.js','tools/special-local-pickup-check.mjs']);
writeFileSync(out+'/source-manifest.json',JSON.stringify(Object.fromEntries(runtime.map(f=>[f,createHash('sha256').update(readFileSync(f)).digest('hex')])),null,2)+'\n');
const summary={completed:true,tests:Number(/^# tests (\d+)$/m.exec(suite)?.[1]),pass:Number(/^# pass (\d+)$/m.exec(suite)?.[1]),fail:Number(/^# fail (\d+)$/m.exec(suite)?.[1]),mutantsKilled:mutants.length,propertyMutantsKilled:2,syntax:true,types:true,lint:true,fullRegressionRun:false,backupsRun:false,tools:{node:process.version,...Object.fromEntries(['typescript','eslint','c8','fast-check'].map(name=>[name,JSON.parse(readFileSync('node_modules/'+name+'/package.json')).version]))}};
writeFileSync(out+'/checks.json',JSON.stringify(summary,null,2)+'\n');
run('coverage',process.execPath,['tools/special-local-pickup-coverage.mjs','--require-complete']);console.log(JSON.stringify(summary));
