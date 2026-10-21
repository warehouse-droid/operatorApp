import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,cpSync,mkdtempSync,symlinkSync,readdirSync,unlinkSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
assert.equal(process.env.MBT_TEST_ISOLATED,'1');assert.ok(process.env.DATABASE_URL.endsWith('/mbt_verify'));
const out='test-artifacts/special-workflow-review/po-approval-reference-20260928';
const runtime=JSON.parse(readFileSync(`${out}/runtime-files.json`)),js=runtime.filter(f=>f.endsWith('.js'));
const own=['unit/special-approval-fulfillment','unit/special-fulfillment-adapter','integration/special-approval-fulfillment','integration/special-approval-http','integration/special-approval-browser'].map(n=>`test/mbt/${n}.test.js`);
const armor=['integration/special-workflow-review','integration/special-workflow-description-race','integration/special-stock-request-workflow.red','integration/special-workflow-closure','integration/special-operation-closure','integration/special-stock-alert-counts','integration/special-workflow-polish-http','unit/special-po-line-discount','unit/special-workflow-quantity-service','unit/special-workflow-polish','unit/special-operation-progress','unit/special-workflow-quantity-transition','unit/special-workflow-rest-orders'].map(n=>`test/mbt/${n}.test.js`);
function run(name,command,args,{failure=false,cwd=process.cwd()}={}) {
 const r=spawnSync(command,args,{cwd,encoding:'utf8',timeout:300000,maxBuffer:20*1024*1024});const log=(r.stdout || '')+(r.stderr || '');writeFileSync(`${out}/${name}.log`,log);
 if(failure)assert.ok(r.status!==0 && /^not ok /m.test(log),`${name} survived`);else assert.equal(r.status,0,`${name}: ${log.slice(-3000)}`);
 console.log(JSON.stringify({check:name,passed:true}));return log;
}
for(const file of js)run('syntax-'+file.split('/').pop(),process.execPath,['--check',file]);
run('types','node_modules/.bin/tsc',['--noEmit','--allowJs','--checkJs','--skipLibCheck','--types','node','--target','ES2022','--module','NodeNext','src/special-stock-rest-orders.js','public/special-stock-workflow.js','src/special-stock-fulfillment-adapter.js','public/special-stock-fulfillment.js']);
run('lint','node_modules/.bin/eslint',['--config','tools/stock-request-layout-eslint.config.mjs','--max-warnings=0',...js.filter(f=>f!=='src/server.js'),...own,'tools/special-approval-check.mjs']);
for(const name of readdirSync(out).filter(n=>n.startsWith('browser-coverage-')))unlinkSync(`${out}/${name}`);
const suite=run('feature-final','node_modules/.bin/c8',['--all=false','--check-coverage=false',...js.map(f=>`--include=${f}`),`--temp-directory=${out}/c8`,`--report-dir=${out}/coverage`,'--reporter=json',process.execPath,'--test','--test-concurrency=1',...armor,...own]);
run('suite-health',process.execPath,['--test','--test-concurrency=1',...own.toReversed()]);
const root=mkdtempSync('/tmp/special-approval-mutants-');for(const folder of ['src','public','test/mbt'])cpSync(folder,`${root}/${folder}`,{recursive:true});
cpSync('package.json',`${root}/package.json`);symlinkSync(resolve('node_modules'),`${root}/node_modules`,'dir');
const mutants=[
 ['public/special-stock-workflow.js','evidence.purchaseOrderApproved === false','evidence.purchaseOrderApproved === true','unit/special-approval-fulfillment',true],
 ['src/special-stock-fulfillment-adapter.js','!same(current.commercial,plan.before.commercial)','false','unit/special-fulfillment-adapter',true],
 ['src/special-stock-planning.js','refs.get(ref(name))',"refs.get(ref(name === detail.purchaseOrderReference ? '' : name))",'unit/special-approval-fulfillment',false],
 ['src/special-stock-request-repository.js',"String(po.dispatch_ref || '') !== input.previousReference",'false','integration/special-approval-fulfillment',false],
 ['src/special-stock-fulfillment-adapter.js','if (!same(current.delivery,plan.target)) {','if (true) {','unit/special-fulfillment-adapter',false]
];
for(const [i,[file,old,replacement,name,property]] of mutants.entries()){
 const path=`${root}/${file}`,source=readFileSync(path,'utf8');assert.equal(source.split(old).length,2);
 try{writeFileSync(path,source.replace(old,replacement));run(`mutant-${i+1}`,process.execPath,['--test',...(property?['--test-name-pattern=^property:']:[]),`test/mbt/${name}.test.js`],{failure:true,cwd:root});}
 finally{writeFileSync(path,source);}assert.equal(readFileSync(file,'utf8'),source);
}
run('secrets',process.execPath,['test/support/scan-diff-secrets.mjs',...runtime,...own,'tools/special-approval-check.mjs']);
const manifest=Object.fromEntries(runtime.map(f=>[f,createHash('sha256').update(readFileSync(f)).digest('hex')]));writeFileSync(`${out}/source-manifest.json`,JSON.stringify(manifest,null,2));
const summary={completed:true,tests:Number(/^# tests (\d+)$/m.exec(suite)?.[1]),pass:Number(/^# pass (\d+)$/m.exec(suite)?.[1]),fail:Number(/^# fail (\d+)$/m.exec(suite)?.[1]),mutantsKilled:mutants.length,propertyMutantsKilled:2,syntax:true,types:true,lint:true,fullRegressionRun:false,backupsRun:false,tools:{node:process.version,...Object.fromEntries(['typescript','eslint','c8','fast-check','playwright'].map(name=>[name,JSON.parse(readFileSync(`node_modules/${name}/package.json`)).version]))}};
writeFileSync(`${out}/checks.json`,JSON.stringify(summary,null,2));console.log(JSON.stringify(summary));run('coverage',process.execPath,['tools/special-approval-coverage.mjs']);
