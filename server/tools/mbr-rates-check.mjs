import assert from 'node:assert/strict';
import {cp,mkdir,readdir,symlink,readFile,writeFile,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {scanUnifiedDiff,scanTextForSecrets} from '../test/support/scan-diff-secrets.mjs';

const mode=process.argv[2],out='/app/test-artifacts/mbr-rates';
const root=`/tmp/mbr-rates-check-${process.pid}`;
await mkdir(root,{recursive:true});
await cp('/app/test',root+'/test',{recursive:true});
await mkdir(root+'/tools');
for(const name of await readdir('/app/tools')) {
  if(name.startsWith('mbr-rates-') && name.endsWith('.mjs')) {await cp('/app/tools/'+name,root+'/tools/'+name);}
}
await cp('/app/tools/mbr-contract-regressions.mjs',root+'/tools/mbr-contract-regressions.mjs');
for(const name of ['src','public','migrations','contracts','data','test-artifacts','package.json','eslint.mbt.config.js','tsconfig.mbt.json']) {
  await symlink('/app/'+name,root+'/'+name);
}
for(const name of await readdir('/app')) {
  if(name.endsWith('.js') && name!=='eslint.mbt.config.js') {await symlink('/app/'+name,root+'/'+name);}
}
await mkdir(root+'/node_modules');
const packages=new Set();
async function addPackage(from,key) {
  if(packages.has(key)) {return;}
  await symlink(from+'/'+key,root+'/node_modules/'+key);packages.add(key);
}
for(const from of ['/app/node_modules','/test-toolchain/node_modules']) {
  for(const name of await readdir(from)) {
    if(name.startsWith('.')) {continue;}
    if(name.startsWith('@')) {
      await mkdir(root+'/node_modules/'+name,{recursive:true});
      for(const child of await readdir(from+'/'+name)) {
        await addPackage(from,name+'/'+child);
      }
    } else {await addPackage(from,name);}
  }
}
if(mode==='candidate') {
  const prepared=JSON.parse(await readFile(out+'/prepared.json','utf8'));
  for(const [file,expected] of Object.entries(prepared.sourceHashes)) {
    assert.equal(createHash('sha256').update(await readFile('/app/'+file)).digest('hex'),expected,file);
  }
}
const results={};
function run(name,args,{required=true,timeout=240000,env={},cwd=root}={}) {
  const result=spawnSync(process.execPath,args,{cwd,encoding:'utf8',timeout,killSignal:'SIGKILL',maxBuffer:16*1024*1024,env:{...process.env,...env}});
  const output=(result.stdout || '')+(result.stderr || '');
  results[name]={exit:result.status,signal:result.signal};
  for(const [,label,value] of output.matchAll(/^(?:#|ℹ) (tests|pass|fail) (\d+)$/gmu)) {
    results[name][label]=(results[name][label] || 0)+Number(value);
  }
  // Synchronous write keeps logs available even if the next stage fails.
  process.stdout.write(output);
  console.log(JSON.stringify({stage:name,...results[name]}));
  return writeFile(`${out}/${mode}-${name}.log`,output).then(()=>{
    if(required) {assert.equal(result.status,0,name);}
    return result.status;
  });
}
const tests=['domain','properties','security','repository','http','runtime','equipment','equipment-http','nullable','nullable-http','rates','rates-http'].map(name=>`test/mbr/${name}.test.js`);
async function secrets() {
  const findings=scanUnifiedDiff(await readFile(out+'/production.patch','utf8'));
  for(const file of ['public/mbr/rates.js','public/mbr/rates-setup.js','src/mbr/rates-repository.js','migrations/290_mbr_model_rates.sql']) {
    findings.push(...scanTextForSecrets(await readFile('/app/'+file,'utf8'),file));
  }
  assert.deepEqual(findings,[],'No secrets in the MBR runtime delta');
  results.secrets={exit:0,findings:findings.length};
}
if(mode==='red') {
  const exit=await run('red',['--test','--test-concurrency=1',...tests.slice(-2)],{required:false});
  assert.notEqual(exit,0,'The new requirements must fail on the old application.');
  process.exitCode=1;
} else {
  await rm(`${out}/coverage-${mode}`,{recursive:true,force:true});
  for(const folder of ['mutations','browser','contract-browser']) {await rm(`${out}/${folder}`,{recursive:true,force:true});}
  await run('types',['node_modules/typescript/bin/tsc','--project','test/mbr/rates-tsconfig.json','--noEmit']);
  await run('lint',['node_modules/eslint/bin/eslint.js','--config','test/mbr/rates-eslint.config.mjs','--max-warnings=0',
    'src/mbr','public/mbr','test/mbr','tools/mbr-rates-check.mjs','tools/mbr-rates-mutations.mjs']);
  if(mode!=='core') {await secrets();}
  if(mode==='core') {await run('tests',['--test','--test-concurrency=1',...tests]);}
  else {
    await run('coverage',[root+'/node_modules/c8/bin/c8.js','--all','--src=/app/src/mbr','--src=/app/public/mbr',
      '--include=src/mbr/*.js','--include=public/mbr/{domain,equipment,rates,ui}.js',
      '--reporter=json','--reporter=json-summary','--reporter=text',`--report-dir=${out}/coverage-${mode}`,
      '--temp-directory=/tmp/mbr-rates-c8','node','--test','--test-concurrency=1',...tests.map(file=>root+'/'+file)],{cwd:'/app'});
    results.tests={...results.coverage};
    await run('mutations',['tools/mbr-rates-mutations.mjs']);
    await run('browser',['test/mbr/rates-browser.mjs']);
    await run('nullable-browser-regression',['test/mbr/nullable-browser.mjs']);
    await run('equipment-browser-regression',['test/mbr/equipment-browser.mjs']);
    await run('mbr-browser-regression',['test/mbr/browser.mjs'],{env:{MBR_BROWSER_ARTIFACTS:'test-artifacts/mbr-rates/contract-browser'}});
    await run('shuffled-tests',['--test','--test-concurrency=1',...tests.toReversed()]);
  }
}
await writeFile(`${out}/checks.${mode}.json`,JSON.stringify({results,node:process.version},null,2)+'\n');
