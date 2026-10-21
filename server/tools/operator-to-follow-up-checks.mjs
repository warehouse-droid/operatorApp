import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {cp,mkdir,readFile,readdir,symlink,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';

const out='/app/test-artifacts/operator-to-follow-up-20261013';
const prepared=JSON.parse(await readFile(`${out}/prepared.json`,'utf8'));
const phase=process.argv[2]||'all';
assert.ok(['all','mutations','supplement','worker'].includes(phase));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
for(const [file,expected] of Object.entries(prepared.sourceHashes)) assert.equal(sha(await readFile('/app/'+file)),expected,file);
const root=`/tmp/operator-to-follow-up-${process.pid}`;
await mkdir(root,{recursive:true});
await cp('/app/test',root+'/test',{recursive:true});
await symlink('/app/tools',root+'/tools');
for(const name of ['src','public','migrations','contracts','data']) await symlink('/app/'+name,root+'/'+name);
for(const name of ['package.json','package-lock.json','.env.example','Dockerfile','Dockerfile.test','eslint.mbt.config.js','tsconfig.mbt.json']) await symlink('/app/'+name,root+'/'+name);
for(const name of await readdir('/app')) if(name.endsWith('.js')&&name!=='eslint.mbt.config.js') await symlink('/app/'+name,root+'/'+name);
await mkdir(root+'/node_modules');
const packages=new Set();
for(const from of ['/app/node_modules','/test-toolchain/node_modules']) for(const name of await readdir(from)) {
  if(name.startsWith('.')) continue;
  if(name.startsWith('@')) {
    await mkdir(root+'/node_modules/'+name,{recursive:true});
    for(const child of await readdir(from+'/'+name)) {
      const key=name+'/'+child;
      if(!packages.has(key)){await symlink(from+'/'+key,root+'/node_modules/'+key);packages.add(key);}
    }
  }else if(!packages.has(name)){await symlink(from+'/'+name,root+'/node_modules/'+name);packages.add(name);}
}
let results={};
if(!['all','worker'].includes(phase)) {
  const core=JSON.parse(await readFile(`${out}/checks.core.json`,'utf8'));
  assert.equal(core.imageId,prepared.imageId);assert.deepEqual(core.sourceHashes,prepared.sourceHashes);
  for(const [name,hash] of Object.entries(core.logHashes)) assert.equal(sha(await readFile(`${out}/${name}.log`)),hash,name);
  results={...core.results};
}
if(phase==='supplement') {
  const previousChecks=JSON.parse(await readFile(`${out}/checks.json`,'utf8'));
  assert.deepEqual(previousChecks.sourceHashes,prepared.sourceHashes);
  results={...previousChecks.results};
}
async function run(name,args,{cwd=root,expected=0,timeout=240000}={}) {
  const r=spawnSync(process.execPath,args,{cwd,encoding:'utf8',timeout,maxBuffer:24*1024*1024,env:process.env});
  const output=(r.stdout||'')+(r.stderr||'');
  results[name]={exit:r.status,signal:r.signal};
  for(const [,key,value] of output.matchAll(/^(?:ℹ|#) (tests|pass|fail|skipped) (\d+)$/gmu)) results[name][key]=(results[name][key]||0)+Number(value);
  await writeFile(`${out}/${name}.log`,output);console.log(JSON.stringify({stage:name,...results[name]}));
  if(expected===0) {
    if(r.status!==0) process.stderr.write(output.slice(-7000));
    assert.equal(r.status,0,name);
  }else{
    assert.equal(r.status,1,name+' must fail behavioral assertions');assert.ok(results[name].fail>0);
    assert.ok(!/ERR_MODULE_NOT_FOUND|SyntaxError:|relation .* does not exist|password authentication failed/.test(output),name+' infrastructure failure');
  }
}
const previous=JSON.parse(await readFile('/app/test-artifacts/operator-direct-yard-visibility/checks.json','utf8'));
const tests=[...new Set([...previous.tests,'test/mbt/integration/operator-netsuite-received-to.test.js',
  'test/mbt/unit/operator-transfer-completion.test.js','test/mbt/integration/scm-reconcile-review-automation.red.test.js',
  'test/dispatch/unit/scm-reconcile-review-policy.test.js','test/dispatch/property/scm-reconcile-review-automation.property.test.js',
  'test/mbt/integration/operator-to-legacy-receiving.test.js','test/mbt/integration/operator-receiving-completed.test.js'])];
if(phase==='worker') {
  await run('worker-backend-regressions',['--test','--test-concurrency=1',
    'test/mbt/unit/linked-direct-ship-sync.test.js','test/mbt/integration/linked-direct-ship-sync.test.js',
    'test/mbt/integration/operator-netsuite-received-to.test.js','test/mbt/integration/scm-reconcile-review-automation.red.test.js',
    'test/dispatch/unit/scm-reconcile-review-policy.test.js','test/dispatch/property/scm-reconcile-review-automation.property.test.js']);
  await writeFile(`${out}/checks.worker.json`,JSON.stringify({imageId:prepared.workerImageId,sourceHashes:prepared.sourceHashes,
    results,productionDependenciesUsed:true,node:process.version},null,2)+'\n');
  console.log('Worker backend checks passed');
  process.exit(0);
}
if(phase==='supplement') {
  await run('saved-key-supplement',['/test-toolchain/node_modules/c8/bin/c8.js','--reporter=json',
    '--include=**/src/delivery-repository.js','--src=/app','--allow-external','--reports-dir='+out+'/coverage-supplement',
    process.execPath,'--test','--test-concurrency=1','test/mbt/integration/operator-netsuite-received-to.test.js']);
}
if(phase==='all') {
  await run('operator-and-review-regressions',['/test-toolchain/node_modules/c8/bin/c8.js','--reporter=json','--reporter=text-summary',
    ...Object.keys(prepared.sourceHashes).map(file=>'--include=**/'+file),'--src=/app','--allow-external',
    '--reports-dir='+out+'/coverage',process.execPath,'--test','--test-concurrency=1',...tests]);
  await run('scm-reconciliation-harness',['src/scm-reconciliation-repository-harness.js']);
  await run('mbr-regressions',['--test','--test-concurrency=1',...['domain','properties','security','repository','http','runtime'].map(name=>`test/mbr/${name}.test.js`)]);
  for(const file of Object.keys(prepared.sourceHashes)) await run('syntax-'+file.split('/').at(-1),['--check','/app/'+file]);
  await run('new-module-types',['/test-toolchain/node_modules/typescript/bin/tsc','--noEmit','--allowJs','--checkJs','--strict',
    '--skipLibCheck','--target','ES2022','--module','NodeNext','--types','node','/app/src/operator-transfer-completion.js']);
  const {ESLint}=await import('/test-toolchain/node_modules/eslint/lib/api.js');
  const eslint=new ESLint({overrideConfigFile:true,overrideConfig:[{languageOptions:{ecmaVersion:'latest',sourceType:'module',globals:{String:'readonly',TypeError:'readonly'}},
    rules:{'no-undef':'error','no-unused-vars':'error','no-unreachable':'error','no-dupe-args':'error','no-constant-condition':'error',complexity:['error',8]}}]});
  const lint=await eslint.lintText(await readFile('/app/src/operator-transfer-completion.js','utf8'),{filePath:'operator-transfer-completion.js'});
  assert.ok(lint.every(r=>!r.errorCount&&!r.warningCount));await writeFile(`${out}/lint.json`,JSON.stringify(lint,null,2));results.lint={exit:0};
  const logHashes={};for(const name of Object.keys(results).filter(name=>name!=='lint')) logHashes[name]=sha(await readFile(`${out}/${name}.log`));
  await writeFile(`${out}/checks.core.json`,JSON.stringify({imageId:prepared.imageId,sourceHashes:prepared.sourceHashes,results,logHashes,productionDependenciesUsed:true},null,2)+'\n');
}
const mutations=[
  ['retain-received-work','src/operator-transfer-completion.js','return `(','return `(FALSE AND (',
    source=>source.replace('  )`;','  ))`;'),'test/mbt/integration/operator-netsuite-received-to.test.js'],
  ['ignore-received-code','src/operator-transfer-completion.js',"= 'G'","= 'X'",null,'test/mbt/integration/operator-netsuite-received-to.test.js'],
  ['hide-partial-receipts','src/operator-transfer-completion.js',"IN ('RECEIVED', 'TRANSFER ORDER:RECEIVED')","LIKE '%RECEIVED%'",null,'test/mbt/integration/operator-netsuite-received-to.test.js'],
  ['review-unmoved-destination','src/scm-reconciliation-repository.js','const destinationChangeRequiresReview = order.kind !== "TO" || transferMovementRecorded;','const destinationChangeRequiresReview = true;',null,'test/mbt/integration/scm-reconcile-review-automation.red.test.js'],
  ['ignore-moved-destination','src/scm-reconciliation-repository.js','const destinationChangeRequiresReview = order.kind !== "TO" || transferMovementRecorded;','const destinationChangeRequiresReview = false;',null,'test/mbt/integration/scm-reconcile-review-automation.red.test.js'],
  ['ignore-local-yard-load','src/scm-reconciliation-repository.js','...(localOrder?.lines || []).map(line => line.cumulativeProgressQuantity),','',null,'test/mbt/integration/scm-reconcile-review-automation.red.test.js']
  ,['ignore-netsuite-header-progress','src/scm-reconciliation-repository.js','netSuiteTransferMovement || [','false || [',null,'test/mbt/integration/scm-reconcile-review-automation.red.test.js']
];
for(const [name,file,original,replacement,finish,testFile] of phase==='supplement'?[]:mutations) {
  const variant=root+'/mutant-'+name;
  await mkdir(variant+'/test/mbt/integration',{recursive:true});
  await cp('/app/src',variant+'/src',{recursive:true});
  for(const entry of ['public','migrations','contracts','data','package.json']) await symlink('/app/'+entry,variant+'/'+entry);
  for(const entry of await readdir('/app')) if(entry.endsWith('.js')) await symlink('/app/'+entry,variant+'/'+entry);
  await symlink(root+'/node_modules',variant+'/node_modules');
  await cp('/app/'+testFile,variant+'/'+testFile);
  let source=await readFile('/app/'+file,'utf8');assert.equal(source.split(original).length,2,name);
  source=source.replace(original,replacement);if(finish) source=finish(source);
  await writeFile(variant+'/'+file,source);
  await run('mutant-'+name,['--test','--test-concurrency=1',testFile],{cwd:variant,expected:1});
}
await writeFile(`${out}/checks.json`,JSON.stringify({results,sourceHashes:prepared.sourceHashes,productionDependenciesUsed:true,
  tests,mutants:mutations.map(([name])=>name),node:process.version},null,2)+'\n');
console.log('TO follow-up checks passed');
