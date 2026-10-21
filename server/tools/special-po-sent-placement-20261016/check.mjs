import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {openSync,closeSync} from 'node:fs';
import {ESLint} from 'eslint';

assert.equal(process.env.MBT_TEST_ISOLATED,'1');
const files=['public/scm-special-stock-requests.js','public/special-stock-case-status.js'];
const checks=[];
const eslint=new ESLint({overrideConfigFile:'tools/regular-stock-v2-eslint.config.mjs'});
const diagnostics=results=>results.flatMap(result=>result.messages.map(({ruleId,severity,message})=>JSON.stringify({ruleId,severity,message})));
for(const file of files) {
  const result=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  const baseline=diagnostics(await eslint.lintText(await readFile('/release/before/'+file,'utf8'),{filePath:file}));
  const added=diagnostics(await eslint.lintFiles([file])).filter(message=>{
    const i=baseline.indexOf(message);if(i<0)return true;baseline.splice(i,1);return false;
  });
  assert.deepEqual(added,[],file);
}
checks.push({name:'syntax-and-lint',passed:true,files});
const tests=[
  'unit/special-planning-arrival.test.js',
  'unit/special-stock-updates.test.js',
  'unit/special-workflow-closure.test.js',
  'unit/special-logistics-progress.test.js',
  'unit/special-approval-fulfillment.test.js',
  'unit/special-status-following.test.js',
  'integration/special-vendor-confirmation.test.js'
].map(name=>'test/mbt/'+name);
const fd=openSync('test-artifacts/tests.log','w');let result;
try{result=spawnSync(process.execPath,['--test','--test-concurrency=1',...tests],{stdio:['ignore',fd,fd],timeout:300000});}finally{closeSync(fd);}
const log=await readFile('test-artifacts/tests.log','utf8');
const count=key=>Number(log.match(new RegExp('^# '+key+' (\\d+)$','m'))?.[1]||0);
checks.push({name:'workflow-and-browser',exitCode:result.status,tests:count('tests'),passed:count('pass'),failed:count('fail')});
const passed=result.status===0&&result.signal===null&&count('fail')===0&&count('tests')>0;
await writeFile('test-artifacts/report.json',JSON.stringify({passed,checks},null,2));
console.log(JSON.stringify({passed,checks}));
if(!passed)console.error(log.slice(-10000));
assert.ok(passed);
