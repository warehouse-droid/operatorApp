import fs from 'node:fs';
import {spawnSync} from 'node:child_process';

fs.mkdirSync('test-artifacts/rebase',{recursive:true});
const stages=[];
for(const [name,command,args] of [
  ['delivery','node',['tools/delivery-linkage-tests.mjs']],
  ['po-sales','node',['tools/special-po-sales-tests.mjs']],
  ['types','npm',['run','typecheck:mbt']]
]) {
  const file=fs.openSync(`test-artifacts/rebase/${name}.log`,'w'),started=Date.now();
  const result=spawnSync(command,args,{stdio:['ignore',file,file],env:process.env,timeout:360000});
  fs.closeSync(file);
  const row={name,exit:result.status,signal:result.signal,ms:Date.now()-started};
  stages.push(row);console.log(JSON.stringify(row));
  fs.writeFileSync('test-artifacts/rebase/stages.json',JSON.stringify(stages,null,2));
}
process.exitCode=stages.some(row=>row.name!=='types' && row.exit!==0)?1:0;
