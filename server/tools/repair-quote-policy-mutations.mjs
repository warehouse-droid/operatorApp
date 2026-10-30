import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {requireMutationBaseline} from './repair-mutation-baseline.mjs';
if(process.env.MBT_TEST_ISOLATED!=='1')throw new Error('Use the bounded disposable runner.');
const cases=[
 {name:'policy-office-authority',file:'src/repair/repository.js',before:"if(input.quoteAutoApproval!==undefined){d.requireAllowed(d.has(actor,'admin'));",after:'if(input.quoteAutoApproval!==undefined){',test:'quote policy defaults off'},
 {name:'external-policy-overlap',file:'src/repair/quote-approval-policy.js',before:"if(job.company==='EXTERNAL')return 'externalCustomers';",after:'',test:'external customer policy takes precedence'},
 {name:'external-policy-property',file:'src/repair/quote-approval-policy.js',before:"if(job.company==='EXTERNAL')return 'externalCustomers';",after:'',test:'property: independent approval flags'},
 {name:'loader-policy-disabled',file:'src/repair/quote-approval-policy.js',before:"['forklift','loader'].includes(job.data.equipmentType)",after:"['forklift'].includes(job.data.equipmentType)",test:'enabled loader policy'},
 {name:'partial-quote-auto-decision',file:'src/repair/quotes.js',before:"status:'approved',note:'Automatically approved",after:"status:line===lines[0]?'approved':'rejected',note:'Automatically approved",test:'multi-line automatic approval'},
 {name:'stale-auto-quote-replay',file:'src/repair/repository.js',before:'if(old){if(old.digest!==digest)',after:"if(old&&!kind.startsWith('quote:')){if(old.digest!==digest)",test:'additional and revised quotes'},
 {name:'policy-body-override',file:'src/repair/quotes.js',before:'automaticQuoteCategory(settings.data,job)',after:'automaticQuoteCategory(input.quoteAutoApproval?{quoteAutoApproval:input.quoteAutoApproval}:settings.data,job)',test:'quote body spoofing'},
 {name:'inspection-bypass',file:'src/repair/quotes.js',before:"if(!source.data.inspectionComplete)throw",after:"if(false&&!source.data.inspectionComplete)throw",test:'quote body spoofing'},
 {name:'policy-snapshot-race',file:'src/repair/quotes.js',before:'SELECT data,revision FROM repair_settings FOR SHARE',after:'SELECT data,revision FROM repair_settings',test:'quote issuance waits'},
 {name:'auto-audit-missing',file:'src/repair/quotes.js',before:"await event(actor,job,'quote_auto_approved'",after:"await event(actor,job,'untracked_auto_approval'",test:'enabled truck policy'}
];
const results=[];
for(const fault of cases){const cwd=path.join('/app/test-artifacts/quote-policy-mutants',fault.name);try{
 await fs.mkdir(path.join(cwd,'test/repair'),{recursive:true});for(const folder of ['src','public'])await fs.cp('/app/'+folder,path.join(cwd,folder),{recursive:true});await fs.symlink('/app/node_modules',path.join(cwd,'node_modules'));await fs.writeFile(path.join(cwd,'package.json'),'{"type":"module"}');for(const name of ['fixture.js','quote-auto-approval.test.js'])await fs.copyFile('/app/test/repair/'+name,path.join(cwd,'test/repair',name));
 const target=path.join(cwd,fault.file),source=await fs.readFile(target,'utf8'),testFile='test/repair/quote-auto-approval.test.js';if(!source.includes(fault.before))throw new Error('Missing quote-policy fault anchor: '+fault.name);await requireMutationBaseline({cwd,pattern:fault.test,testFile});await fs.writeFile(target,source.replace(fault.before,fault.after));
 const log=await fs.open(path.join(cwd,'fault.log'),'w'),child=spawn(process.execPath,['--test','--test-name-pattern='+fault.test,testFile],{cwd,env:process.env,stdio:['ignore',log.fd,log.fd],timeout:60000}),outcome=await new Promise(resolve=>child.on('exit',(code,signal)=>resolve({code,signal})));await log.close();const output=await fs.readFile(path.join(cwd,'fault.log'),'utf8'),trigger=output.split('\n').find(line=>line.startsWith('not ok ')&&line.includes(fault.test));if(outcome.code!==1||outcome.signal||!trigger)throw new Error('Fault not caught: '+fault.name+' '+JSON.stringify(outcome)+' '+output.slice(-1800));results.push({name:fault.name,baselinePassed:true,killed:true,trigger});
 }finally{await fs.rm(cwd,{recursive:true,force:true});}}
console.log(JSON.stringify({quotePolicyMutants:results,killed:results.length}));
