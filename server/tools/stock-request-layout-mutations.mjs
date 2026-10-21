import {mkdtemp,mkdir,readdir,readFile,writeFile,symlink,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
const out='test-artifacts/stock-request-cleanup-layout';
const unit='test/mbt/unit/stock-request-yard-filter.test.js';
const integration='test/mbt/integration/stock-request-yard-selection.test.js';
const mutations=[
 ['ignore-selected-yards','src/special-stock-request-repository.js','if (selectedYards.length) {','if (false) {',integration],
 ['ignore-sales-yard-access','src/special-stock-request-repository.js','if (authorizedStoreLocationIds !== undefined) {','if (false) {',integration],
 ['accept-zero-yard','public/stock-request-yard-filter.js','Number(id) <= 0','Number(id) < 0',unit],
 ['ignore-stale-backup','tools/stock-request-test-cleanup.mjs',"assert.equal(digest(payload),expected,'Backup no longer matches the locked requests; nothing removed');",'',unit],
 ['allow-wrong-request-type','tools/stock-request-test-cleanup.mjs',"assert.ok(snapshot.rows.sales_stock_requests.every(row => row.request_type === 'special'),'Only special requests may be removed');",'',unit]
];
const results=[];
for(const [name,file,needle,replacement,test] of mutations){
 const temp=await mkdtemp('/tmp/stock-yard-mutant-');
 try{
  for(const dir of ['src','public','tools']){
   await mkdir(join(temp,dir));
   for(const entry of await readdir(dir))await symlink(resolve(dir,entry),join(temp,dir,entry));
  }
  await symlink(resolve('node_modules'),join(temp,'node_modules'));
  await writeFile(join(temp,'package.json'),'{"type":"module"}');
  await mkdir(join(temp,'test/mbt',test.includes('/unit/')?'unit':'integration'),{recursive:true});
  await writeFile(join(temp,test),await readFile(test));
  const original=await readFile(file,'utf8');assert.equal(original.split(needle).length,2,name);
  await rm(join(temp,file));await writeFile(join(temp,file),original.replace(needle,replacement));
  const result=spawnSync(process.execPath,['--test',test],{cwd:temp,env:process.env,encoding:'utf8',timeout:20000});
  assert.equal(result.error,undefined,name);assert.notEqual(result.status,0,`Survived: ${name}`);
  assert.match(result.stdout,/ERR_ASSERTION|ERR_TEST_FAILURE/,`Non-assertion failure: ${name}`);
  await writeFile(`${out}/mutant-${name}.log`,result.stdout+result.stderr);results.push({name,killed:true});
  if (name === 'ignore-selected-yards' || name === 'ignore-sales-yard-access') {
    const property=spawnSync(process.execPath,['--test','--test-name-pattern=property:',test],{cwd:temp,env:process.env,encoding:'utf8',timeout:20000});
    assert.equal(property.error,undefined);assert.notEqual(property.status,0);assert.match(property.stdout,/ERR_TEST_FAILURE/);
    await writeFile(`${out}/mutant-property-${name}.log`,property.stdout+property.stderr);results.at(-1).propertyAloneKilled=true;
  }
 } finally{await rm(temp,{recursive:true,force:true});}
}
await writeFile(`${out}/mutations.json`,JSON.stringify(results,null,2));console.log(JSON.stringify(results));
