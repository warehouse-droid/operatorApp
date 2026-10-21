import {cpSync,mkdtempSync,mkdirSync,readFileSync,writeFileSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const directory=mkdtempSync(path.join(tmpdir(),'to-posting-mutants-'));
cpSync('src',path.join(directory,'src'),{recursive:true});
cpSync('test/fixtures/to-line-reference-20261003',path.join(directory,'test/fixtures/to-line-reference-20261003'),{recursive:true});
mkdirSync(path.join(directory,'test/mbt/unit'),{recursive:true});
const tests=['test/mbt/unit/to-posting-reference.test.js','test/mbt/unit/transfer-order-background-posting.test.js'];
for(const test of tests)cpSync(test,path.join(directory,test));
writeFileSync(path.join(directory,'package.json'),'{"type":"module"}');
symlinkSync(path.resolve('node_modules'),path.join(directory,'node_modules'));
const mutants=[
 ['wrong transfer leg','src/netsuite-transfer-posting-line.js','lines.filter(line => line.hidden)','lines.filter(line => !line.hidden)'],
 ['quantity inflation','src/transfer-order-posting-domain.js','quantity=Number(local.quantity)','quantity=Number(local.quantity)+1'],
 ['missing Operator evidence','src/transfer-order-posting-domain.js','if (!job.operator_record_id)','if (false)'],
 ['pickup accepted as dropoff','src/transfer-order-posting-domain.js',"&& event.stop_type==='dropoff'",''],
 ['wrong dispatch plan','src/transfer-order-posting-domain.js','&& (!job.snapshot.planId || String(event.plan_id)===String(job.snapshot.planId))','']
];
const results=[];
for(const [name,file,before,after] of mutants){
 const target=path.join(directory,file),original=readFileSync(target,'utf8');
 if(!original.includes(before))throw new Error(`Mutation target missing: ${name}`);
 writeFileSync(target,original.replace(before,after));
 try{
  const full=spawnSync(process.execPath,['--test',...tests],{cwd:directory,encoding:'utf8',timeout:30000});
  const properties=spawnSync(process.execPath,['--test','--test-name-pattern=property:',...tests],{cwd:directory,encoding:'utf8',timeout:30000});
  results.push({name,killed:full.status===1,propertyKilled:properties.status===1});
 }finally{writeFileSync(target,original);}
}
writeFileSync('test-artifacts/to-line-reference-20261003/mutation.json',JSON.stringify(results,null,2)+'\n');
console.log(JSON.stringify(results,null,2));
if(results.some(result=>!result.killed||!result.propertyKilled))process.exitCode=1;
