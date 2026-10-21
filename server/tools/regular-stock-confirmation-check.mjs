import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,cp,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
assert.equal(process.env.MBT_TEST_ISOLATED,'1');
const out='test-artifacts/regular-stock-confirmation',layers=[];
const files=JSON.parse(await readFile('tools/regular-stock-confirmation-files.json','utf8'));
const regression='test/mbt/unit/regular-stock-confirmation.test.js';
const suites=[regression,'test/mbt/unit/regular-stock-domain.test.js','test/mbt/unit/regular-stock-ancillary.test.js',
 'test/mbt/unit/regular-stock-netsuite.test.js','test/mbt/integration/regular-stock-header.test.js',
 'test/mbt/integration/regular-stock-handoff.test.js','test/mbt/integration/regular-stock-external-workflow.test.js','test/mbt/property/regular-stock.property.test.js'];
async function run(name,args){
 const result=spawnSync(process.execPath,args,{encoding:'utf8',maxBuffer:20_000_000});
 await writeFile(`${out}/${name}.log`,result.stdout+result.stderr);layers.push({name,exitCode:result.status});
 assert.equal(result.status,0,`${name}: ${result.stdout}${result.stderr}`);return result.stdout;
}
const reverse=await run('reverse-order',['--test','--test-concurrency=1',...suites.reverse()]);
await run('static',['tools/regular-stock-v2-static.mjs']);
await run('new-lint',['node_modules/eslint/bin/eslint.js','--config','tools/regular-stock-v2-eslint.config.mjs',
 'src/regular-stock-confirmation.js',regression,'tools/regular-stock-confirmation-check.mjs',
 'tools/regular-stock-confirmation-coverage.mjs','tools/regular-stock-v2-browser.mjs',
 'test/mbt/integration/regular-stock-handoff.test.js','test/mbt/integration/regular-stock-external-workflow.test.js']);
const baseline=JSON.parse(await readFile('tools/regular-stock-confirmation-baseline.json','utf8'));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
assert.equal(hash(await readFile('package.json')),baseline.packageSha256);
const sources=Object.fromEntries(await Promise.all(files.map(async file=>[file,await readFile(file,'utf8')])));
const mutations=[
 ['wrong SO quantity in message','src/regular-stock-domain.js','has ${matchedQuantity}${unit}','has ${quantity}${unit}'],
 ['ignore requested quantity in message','src/regular-stock-domain.js','approves ${quantity}${unit}','approves ${matchedQuantity}${unit}'],
 ['ignore changed confirmation','src/regular-stock-confirmation.js','if(token!==regularStockConfirmationToken(requestId,plan))','if(false)'],
 ['allow absent confirmation','src/regular-stock-confirmation.js','if(!token)throw','if(!token)return; if(!token)throw'],
 ['lose serialized retry compatibility','src/regular-stock-confirmation.js','value instanceof Date?value.toISOString():','']
];
const temporary=await mkdtemp(join(tmpdir(),'regular-confirmation-mutants-')),mutants=[];
try{
 for(const folder of ['src','public','test'])await cp(resolve(folder),join(temporary,folder),{recursive:true});
 await cp('package.json',join(temporary,'package.json'));await symlink(resolve('node_modules'),join(temporary,'node_modules'),'dir');
 for(const [name,file,needle,replacement] of mutations){
  assert(sources[file].includes(needle));await writeFile(join(temporary,file),sources[file].replace(needle,replacement));
  for(const propertyOnly of [false,true]){
   const result=spawnSync(process.execPath,['--test',...(propertyOnly?['--test-name-pattern=property:']:[]),regression],{cwd:temporary,encoding:'utf8',timeout:60000});
   assert.equal(result.status,1,name);assert.match(result.stdout,/not ok/);
  }
  await writeFile(join(temporary,file),sources[file]);mutants.push({name,killedByRegressions:true,killedByProperties:true});
 }
 const restored=spawnSync(process.execPath,['--test',regression],{cwd:temporary,encoding:'utf8'});assert.equal(restored.status,0,restored.stdout+restored.stderr);
}finally{await rm(temporary,{recursive:true,force:true});}
const patch=await readFile('test/regular-stock-confirmation.changes.patch','utf8');
for(const line of patch.split('\n').filter(line=>line.startsWith('+')&&!line.startsWith('+++')))
 assert.doesNotMatch(line,/process\.env|child_process|readFile|writeFile|Authorization|Bearer|-----BEGIN/);
const report={sourceHashes:Object.fromEntries(files.map(file=>[file,hash(sources[file])])),layers,
 tests:Number(reverse.match(/^# tests (\d+)/m)?.[1]),passed:Number(reverse.match(/^# pass (\d+)/m)?.[1]),
 propertyCases:350,propertySeeds:[121631,121632],mutants,dependenciesChanged:false,
 capabilityChange:'Existing endpoints and JSON columns; no new outbound connections, filesystem access or schema'};
await writeFile(out+'/checks.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
