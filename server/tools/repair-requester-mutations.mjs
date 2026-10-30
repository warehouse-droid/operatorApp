import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
if(process.env.MBT_TEST_ISOLATED!=='1')throw new Error('Use the disposable Repair runner.');
const cases=[
 {name:'delegation-privacy',file:'public/repair/domain.js',before:'return isOwner(actor,job);',after:'return isOwner(actor,job)||job.data?.recipient===actorKey(actor);',suite:'requester-page.test.js',test:'property: receiving delegation'},
 {name:'mixed-requester-authority',file:'src/repair/router.js',before:'role,roles:[role]',after:'role,roles:req.repairActor.roles',suite:'requester-page.test.js',test:'requester context restricts'},
 {name:'assignment-equipment-kind',file:'src/repair/handover.js',before:'&&types.includes(job.data.equipmentType)',after:'',test:'equipment assignment APIs'},
 {name:'internal-receipt-bypass',file:'src/repair/jobs.js',before:"if(parent.company==='MBR')",after:"if(['MBBS','MBT','MBR'].includes(parent.company))",test:'internal forklift and truck'},
 {name:'customer-token-binding',file:'src/repair/handover.js',before:'link?.hash===actor.tokenHash',after:'Boolean(link)',test:'customer handover accepts'}
];
const results=[];
for(const mutant of cases){
 const cwd=path.join('/app/test-artifacts/requester-mutants',mutant.name);try{await fs.mkdir(path.join(cwd,'test/repair'),{recursive:true});await fs.cp('/app/src',path.join(cwd,'src'),{recursive:true});await fs.cp('/app/public/repair',path.join(cwd,'public/repair'),{recursive:true});await fs.symlink('/app/node_modules',path.join(cwd,'node_modules'));await fs.writeFile(path.join(cwd,'package.json'),'{"type":"module"}');
 for(const name of ['fixture.js','requester-page.test.js','assignment-receipt.test.js'])await fs.copyFile('/app/test/repair/'+name,path.join(cwd,'test/repair',name));
 const target=path.join(cwd,mutant.file),source=await fs.readFile(target,'utf8');if(!source.includes(mutant.before))throw new Error('Missing mutation anchor: '+mutant.name);await fs.writeFile(target,source.replace(mutant.before,mutant.after));
 const logPath=path.join(cwd,'result.log'),log=await fs.open(logPath,'w'),child=spawn(process.execPath,['--test','--test-name-pattern='+mutant.test,'test/repair/'+(mutant.suite||'assignment-receipt.test.js')],{cwd,env:process.env,stdio:['ignore',log.fd,log.fd],timeout:60000});
 const result=await new Promise(resolve=>child.on('exit',(code,signal)=>resolve({code,signal})));await log.close();const output=await fs.readFile(logPath,'utf8'),failure=output.split('\n').find(line=>line.startsWith('not ok ')&&line.includes(mutant.test));
 if(result.code!==1||result.signal||!failure)throw new Error('Mutation did not fail its intended assertion: '+mutant.name+' '+output.slice(-2000));results.push({name:mutant.name,killed:true,trigger:failure});
 }finally{await fs.rm(cwd,{recursive:true,force:true});}
}
console.log(JSON.stringify({requesterReceiptMutations:results,mutantsKilled:results.length,propertyOnlyKilled:1}));
