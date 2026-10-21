import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {cp,mkdtemp,readFile,writeFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {regularTests} from './regular-stock-v2-suites.mjs';
import {ESLint} from 'eslint';

assert.equal(process.env.MBT_TEST_ISOLATED,'1');
const files=JSON.parse(await readFile('tools/regular-stock-kit-spec.json','utf8')).setup.runtimeFiles;
const suites=['test/mbt/unit/regular-stock-kit.test.js','test/mbt/integration/regular-stock-kit.test.js'];
const layers=[];
async function run(name,command,args,options={}){
 const result=spawnSync(command,args,{encoding:'utf8',maxBuffer:40_000_000,...options});
 const output=result.stdout+result.stderr;
 await writeFile('test-artifacts/'+name+'.log',output);
 layers.push({name,exitCode:result.status});
 assert.equal(result.status,0,output);
 return output;
}
const tests=await run('coverage',process.execPath,['node_modules/c8/bin/c8.js',...files.map(file=>'--include='+file),
 '--check-coverage=false','--reporter=json','--reporter=text','--report-dir=test-artifacts/coverage','--temp-directory=/tmp/regular-kit-c8',
 'node','--test','--test-concurrency=1',...regularTests]);
await run('reverse',process.execPath,['--test','--test-concurrency=1',...regularTests.slice().reverse()]);
await run('lint','node_modules/.bin/eslint',['--config','tools/regular-stock-v2-eslint.config.mjs',
 'src/regular-stock-netsuite-adapter.js','src/regular-stock-delivery-domain.js','src/regular-stock-domain.js',
 'test/mbt/fixtures/regular-stock-kit.js',...suites,'tools/regular-stock-kit-suite.mjs','tools/regular-stock-kit-gauntlet.mjs']);
const lint=new ESLint({overrideConfigFile:'tools/regular-stock-v2-eslint.config.mjs'});
const baselineLint=JSON.parse(await readFile('tools/regular-stock-kit-lint-baseline.json','utf8'));
for(const file of files){
 const allowed=baselineLint[file].map(message=>JSON.stringify(message));
 const messages=(await lint.lintText(await readFile(file,'utf8'),{filePath:file}))[0].messages;
 for(const {ruleId,severity,message} of messages){
  const index=allowed.indexOf(JSON.stringify({ruleId,severity,message}));
  assert(index>=0,'New lint diagnostic in '+file+': '+message);allowed.splice(index,1);
 }
}
layers.push({name:'runtime-lint-baseline-comparison',exitCode:0});
for(const file of files)await run('syntax-'+file.replaceAll('/','-'),process.execPath,['--check',file]);
await run('types','node_modules/.bin/tsc',['-p','tools/regular-stock-delivery-simple-tsconfig.json']);
const coverage=JSON.parse(await readFile('test-artifacts/coverage/coverage-final.json','utf8'));
const changed=JSON.parse(await readFile('tools/regular-stock-kit-changed-lines.json','utf8'));
const covered={};
for(const file of files){
 const record=coverage[resolve(file)];
 assert(record,'Missing coverage for '+file);
 const lines=changed[file].filter(number=>Object.values(record.statementMap).some(value=>value.start.line<=number&&value.end.line>=number));
 for(const number of lines)assert(Object.entries(record.statementMap).some(([key,value])=>value.start.line<=number&&value.end.line>=number&&record.s[key]>0),file+':'+number+' is not covered');
 covered[file]=lines;
}
const mutations=[
 ['count hidden children as visible','src/regular-stock-netsuite-adapter.js','return visible;','return rows;'],
 ['reject valid kit parents','src/regular-stock-netsuite-adapter.js',"parents.get(parent)?.item_type !== 'Kit'","parents.get(parent)?.item_type === 'Kit'"],
 ['require a stock unit for a committed kit','src/regular-stock-delivery-domain.js',"line.itemType !== 'Kit' && ", ''],
 ['ignore positive kit parent backorders','src/regular-stock-delivery-domain.js','line.backorderedQuantity !== 0 ||','line.backorderedQuantity < 0 ||'],
 ['ignore component changes during delivery retry','src/regular-stock-handoff.js','||!regularStockKitComponentsMatch(line,current)','||false']
];
const temporary=await mkdtemp(join(tmpdir(),'regular-kit-mutants-')),mutants=[];
try{
 for(const folder of ['src','public','test'])await cp(resolve(folder),join(temporary,folder),{recursive:true});
 await cp('package.json',join(temporary,'package.json'));await symlink(resolve('node_modules'),join(temporary,'node_modules'),'dir');
 for(const [name,file,needle,replacement] of mutations){
  const original=await readFile(file,'utf8');assert(original.includes(needle));
  await writeFile(join(temporary,file),original.replace(needle,replacement));
  for(const propertiesOnly of [false,true]){
   const result=spawnSync(process.execPath,['--test','--test-concurrency=1',...(propertiesOnly?['--test-name-pattern=property:']:[]),...suites],
    {cwd:temporary,encoding:'utf8',timeout:60000,maxBuffer:20_000_000});
   await writeFile('test-artifacts/mutant-'+mutants.length+'-'+propertiesOnly+'.tap',result.stdout+result.stderr);
   assert.equal(result.status,1,name);assert.match(result.stdout,/not ok/);
  }
  await writeFile(join(temporary,file),original);
  mutants.push({name,killedByRegression:true,killedByProperties:true});
 }
 await run('restored',process.execPath,['--test','--test-concurrency=1',...suites],{cwd:temporary});
}finally{await rm(temporary,{recursive:true,force:true});}
const hashes=Object.fromEntries(await Promise.all(files.map(async file=>[file,createHash('sha256').update(await readFile(file)).digest('hex')])));
const report={layers,tests:Number(tests.match(/^# tests (\d+)/m)?.[1]),passed:Number(tests.match(/^# pass (\d+)/m)?.[1]),
 coveredChangedLines:covered,changedExecutableLines:Object.values(covered).reduce((sum,lines)=>sum+lines.length,0),
 mutants,propertyCases:260,propertySeeds:[121863,121864,121865],sourceHashes:hashes,
 dependenciesChanged:false,capabilityChange:'Existing SO read query and saved snapshot comparison only; no new runtime network or process capabilities'};
await writeFile('test-artifacts/checks.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
