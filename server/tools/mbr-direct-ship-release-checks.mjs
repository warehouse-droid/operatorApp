import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {cp,mkdir,readFile,readdir,symlink,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';

const out='/app/test-artifacts/mbr-direct-ship-release';
const mode=process.argv[2];
assert.ok(['core','browser'].includes(mode));
const prepared=JSON.parse(await readFile(`${out}/prepared.json`,'utf8'));
for(const [file,expected] of Object.entries(prepared.sourceHashes)) {
  assert.equal(createHash('sha256').update(await readFile('/app/'+file)).digest('hex'),expected,file);
}
const root=`/tmp/mbbs-combined-image-tests-${process.pid}`;
await mkdir(root,{recursive:true});
await cp('/app/test',root+'/test',{recursive:true});
await mkdir(root+'/tools');
for(const name of ['mbr-contract-check.mjs','mbr-contract-regressions.mjs']) {
  await cp('/app/tools/'+name,root+'/tools/'+name);
}
for(const name of ['src','public','migrations','contracts','data']) {
  await symlink('/app/'+name,root+'/'+name);
}
const artifacts=out+'/'+mode+'-artifacts';
await mkdir(artifacts+'/mbr-contract',{recursive:true});
await symlink(artifacts,root+'/test-artifacts');
for(const name of ['package.json','package-lock.json','.env.example','Dockerfile','Dockerfile.test','eslint.mbt.config.js','tsconfig.mbt.json']) {
  await symlink('/app/'+name,root+'/'+name);
}
for(const name of await readdir('/app')) {
  if(name.endsWith('.js') && name!=='eslint.mbt.config.js') {await symlink('/app/'+name,root+'/'+name);}
}
await mkdir(root+'/node_modules');
const packages=new Set();
for(const from of ['/app/node_modules','/test-toolchain/node_modules']) {
  for(const name of await readdir(from)) {
    if(name.startsWith('.')) {continue;}
    if(name.startsWith('@')) {
      await mkdir(root+'/node_modules/'+name,{recursive:true});
      for(const child of await readdir(from+'/'+name)) {
        const key=name+'/'+child;
        if(!packages.has(key)) {await symlink(from+'/'+key,root+'/node_modules/'+key);packages.add(key);}
      }
    } else if(!packages.has(name)) {
      await symlink(from+'/'+name,root+'/node_modules/'+name);packages.add(name);
    }
  }
}
const results={};
async function run(name,args,timeout=240000) {
  const result=spawnSync(process.execPath,args,{cwd:root,encoding:'utf8',timeout,maxBuffer:16*1024*1024,env:process.env});
  const output=(result.stdout||'')+(result.stderr||'');
  results[name]={exit:result.status,signal:result.signal};
  const counts=[...output.matchAll(/^(?:ℹ|#) (tests|pass|fail) (\d+)$/gmu)];
  for(const [,key,value] of counts) {results[name][key]=(results[name][key]||0)+Number(value);}
  await writeFile(`${out}/${name}.log`,output);
  console.log(JSON.stringify({stage:name,...results[name]}));
  if(result.status!==0) {process.stderr.write(output.slice(-7000));}
  assert.equal(result.status,0,name);
}
const direct=JSON.parse(await readFile('/app/test-artifacts/linked-direct-ship-sync/checks.json','utf8'));
if(mode==='core') {
  await run('direct-ship',['--test','--test-concurrency=1',...direct.tests]);
  await run('mbr-contract',['--test','--test-concurrency=1',...['domain','properties','security','repository','http','runtime'].map(name=>`test/mbr/${name}.test.js`)]);
} else {
  await run('browser-availability',['--input-type=module','-e',
    "const {chromium,webkit}=await import('/test-toolchain/node_modules/playwright/index.mjs');for(const engine of [chromium,webkit]){const b=await engine.launch({headless:true,args:engine.name()==='chromium'?['--no-sandbox']:[],timeout:10000});try{const page=await b.newPage();await page.goto('data:text/html,<h1>Browser ready</h1>');console.log(engine.name()+' page ready');}finally{await b.close();}}"]);
  const shared=JSON.parse(await readFile(`${out}/shared-regression-validation.json`,'utf8'));
  assert.equal(shared.passed,true);
  assert.deepEqual(shared.sourceHashes,prepared.sourceHashes);
  assert.deepEqual(shared.newFailures,[]);
  assert.equal(createHash('sha256').update(await readFile(`${out}/mbr-shared-regressions.log`)).digest('hex'),shared.logSha256);
  results['mbr-shared-regressions']={...shared.counts,baselineFailures:shared.baselineFailures,newFailures:shared.newFailures,verifiedFromCompletedRun:true};
  await run('mbr-browser',['test/mbr/browser.mjs']);
}
await writeFile(`${out}/checks.${mode}.json`,JSON.stringify({results,sourceHashes:prepared.sourceHashes,
  productionDependenciesUsed:true,node:process.version},null,2)+'\n');
console.log('Combined release checks passed');
