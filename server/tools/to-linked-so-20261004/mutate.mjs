import {cpSync,mkdtempSync,mkdirSync,readFileSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const directory=mkdtempSync('/tmp/to-linked-so-mutants-');
const tests=['test/mbt/unit/to-linked-so-completion.test.js','test/mbt/unit/transfer-order-background-posting.test.js'];
const mutants=[
 ['missing group member allowed','src/transfer-order-posting-domain.js','selected.some((/** @type {unknown} */ event)=>!event)','false'],
 ['one SO authorizes another','src/transfer-order-posting-domain.js','String(event.order_ref).toUpperCase()===ref','true'],
 ['wrong load accepted','src/transfer-order-posting-domain.js','&& (!job.snapshot.loadId || event.load_id===job.snapshot.loadId)',''],
 ['pickup accepted','src/transfer-order-posting-domain.js',"&& event.stop_type==='dropoff'",''],
 ['date object corrupted','src/transfer-order-posting-link-domain.js','value.toISOString().slice(0,10)','String(value).slice(0,10)'],
 ['cancelled plan accepted','src/transfer-order-posting-link-domain.js','|| d.plan_active===false','']
];
try {
 cpSync('src',path.join(directory,'src'),{recursive:true});cpSync('public',path.join(directory,'public'),{recursive:true});
 mkdirSync(path.join(directory,'test/mbt/unit'),{recursive:true});
 for(const test of tests)cpSync(test,path.join(directory,test));
 writeFileSync(path.join(directory,'package.json'),'{"type":"module"}');symlinkSync(path.resolve('node_modules'),path.join(directory,'node_modules'));
 const results=[];
 for(const [name,file,before,after] of mutants){
  const target=path.join(directory,file),original=readFileSync(target,'utf8');if(!original.includes(before))throw new Error('Missing mutant '+name);
  writeFileSync(target,original.replace(before,after));
  try {
   const full=spawnSync(process.execPath,['--test',...tests],{cwd:directory,encoding:'utf8',timeout:30000});
   const property=spawnSync(process.execPath,['--test','--test-name-pattern=property:',...tests],{cwd:directory,encoding:'utf8',timeout:30000});
   results.push({name,killed:full.status===1,propertyKilled:property.status===1});
  }finally{writeFileSync(target,original);}
 }
 mkdirSync(path.join(directory,'test/mbt/integration'),{recursive:true});
 const integration='test/mbt/integration/to-linked-so-completion.test.js';cpSync(integration,path.join(directory,integration));
 const baseline=spawnSync(process.execPath,['tools/to-line-reference-20261003/focused.mjs',process.execPath,'--test',path.join(directory,integration)],
  {encoding:'utf8',timeout:30000});
 writeFileSync('test-artifacts/to-linked-so-20261004/mutation-database-baseline.log',baseline.stdout+baseline.stderr);
 if(baseline.status!==0)throw new Error('Unmutated database copy must pass before mutation results are valid');
 for(const [name,file,before,after] of [
  ['replaced second completion accepted','src/transfer-order-posting-repository.js','|| (job.snapshot.driverTarget && JSON.stringify(linkedIds)!==JSON.stringify(job.snapshot.completionEventIds))',''],
  ['completed IF reopens','src/transfer-order-posting-service.js',"['attention','completed'].includes(job.status)","job.status==='attention'"],
  ['stale Admin retry reopens IF','src/transfer-order-posting-service.js',"if(job.status==='completed'){return job;}",''],
  ['removed Driver SO remains effective','src/transfer-order-posting-repository.js','AND d.order_refs ? e.order_ref',''],
  ['changed Driver date remains effective','src/transfer-order-posting-repository.js','AND d.plan_date IS NOT DISTINCT FROM e.plan_date','']
 ]) {
  const target=path.join(directory,file),original=readFileSync(target,'utf8');if(!original.includes(before))throw new Error('Missing mutant '+name);
  writeFileSync(target,original.replace(before,after));
  try {
   const result=spawnSync(process.execPath,['tools/to-line-reference-20261003/focused.mjs',process.execPath,'--test',path.join(directory,integration)],
    {encoding:'utf8',timeout:30000});
   results.push({name,killed:result.status===1,propertyKilled:null,layer:'real database integration'});
  }finally{writeFileSync(target,original);}
 }
 writeFileSync('test-artifacts/to-linked-so-20261004/mutation.json',JSON.stringify(results,null,2)+'\n');console.log(JSON.stringify(results));
 if(results.some(r=>!r.killed||r.propertyKilled===false))process.exitCode=1;
}finally{rmSync(directory,{recursive:true,force:true});}
