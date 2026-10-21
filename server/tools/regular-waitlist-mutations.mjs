import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,cpSync,rmSync,symlinkSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const out=resolve('test-artifacts/regular-waitlist'),root=process.cwd(),scratch=mkdtempSync(resolve(tmpdir(),'waitlist-mutations-'));
mkdirSync(out+'/mutations',{recursive:true});
const files=JSON.parse(readFileSync('tools/regular-waitlist-files.json'));
const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const originalHashes=Object.fromEntries(files.map(file=>[file,hash(file)]));
const unit='test/mbt/unit/regular-waitlist-domain.test.js',property='test/mbt/property/regular-waitlist.property.test.js',repo='test/mbt/integration/regular-waitlist-repository.test.js';
const mutants=[
  {name:'committed-stock-returned',file:'src/regular-waitlist-domain.js',from:"if(allocation.status === 'committed')convertedQty += quantity;",to:"if(allocation.status === 'committed')convertedQty += 0;",tests:[unit,property]},
  {name:'partial-conversion-restores-demand',file:'src/regular-waitlist-domain.js',from:'Math.max(0,requestedQty-convertedQty)',to:'Math.max(0,requestedQty)',tests:[unit,property]},
  {name:'automatic-release-without-competitor',file:'src/regular-waitlist-domain.js',from:'age>=WAITLIST_AUTO_RELEASE_MS && hasCompetingDemand',to:'age>=WAITLIST_AUTO_RELEASE_MS',tests:[unit,property]},
  {name:'selling-yard-priority-reversed',file:'src/regular-waitlist-domain.js',from:'group(a)-group(b)',to:'group(b)-group(a)',tests:[unit,property]},
  {name:'duplicate-command-reapplied',file:'src/regular-waitlist-repository.js',from:'if(previous){',to:'if(false && previous){',tests:[repo]},
  {name:'concurrent-ledger-not-serialized',file:'src/regular-waitlist-repository.js',from:'await query("SELECT pg_advisory_xact_lock(hashtextextended(\'regular-waitlist-ledger\',0))");',to:'await Promise.resolve();',tests:[repo]},
  {name:'native-pricing-overridden',file:'src/regular-waitlist-netsuite.js',from:'quantity:waitlistQuantity(operation.quantity),units:',to:'price:{id:"-1"},rate:1,quantity:waitlistQuantity(operation.quantity),units:',tests:['test/mbt/unit/regular-waitlist-netsuite.test.js']},
  {name:'conversion-reposted-after-uncertain-response',file:'src/regular-waitlist-service.js',from:'if(operation.remoteStartedAt){',to:'if(false && operation.remoteStartedAt){',tests:['test/mbt/integration/regular-waitlist-safety.test.js']},
  {name:'startup-expiry-not-started',file:'src/server.js',from:'waitlistRuntime.start();',to:'/* waitlist runtime omitted */',tests:['test/mbt/integration/regular-waitlist-startup.test.js']},
  {name:'delivery-error-hidden',file:'public/regular-waitlist.js',from:'if(mount)mount.textContent=error.message;',to:"if(mount)mount.textContent='';",tests:['test/mbt/integration/regular-waitlist-http-browser.test.js']},
  {name:'old-actions-accept-waitlist',file:'src/stock-request-repository.js',from:"if(isWaitlist(request))throw waitlistError('Use Close to return unused waitlist allocations.','WAITLIST_WORKFLOW_ONLY',409);",to:'/* legacy cancel wrongly permits waitlist */',tests:['test/mbt/integration/regular-waitlist-legacy-guards.test.js']}
];
const results=[];
try{
  for(const folder of ['src','public','migrations','test','tools'])cpSync(folder,scratch+'/'+folder,{recursive:true});
  for(const file of ['package.json','package-lock.json','netsuite-smart-scm-picking-ticket-restlet.js'])cpSync(file,scratch+'/'+file);
  symlinkSync(resolve('node_modules'),scratch+'/node_modules','dir');
  for(const mutant of mutants){
    const path=scratch+'/'+mutant.file,original=readFileSync(path,'utf8');assert.equal(original.split(mutant.from).length,2,'Unique mutation target: '+mutant.name);
    const runs=[];
    try{
      writeFileSync(path,original.replace(mutant.from,mutant.to));
      for(const testFile of mutant.tests){
        const result=spawnSync(process.execPath,['tools/regular-waitlist-focused.mjs','--file',testFile,'--no-coverage'],{cwd:scratch,env:{...process.env,NODE_V8_COVERAGE:''},encoding:'utf8',timeout:120000,maxBuffer:15000000});
        const log=(result.stdout||'')+(result.stderr||''),label=mutant.name+'-'+testFile.split('/').at(-2);
        writeFileSync(out+'/mutations/'+label+'.log',log);
        assert(!result.error&&!result.signal,'Mutant must finish its assertions: '+label);
        assert(/ℹ tests [1-9]\d*/u.test(log)&&/ℹ fail [1-9]\d*/u.test(log),'Mutation must fail a real assertion: '+label);
        assert.notEqual(result.status,0,'Surviving mutation: '+label);
        runs.push({testFile,exitCode:result.status,killed:true,failedTests:log.split('\n').filter(line=>/^✖ /u.test(line)&&!line.includes('failing tests'))});
      }
    }finally{writeFileSync(path,original);assert.equal(hash(path),hash(root+'/'+mutant.file),'Mutation restored');}
    results.push({name:mutant.name,file:mutant.file,runs});console.log(JSON.stringify(results.at(-1)));
  }
}finally{
  rmSync(scratch,{recursive:true,force:true});
  assert.deepEqual(Object.fromEntries(files.map(file=>[file,hash(file)])),originalHashes,'Real source never mutated');
  writeFileSync(out+'/mutations.json',JSON.stringify({mutants:results.length,allKilled:results.length===mutants.length,sourceHashes:originalHashes,results},null,2));
}
