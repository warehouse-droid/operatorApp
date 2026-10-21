import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
const file='src/stock-check/ollama-matching.js',test='test/mbt/unit/stock-check-ollama.test.js',source=await fs.readFile(file,'utf8');
const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'stock-ollama-mutants-'));
const mutants=[
  {name:'accept low confidence',from:'row.confidence<.9',to:'row.confidence<0'},
  {name:'invented SKU chooses first candidate',from:'candidates.find(item=>item.sku===row.sku)',to:'(candidates.find(item=>item.sku===row.sku)??candidates[0])'},
  {name:'ignore explicit variant conflicts',from:'if(!identityAgrees(line,product))',to:'if(false)'},
  {name:'select indistinguishable duplicate variants',from:'products.filter(item=>signature(item)===signature(product)).length===1',to:'products.filter(item=>signature(item)===signature(product)).length>=1'}
];
const results=[];
try {
  for(const name of [file,'src/stock-check/line-matching.js',test]) {await fs.mkdir(path.dirname(path.join(temporary,name)),{recursive:true});await fs.copyFile(name,path.join(temporary,name));}
  await fs.writeFile(path.join(temporary,'src/config.js'),'export const config={ollama:{}};');
  await fs.writeFile(path.join(temporary,'package.json'),'{"type":"module"}');
  const run=()=>spawnSync(process.execPath,['--test',test],{cwd:temporary,encoding:'utf8',timeout:30000});
  const baseline=run();if(baseline.status!==0) {throw new Error('Mutation baseline failed: '+baseline.stdout+baseline.stderr);}
  for(const mutant of mutants) {
    if(source.split(mutant.from).length!==2) {throw new Error('Mutation target is not unique: '+mutant.name);}
    await fs.writeFile(path.join(temporary,file),source.replace(mutant.from,mutant.to));
    const result=run(),killed=result.status!==0&&/not ok \d/u.test(result.stdout)&&!/(SyntaxError|ERR_MODULE_NOT_FOUND)/u.test(result.stderr);
    results.push({name:mutant.name,killed});await fs.writeFile('test-artifacts/stock-check-ollama/mutant-'+results.length+'.log',result.stdout+result.stderr);
  }
  const sourceUnchanged=await fs.readFile(file,'utf8')===source;
  await fs.writeFile('test-artifacts/stock-check-ollama/mutations.json',JSON.stringify({results,sourceUnchanged},null,2));
  console.log(JSON.stringify({total:results.length,killed:results.filter(row=>row.killed).length,sourceUnchanged}));
  if(!sourceUnchanged||results.some(row=>!row.killed)) {process.exitCode=1;}
} finally {await fs.rm(temporary,{recursive:true,force:true});}
