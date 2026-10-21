import {cpSync,mkdtempSync,mkdirSync,readFileSync,writeFileSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const directory=mkdtempSync(path.join(tmpdir(),'attention-mutants-'));
cpSync('src',path.join(directory,'src'),{recursive:true});
cpSync('tools/netsuite-attention-20261003',path.join(directory,'tools/netsuite-attention-20261003'),{recursive:true});
mkdirSync(path.join(directory,'test/mbt/unit'),{recursive:true});
const tests=['netsuite-attention-properties.test.js','netsuite-attention-first-split.test.js','netsuite-attention-recovery-proof.test.js',
 'sales-order-auto-fulfillment-service.red.test.js'].map(f=>'test/mbt/unit/'+f);
for(const test of tests)cpSync(test,path.join(directory,test));
writeFileSync(path.join(directory,'package.json'),'\u007b"type":"module"\u007d');
symlinkSync(path.resolve('node_modules'),path.join(directory,'node_modules'));
const mutants=[
 ['waiting work posts','src/sales-order-auto-fulfillment-service.js','["queued", "uncertain"].includes(candidate.status)','["queued", "uncertain", "waiting_evidence"].includes(candidate.status)'],
 ['recovery can transform','src/sales-order-auto-fulfillment-service.js','if (explicitRecovery && !preRecoveredRecord && !splitRecovery)','if (false)'],
 ['billing selects no exclusions','src/netsuite-fulfillment-exclusions.js',"row.item_type==='NonInvtPart'","row.item_type==='InvtPart'"],
 ['split posts parent quantity','src/sales-order-fulfillment-first-split.js','target_quantity:quantity','target_quantity:line.target_quantity'],
 ['split ignores item identity','src/sales-order-fulfillment-first-split.js','&& Number(line.item_id)===Number(item.itemId)',''],
 ['wrong unit factor','tools/netsuite-attention-20261003/verify-reviewed-existing.mjs','Number(original.quantity)/factor','Number(original.quantity)*factor']
];
const results=[];
for(const [name,file,before,after] of mutants){
 const target=path.join(directory,file),original=readFileSync(target,'utf8');
 if(!original.includes(before))throw new Error('Missing mutant '+name);
 writeFileSync(target,original.replace(before,after));
 try{
  const full=spawnSync(process.execPath,['--test',...tests],{cwd:directory,encoding:'utf8',timeout:30000});
  const properties=spawnSync(process.execPath,['--test','--test-name-pattern=property:',...tests],{cwd:directory,encoding:'utf8',timeout:30000});
  results.push({name,killed:full.status===1,propertyKilled:properties.status===1});
 }finally{writeFileSync(target,original);}
}
writeFileSync('test-artifacts/netsuite-attention-20261003/mutation.json',JSON.stringify(results,null,2)+'\n');
console.log(JSON.stringify(results));if(results.some(r=>!r.killed||!r.propertyKilled))process.exitCode=1;
