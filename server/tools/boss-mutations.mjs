import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import crypto from 'node:crypto';
const root=process.cwd(),directory=await fs.mkdtemp(path.join(os.tmpdir(),'boss-mutants-'));
const unit=['test/mbt/unit/boss-approval-domain.test.js','test/mbt/unit/boss-approval-service.test.js','test/mbt/unit/boss-approval-refresh-gate.test.js'];
const integration='test/mbt/integration/boss-approvals.test.js';
const mutants=[
 ['all owners shared','src/boss-approval-domain.js','(matching ? [matching] : roster)','(roster)',unit],
 ['inactive owner allowed','src/boss-approval-domain.js','p.operatorId && p.active &&','p.operatorId &&',unit],
 ['pending counted as approved','src/boss-approval-service.js','APPROVED_SO_STATUSES.includes(snapshot.status)','(snapshot.status === "A" || APPROVED_SO_STATUSES.includes(snapshot.status))',unit],
 ['observation hook disabled','src/netsuite-delayed-status-refresh-service.js','&& dependencies.onStatusObserved) {','&& false) {',unit],
 ['expired lease accepted','src/boss-approval-repository.js','&&new Date(source.lease_until)>new Date()','',[integration]],
 ['pending notifications visible to all recipients','src/boss-approval-repository.js',"(r.status NOT IN ('pending','processing') OR",'(true OR',[integration]]
];
const hash=data=>crypto.createHash('sha256').update(data).digest('hex');
const results=[];
try {
 await fs.cp('src',path.join(directory,'src'),{recursive:true});
 await fs.cp('migrations',path.join(directory,'migrations'),{recursive:true});
 await fs.symlink(path.join(root,'node_modules'),path.join(directory,'node_modules'));
 await fs.writeFile(path.join(directory,'package.json'),'{"type":"module"}');
 for(const file of [...unit,integration]){await fs.mkdir(path.dirname(path.join(directory,file)),{recursive:true});await fs.copyFile(file,path.join(directory,file));}
 for(const [name,file,from,to,tests] of mutants){
  const original=await fs.readFile(file,'utf8');assert(original.includes(from),`Mutation anchor missing: ${name}`);
  const target=path.join(directory,file);await fs.writeFile(target,original.replace(from,to));
  const run=spawnSync(process.execPath,['--test','--test-concurrency=1',...tests],{cwd:directory,encoding:'utf8',timeout:60000,env:process.env});
  const property=spawnSync(process.execPath,['--test','--test-name-pattern=property:',...unit],{cwd:directory,encoding:'utf8',timeout:60000,env:process.env});
  results.push({name,killed:run.status!==0,propertyKilled:property.status!==0});
  await fs.writeFile(`test-artifacts/boss-approvals/mutant-${results.length}.log`,run.stdout+run.stderr);
  await fs.writeFile(target,original);assert.equal(hash(await fs.readFile(file)),hash(original),'Original source changed during isolated mutation');
 }
 await fs.writeFile('test-artifacts/boss-approvals/mutations.json',JSON.stringify(results,null,2));
 process.stdout.write(JSON.stringify(results,null,2)+'\n');assert(results.every(result=>result.killed),'A deliberate mutant survived');
}finally{await fs.rm(directory,{recursive:true,force:true});}
