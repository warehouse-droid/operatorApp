import fs from 'node:fs';
import {spawn} from 'node:child_process';
fs.mkdirSync('test-artifacts/regression',{recursive:true});
const results=[];
for(const script of ['test:mbt','typecheck:mbt','lint:mbt']){
 const file=`test-artifacts/regression/${script.replaceAll(':','-')}.log`,fd=fs.openSync(file,'w'),start=Date.now();
 const child=spawn('npm',['run',script],{stdio:['ignore',fd,fd],env:process.env});
 const watchdog=script==='test:mbt'?spawn(process.execPath,['tools/request-loading-20261008/watchdog.mjs',file,String(child.pid)],{stdio:['ignore',fd,fd]}):null;
 const r=await new Promise(resolve=>child.once('exit',(status,signal)=>resolve({status,signal})));watchdog?.kill();fs.closeSync(fd);
 const row={script,exit:r.status,signal:r.signal,ms:Date.now()-start,file};results.push(row);console.log(JSON.stringify(row));
 fs.writeFileSync('test-artifacts/regression/stages.json',JSON.stringify(results,null,2));
}
