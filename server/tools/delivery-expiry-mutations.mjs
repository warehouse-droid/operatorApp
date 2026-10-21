import {cp,mkdtemp,mkdir,readFile,writeFile,symlink,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import path from 'node:path';
const scratch=await mkdtemp('/tmp/delivery-expiry-mutants-'),results=[];
const domain='src/delivery-request-domain.js',time='public/delivery-request-expiry-time.js';
const unit='test/mbt/unit/delivery-request-expiry-controls.test.js';
const browser='test/mbt/integration/delivery-request-expiry-controls.test.js';
const mutants=[
  {name:'override is ignored',file:domain,from:'expiryTime===undefined || expiryTime===\'\'',to:'true',property:true},
  {name:'Sales can manually expire',file:domain,from:"'set-expiry','expire'",to:"'set-expiry'"},
  {name:'manual expiry cancels instead',file:domain,from:"return {...row,status:'expired',approvalExpiresAt:null,reminderAt:null,reminderSentAt:null};",
    to:"return {...row,status:'cancelled',approvalExpiresAt:null,reminderAt:null,reminderSentAt:null};"},
  {name:'PM is parsed as AM',file:time,from:"suffix==='pm'?12:0",to:'0',property:true},
  {name:'past clock times become immediate deadlines',file:time,from:'candidate>instant',to:'candidate>=instant-86400000',property:true},
  {name:'Sales receives Dispatch expiry controls',file:'public/delivery-requests.js',
    from:"if(audience!=='dispatch' || !['submitted','proposed','preapproved'].includes(row.status))",
    to:"if(!['submitted','proposed','preapproved'].includes(row.status))",test:browser},
  {name:'Sales is not told the deadline changed',file:'public/delivery-request-alert.js',
    from:'Dispatch changed the approval deadline for this request. Add Sales or Transfer Orders before the new expiry.',
    to:'Open the request to review the update.',test:browser}
];
function run(pattern,file=unit) {
  const args=['--test'];if(pattern){args.push(`--test-name-pattern=${pattern}`);}args.push(file);
  if(file===browser) {
    args.splice(0,args.length,'--input-type=module','-e',
      `import {runNodeTestFilesIsolated} from ${JSON.stringify(path.resolve('test/support/test-database-isolation.mjs'))}; process.exitCode=await runNodeTestFilesIsolated([${JSON.stringify(browser)}],{label:'Expiry browser mutation'});`);
  }
  const result=spawnSync(process.execPath,args,{cwd:scratch,encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024,
    env:{...process.env,DELIVERY_UI_COVERAGE:'0',XDG_CONFIG_HOME:path.join(scratch,'config'),XDG_CACHE_HOME:path.join(scratch,'cache')}});
  return {result,killed:result.status!==0 && /not ok \d+ - |^✖ (?:expiry UI|expiry alerts)/m.test(result.stdout)};
}
try {
  for(const directory of ['src','public']) {await cp(directory,path.join(scratch,directory),{recursive:true});}
  for(const file of [unit,browser,'test/mbt/support/delivery-request-fixtures.js','test/mbt/support/delivery-request-database.js']) {
    await mkdir(path.dirname(path.join(scratch,file)),{recursive:true});await cp(file,path.join(scratch,file));
  }
  await writeFile(path.join(scratch,'package.json'),'{"type":"module"}\n');await symlink(path.resolve('node_modules'),path.join(scratch,'node_modules'));
  for(const mutant of mutants) {
    const target=path.join(scratch,mutant.file),original=await readFile(target,'utf8');
    assert.equal(original.split(mutant.from).length,2,`Unique mutation: ${mutant.name}`);
    const record={name:mutant.name,killed:false,restored:false};
    try {
      await writeFile(target,original.replace(mutant.from,mutant.to));
      const {result,killed}=run(mutant.pattern,mutant.test);record.killed=killed;
      await writeFile(`test-artifacts/expiry-mutant-${results.length+1}.log`,result.stdout+result.stderr);
      if(mutant.property) {record.propertyKilled=run('generated clock').killed;assert.ok(record.propertyKilled,mutant.name);}
    } finally {await writeFile(target,original);record.restored=(await readFile(target,'utf8'))===original;results.push(record);}
    assert.ok(record.killed,mutant.name);
  }
  assert.equal(run().result.status,0);
} finally {
  await writeFile('test-artifacts/mutations.json',JSON.stringify(results,null,2)+'\n');await rm(scratch,{recursive:true,force:true});
}
process.stdout.write(JSON.stringify(results)+'\n');
