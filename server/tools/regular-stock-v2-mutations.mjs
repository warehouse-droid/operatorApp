import assert from 'node:assert/strict';
import {cp,mkdtemp,readFile,writeFile,symlink,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const directory=await mkdtemp(join(tmpdir(),'regular-stock-mutants-'));
const suites=['test/mbt/unit/regular-stock-domain.test.js','test/mbt/property/regular-stock.property.test.js'];
const domain='src/regular-stock-domain.js';
const mutations=[
 ['strict safety inequality','Number(remaining) + 1e-9 >= Number(safety)','Number(remaining) > Number(safety)'],
 ['ignore lead time','arrivalMs >= nowMs + hours * 3600000','arrivalMs >= nowMs'],
 ['drop duplicate demand','(totals.get(key(line)) || 0) + Number(line.salesQty)','Number(line.salesQty)'],
 ['under-order replenishment','Math.ceil(gap / Number(purchaseIncrement) - 1e-9)','Math.floor(gap / Number(purchaseIncrement) - 1e-9)'],
 ['ignore extra local SO materials',"complete && sources.size === 1 ? 'location' : 'transfer'","sources.size === 1 ? 'location' : 'transfer'"]
];
const results=[];
try{
 for(const name of ['src','public','test'])await cp(resolve(name),join(directory,name),{recursive:true});
 await cp('package.json',join(directory,'package.json'));await symlink(resolve('node_modules'),join(directory,'node_modules'),'dir');
 const original=await readFile(domain,'utf8');
 const execute=files=>spawnSync(process.execPath,['--test',...files],{cwd:directory,encoding:'utf8',timeout:60000});
 assert.equal(execute(suites).status,0,'Unmodified isolated suite must pass');
 for(const [name,needle,replacement] of mutations){
   assert(original.includes(needle),`Mutation anchor missing: ${name}`);
   await writeFile(join(directory,domain),original.replace(needle,replacement));
   const full=execute(suites),properties=execute([suites[1]]);
   assert.notEqual(full.status,0,`Survived: ${name}`);assert.notEqual(properties.status,0,`Property blind spot: ${name}`);
   assert.match(full.stdout,/not ok/);assert.match(properties.stdout,/not ok/);
   results.push({name,killedByCombinedSuite:true,killedByProperties:true});
 }
 await writeFile(join(directory,domain),original);assert.equal(execute(suites).status,0,'Restore must pass');
 await mkdir('test-artifacts/regular-stock-v2',{recursive:true});await writeFile('test-artifacts/regular-stock-v2/mutations.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results));
}finally{await rm(directory,{recursive:true,force:true});}
