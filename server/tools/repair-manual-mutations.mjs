import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {requireMutationBaseline} from './repair-mutation-baseline.mjs';
if(process.env.MBT_TEST_ISOLATED!=='1')throw new Error('Use the bounded disposable Repair runner.');
const cases=[
 {name:'prestart-work',file:'src/repair/actions.js',before:'d.requireJobStarted(job,phase);',after:'',test:'Start Job is enforced'},
 {name:'prestart-work-photo',file:'src/repair/repository.js',before:"if(input.kind==='work')d.requireJobStarted(job);",after:'',test:'Start Job is enforced'},
 {name:'completed-team-list',file:'src/repair/repository.js',before:'.filter(d.teamJobOpen)',after:'.filter(job=>!d.isRejectedJob(job))',test:'Start Job is enforced'},
 {name:'background-financial-post',file:'src/repair/runtime.js',before:'await push.tick();',after:"await (await import('./worker.js')).createRepairWorker({repo,adapter,enabled:()=>true,logger}).tick();await push.tick();",test:'background runtime never'},
 {name:'actual-workforce-authority',file:'src/repair/manual-posting.js',before:'api.correctWorkforce=async(actor,id,input)=>{office(actor);',after:'api.correctWorkforce=async(actor,id,input)=>{',test:'Office actual labour corrections'},
 {name:'actual-workforce-cost-leak',file:'src/repair/repository.js',before:"key!=='hourlyCostMinor'",after:'true',test:'Office actual labour corrections'},
 {name:'actual-workforce-audit-cost-leak',file:'src/repair/repository.js',before:"entry.kind==='actual_labour_corrected'?",after:"entry.kind==='ignored'?",test:'Office actual labour corrections'},
 {name:'quoted-wor-hours',file:'src/repair/netsuite.js',before:'custrecord152:actualHours,custrecord156:actualHours',after:'custrecord152:actualHours,custrecord156:line.quantityMilli/1000',test:'WOR uses actual workforce'},
 {name:'quoted-wor-hours-property',file:'src/repair/netsuite.js',before:'custrecord152:actualHours,custrecord156:actualHours',after:'custrecord152:actualHours,custrecord156:line.quantityMilli/1000',test:'property: actual hours',suite:'manual-netsuite'},
 {name:'parts-receipt-loses-start',file:'src/repair/purchasing.js',before:"job.status=job.data.phase==='repair'?'in_progress':'queuing';",after:"job.status='queuing';",test:'receiving parts preserves'},
 {name:'wrong-workforce-job-audit',file:'src/repair/manual-posting.js',before:"await event(actor,target,'actual_labour_corrected'",after:"await event(actor,s.child,'actual_labour_corrected'",test:'request-wide view'},
 {name:'missing-wor-sos-backlink',file:'src/repair/netsuite.js',before:"const linked=await update('customrecord_mbr_work_order',wor.id,{custrecord_wo_so:ref(sos.id)});",after:"const linked=await read('customrecord_mbr_work_order',wor.id);",test:'manual WOR sends actual',suite:'manual-netsuite'},
 {name:'local-parts-global-lock',file:'src/repair/repository.js',before:'if(!localPartsCommand(kind))',after:'if(true||!localPartsCommand(kind))',test:'local PO placement and receipt'},
 {name:'received-refresh-stall',file:'public/repair/workshop.js',before:'if(applyReceipt(state,result))render();',after:'await refresh();if(applyReceipt(state,result))render();',test:'local receiving confirms'},
 {name:'office-po-refresh-stall',file:'public/repair/job.js',before:'state.localSaveComplete=true;',after:'state.localSaveComplete=false;',test:'Office PO commit updates',suite:'manual-browser'},
 {name:'po-invoice-price-replaces-order',file:'src/repair/pdf.js',before:'line.orderedUnitMinor??line.unitMinor',after:'line.unitMinor',test:'designed quote and PO',suite:'pdf-layout'}
];
const results=[];
for(const fault of cases){const cwd=path.join('/app/test-artifacts/manual-mutants',fault.name);try{
 await fs.mkdir(path.join(cwd,'test/repair'),{recursive:true});for(const folder of ['src','public'])await fs.cp('/app/'+folder,path.join(cwd,folder),{recursive:true});await fs.symlink('/app/node_modules',path.join(cwd,'node_modules'));await fs.writeFile(path.join(cwd,'package.json'),'{"type":"module"}');
 for(const name of ['fixture','manual-flow','manual-netsuite','manual-browser','pdf-layout'])await fs.copyFile(`/app/test/repair/${name}${name==='fixture'?'':'.test'}.js`,path.join(cwd,`test/repair/${name}${name==='fixture'?'':'.test'}.js`));
 const testFile=`test/repair/${fault.suite||'manual-flow'}.test.js`,target=path.join(cwd,fault.file),source=await fs.readFile(target,'utf8');if(!source.includes(fault.before))throw new Error('Mutation anchor missing: '+fault.name);
 await requireMutationBaseline({cwd,pattern:fault.test,testFile});await fs.writeFile(target,source.replace(fault.before,fault.after));
 const log=await fs.open(path.join(cwd,'mutant.log'),'w'),child=spawn(process.execPath,['--test','--test-name-pattern='+fault.test,testFile],{cwd,env:process.env,stdio:['ignore',log.fd,log.fd],timeout:60000});const outcome=await new Promise(resolve=>child.on('exit',(code,signal)=>resolve({code,signal})));await log.close();const output=await fs.readFile(path.join(cwd,'mutant.log'),'utf8'),failure=output.split('\n').find(line=>line.startsWith('not ok ')&&line.includes(fault.test));if(outcome.code!==1||outcome.signal||!failure)throw new Error('Fault not caught by intended assertion: '+fault.name+' '+JSON.stringify(outcome)+' '+output.slice(-1500));results.push({name:fault.name,baselinePassed:true,killed:true,trigger:failure});
 }finally{await fs.rm(cwd,{recursive:true,force:true});}}
console.log(JSON.stringify({manualFlowMutants:{killed:results.length,results}}));
