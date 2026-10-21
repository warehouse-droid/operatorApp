import assert from 'node:assert/strict';
import {cp,mkdtemp,readFile,writeFile,symlink,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
assert.equal(process.env.MBT_TEST_ISOLATED,'1');
const out='test-artifacts/regular-stock-purchase';await mkdir(out,{recursive:true});
const domain='src/regular-stock-purchase-domain.js',ledger='src/regular-stock-purchase-repository.js';
const unit=['test/mbt/unit/regular-stock-purchase-domain.test.js','test/mbt/property/regular-stock-purchase.property.test.js'];
const integration=['test/mbt/integration/regular-stock-purchase.test.js','test/mbt/integration/regular-stock-purchase-loads.test.js'];
const mutations=[
  ['round purchase down',domain,'Math.ceil(reviewed / conversion)','Math.floor(reviewed / conversion)',unit,true],
  ['lose micro-unit surplus',domain,'Math.ceil(reviewed / conversion)','Math.ceil(round(reviewed / conversion))',unit,true],
  ['lose original requested quantity',domain,'requestedQuantity:requested','requestedQuantity:reviewed',unit,true],
  ['ignore allocation capacity',domain,'Math.min(capacity,Math.max(0,Number(demand.remaining)||0))','Math.max(0,Number(demand.remaining)||0)',unit,true],
  ['assign a receipt to multiple requests',domain,'round(Math.min(allocated,receipts))','round(receipts)',unit,true],
  ['reverse shared-item acceptance priority',domain,'for (const demand of demands)','for (const demand of [...demands].reverse())',unit,true],
  ['complete a request when only proposed',ledger,'round(received)>=round(target)','true',integration,false],
  ['lose request ownership during a merge','src/smart-scm-proposal-editor.js','purchaseDemandIds:[...new Set([...(existing.reason?.purchaseDemandIds||[]),...(next.reason?.purchaseDemandIds||[])])]','purchaseDemandIds:existing.reason?.purchaseDemandIds||[]',integration,false]
];
const temporary=await mkdtemp(join(tmpdir(),'purchase-stock-mutants-')),results=[];
try{
  for(const folder of ['src','public','test'])await cp(resolve(folder),join(temporary,folder),{recursive:true});
  await cp('package.json',join(temporary,'package.json'));await symlink(resolve('node_modules'),join(temporary,'node_modules'),'dir');
  const execute=files=>spawnSync(process.execPath,['--test','--test-concurrency=1',...files],{cwd:temporary,encoding:'utf8',timeout:60000,maxBuffer:8_000_000});
  assert.equal(execute(unit).status,0,'Unmodified isolated domain suite must pass');
  for(const [index,[name,file,needle,replacement,suites,checkProperties]] of mutations.entries()){
    const original=await readFile(file,'utf8');assert(original.includes(needle),`Missing mutation anchor: ${name}`);
    await writeFile(join(temporary,file),original.replace(needle,replacement));
    const result=execute(suites);
    await writeFile(`${out}/mutation-${index+1}.log`,result.stdout+result.stderr);
    assert.equal(result.status,1,`Surviving or invalid mutant: ${name}`);assert.match(result.stdout,/not ok/);assert.doesNotMatch(result.stderr,/SyntaxError|ReferenceError/);
    if(checkProperties){const property=execute([unit[1]]);assert.equal(property.status,1,`Property blind spot: ${name}`);assert.match(property.stdout,/not ok/);}
    await writeFile(join(temporary,file),original);
    results.push({name,killed:true,layer:checkProperties?'unit and generated properties':'database workflow'});
  }
  assert.equal(execute(unit).status,0,'Restored domain suite must pass');
  const restored=execute(integration);assert.equal(restored.status,0,restored.stdout+restored.stderr);
  await writeFile(`${out}/mutations.json`,JSON.stringify({killed:results.length,total:mutations.length,results},null,2));
  console.log(JSON.stringify({killed:results.length,total:mutations.length}));
}finally{await rm(temporary,{recursive:true,force:true});}
