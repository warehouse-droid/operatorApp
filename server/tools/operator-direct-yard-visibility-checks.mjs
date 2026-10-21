import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {cp, mkdir, readFile, readdir, symlink, writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';

const out='/app/test-artifacts/operator-direct-yard-visibility';
const phase=process.argv[2]||'all';
assert.ok(['all','mutations'].includes(phase));
const prepared=JSON.parse(await readFile(`${out}/prepared.json`,'utf8'));
const hash=value=>createHash('sha256').update(value).digest('hex');
for(const [file,expected] of Object.entries(prepared.sourceHashes)) {
  assert.equal(hash(await readFile('/app/'+file)),expected,file);
}
const root=`/tmp/operator-yard-visibility-${process.pid}`;
await mkdir(root,{recursive:true});
await cp('/app/test',root+'/test',{recursive:true});
for(const name of ['src','public','migrations','contracts','data']) await symlink('/app/'+name,root+'/'+name);
for(const name of ['package.json','package-lock.json','.env.example','Dockerfile','Dockerfile.test','eslint.mbt.config.js','tsconfig.mbt.json']) {
  await symlink('/app/'+name,root+'/'+name);
}
for(const name of await readdir('/app')) {
  if(name.endsWith('.js') && name!=='eslint.mbt.config.js') await symlink('/app/'+name,root+'/'+name);
}
await mkdir(root+'/node_modules');
const packages=new Set();
for(const from of ['/app/node_modules','/test-toolchain/node_modules']) {
  for(const name of await readdir(from)) {
    if(name.startsWith('.')) continue;
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
let results={};
if(phase==='mutations') {
  const core=JSON.parse(await readFile(`${out}/checks.core.json`,'utf8'));
  assert.equal(core.imageId,prepared.imageId);
  assert.deepEqual(core.sourceHashes,prepared.sourceHashes);
  for(const [name,expected] of Object.entries(core.logHashes)) {
    assert.equal(hash(await readFile(`${out}/${name}.log`)),expected,name+' core log');
  }
  results={...core.results};
}
function run(name,args,{cwd=root,expected=0,timeout=240000}={}) {
  const result=spawnSync(process.execPath,args,{cwd,encoding:'utf8',timeout,maxBuffer:16*1024*1024,env:process.env});
  const output=(result.stdout||'')+(result.stderr||'');
  results[name]={exit:result.status,signal:result.signal};
  for(const [,key,value] of output.matchAll(/^(?:ℹ|#) (tests|pass|fail|skipped) (\d+)$/gmu)) {
    results[name][key]=(results[name][key]||0)+Number(value);
  }
  return writeFile(`${out}/${name}.log`,output).then(()=>{
    console.log(JSON.stringify({stage:name,...results[name]}));
    if(expected===0 && result.status!==0) process.stderr.write(output.slice(-7000));
    if(expected===0) assert.equal(result.status,0,name);
    else {
      assert.equal(result.status,1,name+' must fail assertions');
      assert.ok(results[name].fail>0,name+' must fail a behavioral test');
      assert.ok(!/ERR_MODULE_NOT_FOUND|SyntaxError:|relation .* does not exist|password authentication failed/.test(output),name+' must not fail infrastructure');
    }
  });
}
const direct=JSON.parse(await readFile('/app/test-artifacts/linked-direct-ship-sync/checks.json','utf8'));
const tests=[...new Set([...direct.tests,'test/mbt/integration/operator-delivery-reference.test.js',
  'test/mbt/integration/group-underpack.test.js','test/dispatch/property/group-underpack-boundary.property.test.js'])];
if(phase==='all') {
  await run('yard-and-direct-regressions',['/test-toolchain/node_modules/c8/bin/c8.js',
    '--reporter=json','--reporter=text-summary','--include=**/src/delivery-repository.js',
    '--src=/app','--allow-external',
    '--reports-dir='+out+'/coverage','--exclude-after-remap=false',process.execPath,
    '--test','--test-concurrency=1',...tests]);
  await run('mbr-regressions',['--test','--test-concurrency=1',
    ...['domain','properties','security','repository','http','runtime'].map(name=>`test/mbr/${name}.test.js`)]);
  await run('syntax',['--check','/app/src/delivery-repository.js']);
  const logHashes={};
  for(const name of Object.keys(results)) logHashes[name]=hash(await readFile(`${out}/${name}.log`));
  await writeFile(`${out}/checks.core.json`,JSON.stringify({imageId:prepared.imageId,sourceHashes:prepared.sourceHashes,
    results,logHashes,productionDependenciesUsed:true},null,2)+'\n');
}
const source=await readFile('/app/src/delivery-repository.js','utf8');
await import('./operator-direct-yard-visibility-lint.mjs');
results.lint={exit:0,scope:'Exact new completedLinkedYardWork function; whole release file syntax checked.'};
const mutants=[
  ['retain-completed-cards','return lines.some(line => line.no_yard_load_required','return false && lines.some(line => line.no_yard_load_required'],
  ['hide-open-yard-work','!lineHasOpenQuantity(line) && !lineHasPackedQuantity(line)','!lineHasPackedQuantity(line)'],
  ['hide-packed-yard-work','!lineHasOpenQuantity(line) && !lineHasPackedQuantity(line)','!lineHasOpenQuantity(line)'],
  ['hide-blocked-links','&& !line.linked_quantity_blocked);',');'],
  ['leak-completed-group-member','for (const child of children) completedChildRefs?.add(String(child.tranid));','completedChildRefs?.clear();']
];
for(const [name,original,replacement] of mutants) {
  assert.equal(source.split(original).length,2,name+' mutation must have one target');
  const variant=root+'/mutant-'+name;
  await mkdir(variant+'/test/mbt/integration',{recursive:true});
  await cp('/app/src',variant+'/src',{recursive:true});
  for(const name of ['public','migrations','contracts','data']) await symlink('/app/'+name,variant+'/'+name);
  for(const name of await readdir('/app')) {
    if(name.endsWith('.js')) await symlink('/app/'+name,variant+'/'+name);
  }
  await symlink(root+'/node_modules',variant+'/node_modules');
  await symlink('/app/package.json',variant+'/package.json');
  await cp('/app/test/mbt/integration/linked-direct-ship-sync.test.js',variant+'/test/mbt/integration/linked-direct-ship-sync.test.js');
  await writeFile(variant+'/src/delivery-repository.js',source.replace(original,replacement));
  await run('mutant-'+name,['--test','--test-concurrency=1',
    '--test-name-pattern=completed|fully covered|locally loaded group|stale preparing|remaining local|packed stock',
    'test/mbt/integration/linked-direct-ship-sync.test.js'],{cwd:variant,expected:1});
}
await writeFile(`${out}/checks.json`,JSON.stringify({results,sourceHashes:prepared.sourceHashes,
  productionDependenciesUsed:true,node:process.version,tests,mutants:mutants.map(([name])=>name)},null,2)+'\n');
console.log('Operator yard visibility checks passed');
