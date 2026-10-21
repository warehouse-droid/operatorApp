import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,cpSync,mkdtempSync,symlinkSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {ESLint} from 'eslint';

assert.equal(process.env.MBT_TEST_ISOLATED,'1');
assert.equal(new URL(process.env.DATABASE_URL).hostname,'mbbs-special-review-db');
const out=resolve('test-artifacts/scm-po-text-refs-20260930');
mkdirSync(out,{recursive:true});
const files=JSON.parse(readFileSync('tools/scm-po-text-refs-files.json'));
const js=files.filter(file=>file.endsWith('.js'));
const suites=[
  'test/mbt/unit/scm-schedule-remarks.red.test.js',
  'test/mbt/property/scm-schedule-remarks.property.test.js',
  'test/mbt/unit/special-po-routing.test.js',
  'test/mbt/unit/special-po-pallet.test.js',
  'test/mbt/integration/scm-po-text.test.js',
  'test/mbt/integration/special-po-routing-browser.test.js',
  'test/mbt/integration/special-po-pallet.test.js',
  'test/mbt/integration/scm-schedule-status-concurrency.test.js'
];
const hash=source=>createHash('sha256').update(source).digest('hex');
const hashes=Object.fromEntries(files.map(file=>[file,hash(readFileSync(file))]));
const statuses={};
function run(label,command,args,{cwd=process.cwd(),diagnostics=false}={}) {
  const result=spawnSync(command,args,{cwd,encoding:'utf8',timeout:180000,maxBuffer:30000000,
    env:{...process.env,SPECIAL_BATCH_BROWSER_OUTPUT:out+'/browser'}});
  const log=(result.stdout||'')+(result.stderr||'');
  writeFileSync(out+'/'+label+'.log',log);
  statuses[label]=result.status;
  assert.ok(result.status===0 || diagnostics && [1,2].includes(result.status),label+': '+log.slice(-4000));
  console.log(JSON.stringify({label,exitCode:result.status}));
  return log;
}
const baseline=mkdtempSync('/tmp/scm-po-text-baseline-');
try {
  for(const folder of ['src','public'])cpSync(folder,baseline+'/'+folder,{recursive:true});
  for(const file of ['package.json','netsuite-smart-scm-picking-ticket-restlet.js'])cpSync(file,baseline+'/'+file);
  symlinkSync(resolve('node_modules'),baseline+'/node_modules','dir');
  for(const file of js)cpSync(out+'/before/'+file,baseline+'/'+file);
  for(const file of js)run('syntax-'+file.split('/').at(-1),process.execPath,['--check',file]);
  const typeArgs=['--noEmit','--allowJs','--checkJs','--skipLibCheck','--types','node','--target','ES2022','--module','NodeNext',...js];
  const types=log=>log.split('\n').filter(line=>/error TS\d+/.test(line)).map(line=>line.replace(/\(\d+,\d+\)/g,'(location)')).sort();
  const oldTypes=types(run('types-before',resolve('node_modules/.bin/tsc'),typeArgs,{cwd:baseline,diagnostics:true}));
  const newTypes=types(run('types-after',resolve('node_modules/.bin/tsc'),typeArgs,{diagnostics:true}));
  const remaining=[...oldTypes];
  const added=newTypes.filter(line=>{const i=remaining.indexOf(line);if(i<0)return true;remaining.splice(i,1);return false;});
  assert.deepEqual(added,[],'No new type diagnostics');
  const lint=new ESLint({overrideConfigFile:resolve('tools/stock-request-layout-eslint.config.mjs')});
  const messages=async(source,file)=>(await lint.lintText(source,{filePath:file}))[0].messages.map(({ruleId,severity,message})=>JSON.stringify({ruleId,severity,message}));
  for(const file of js) {
    const previous=await messages(readFileSync(baseline+'/'+file,'utf8'),file);
    const current=await messages(readFileSync(file,'utf8'),file);
    assert.deepEqual(current.filter(message=>{const i=previous.indexOf(message);if(i<0)return true;previous.splice(i,1);return false;}),[],file+' has new lint findings');
  }
  run('lint-tests',resolve('node_modules/.bin/eslint'),['--config','tools/stock-request-layout-eslint.config.mjs','--max-warnings=0',
    'test/mbt/integration/scm-po-text.test.js','test/mbt/integration/special-po-routing-browser.test.js','tools/scm-po-text-refs-check.mjs']);
} finally {rmSync(baseline,{recursive:true,force:true});}
const log=run('final-tests',process.execPath,['--test','--test-concurrency=1',...suites]);
const counts=Object.fromEntries(['tests','pass','fail','skipped'].map(key=>[key,Number(log.match(new RegExp(`^# ${key} (\\d+)$`,'m'))?.[1])]));
assert.equal(counts.tests,34);assert.equal(counts.fail,0);assert.equal(counts.skipped,0);
const remarkBefore=run('shared-remark-before',process.execPath,['tools/scm-po-text-refs-harness.mjs','--baseline'],{diagnostics:true});
const remarkAfter=run('shared-remark',process.execPath,['tools/scm-po-text-refs-harness.mjs'],{diagnostics:true});
const existingFailure='AssertionError [ERR_ASSERTION]: Missing expected rejection.';
assert.ok(statuses['shared-remark']===0 || statuses['shared-remark-before']===1 && statuses['shared-remark']===1
  && remarkBefore.includes(existingFailure) && remarkAfter.includes(existingFailure),'No new shared-remark harness failure');
run('dispatch-note',process.execPath,['src/scm-dispatch-assignment-harness.js']);
run('secrets',process.execPath,['test/support/scan-diff-secrets.mjs',...files,
  'test/mbt/unit/scm-schedule-remarks.red.test.js','test/mbt/integration/scm-po-text.test.js',
  'test/mbt/integration/special-po-routing-browser.test.js','tools/scm-po-text-refs-check.mjs','tools/scm-po-text-refs-run.py','tools/scm-po-text-refs-harness.mjs']);
assert.deepEqual(Object.fromEntries(files.map(file=>[file,hash(readFileSync(file))])),hashes);
const result={completed:true,...counts,newTypeDiagnostics:0,newLintFindings:0,sharedRemarkHarness:statuses['shared-remark']===0,
  baselineHarnessFailures:statuses['shared-remark-before']===1?[existingFailure]:[],newFailures:[],dispatchNoteHarness:true,sourceHashes:hashes,
  tools:{node:process.version,...Object.fromEntries(['typescript','eslint','@playwright/test'].map(name=>[name,JSON.parse(readFileSync('node_modules/'+name+'/package.json')).version]))}};
writeFileSync(out+'/checks.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result));
