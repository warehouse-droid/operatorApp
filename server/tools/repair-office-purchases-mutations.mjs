import {requireMutationBaseline} from './repair-mutation-baseline.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
if(process.env.MBT_TEST_ISOLATED!=='1')throw new Error('Use the disposable Repair runner.');
const cases=[
 {name:'office-receipt-bypass',file:'src/repair/purchasing.js',before:'api.receivePurchase=async(actor,id,lineId,input)=>{d.requireAllowed(d.canWorkshop(actor));',after:'api.receivePurchase=async(actor,id,lineId,input)=>{d.requireAllowed(d.canWorkshop(actor)||d.canViewCosts(actor));',test:'four PO steps'},
 {name:'invoice-before-parts',file:'src/repair/purchase-orders.js',before:'if(lines.some(l=>Number(l.received_milli)<Number(l.quantity_milli)))',after:'if(false&&lines.some(l=>Number(l.received_milli)<Number(l.quantity_milli)))',test:'four PO steps'},
 {name:'prequote-request-blocked',file:'src/repair/purchasing.js',before:"const quote=input.quoteLineId?await requireApproved(job,d.text(input.quoteLineId,'Quote line',80)):null;",after:'const quote=await requireApproved(job,input.quoteLineId);',test:'parts requests can precede quotes'},
 {name:'parts-photo-cross-job',file:'src/repair/repository.js',before:'||part.job_id!==job.id',after:'',test:'parts request evidence cannot'},
 {name:'unreceived-bill-posted',file:'src/repair/worker.js',before:'if(purchase.data.poNumber&&purchase.lines.some',after:'if(false&&purchase.data.poNumber&&purchase.lines.some',test:'Bill worker refuses'},
 {name:'combined-save-loses-condition',file:'src/repair/actions.js',before:'job.priority=priority;job.condition=condition;',after:'job.priority=priority;',test:'combined Save corrects equipment'},
 {name:'lost-photo-retry',file:'public/repair/workshop.js',before:'if(!request.savedRequest){delete input.photos;',after:'if(true){delete input.photos;',test:'parts request survives',browser:true},
 {name:'blocked-phone-retry',file:'public/repair/workshop.css',before:'pointer-events:none',after:'pointer-events:auto',test:'parts request survives',browser:true}
];
const results=[];
for(const mutant of cases){
 const cwd=path.join('/app/test-artifacts/office-purchase-mutants',mutant.name);try{await fs.mkdir(path.join(cwd,'test/repair'),{recursive:true});await fs.cp('/app/src',path.join(cwd,'src'),{recursive:true});await fs.cp('/app/public',path.join(cwd,'public'),{recursive:true});await fs.symlink('/app/node_modules',path.join(cwd,'node_modules'));await fs.writeFile(path.join(cwd,'package.json'),'{"type":"module"}');
 for(const file of ['fixture.js','office-purchase-flow.test.js','office-purchase-browser.test.js'])await fs.copyFile('/app/test/repair/'+file,path.join(cwd,'test/repair',file));
 const target=path.join(cwd,mutant.file),source=await fs.readFile(target,'utf8');if(!source.includes(mutant.before))throw new Error('Missing mutation anchor: '+mutant.name);await requireMutationBaseline({cwd,pattern:mutant.test,testFile:'test/repair/office-purchase-'+(mutant.browser?'browser':'flow')+'.test.js'});await fs.writeFile(target,source.replace(mutant.before,mutant.after));
 const logPath=path.join(cwd,'result.log'),log=await fs.open(logPath,'w');const child=spawn(process.execPath,['--test','--test-name-pattern='+mutant.test,'test/repair/office-purchase-'+(mutant.browser?'browser':'flow')+'.test.js'],{cwd,env:process.env,stdio:['ignore',log.fd,log.fd],timeout:60000});const result=await new Promise(resolve=>child.on('exit',(code,signal)=>resolve({code,signal})));await log.close();const output=await fs.readFile(logPath,'utf8'),failure=output.split('\n').find(line=>line.startsWith('not ok ')&&line.includes(mutant.test));
 if(result.code!==1||result.signal||!failure)throw new Error('Mutation did not fail its intended assertion: '+mutant.name+' '+output.slice(-2000));results.push({name:mutant.name,baselinePassed:true,killed:true,trigger:failure});
 }finally{await fs.rm(cwd,{recursive:true,force:true});}
}
console.log(JSON.stringify({officePurchaseMutations:results,mutantsKilled:results.length}));
