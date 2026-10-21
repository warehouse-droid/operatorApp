import assert from 'node:assert/strict';
import {cp,mkdtemp,readFile,writeFile,symlink,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

assert.equal(process.env.MBT_TEST_ISOLATED,'1');
const out='test-artifacts/regular-stock-header';await mkdir(out,{recursive:true});
const adapter='src/regular-stock-netsuite-adapter.js';
const regression='test/mbt/integration/regular-stock-header.test.js';
const ancillary='test/mbt/unit/regular-stock-ancillary.test.js';
const suites=[regression,ancillary,'test/mbt/unit/regular-stock-netsuite.test.js','test/mbt/integration/regular-stock-external-workflow.test.js',
  'test/mbt/integration/regular-stock-handoff.test.js','test/mbt/unit/regular-stock-domain.test.js','test/mbt/property/regular-stock.property.test.js'];
const layers=[];
function run(name,command,args,options={}){
 const result=spawnSync(command,args,{encoding:'utf8',maxBuffer:20_000_000,...options});
 const text=result.stdout+result.stderr;
 layers.push({name,exitCode:result.status});
 return {result,text};
}
const covered=run('tests-and-coverage',process.execPath,['node_modules/c8/bin/c8.js','--include='+adapter,
 '--check-coverage=true','--reporter=json','--reporter=text','--report-dir='+out+'/coverage','--temp-directory=/tmp/regular-header-coverage',
 'node','--test','--test-concurrency=1',...suites]);
await writeFile(out+'/tests.tap',covered.text);assert.equal(covered.result.status,0,covered.text);
const reverse=run('reverse-order',process.execPath,['--test','--test-concurrency=1',...suites.slice().reverse()]);
await writeFile(out+'/reverse.tap',reverse.text);assert.equal(reverse.result.status,0,reverse.text);
const lint=run('lint','node_modules/.bin/eslint',['--config','tools/regular-stock-v2-eslint.config.mjs',adapter,regression,ancillary,
 'tools/regular-stock-header-check.mjs','tools/regular-stock-header-live.mjs']);
assert.equal(lint.result.status,0,lint.text);
const syntax=run('syntax',process.execPath,['--check',adapter]);assert.equal(syntax.result.status,0,syntax.text);
const types=run('strict-core-types','node_modules/.bin/tsc',['-p','tools/regular-stock-v2-tsconfig.json']);assert.equal(types.result.status,0,types.text);
const original=await readFile(adapter,'utf8');
const baseline=JSON.parse(await readFile('tools/regular-stock-header-baseline.json','utf8'));
assert.equal(createHash('sha256').update(await readFile('package.json')).digest('hex'),baseline.packageSha256,'No new dependencies');
const coverage=Object.values(JSON.parse(await readFile(out+'/coverage/coverage-final.json','utf8')))[0];
const patch=await readFile('test/regular-stock-header.changes.patch','utf8');
assert.deepEqual([...patch.matchAll(/^\+\+\+ b\/(.+)$/gm)].map(match=>match[1]),[adapter]);
const changed=[];let number=0;
for(const line of patch.split('\n')){
 const header=line.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);if(header){number=Number(header[1]);continue;}
 if(line.startsWith('+++')||line.startsWith('---'))continue;
 if(line.startsWith('+')){changed.push(number++);assert.doesNotMatch(line,/process\.env|child_process|readFile|writeFile|Authorization|Bearer/);}
 else if(line.startsWith(' '))number++;
}
for(const line of changed)assert(Object.entries(coverage.statementMap).some(([key,value])=>value.start.line<=line&&value.end.line>=line&&coverage.s[key]>0),'Uncovered changed line '+line);
const mutations=[
 ['wrong transaction-body header','main_tl.location AS order_location_id','t.location AS order_location_id'],
 ['drop location race check','Number(record.location?.id) !== Number(rows[0].order_location_id) || ',''],
 ['count PALLET as requested stock',"const ancillary = nonStockTypes.has(itemType) || /^PALLET$/i.test(String(row.item_name));","const ancillary = nonStockTypes.has(itemType);"],
 ['leave non-stock lines at old yard','fresh.lines.filter(line => line.ancillary)','fresh.lines.filter(line => line.physicalPallet)'],
 ['lose absent discount quantity','ancillary && line.quantity == null ? null : Number(line.quantity)','Number(line.quantity)'],
 ['drop built-in subtotal','LEFT JOIN item i ON i.id=tl.item','JOIN item i ON i.id=tl.item']
];
const temporary=await mkdtemp(join(tmpdir(),'regular-header-mutants-')),mutants=[];
try{
 for(const folder of ['src','public','test'])await cp(resolve(folder),join(temporary,folder),{recursive:true});
 await cp('package.json',join(temporary,'package.json'));await symlink(resolve('node_modules'),join(temporary,'node_modules'),'dir');
 for(const [name,needle,replacement] of mutations){
  assert(original.includes(needle));await writeFile(join(temporary,adapter),original.replace(needle,replacement));
  for(const propertyOnly of [false,true]){
   const args=['--test','--test-concurrency=1',...(propertyOnly?['--test-name-pattern=header identity property|ancillary property']:[]),regression,ancillary];
   const result=spawnSync(process.execPath,args,{cwd:temporary,encoding:'utf8',timeout:60000});
   assert.equal(result.status,1,name);assert.match(result.stdout,/not ok/);
  }
  mutants.push({name,killedByRegressions:true,killedByProperties:true});
 }
 await writeFile(join(temporary,adapter),original);
 const restored=spawnSync(process.execPath,['--test','--test-concurrency=1',regression,ancillary],{cwd:temporary,encoding:'utf8'});assert.equal(restored.status,0,restored.stdout+restored.stderr);
}finally{await rm(temporary,{recursive:true,force:true});}
const report={sourceSha256:createHash('sha256').update(original).digest('hex'),layers,
 tests:Number(covered.text.match(/^# tests (\d+)/m)?.[1]),passed:Number(covered.text.match(/^# pass (\d+)/m)?.[1]),
 propertyCases:300,propertySeeds:[121631,121632],changedLines:changed,coveredChangedLines:changed,mutants,dependenciesChanged:false,
 capabilityChange:'Existing read query only; no new network, filesystem, process or environment access in runtime code'};
await writeFile(out+'/checks.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
