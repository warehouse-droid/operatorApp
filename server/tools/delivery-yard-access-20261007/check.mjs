import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,openSync,closeSync,readdirSync,rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {runNodeTestFilesIsolated} from '../../test/support/test-database-isolation.mjs';

assert.equal(process.env.MBT_TEST_ISOLATED,'1');
const out='test-artifacts/delivery-yard-access-20261007';mkdirSync(out,{recursive:true});
const mode=process.argv.at(-1);
const focused=[
  'test/mbt/unit/regular-stock-target-yard-access.test.js',
  'test/mbt/unit/regular-stock-delivery-selection.test.js',
  'test/mbt/unit/regular-stock-150-sales.test.js',
  'test/mbt/unit/regular-stock-delivery-simple.test.js',
  'test/mbt/integration/regular-stock-target-yard-access.test.js',
  'test/mbt/integration/regular-stock-150-sales.test.js',
  'test/mbt/integration/regular-stock-delivery-simple.test.js',
  'test/mbt/integration/regular-stock-delivery-simple-http.test.js',
  'test/mbt/integration/regular-stock-delivery-selection-browser.test.js',
  'test/mbt/integration/regular-stock-delivery-progress.test.js'
];
function run(label,args,{allowFailure=false}={}){
  const fd=openSync(out+'/'+label+'.log','w');let result;
  try{result=spawnSync(process.execPath,args,{stdio:['ignore',fd,fd],timeout:1800000});}finally{closeSync(fd);}
  const log=readFileSync(out+'/'+label+'.log','utf8');
  const counts=Object.fromEntries(['tests','pass','fail','skipped'].map(key=>[key,Number(log.match(new RegExp('^# '+key+' (\\d+)$','m'))?.[1]||0)]));
  console.log(JSON.stringify({label,exit:result.status,...counts}));
  writeFileSync(out+'/'+label+'-stage.json',JSON.stringify({label,exit:result.status,...counts},null,2));
  assert.notEqual(result.status,null,'Timeout '+label);
  if(!allowFailure)assert.equal(result.status,0,log.slice(-5000));return {log,...counts};
}
function allFiles(){
  const visit=folder=>readdirSync(folder,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(entry=>
    entry.isDirectory()?visit(folder+'/'+entry.name):/\.test\.(js|mjs)$/.test(entry.name)?[folder+'/'+entry.name]:[]);
  return ['infrastructure','unit','contracts','property','integration','adversarial','concurrency'].flatMap(group=>visit('test/mbt/'+group));
}
function componentFiles(){
  return allFiles().filter(file=>/\/(regular-stock|stock-request|sales-stock|regular-waitlist|stocking|backorder)[^/]*\.(?:test|property)\.[jm]s$/.test(file)
    && !file.includes('browser') && !focused.includes(file));
}
function staticChecks(){
  const runtime=JSON.parse(readFileSync('tools/delivery-yard-access-20261007/files.json'));
  run('types',['node_modules/typescript/bin/tsc','--allowJs','--checkJs','false','--noEmit','--strict','--module','NodeNext',
    '--moduleResolution','NodeNext','--target','ES2023','--skipLibCheck','--types','node',
    'src/regular-stock-delivery-access.js','src/regular-stock-delivery-domain.js']);
  run('lint',['node_modules/eslint/bin/eslint.js','--config','tools/delivery-yard-access-20261007/eslint.config.mjs','--max-warnings=0',
    ...runtime.filter(file=>file.endsWith('.js')),...focused,
    'tools/delivery-yard-access-20261007/check.mjs','tools/delivery-yard-access-20261007/coverage.mjs','tools/delivery-yard-access-20261007/mutations.mjs',
    'tools/delivery-yard-access-20261007/verify-live.mjs']);
  run('secrets',['test/support/scan-diff-secrets.mjs',...runtime,...focused]);
  for(const file of runtime){
    const diff=spawnSync('diff',['-U0','tools/delivery-yard-access-20261007/baseline/'+file,file],{encoding:'utf8'}).stdout;
    assert.ok(!diff.split('\n').some(line=>line.startsWith('+')&&!line.startsWith('+++')&&/[ \t]+$/.test(line)),file+' has trailing whitespace');
  }
}
function coverage(){
  rmSync(out+'/coverage',{recursive:true,force:true});rmSync(out+'/c8',{recursive:true,force:true});rmSync(out+'/browser',{recursive:true,force:true});
  run('coverage',['node_modules/c8/bin/c8.js','--all=false','--check-coverage=false',
    '--include=src/regular-stock-delivery-access.js','--include=src/regular-stock-delivery-domain.js',
    '--include=src/regular-stock-delivery.js','--include=src/stock-request-repository.js',
    '--temp-directory='+out+'/c8','--report-dir='+out+'/coverage','--reporter=json','--reporter=json-summary',
    process.execPath,'--test','--test-concurrency=1',...focused]);
  run('changed-coverage',['tools/delivery-yard-access-20261007/coverage.mjs']);
}
function counts(log){
  const result={tests:0,pass:0,fail:0,skipped:0,failures:[]};
  for(const key of ['tests','pass','fail','skipped'])result[key]=[...log.matchAll(new RegExp('^[ℹ#] '+key+' (\\d+)$','gm'))].reduce((total,match)=>total+Number(match[1]),0);
  let file='';
  for(const line of log.split('\n')){
    const boundary=line.match(/^\[isolation\].*? ((?:\/app\/)?test\/mbt\/.*)$/);if(boundary)file=boundary[1].replace(/^\/app\//,'');
    const failure=line.match(/^✖ (.+?) \([\d.]+ms\)/);if(failure)result.failures.push(file+': '+failure[1]);
    const timeout=line.match(/^\[gauntlet-timeout\] (.+)$/);if(timeout)result.failures.push(timeout[1]+': stalled isolated test process');
  }
  result.failures=[...new Set(result.failures)].sort();return result;
}
if(mode==='selection-red')run(mode,['--test','--test-concurrency=1',focused[1],focused[4]],{allowFailure:true});
else if(mode==='focused')run(mode,['--test','--test-concurrency=1',...focused]);
else if(mode==='baseline'){
  const files=allFiles().filter(file=>!/^regular-stock-(target-yard-access|delivery-selection)/.test(file.split('/').at(-1)));
  const exit=await runNodeTestFilesIsolated(files,{label:'Delivery baseline'});process.exitCode=exit;
}
else if(mode==='component-baseline'){
  const files=componentFiles();writeFileSync(out+'/component-baseline-files.json',JSON.stringify(files,null,2));
  process.exitCode=await runNodeTestFilesIsolated(files,{label:'Stock-request baseline'});
}
else if(mode==='static')staticChecks();
else if(mode==='mutations')run('mutations',['tools/delivery-yard-access-20261007/mutations.mjs']);
else if(mode==='coverage')coverage();
else if(mode==='final'||mode==='finish'||mode==='gauntlet'){
  rmSync(out+'/coverage',{recursive:true,force:true});rmSync(out+'/c8',{recursive:true,force:true});rmSync(out+'/browser',{recursive:true,force:true});
  let baseline,candidate;
  if(mode==='gauntlet'){
    const files=componentFiles();
    assert.deepEqual(files,JSON.parse(readFileSync(out+'/component-baseline-files.json')));
    console.log(JSON.stringify({componentFiles:files.length}));
    await runNodeTestFilesIsolated(files,{label:'Stock-request candidate'});
    baseline=counts(readFileSync(out+'/component-baseline-runner.log','utf8'));
    candidate=counts(readFileSync(out+'/gauntlet-runner.log','utf8'));
  }else{
    if(mode==='final')run('full-final',['test/support/run-node-tests.mjs','infrastructure','unit','contracts','property','integration','adversarial','concurrency'],{allowFailure:true});
    else {
      const original=JSON.parse(readFileSync(out+'/full-source.json'));
      assert.ok(Object.entries(original.manifest).every(([file,identity])=>createHash('sha256').update(readFileSync(file)).digest('hex')===identity.hash),'Runtime changed after full run');
    }
    baseline=counts(readFileSync(out+'/baseline-runner.log','utf8'));candidate=counts(readFileSync(out+'/full-final.log','utf8'));
  }
  const newFailures=candidate.failures.filter(failure=>!baseline.failures.includes(failure));
  writeFileSync(out+'/regression.json',JSON.stringify({baseline,candidate,newFailures},null,2));assert.deepEqual(newFailures,[]);
  run('focused-final',['--test','--test-concurrency=1',...focused]);
  run('coverage',['node_modules/c8/bin/c8.js','--all=false','--check-coverage=false',
    '--include=src/regular-stock-delivery-access.js','--include=src/regular-stock-delivery-domain.js',
    '--include=src/regular-stock-delivery.js','--include=src/stock-request-repository.js',
    '--temp-directory='+out+'/c8','--report-dir='+out+'/coverage','--reporter=json','--reporter=json-summary',
    process.execPath,'--test','--test-concurrency=1',...focused]);
  staticChecks();run('changed-coverage',['tools/delivery-yard-access-20261007/coverage.mjs']);
  run('mutations',['tools/delivery-yard-access-20261007/mutations.mjs']);
  run('reversed',['--test','--test-concurrency=1',...focused.toReversed()]);
  const runtime=JSON.parse(readFileSync('tools/delivery-yard-access-20261007/files.json'));
  const hash=value=>createHash('sha256').update(value).digest('hex');
  const manifest=Object.fromEntries(runtime.map(file=>[file,hash(readFileSync(file))]));
  const evidence={specApproval:'not obtained (autonomous run)',manifest,sourceHash:hash(JSON.stringify(manifest)),
    specHash:hash(readFileSync('tools/delivery-yard-access-20261007/spec.json')),
    testManifest:Object.fromEntries([...focused,...componentFiles()].map(file=>[file,hash(readFileSync(file))])),
    acceptance:{allSalesBothDirections:[focused[0],focused[4],focused[5],focused[8]],
      restrictedOtherRoutesAndMethods:[focused[0],focused[2],focused[4],focused[7]],
      authenticatedActiveSales:[focused[4],focused[5],focused[7],focused[9]],
      selectedLineIdentityAndImmutableOrder:[focused[1],focused[4]],
      shortageAndEmptySelection:[focused[4],focused[8]],
      duplicateSubmitRetryAndReload:[focused[4],focused[8],focused[9]]},
    dependencyLockHash:hash(readFileSync('package-lock.json')),focused:JSON.parse(readFileSync(out+'/focused-final-stage.json')),
    baseline,candidate,newFailures,types:'pass',lint:'pass',secrets:'pass',
    changedLines:JSON.parse(readFileSync(out+'/changed-coverage.json')),mutations:JSON.parse(readFileSync(out+'/mutations.json')),
    toolchain:{node:process.version,...Object.fromEntries(['typescript','eslint','c8','fast-check','@playwright/test'].map(name=>[name,JSON.parse(readFileSync('node_modules/'+name+'/package.json')).version]))},
    knownLimits:['Synthetic boundary for NetSuite/printer side effects; live production verification is read-only.',
      'Completed the non-browser stock-request component regression suite; existing baseline failures retained in regression.json with zero new failures.',
      'Whole-repository baseline/candidate runs were interrupted after the user expanded Sales access; partial logs retained. Unrelated browser stalls prevent claiming a complete repository-wide pass. Focused real-browser coverage includes desktop and mobile, unrelated and unassigned Sales accounts.',
      'Properties independently kill authorization and subset-selection mutants; SQL, service and UI mutations use matrix, integration and browser assertions.',
      'No dependency changes; dependency audit not repeated.']};
  writeFileSync(out+'/evidence.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify({focused:evidence.focused,newFailures:0,changedLines:evidence.changedLines.covered,mutations:evidence.mutations.length,sourceHash:evidence.sourceHash}));
}
else throw new Error('Unknown check mode '+mode);
