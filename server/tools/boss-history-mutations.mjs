import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
const root=process.cwd(),directory=await fs.mkdtemp(path.join(os.tmpdir(),'boss-history-mutants-'));
const artifact='test-artifacts/boss-search-history-20261003';await fs.mkdir(artifact,{recursive:true});
const integration='test/mbt/integration/boss-search-history.test.js',browser='test/mbt/integration/boss-history-browser.test.js';
const mutations=[
 {name:'search only selected tab',file:'src/boss-approval-repository.js',from:'search?`(${pending} OR ${completed})`:history?completed:pending',to:'history?completed:pending',test:integration,pattern:'search from either|property:',property:true},
 {name:'treat search wildcard text as patterns',file:'src/boss-approval-repository.js',from:"search.replace(/[\\\\%_]/g,'\\\\$&')",to:'search',test:integration,pattern:'paginates|property:',property:true},
 {name:'replace reviewed figures with post-approval read-back',file:'src/boss-approval-repository.js',from:'external?r.snapshot:owned.snapshot',to:'external?r.snapshot:snapshot',test:integration,pattern:'approval retains the reviewed snapshot'},
 {name:'trust mutated worker snapshot',file:'src/boss-approval-repository.js',from:'external?r.snapshot:owned.snapshot',to:'external?r.snapshot:command.snapshot',test:integration,pattern:'finalization uses the persisted command'},
 {name:'render audit details as HTML',file:'public/control.js',from:'escapeHtml(JSON.stringify(row.details || {}, null, 2))',to:'JSON.stringify(row.details || {}, null, 2)',test:browser,pattern:'Admin audit'}
];
const results=[];
try{
 for(const folder of ['src','public','test']){await fs.cp(folder,path.join(directory,folder),{recursive:true});}
 await fs.symlink(path.join(root,'node_modules'),path.join(directory,'node_modules'));await fs.writeFile(path.join(directory,'package.json'),'{"type":"module"}');
 for(const mutation of mutations){
  const {name,file,from,to,test:targetTest,pattern}=mutation,original=await fs.readFile(file,'utf8');assert(original.includes(from),name);
  const target=path.join(directory,file);await fs.writeFile(target,original.replace(from,to));
  const run=spawnSync(process.execPath,['--test','--test-name-pattern='+pattern,targetTest],{cwd:directory,encoding:'utf8',timeout:60000});
  const log=(run.stdout||'')+(run.stderr||'');await fs.writeFile(`${artifact}/mutant-${results.length+1}.log`,log);
  const result={name,killed:run.status!==0&&/not ok/.test(log),propertyKilled:null};
  if(mutation.property){
   const property=spawnSync(process.execPath,['--test','--test-name-pattern=property:',targetTest],{cwd:directory,encoding:'utf8',timeout:60000});
   await fs.writeFile(`${artifact}/mutant-${results.length+1}-property.log`,(property.stdout||'')+(property.stderr||''));
   result.propertyKilled=property.status!==0&&/not ok/.test(property.stdout||'');
  }
  results.push(result);await fs.writeFile(target,original);assert.equal(await fs.readFile(file,'utf8'),original);
 }
 await fs.writeFile(`${artifact}/mutations.json`,JSON.stringify(results,null,2));process.stdout.write(JSON.stringify(results,null,2)+'\n');assert(results.every(r=>r.killed));
}finally{await fs.rm(directory,{recursive:true,force:true});}
