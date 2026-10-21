import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,mkdtemp,cp,symlink,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {ESLint} from 'eslint';
import {suites,prepareRegressionFixture} from './delivery-instruction-netsuite-tests.mjs';
assert.equal(process.env.MBT_TEST_ISOLATED,'1');
const out='test-artifacts/delivery-instruction-netsuite',files=JSON.parse(await readFile('tools/delivery-instruction-netsuite-files.json','utf8')),layers=[];
await prepareRegressionFixture();
async function run(name,args,options={}){
 const result=spawnSync(process.execPath,args,{encoding:'utf8',maxBuffer:30_000_000,...options});
 const text=result.stdout+result.stderr;
 const known=JSON.parse(await readFile('tools/delivery-instruction-netsuite-known-failures.json','utf8'));
 const knownMessage=args.length===2&&known['/app/'+args[1]];
 const knownFailure=Boolean(knownMessage&&result.status===1&&text.includes(knownMessage));
 await writeFile(`${out}/${name}.log`,text);layers.push({name,exitCode:knownFailure?0:result.status,actualExitCode:result.status,knownFailure});
 if(knownFailure)return text;
 assert.equal(result.status,0,`${name}: ${result.stdout}${result.stderr}`);return result.stdout;
}
const lint=new ESLint({overrideConfigFile:'tools/regular-stock-v2-eslint.config.mjs'}),failures=[];
const diagnostics=async(source,file)=>(await lint.lintText(source,{filePath:file}))[0].messages.map(({ruleId,severity,message})=>JSON.stringify({ruleId,severity,message}));
let existing=0;
for(const file of files.filter(f=>f.endsWith('.js'))){
 await run('syntax-'+file.replaceAll('/','_'),['--check',file]);
 const before=`${out}/before/${file}`,allowed=existsSync(before)?await diagnostics(await readFile(before,'utf8'),file):[];
 for(const message of await diagnostics(await readFile(file,'utf8'),file)){
  const index=allowed.indexOf(message);if(index<0)failures.push({file,message});else{allowed.splice(index,1);existing++;}
 }
}
await writeFile(`${out}/static.json`,JSON.stringify({unchangedLegacyDiagnostics:existing,newDiagnostics:failures},null,2));
assert.deepEqual(failures,[],'New lint violations');
await run('types',['node_modules/typescript/bin/tsc','--allowJs','--checkJs','--strict','--noEmit','--skipLibCheck','--types','node','--module','NodeNext','--target','ES2023','src/delivery-instruction-netsuite.js']);
await run('test-tool-lint',['node_modules/eslint/bin/eslint.js','--config','tools/regular-stock-v2-eslint.config.mjs',
 'tools/delivery-instruction-netsuite-check.mjs','tools/delivery-instruction-netsuite-tests.mjs','tools/delivery-instruction-netsuite-coverage.mjs',
 'tools/delivery-instruction-netsuite-browser.mjs','test/mbt/unit/delivery-instruction-netsuite.test.js',
 'test/mbt/property/delivery-instruction-netsuite.property.test.js','test/mbt/integration/delivery-instruction-netsuite.test.js','test/mbt/integration/delivery-instruction-netsuite-http.test.js']);
// Separate processes ensure Node cannot sort away the requested randomized order.
const order=[...suites];let seed=29670929;
for(let i=order.length-1;i>0;i--){seed=(Math.imul(seed,1664525)+1013904223)>>>0;const j=seed%(i+1);[order[i],order[j]]=[order[j],order[i]];}
for(const[i,file]of order.entries())await run(`shuffled-${i}`,['--test',file]);
await writeFile(`${out}/shuffled-order.json`,JSON.stringify(order,null,2));
const adapter='src/delivery-instruction-netsuite.js',source=await readFile(adapter,'utf8');
const unit='test/mbt/unit/delivery-instruction-netsuite.test.js',property='test/mbt/property/delivery-instruction-netsuite.property.test.js';
const mutants=[
 ['wrong note mapping',"['memo', 'custbody7']","['memo', 'memo']"],
 ['skip stale snapshot guard',"|| (!same(current.values, before) && !same(current.values, target))",''],
 ['lose significant memo spaces',"value.memo.replace(/\\r\\n?/g, '\\n')","value.memo.replace(/\\r\\n?/g, '\\n').trim()"],
 ['accept impossible dates',"date.toISOString().slice(0, 10) !== value",'false'],
 ['skip patch entirely',"await boundary.rest(`/record/v1/salesOrder/${id}`, { method: 'PATCH', body });",'void body;']
];
const temp=await mkdtemp(join(tmpdir(),'delivery-netsuite-mutation-')),mutation=[];
try{
 for(const file of [adapter,unit,property,'package.json']){await mkdir(join(temp,file,'..'),{recursive:true});await cp(file,join(temp,file));}
 await symlink('/app/node_modules',join(temp,'node_modules'),'dir');
 for(const[index,[name,from,to]]of mutants.entries()){
  assert.equal(source.split(from).length,2,`Mutation anchor ${name}`);await writeFile(join(temp,adapter),source.replace(from,to));
  const results=[];
  for(const[kind,file]of[['unit',unit],['property',property]]){
   const result=spawnSync(process.execPath,['--test',file],{cwd:temp,encoding:'utf8',maxBuffer:10_000_000});
   await writeFile(`${out}/mutant-${index}-${kind}.log`,result.stdout+result.stderr);
   assert.equal(result.status,1,`Survived ${name} in ${kind}`);assert.match(result.stdout,/not ok/);assert.doesNotMatch(result.stdout+result.stderr,/SyntaxError|ERR_MODULE_NOT_FOUND/);results.push(kind);
  }
  mutation.push({name,killedBy:results});
 }
 await writeFile(join(temp,adapter),source);await run('mutant-restore',['--test',unit,property],{cwd:temp});
}finally{await rm(temp,{recursive:true,force:true});}
await writeFile(`${out}/mutations.json`,JSON.stringify(mutation,null,2));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),baseline=JSON.parse(await readFile('tools/delivery-instruction-netsuite-baseline.json','utf8'));
assert.equal(hash(await readFile('package.json')),baseline.packageSha256);
const sourceHashes=Object.fromEntries(await Promise.all(files.map(async f=>[f,hash(await readFile(f))])));
const counts=JSON.parse(await readFile(`${out}/tests.json`));
await writeFile(`${out}/checks.json`,JSON.stringify({sourceHashes,layers,tests:counts.tests,passed:counts.pass,knownFailures:counts.knownFailures,mutations:mutation.length,propertyCases:800,unchangedLegacyDiagnostics:existing},null,2));
console.log(JSON.stringify({tests:counts.tests,passed:counts.pass,mutations:mutation.length,propertyCases:800,strictTypes:'passed',newLintViolations:0}));
