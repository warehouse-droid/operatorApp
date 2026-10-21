import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,cp,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
assert.equal(process.env.MBT_TEST_ISOLATED,'1');
const out='test-artifacts/regular-stock-stocking',layers=[];
const files=JSON.parse(await readFile('tools/regular-stock-stocking-files.json','utf8'));
const regression='test/mbt/unit/regular-stock-methods.test.js';
const suites=[regression,'test/mbt/unit/regular-stock-pickup.test.js','test/mbt/integration/regular-stock-pickup.test.js','test/mbt/integration/regular-stock-stocking.test.js','test/mbt/integration/regular-stock-controls.test.js','test/mbt/integration/regular-stock-controls-http.test.js','test/mbt/unit/regular-stock-controls.test.js','test/mbt/unit/regular-stock-domain.test.js','test/mbt/unit/regular-stock-ancillary.test.js',
 'test/mbt/unit/regular-stock-netsuite.test.js','test/mbt/integration/regular-stock-header.test.js',
 'test/mbt/integration/regular-stock-handoff.test.js','test/mbt/integration/regular-stock-external-workflow.test.js','test/mbt/property/regular-stock.property.test.js'];
async function run(name,args){
 const result=spawnSync(process.execPath,args,{encoding:'utf8',maxBuffer:20_000_000});
 await writeFile(`${out}/${name}.log`,result.stdout+result.stderr);layers.push({name,exitCode:result.status});
 assert.equal(result.status,0,`${name}: ${result.stdout}${result.stderr}`);return result.stdout;
}
// Node sorts discovered files even when CLI arguments are reversed. Run each
// suite separately in a seeded shuffle so execution order really changes.
const suiteOrder=[...suites];let orderState=296731;
for(let i=suiteOrder.length-1;i>0;i--){orderState=(Math.imul(orderState,1664525)+1013904223)>>>0;const j=orderState%(i+1);[suiteOrder[i],suiteOrder[j]]=[suiteOrder[j],suiteOrder[i]];}
let shuffled='';
for(const [i,file] of suiteOrder.entries())shuffled+=await run(`shuffled-${i}`,['--test',file]);
await writeFile(`${out}/shuffled-order.log`,shuffled);
await run('static',['tools/regular-stock-v2-static.mjs']);
await run('new-lint',['node_modules/eslint/bin/eslint.js','--config','tools/regular-stock-v2-eslint.config.mjs',
 'src/regular-stock-pickup.js','public/scm-stock-pickup.js',regression,'tools/regular-stock-stocking-check.mjs',
 'tools/regular-stock-stocking-coverage.mjs','tools/regular-stock-stocking-browser.mjs',
 'test/mbt/integration/regular-stock-stocking.test.js','test/mbt/integration/regular-stock-handoff.test.js','test/mbt/integration/regular-stock-external-workflow.test.js']);
const baseline=JSON.parse(await readFile('tools/regular-stock-stocking-baseline.json','utf8'));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
assert.equal(hash(await readFile('package.json')),baseline.packageSha256);
const sources=Object.fromEntries(await Promise.all(files.map(async file=>[file,await readFile(file,'utf8')])));
const mutations=[
 ['bypass Stocking gate','src/regular-stock-domain.js',"automatic: deliveryMethod !== 'stocking' &&",'automatic:'],
 ['add Pickup lead time','src/regular-stock-domain.js',"const leadTimeApplies = deliveryMethod === 'delivery';","const leadTimeApplies = deliveryMethod !== 'stocking';"],
 ['bypass disabled gate','src/regular-stock-domain.js','&& autoApprovalEnabled &&','&&'],
 ['allow below safety','src/regular-stock-domain.js','Number(remaining) + 1e-9 >= Number(safety)','Number(available) + 1e-9 >= Number(safety)'],
 ['lose lead requirement','src/regular-stock-domain.js','evidence.length > 0 && enoughTime &&','evidence.length > 0 &&'],
 ['expiry off by one','src/regular-stock-domain.js','new Date(now).getTime()>=new Date','new Date(now).getTime()>new Date'],

];
const temporary=await mkdtemp(join(tmpdir(),'regular-controls-mutants-')),mutants=[];
try{
 for(const folder of ['src','public','test'])await cp(resolve(folder),join(temporary,folder),{recursive:true});
 await cp('package.json',join(temporary,'package.json'));await symlink(resolve('node_modules'),join(temporary,'node_modules'),'dir');
 for(const [name,file,needle,replacement] of mutations){
  assert(sources[file].includes(needle));await writeFile(join(temporary,file),sources[file].replace(needle,replacement));
  for(const propertyOnly of [false,true]){
   const result=spawnSync(process.execPath,['--test',...(propertyOnly?['--test-name-pattern=property:']:[]),regression,'test/mbt/unit/regular-stock-pickup.test.js','test/mbt/unit/regular-stock-controls.test.js'],{cwd:temporary,encoding:'utf8',timeout:60000});
   assert.equal(result.status,1,name);assert.match(result.stdout,/not ok/);
  }
  await writeFile(join(temporary,file),sources[file]);mutants.push({name,killedByRegressions:true,killedByProperties:true});
 }
 const restored=spawnSync(process.execPath,['--test',regression,'test/mbt/unit/regular-stock-pickup.test.js','test/mbt/unit/regular-stock-controls.test.js'],{cwd:temporary,encoding:'utf8'});assert.equal(restored.status,0,restored.stdout+restored.stderr);
}finally{await rm(temporary,{recursive:true,force:true});}
const patch=await readFile('test/regular-stock-stocking.changes.patch','utf8');
for(const line of patch.split('\n').filter(line=>line.startsWith('+')&&!line.startsWith('+++')))
 assert.doesNotMatch(line,/process\.env|child_process|readFile|writeFile|Authorization|Bearer|-----BEGIN/);
const report={sourceHashes:Object.fromEntries(files.map(file=>[file,hash(sources[file])])),layers,
 tests:[...shuffled.matchAll(/^# tests (\d+)/gm)].reduce((n,m)=>n+Number(m[1]),0),passed:[...shuffled.matchAll(/^# pass (\d+)/gm)].reduce((n,m)=>n+Number(m[1]),0),suiteOrderSeed:296731,suiteOrder,
 propertyCases:1100,propertySeeds:[296729,296730,296715,15005,15006],mutants,dependenciesChanged:false,
 toolchain:{node:process.version,...Object.fromEntries(await Promise.all(['fast-check','c8','eslint','typescript'].map(async name=>[name,JSON.parse(await readFile(`node_modules/${name}/package.json`,'utf8')).version])))},
 capabilityChange:'Separate Stocking direct TO conversion from customer Pickup; Pickup skips minimum lead time but retains safety and SO controls; no new endpoints, dependencies, migrations or outbound services'};
await writeFile(out+'/checks.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
