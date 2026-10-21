import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
const file='src/stock-check/line-matching.js',test='test/mbt/property/stock-check-lines.property.test.js';
const original=await fs.readFile(file,'utf8'),hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'stock-check-lines-mutants-'));
const mutants=[
  {name:'reuse availability after quantity changes',from:'line.vendorReference,line.quantity,line.uom',to:'line.vendorReference,1,line.uom'},
  {name:'select the first ambiguous variant',from:'matches.length===1?',to:'matches.length>=1?'},
  {name:'show checks for every vendor',from:"test(String(name??'').trim())",to:"test('Unilock')"},
  {name:'ignore missing colour on descriptive matches',from:'normalized(line.color)===normalized(product.colour) && normalized(line.size)',to:'true && normalized(line.size)'}
];
const results=[];
try {
  for(const name of [file,test]) {await fs.mkdir(path.dirname(path.join(temporary,name)),{recursive:true});await fs.copyFile(name,path.join(temporary,name));}
  await fs.writeFile(path.join(temporary,'package.json'),'{"type":"module"}');await fs.symlink(path.resolve('node_modules'),path.join(temporary,'node_modules'));
  const run=()=>spawnSync(process.execPath,['--test',test],{cwd:temporary,encoding:'utf8',timeout:30000});
  const baseline=run();if(baseline.status!==0) {throw new Error('The property suite must pass before mutation: '+baseline.stdout+baseline.stderr);}
  for(const mutant of mutants) {
    if(original.split(mutant.from).length!==2) {throw new Error('Mutation target is not unique: '+mutant.name);}
    await fs.writeFile(path.join(temporary,file),original.replace(mutant.from,mutant.to));
    const result=run(),killed=result.status!==0&&/not ok \d/u.test(result.stdout)&&!/(SyntaxError|ERR_MODULE_NOT_FOUND)/u.test(result.stderr);
    results.push({name:mutant.name,killed});
    await fs.writeFile('test-artifacts/stock-check/lines-mutant-'+results.length+'.log',result.stdout+result.stderr);
  }
  if(hash(await fs.readFile(file))!==hash(original)) {throw new Error('Original matching source changed.');}
  await fs.writeFile('test-artifacts/stock-check/lines-mutations.json',JSON.stringify({results,sourceUnchanged:true},null,2));
  console.log(JSON.stringify({mutants:results.length,killed:results.filter(row=>row.killed).length,sourceUnchanged:true}));
  if(results.some(row=>!row.killed)) {process.exitCode=1;}
} finally {await fs.rm(temporary,{recursive:true,force:true});}
