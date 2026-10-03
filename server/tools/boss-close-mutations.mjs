import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
const root=process.cwd(),directory=await fs.mkdtemp(path.join(os.tmpdir(),'boss-close-mutants-'));
const artifact='test-artifacts/boss-reject-close-20261003';await fs.mkdir(artifact,{recursive:true});
const unit='test/mbt/unit/boss-reject-close.test.js',integration='test/mbt/integration/boss-approvals.test.js';
const mutations=[
 {name:'send approval instead of closure',file:'src/boss-approval-service.js',from:"command.action==='reject'?remote.close:remote.approve",to:'remote.approve',test:unit,pattern:'Reject sends|property:',property:true},
 {name:'claim closure for approved status',file:'src/boss-approval-service.js',from:"command.action==='reject'&&snapshot.status==='H'",to:"command.action==='reject'&&snapshot.status==='B'",test:unit,pattern:'Reject sends|property:',property:true},
 {name:'close adjacent line IDs',file:'src/boss-approval-netsuite.js',from:'line:positiveId(line.line),isClosed:true',to:'line:positiveId(line.line)+1,isClosed:true',test:unit,pattern:'native close uses|property:',property:true},
 {name:'skip authority check inside close queue',file:'src/boss-approval-netsuite.js',from:'items=closeItems(order,id,expectedVersion);\n        await beforeSend();',to:'items=closeItems(order,id,expectedVersion);',test:unit,pattern:'native close uses|invalid or truncated'},
 {name:'overwrite rejected financial snapshot with readback',file:'src/boss-approval-repository.js',from:'external?r.snapshot:owned.snapshot',to:'external?r.snapshot:snapshot',test:integration,pattern:'first shared decision'}
];
const results=[];
function run(targetTest,pattern){
 const result=spawnSync(process.execPath,['--test','--test-name-pattern='+pattern,targetTest],{cwd:directory,encoding:'utf8',timeout:60000});
 return {log:(result.stdout||'')+(result.stderr||''),status:result.status};
}
try{
 for(const folder of ['src','public','test']){await fs.cp(folder,path.join(directory,folder),{recursive:true});}
 await fs.symlink(path.join(root,'node_modules'),path.join(directory,'node_modules'));await fs.writeFile(path.join(directory,'package.json'),'{"type":"module"}');
 for(const mutation of mutations){
  const {name,file,from,to,test:targetTest,pattern}=mutation,original=await fs.readFile(file,'utf8');assert(original.includes(from),name);
  const target=path.join(directory,file);await fs.writeFile(target,original.replace(from,to));
  const tested=run(targetTest,pattern);await fs.writeFile(artifact+'/mutant-'+(results.length+1)+'.log',tested.log);
  const result={name,killed:tested.status!==0&&/not ok/.test(tested.log),propertyKilled:null};
  if(mutation.property){
   const property=run(targetTest,'property:');await fs.writeFile(artifact+'/mutant-'+(results.length+1)+'-property.log',property.log);
   result.propertyKilled=property.status!==0&&/not ok/.test(property.log);
  }
  results.push(result);await fs.writeFile(target,original);assert.equal(await fs.readFile(file,'utf8'),original);
 }
 await fs.writeFile(artifact+'/mutations.json',JSON.stringify(results,null,2));process.stdout.write(JSON.stringify(results,null,2)+'\n');
 assert(results.every(r=>r.killed&&r.propertyKilled!==false));
}finally{await fs.rm(directory,{recursive:true,force:true});}
