import {requireMutationBaseline} from './repair-mutation-baseline.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
if(process.env.MBT_TEST_ISOLATED!=='1')throw new Error('Use the bounded disposable Repair runner.');
const cases=[
 {name:'approval-notice-type',file:'src/repair/quotes.js',before:"lines.some(line=>line.decision==='approved')?'quote_approved':'quote_decided'",after:"'quote_decided'",test:'requester receives completed'},
 {name:'operator-kilometres',file:'src/repair/repository.js',before:"if(input.meterUnit!=='hours')",after:"if(false&&input.meterUnit!=='hours')",test:'Operator intake enforces'},
 {name:'truck-master-spoof',file:'src/repair/repository.js',before:"||!['unknown','forklift','loader'].includes(vehicle.equipmentType)",after:'',test:'Operator intake enforces'},
 {name:'blocking-master-search',file:'src/repair/directory.js',before:'void refresh().catch',after:'await refresh().catch',test:'equipment search returns cached'},
 {name:'camera-track-leak',file:'public/repair/requester-camera.js',before:'stop(old.stream);',after:'',test:'Windows requester Camera'},
 {name:'stale-camera-close',file:'public/repair/requester-camera.js',before:"dialog.addEventListener('close',()=>{if(current===item)close();},{once:true});",after:"dialog.addEventListener('close',close,{once:true});",test:'camera close event'},
 {name:'lost-reload-command',file:'public/repair/requester-pwa.js',before:"if(saved?.commandId)state.commands.set('create',saved.commandId);",after:'',test:'request replay survives'},
 {name:'unapproved-repair-alert',file:'public/repair/app.js',before:"rows.filter(n=>!n.read_at&&n.kind==='quote_approved').length",after:'rows.filter(n=>!n.read_at).length',test:'office repair attention'}
];
const results=[];
for(const mutant of cases){
 const cwd=path.join('/app/test-artifacts/requester-pwa-mutants',mutant.name);try{await fs.mkdir(path.join(cwd,'test/repair'),{recursive:true});await fs.cp('/app/src',path.join(cwd,'src'),{recursive:true});await fs.cp('/app/public',path.join(cwd,'public'),{recursive:true});await fs.symlink('/app/node_modules',path.join(cwd,'node_modules'));await fs.writeFile(path.join(cwd,'package.json'),'{"type":"module"}');
 for(const name of ['fixture.js','requester-pwa.test.js'])await fs.copyFile('/app/test/repair/'+name,path.join(cwd,'test/repair',name));
 const target=path.join(cwd,mutant.file),source=await fs.readFile(target,'utf8');if(!source.includes(mutant.before))throw new Error('Missing mutation anchor: '+mutant.name);await requireMutationBaseline({cwd,pattern:mutant.test,testFile:'test/repair/requester-pwa.test.js'});await fs.writeFile(target,source.replace(mutant.before,mutant.after));
 const logPath=path.join(cwd,'result.log'),log=await fs.open(logPath,'w');const child=spawn(process.execPath,['--test','--test-name-pattern='+mutant.test,'test/repair/requester-pwa.test.js'],{cwd,env:process.env,stdio:['ignore',log.fd,log.fd],timeout:60000});const result=await new Promise(resolve=>child.on('exit',(code,signal)=>resolve({code,signal})));await log.close();const output=await fs.readFile(logPath,'utf8'),failure=output.split('\n').find(line=>line.startsWith('not ok ')&&line.includes(mutant.test));
 if(result.code!==1||result.signal||!failure)throw new Error('Mutation did not fail its intended assertion: '+mutant.name+' '+output.slice(-1800));results.push({name:mutant.name,baselinePassed:true,killed:true,trigger:failure});
 }finally{await fs.rm(cwd,{recursive:true,force:true});}
}
console.log(JSON.stringify({requesterPwaMutations:results,mutantsKilled:results.length}));
