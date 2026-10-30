import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
if(process.env.MBT_TEST_ISOLATED!=='1')throw new Error('Use the bounded disposable Repair runner.');
const cases=[
 {name:'mixed-quote-decisions',file:'public/repair/domain.js',before:"if(new Set([...byId.values()].map(value=>value.decision)).size!==1)",after:'if(false)',test:'whole quote API refuses mixed',property:true},
 {name:'rejection-needs-manual-completion',file:'src/repair/quotes.js',before:"async function rejectJob(job,actor){job.status='completed'",after:"async function rejectJob(job,actor){job.status='queuing'",test:'whole quote rejection resolves only'},
 {name:'rejected-job-in-team-list',file:'src/repair/repository.js',before:'.filter(d.teamJobOpen)',after:'.filter(()=>true)',test:'whole quote rejection resolves only'},
 {name:'wrong-purchase-request-lines',file:'public/repair/workshop-view.js',before:'line.partRequestId===receipt.request.id',after:'line.partRequestId!==receipt.request.id',test:'Team purchase-request card receives only'},
 {name:'lost-receipt-command',file:'public/repair/workshop.js',before:'commandId:state.receiptCommands.get(signature)',after:'commandId:crypto.randomUUID()',test:'Team purchase-request card receives only'},
 {name:'unsafe-historical-correction',file:'src/repair/quotes.js',before:'if(Number(used.count))',after:'if(false)',test:'historical mixed rejection correction'},
 {name:'stale-rejected-selection',file:'public/repair/workshop.js',before:'if(!teamJobOpen(job)){state.job=null;',after:'if(false){state.job=null;',test:'Control, Repair and customer quote screens'}
];
const results=[];
async function resetFixtures(){const {default:pg}=await import('pg');const client=new pg.Client({connectionString:process.env.DATABASE_URL});await client.connect();try{await client.query('TRUNCATE repair_commands,repair_notifications,repair_vehicles,repair_parts,repair_purchases CASCADE');}finally{await client.end();}}
async function execute(cwd,pattern,name){const logPath=path.join(cwd,name+'.log'),log=await fs.open(logPath,'w'),child=spawn(process.execPath,['--test','--test-name-pattern='+pattern,'test/repair/whole-quote-receiving.test.js'],{cwd,env:process.env,stdio:['ignore',log.fd,log.fd],timeout:60000});const result=await new Promise(resolve=>child.on('exit',(code,signal)=>resolve({code,signal})));await log.close();return {...result,output:await fs.readFile(logPath,'utf8')};}
if(process.argv[2]&&!cases.some(row=>row.name===process.argv[2]))throw new Error('Unknown mutation selector.');
for(const mutant of cases.filter(row=>!process.argv[2]||row.name===process.argv[2])){
 const cwd=path.join('/app/test-artifacts/whole-quote-mutants',mutant.name);try{await fs.mkdir(path.join(cwd,'test/repair'),{recursive:true});await fs.cp('/app/src',path.join(cwd,'src'),{recursive:true});await fs.cp('/app/public',path.join(cwd,'public'),{recursive:true});await fs.symlink('/app/node_modules',path.join(cwd,'node_modules'));await fs.writeFile(path.join(cwd,'package.json'),'{"type":"module"}');
 for(const name of ['fixture.js','whole-quote-receiving.test.js'])await fs.copyFile('/app/test/repair/'+name,path.join(cwd,'test/repair',name));
 const target=path.join(cwd,mutant.file),source=await fs.readFile(target,'utf8');if(!source.includes(mutant.before))throw new Error('Missing mutation anchor: '+mutant.name);
 for(const property of mutant.property?[false,true]:[false]){
  const pattern=property?'property: complete uniform decisions':mutant.test;await resetFixtures();await fs.writeFile(target,source);const baseline=await execute(cwd,pattern,property?'property-baseline':'baseline');if(baseline.code!==0||baseline.signal)throw new Error('Unmodified mutation baseline failed: '+mutant.name+' '+baseline.output.slice(-1800));
  await resetFixtures();await fs.writeFile(target,source.replace(mutant.before,mutant.after));const result=await execute(cwd,pattern,property?'property':'test'),failure=result.output.split('\n').find(l=>l.startsWith('not ok ')&&l.includes(pattern));
  if(result.code!==1||result.signal||!failure){console.log(JSON.stringify({wholeQuoteMutationFailure:{name:mutant.name,property,code:result.code,signal:result.signal,output:result.output.slice(-1800)}}));throw new Error('Mutation not caught by intended assertion: '+mutant.name);}results.push({name:mutant.name,property,baselinePassed:true,killed:true,trigger:failure});
 }
 }finally{await fs.rm(cwd,{recursive:true,force:true});}
}
console.log(JSON.stringify({wholeQuoteMutations:results,mutantsKilled:results.filter(result=>!result.property).length,propertyOnlyKilled:results.filter(result=>result.property).length}));
