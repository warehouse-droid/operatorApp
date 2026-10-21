import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,cpSync,mkdtempSync,symlinkSync,rmSync,readdirSync,unlinkSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {ESLint} from 'eslint';
assert.equal(process.env.MBT_TEST_ISOLATED,'1');assert.ok(process.env.DATABASE_URL.endsWith('/mbt_verify'));
const out='test-artifacts/special-workflow-review/request-enhancements-20260928';
const runtime=JSON.parse(readFileSync(out+'/runtime-files.json')),js=runtime.filter(f=>f.endsWith('.js'));
const own=['unit/special-request-enhancements','unit/special-expiry-runtime','integration/special-request-enhancements','integration/special-expiry-race','integration/special-enhancements-http','integration/special-enhancements-browser','integration/special-sales-alert-browser'].map(n=>'test/mbt/'+n+'.test.js');
const related=['unit/special-stock-request-domain.red','unit/special-purchase-discount-reps','unit/special-stock-request-service.red','unit/special-workflow-rest-orders','unit/special-workflow-documents','integration/special-approval-browser','integration/special-workflow-pricing','integration/special-stock-alert-http','integration/special-stock-request-http.red'].map(n=>'test/mbt/'+n+'.test.js');
function run(name,command,args,{failure=false,cwd=process.cwd()}={}) {
 const result=spawnSync(command,args,{cwd,encoding:'utf8',timeout:60000,maxBuffer:25*1024*1024});
 const log=(result.stdout||'')+(result.stderr||'');writeFileSync(out+'/'+name+'.log',log);
 if(failure)assert.ok(result.status!==0 && /^not ok /m.test(log),name+' survived');else assert.equal(result.status,0,name+': '+log.slice(-6000));
 console.log(JSON.stringify({check:name,passed:true}));return log;
}
for(const file of js)run('syntax-'+file.split('/').at(-1),process.execPath,['--check',file]);
run('types','node_modules/.bin/tsc',['--noEmit','--allowJs','--checkJs','--skipLibCheck','--types','node','--target','ES2022','--module','NodeNext','public/special-stock-expiry.js','public/special-stock-line-details.js','public/stock-request-vendor-filter.js','src/special-stock-rest-orders.js']);
run('lint','node_modules/.bin/eslint',['--config','tools/stock-request-layout-eslint.config.mjs','--max-warnings=0',...js.filter(f=>f!=='src/server.js'),...own,'tools/special-enhancements-check.mjs']);
const lint=new ESLint({overrideConfigFile:'tools/stock-request-layout-eslint.config.mjs'});
const messages=async source=>(await lint.lintText(source,{filePath:'src/server.js'}))[0].messages.map(({ruleId,severity,message})=>({ruleId,severity,message}));
const baseline=await messages(readFileSync(out+'/baseline/src/server.js','utf8')),current=await messages(readFileSync('src/server.js','utf8'));
assert.deepEqual(current,baseline);writeFileSync(out+'/server-lint.json',JSON.stringify({existing:baseline.length,new:0}));
run('migration',process.execPath,['tools/special-enhancements-migrate.mjs']);
for(const dir of ['c8','coverage'])rmSync(out+'/'+dir,{recursive:true,force:true});
for(const file of readdirSync(out).filter(f=>f.startsWith('browser-coverage-')))unlinkSync(out+'/'+file);
const suite=run('feature-final','node_modules/.bin/c8',['--all=false','--check-coverage=false',...js.map(f=>'--include='+f),'--temp-directory='+out+'/c8','--report-dir='+out+'/coverage','--reporter=json',process.execPath,'--test','--test-concurrency=1',...own,...related]);
const selectedHttp=run('request-http-contract',process.execPath,['--test','--test-name-pattern=new enquiry|yard queue HTTP','test/mbt/integration/special-workflow-pricing-http.test.js']);
run('suite-health',process.execPath,['--test','--test-concurrency=1',...own.toReversed()]);
const root=mkdtempSync('/tmp/special-enhancement-mutants-');for(const folder of ['src','public','test/mbt','migrations'])cpSync(folder,root+'/'+folder,{recursive:true});
cpSync('package.json',root+'/package.json');symlinkSync(resolve('node_modules'),root+'/node_modules','dir');
const mutants=[
 ['src/special-stock-request-repository.js','special.expires_on < $1::date','special.expires_on <= $1::date','integration/special-request-enhancements',false],
 ['src/special-stock-alerts.js','request.requested_by=$1 AND request.destination_location_id',"($1::text IS NOT NULL) AND request.destination_location_id",'integration/special-request-enhancements',false],
 ['src/special-stock-request-service.js','customerId: detail.netsuiteCustomerId || detail.customerId,','customerId: detail.customerId,','unit/special-stock-request-service.red',false],
 ['public/special-stock-line-details.js','payload[native] = value;','payload[native] = 0;','unit/special-request-enhancements',true],
 ['public/special-stock-expiry.js','date.getUTCMonth() + 1','date.getUTCMonth() + 2','unit/special-request-enhancements',true],
 ['src/special-stock-rest-orders.js','const payload = { line: Number(source.line) };','const payload = { line: Number(source.line), custcol_plt: 0 };','unit/special-workflow-rest-orders',false]
];
try{for(const [index,[file,old,replacement,tests,property]] of mutants.entries()){
 const path=root+'/'+file,source=readFileSync(path,'utf8');assert.equal(source.split(old).length,2);
 try{writeFileSync(path,source.replace(old,replacement));run('mutant-'+(index+1),process.execPath,['--test',...(property?['--test-name-pattern=^property:']:[]),'test/mbt/'+tests+'.test.js'],{failure:true,cwd:root});}
 finally{writeFileSync(path,source);}assert.equal(readFileSync(file,'utf8'),source,'Source drift');
}}finally{rmSync(root,{recursive:true,force:true});}
run('secrets',process.execPath,['test/support/scan-diff-secrets.mjs',...runtime,...own,'tools/special-enhancements-check.mjs']);
writeFileSync(out+'/source-manifest.json',JSON.stringify(Object.fromEntries(runtime.map(f=>[f,createHash('sha256').update(readFileSync(f)).digest('hex')])),null,2));
const summary={completed:true,tests:Number(/^# tests (\d+)$/m.exec(suite)?.[1])+Number(/^# pass (\d+)$/m.exec(selectedHttp)?.[1]),pass:Number(/^# pass (\d+)$/m.exec(suite)?.[1])+Number(/^# pass (\d+)$/m.exec(selectedHttp)?.[1]),fail:Number(/^# fail (\d+)$/m.exec(suite)?.[1]),mutantsKilled:mutants.length,propertyMutantsKilled:2,syntax:true,types:true,lint:true,fullRegressionRun:false,backupsRun:false,tools:{node:process.version,...Object.fromEntries(['typescript','eslint','c8','fast-check','playwright'].map(name=>[name,JSON.parse(readFileSync('node_modules/'+name+'/package.json')).version]))}};
run('coverage',process.execPath,['tools/special-enhancements-coverage.mjs']);writeFileSync(out+'/checks.json',JSON.stringify(summary,null,2));console.log(JSON.stringify(summary));
