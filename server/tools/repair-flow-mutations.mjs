import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
if(process.env.MBT_TEST_ISOLATED!=='1')throw new Error('Use the disposable Repair runner.');
const root='/app/test-artifacts/repair-flow-mutants';
const cases=[
 {name:'stock-delta-sign',file:'src/repair/purchase-orders.js',before:'(Number(usage.quantity_milli)-qty)*sign',after:'(qty-Number(usage.quantity_milli))*sign',test:'editing issued',property:true},
 {name:'excess-return',file:'src/repair/purchase-orders.js',before:'if(net-delta<0)',after:'if(net-delta< -1000000000)',test:'editing issued'},
 {name:'po-overorder',file:'src/repair/purchasing.js',before:"if(order)throw d.fail('PO quantity",after:"if(false&&order)throw d.fail('PO quantity",test:'PO races'},
 {name:'premature-vendor-bill',file:'src/repair/purchase-orders.js',before:"await refreshPartsEta(job);const saved=await save(job);",after:"await c.posting(null,'bill',{},po.id);await refreshPartsEta(job);const saved=await save(job);",test:'office places a local PO'},
 {name:'technician-cost-classification',file:'public/repair/domain.js',before:"return has(actor,'repair_office','admin');",after:"return has(actor,'repair_office','admin','repair_technician');",test:'office places a local PO'},
 {name:'cross-job-approval',file:'src/repair/repository.js',before:"SELECT * FROM repair_quotes WHERE job_id=$1 AND status<>'superseded' ORDER BY scope_number,version\",[job.id]",after:"SELECT * FROM repair_quotes WHERE request_id=$1 AND status<>'superseded' ORDER BY scope_number,version\",[job.requestId]",test:'one request lists once',suite:'quote-scopes.test.js'},
 {name:'incomplete-parent-receipt',file:'src/repair/jobs.js',before:"live.every(j=>j.status==='completed')",after:"live.some(j=>j.status==='completed')",test:'new issues do not stop',suite:'quote-scopes.test.js'},
 {name:'single-job-posting',file:'src/repair/worker.js',before:'quotes.flatMap(q=>q.lines)',after:'quotes.at(-1).lines',test:'new issues do not stop',suite:'quote-scopes.test.js'},
 {name:'requester-wrong-revision',file:'src/repair/repository.js',before:'publicRequest(actor,result.request),{revision:job.revision}',after:'publicRequest(actor,result.request)',test:'requester receives',suite:'request-rollup.test.js'}
];
const results=[];
for(const mutant of cases){
 const cwd=path.join(root,mutant.name);try{await fs.mkdir(path.join(cwd,'test/repair'),{recursive:true});await fs.cp('/app/src',path.join(cwd,'src'),{recursive:true});await fs.cp('/app/public/repair',path.join(cwd,'public/repair'),{recursive:true});await fs.symlink('/app/node_modules',path.join(cwd,'node_modules'));await fs.writeFile(path.join(cwd,'package.json'),'{"type":"module"}');
 for(const file of ['fixture.js','job-flow.test.js','quote-scopes.test.js','request-rollup.test.js'])await fs.copyFile('/app/test/repair/'+file,path.join(cwd,'test/repair',file));
 const target=path.join(cwd,mutant.file),source=await fs.readFile(target,'utf8');if(!source.includes(mutant.before))throw new Error('Missing mutant anchor: '+mutant.name);await fs.writeFile(target,source.replace(mutant.before,mutant.after));
 for(const pattern of [mutant.test,...mutant.property?['property: arbitrary issue']:[]]){const logPath=path.join(cwd,pattern.startsWith('property')?'property.log':'result.log'),log=await fs.open(logPath,'w');const child=spawn(process.execPath,['--test','--test-name-pattern='+pattern,'test/repair/'+(mutant.suite||'job-flow.test.js')],{cwd,env:process.env,stdio:['ignore',log.fd,log.fd],timeout:60000});const result=await new Promise(resolve=>child.on('exit',(code,signal)=>resolve({code,signal})));await log.close();const output=await fs.readFile(logPath,'utf8');const failures=output.split('\n').filter(line=>line.startsWith('not ok '));if(result.code!==1||result.signal||!failures.some(line=>line.includes(pattern)))throw new Error('Mutant not killed by its intended assertion: '+mutant.name+' '+output.slice(-2000));results.push({name:mutant.name,property:pattern.startsWith('property'),killed:true,trigger:failures[0]});}
 }finally{await fs.rm(cwd,{recursive:true,force:true});}
}
console.log(JSON.stringify({flowMutations:results,mutantsKilled:cases.length,propertyOnlyKilled:results.filter(r=>r.property).length}));
