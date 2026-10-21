import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,cp,symlink,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {ESLint} from 'eslint';
import coverage from 'istanbul-lib-coverage';
import v8ToIstanbul from 'v8-to-istanbul';
assert.equal(process.env.MBT_TEST_ISOLATED,'1');
const files=JSON.parse(await readFile('tools/regular-stock-delivery-simple-files.json','utf8'));
const out='test-artifacts',layers=[];
const hash=data=>createHash('sha256').update(data).digest('hex');
const sourceHashes=Object.fromEntries(await Promise.all(files.map(async file=>[file,hash(await readFile(file))])));
async function run(name,args,options={}){
 const result=spawnSync(process.execPath,args,{encoding:'utf8',maxBuffer:20_000_000,...options});
 await writeFile(`${out}/${name}.log`,(result.stdout||'')+(result.stderr||''));
 layers.push({name,exitCode:result.status});assert.equal(result.status,0,`${name}: ${(result.stdout||'')+(result.stderr||'')}`);return result.stdout;
}
for(const file of files.filter(file=>file.endsWith('.js')))await run('syntax-'+file.replaceAll('/','-'),['--check',file]);
await run('types',['node_modules/typescript/bin/tsc','-p','tools/regular-stock-delivery-simple-tsconfig.json']);
const lint=new ESLint({overrideConfigFile:'tools/regular-stock-v2-eslint.config.mjs'}),newDiagnostics=[];
const diagnostics=async(source,file)=>(await lint.lintText(source,{filePath:file}))[0].messages.map(({ruleId,severity,message})=>JSON.stringify({ruleId,severity,message}));
for(const file of [...files.filter(file=>file.endsWith('.js')),'test/mbt/unit/regular-stock-delivery-simple.test.js','test/mbt/integration/regular-stock-delivery-simple.test.js','test/mbt/integration/regular-stock-delivery-simple-http.test.js','tools/regular-stock-delivery-simple-check.mjs','tools/regular-stock-delivery-simple-browser.mjs']){
 const prior=existsSync(`${out}/before/${file}`)?await diagnostics(await readFile(`${out}/before/${file}`,'utf8'),file):[];
 for(const message of await diagnostics(await readFile(file,'utf8'),file)){
  const index=prior.indexOf(message);if(index<0)newDiagnostics.push({file,message});else prior.splice(index,1);
 }
}
await writeFile(`${out}/lint.json`,JSON.stringify(newDiagnostics,null,2));assert.deepEqual(newDiagnostics,[]);
const baseline=JSON.parse(await readFile(`${out}/baseline.json`,'utf8'));
assert.equal(hash(await readFile('package.json')),baseline.packageSha256);
const suites=['test/mbt/integration/regular-stock-stocking.test.js','test/mbt/unit/regular-stock-delivery-simple.test.js',
 'test/mbt/integration/regular-stock-delivery-simple.test.js','test/mbt/integration/regular-stock-http.test.js',
 'test/mbt/integration/regular-stock-external-workflow.test.js','test/mbt/unit/regular-stock-methods.test.js'];
let state=296712441;
for(let i=suites.length-1;i>0;i--){state=(Math.imul(state,1664525)+1013904223)>>>0;const j=state%(i+1);[suites[i],suites[j]]=[suites[j],suites[i]];}
for(const [i,file] of suites.entries())await run(`shuffle-${i}`,['--test',file]);
const mutations=[
 ['auto-approval lost','src/regular-stock-delivery-domain.js',"automatic:(from.locationId === 1 && to.locationId === 28) || (from.locationId === 28 && to.locationId === 1)","automatic:false",true],
 ['reverse route lost','src/regular-stock-delivery-domain.js',' || (from.locationId === 28 && to.locationId === 1)','',true],
 ['manual route automatically approved','src/regular-stock-delivery-domain.js',"automatic:(from.locationId === 1 && to.locationId === 28) || (from.locationId === 28 && to.locationId === 1)","automatic:true",true],
 ['fulfilled material accepted','src/regular-stock-delivery-domain.js',' && line.open !== true',' && false',true],
 ['zero material accepted','src/regular-stock-delivery-domain.js','line.quantity <= 0','line.quantity < 0',true],
 ['whole line always chosen','src/regular-stock-delivery-domain.js','const full = Number(remaining.get(line.itemId)) >= extra','const full = true',true],
 ['minimum backorder check bypassed','src/regular-stock-delivery-domain.js','available < minimum','available < 0',true],
 ['SO owner not enforced','src/regular-stock-delivery.js',' || request.requestedBy !== context.operatorId','',false],
 ['old handoff bypasses manual approval','src/regular-stock-handoff.js',"before.regular.deliveryVersion === 1 && (before.regular.deliveryApproval !== 'approved' || before.status === 'cancelled')",'false',false]
];
const temporary=await mkdtemp(join(tmpdir(),'delivery-mutants-')),mutants=[];
try{
 for(const folder of ['src','public','test'])await cp(resolve(folder),join(temporary,folder),{recursive:true});
 await cp('package.json',join(temporary,'package.json'));await symlink(resolve('node_modules'),join(temporary,'node_modules'),'dir');
 for(const [index,mutation] of mutations.entries()){
  const [name,file,needle,replacement,property]=mutation,source=await readFile(file,'utf8');
  assert(source.includes(needle),name);await writeFile(join(temporary,file),source.replace(needle,replacement));
  const results=[];
  for(const propertiesOnly of property?[false,true]:[false]){
   const result=spawnSync(process.execPath,['--test',...(propertiesOnly?['--test-name-pattern=property:']:[]),
    property?'test/mbt/unit/regular-stock-delivery-simple.test.js':'test/mbt/integration/regular-stock-delivery-simple.test.js'],
    {cwd:temporary,encoding:'utf8',timeout:60000,maxBuffer:4_000_000});
   await writeFile(`${out}/mutant-${index}-${propertiesOnly}.log`,(result.stdout||'')+(result.stderr||''));
   assert.equal(result.status,1,`${name}: ${result.stdout}${result.stderr}`);assert.match(result.stdout,/not ok/);results.push({propertiesOnly,killed:true});
  }
  await writeFile(join(temporary,file),source);mutants.push({name,results});
 }
 await run('mutants-restored',['--test','test/mbt/unit/regular-stock-delivery-simple.test.js','test/mbt/integration/regular-stock-delivery-simple.test.js'],{cwd:temporary});
}finally{await rm(temporary,{recursive:true,force:true});}
const measured=coverage.createCoverageMap(JSON.parse(await readFile(`${out}/coverage/coverage-final.json`,'utf8')));
for(const entry of JSON.parse(await readFile(`${out}/browser-coverage.json`,'utf8'))){
 if(!entry.url.startsWith('http'))continue;
 const file='public/'+new URL(entry.url).pathname.split('/').pop();if(!files.includes(file))continue;
 const source=await readFile(file,'utf8');assert.equal(entry.source,source);
 const converter=v8ToIstanbul(resolve(file),0,{source});await converter.load();converter.applyCoverage(entry.functions);measured.merge(converter.toIstanbul());
}
const changed=JSON.parse(await readFile(`${out}/changed-source-lines.json`,'utf8'));
const report={covered:0,total:0,uncovered:[],missingFiles:[],branches:{covered:0,total:0}};
for(const [file,added] of Object.entries(changed)){
 if(!file.endsWith('.js'))continue;
 if(!measured.files().includes(resolve(file))){report.missingFiles.push(file);continue;}
 const entry=measured.fileCoverageFor(resolve(file)),lines=entry.getLineCoverage(),source=(await readFile(file,'utf8')).split('\n');
 for(const number of added){
  if(/^\s*(?:\/\/.*|[{}\[\]();,]*)\s*$/.test(source[number-1])||!Object.hasOwn(lines,number))continue;
  report.total++;if(lines[number])report.covered++;else report.uncovered.push(`${file}:${number}`);
 }
 for(const [id,branch] of Object.entries(entry.branchMap))if(added.includes(branch.line))for(const count of entry.b[id]){report.branches.total++;if(count)report.branches.covered++;}
}
await writeFile(`${out}/changed-lines.json`,JSON.stringify(report,null,2));
assert.deepEqual(report.missingFiles,[]);
assert.deepEqual(report.uncovered,[],'Changed executable lines must be exercised');
const patch=await readFile('test/regular-stock-delivery-simple.changes.patch','utf8');
for(const line of patch.split('\n').filter(line=>line.startsWith('+')&&!line.startsWith('+++'))){
 assert.doesNotMatch(line,/-----BEGIN|AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9_-]{20,}|process\.env|child_process/);
}
const toolchain={node:process.version};
for(const name of ['fast-check','c8','eslint','typescript','playwright'])toolchain[name]=JSON.parse(await readFile(`node_modules/${name}/package.json`,'utf8')).version;
const result={sourceHashes,sourceTreeSha256:hash(JSON.stringify(sourceHashes)),layers,mutants,coverage:report,toolchain,dependenciesChanged:false,shuffleSeed:296712441,suiteOrder:suites};
await writeFile(`${out}/checks.json`,JSON.stringify(result,null,2));
console.log(JSON.stringify({syntax:files.filter(file=>file.endsWith('.js')).length,newLintDiagnostics:0,types:'passed',mutants:mutants.length,coverage:report}));
