import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,cpSync,rmSync,symlinkSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const out=resolve('test-artifacts/regular-waitlist'),root=process.cwd(),scratch=mkdtempSync(resolve(tmpdir(),'waitlist-enhancement-mutants-'));
mkdirSync(out+'/enhancement-mutations',{recursive:true});
const files=JSON.parse(readFileSync('tools/regular-waitlist-files.json')),hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const originalHashes=Object.fromEntries(files.map(file=>[file,hash(file)]));
const property='test/mbt/property/regular-waitlist-list.property.test.js',repo='test/mbt/integration/regular-waitlist-enhancements.test.js';
const mutants=[
  {name:'combined-filters-use-or',file:'public/scm-waitlist-list.js',from:'filterFields.every(',to:'filterFields.some(',tests:[property],property:true},
  {name:'quantities-sort-as-text',file:'public/scm-waitlist-list.js',from:'Number(a[sortBy])-Number(b[sortBy])',to:'String(a[sortBy]).localeCompare(String(b[sortBy]))',tests:[property],property:true},
  {name:'rejected-holds-not-returned',file:'src/regular-waitlist-repository.js',from:'for(const hold of holds)await releaseEvent(hold,',to:'if(!scmReject)for(const hold of holds)await releaseEvent(hold,',tests:[repo]},
  {name:'rejection-notice-not-unread',file:'src/regular-waitlist-repository.js',from:'{notify:scmReject}',to:'{notify:false}',tests:[repo]},
  {name:'reject-allows-active-conversion',file:'src/regular-waitlist-repository.js',from:"return command((scmReject?'reject:':'close:')+id,normalized,context,async()=>{\n      await assertNotConverting(id);",to:"return command((scmReject?'reject:':'close:')+id,normalized,context,async()=>{\n      if(!scmReject)await assertNotConverting(id);",tests:[repo]},
  {name:'recent-po-order-reversed',file:'src/regular-waitlist-supply.js',from:'PARTITION BY item_id ORDER BY queued_at DESC NULLS LAST,id DESC',to:'PARTITION BY item_id ORDER BY queued_at ASC NULLS LAST,id DESC',tests:[repo]},
  {name:'delivery-date-wrong-netsuite-field',file:'src/regular-waitlist-netsuite.js',from:'payload.custbody4=fulfillment.deliveryDate;',to:'payload.custbody5=fulfillment.deliveryDate;',tests:['test/mbt/unit/regular-waitlist-netsuite.test.js']}
];
const results=[];
try{
  for(const folder of ['src','public','migrations','test','tools'])cpSync(folder,scratch+'/'+folder,{recursive:true});
  for(const file of ['package.json','package-lock.json','netsuite-smart-scm-picking-ticket-restlet.js'])cpSync(file,scratch+'/'+file);
  symlinkSync(resolve('node_modules'),scratch+'/node_modules','dir');
  for(const mutant of mutants){
    const path=scratch+'/'+mutant.file,original=readFileSync(path,'utf8');assert.equal(original.split(mutant.from).length,2,'Unique mutant: '+mutant.name);
    const runs=[];
    try{
      writeFileSync(path,original.replace(mutant.from,mutant.to));
      for(const testFile of mutant.tests){
        const result=spawnSync(process.execPath,['tools/regular-waitlist-focused.mjs','--file',testFile,'--no-coverage'],{cwd:scratch,env:{...process.env,NODE_V8_COVERAGE:''},encoding:'utf8',timeout:120000,maxBuffer:15000000});
        const log=(result.stdout||'')+(result.stderr||'');writeFileSync(out+'/enhancement-mutations/'+mutant.name+'.log',log);
        assert(!result.error&&!result.signal,'Mutant must finish normally');assert(/ℹ fail [1-9]\d*/u.test(log)&&result.status!==0,'Surviving mutant: '+mutant.name);
        const failedTests=log.split('\n').filter(line=>/^✖ /u.test(line)&&!line.includes('failing tests'));
        if(mutant.property)assert(failedTests.some(line=>line.startsWith('✖ property:')),'Generated properties must kill this mutant');
        runs.push({testFile,exitCode:result.status,killed:true,failedTests});
      }
    }finally{writeFileSync(path,original);assert.equal(hash(path),hash(root+'/'+mutant.file));}
    results.push({name:mutant.name,file:mutant.file,runs});console.log(JSON.stringify(results.at(-1)));
  }
}finally{
  rmSync(scratch,{recursive:true,force:true});assert.deepEqual(Object.fromEntries(files.map(file=>[file,hash(file)])),originalHashes);
  writeFileSync(out+'/enhancement-mutations.json',JSON.stringify({mutants:results.length,allKilled:results.length===mutants.length,sourceHashes:originalHashes,results},null,2));
}
