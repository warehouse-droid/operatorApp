import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
const root=process.cwd(),directory=await fs.mkdtemp(path.join(os.tmpdir(),'staff-reset-mutants-'));
const artifact='test-artifacts/staff-login-reset-20261003';await fs.mkdir(artifact,{recursive:true});
const unit='test/mbt/unit/boss-credit-display.test.js',integration='test/mbt/integration/password-reset.test.js';
const mutations=[
 ['accept expired codes','src/password-reset-service.js','timestamp(row.code_expires_at)<=now()','timestamp(row.code_expires_at)<now()',integration],
 ['allow resend at 19 seconds','src/password-reset-service.js','lockedTime+20000','lockedTime+19000',integration],
 ['permit sixth guess','src/password-reset-service.js','row.attempts>=5','row.attempts>=6',integration],
 ['reuse verified code','src/password-reset-service.js','SET code_hash=NULL,code_expires_at=NULL,','SET code_hash=code_hash,code_expires_at=code_expires_at,',integration],
 ['drop leading zeroes','src/password-reset-service.js',".padStart(6,'0')",'',integration],
 ['ignore unbilled orders','src/boss-approval-domain.js','addAmounts([balance, unbilledOrders])','addAmounts([balance])',unit],
 ['add owed to credit','src/boss-approval-domain.js',"used.slice(1) : '-' + used","used.slice(1) : used",unit],
 ['round credit to whole dollars','src/boss-approval-domain.js','creditBalance: addAmounts([creditLimit, currentOwed])','creditBalance: String(Math.round(Number(addAmounts([creditLimit, currentOwed]))))',unit]
];
const results=[];
try{
 await fs.cp('src',path.join(directory,'src'),{recursive:true});await fs.cp('public',path.join(directory,'public'),{recursive:true});
 await fs.symlink(path.join(root,'node_modules'),path.join(directory,'node_modules'));await fs.writeFile(path.join(directory,'package.json'),'{"type":"module"}');
 for(const file of [unit,integration]){await fs.mkdir(path.dirname(path.join(directory,file)),{recursive:true});await fs.copyFile(file,path.join(directory,file));}
 for(const [name,file,from,to,testFile] of mutations){
  const original=await fs.readFile(file,'utf8');assert(original.includes(from),name);const target=path.join(directory,file);await fs.writeFile(target,original.replaceAll(from,to));
  const run=spawnSync(process.execPath,['--test',testFile],{cwd:directory,encoding:'utf8',timeout:60000});
  const property=spawnSync(process.execPath,['--test','--test-name-pattern=property:',testFile],{cwd:directory,encoding:'utf8',timeout:60000});
  await fs.writeFile(`${artifact}/mutant-${results.length+1}.log`,run.stdout+run.stderr);results.push({name,killed:run.status!==0,propertyKilled:property.status!==0});
  await fs.writeFile(target,original);assert.equal(await fs.readFile(file,'utf8'),original);
 }
 await fs.writeFile(`${artifact}/mutations.json`,JSON.stringify(results,null,2));process.stdout.write(JSON.stringify(results,null,2)+'\n');assert(results.every(r=>r.killed));
}finally{await fs.rm(directory,{recursive:true,force:true});}
