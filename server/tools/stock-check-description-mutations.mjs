import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
const file='src/stock-check/line-description.js',test='test/mbt/unit/stock-check-description.test.js',source=await fs.readFile(file,'utf8');
const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'stock-description-mutants-'));
const mutants=[
  {name:'use the NetSuite code as the description',from:'const productName=detailSpec||',to:'const productName=code||'},
  {name:'send the internal code to matching',from:'itemCode:null',to:'itemCode:code'},
  {name:'drop inventory description fallback',from:'description(row.inventory_description)||',to:''},
  {name:'accept an internal code as a description',from:"text.toLowerCase()===code.toLowerCase()?'':text",to:'text'}
],results=[];
try {
  for(const name of [file,'src/stock-check/line-matching.js',test]) {await fs.mkdir(path.dirname(path.join(temporary,name)),{recursive:true});await fs.copyFile(name,path.join(temporary,name));}
  await fs.writeFile(path.join(temporary,'package.json'),'{"type":"module"}');
  const run=()=>spawnSync(process.execPath,['--test',test],{cwd:temporary,encoding:'utf8',timeout:30000});
  const baseline=run();if(baseline.status!==0) {throw new Error('Description mutation baseline failed: '+baseline.stdout);}
  for(const mutant of mutants) {
    if(source.split(mutant.from).length!==2) {throw new Error('Mutation target is not unique: '+mutant.name);}
    await fs.writeFile(path.join(temporary,file),source.replace(mutant.from,mutant.to));
    const result=run(),killed=result.status!==0&&/not ok \d/u.test(result.stdout)&&!/(SyntaxError|ERR_MODULE_NOT_FOUND)/u.test(result.stderr);
    results.push({name:mutant.name,killed});await fs.writeFile('test-artifacts/stock-check-description/mutant-'+results.length+'.log',result.stdout+result.stderr);
  }
  const sourceUnchanged=await fs.readFile(file,'utf8')===source;
  await fs.writeFile('test-artifacts/stock-check-description/mutations.json',JSON.stringify({results,sourceUnchanged},null,2));
  console.log(JSON.stringify({total:results.length,killed:results.filter(row=>row.killed).length,sourceUnchanged}));
  if(!sourceUnchanged||results.some(row=>!row.killed)) {process.exitCode=1;}
} finally {await fs.rm(temporary,{recursive:true,force:true});}
