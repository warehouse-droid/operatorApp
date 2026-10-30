import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
if(process.env.MBT_TEST_ISOLATED!=='1')throw new Error('Use the disposable Repair runner.');
const root='/app/test-artifacts/repair-team-mutants';
const cases=[
 {name:'reversed-panels',file:'workshop.css',before:'grid-template-columns:minmax(0,3fr) minmax(0,7fr)',after:'grid-template-columns:minmax(0,7fr) minmax(0,3fr)',test:'Operator-style Team tablet'},
 {name:'missing-completion-photo',file:'workshop.js',before:"if(['complete','inspection_complete'].includes(action)&&!current.files.length)",after:"if(false&&['complete','inspection_complete'].includes(action)&&!current.files.length)",test:'Team at 820px'},
 {name:'lost-draft-on-tab',file:'workshop.js',before:'if(button.dataset.teamTab){state.receiving=null;state.tab=',after:'if(button.dataset.teamTab){state.drafts.clear();state.receiving=null;state.tab=',test:'Team at 820px'}
];
const results=[];
for(const mutant of cases){
 const cwd=path.join(root,mutant.name);try{await fs.mkdir(path.join(cwd,'test/repair'),{recursive:true});
 await fs.cp('/app/public',path.join(cwd,'public'),{recursive:true});
 await fs.symlink('/app/src',path.join(cwd,'src'));await fs.symlink('/app/node_modules',path.join(cwd,'node_modules'));
 await fs.writeFile(path.join(cwd,'package.json'),'{"type":"module"}');
 for(const name of ['fixture.js','team-workbench.test.js'])await fs.copyFile('/app/test/repair/'+name,path.join(cwd,'test/repair',name));
 const target=path.join(cwd,'public/repair',mutant.file),source=await fs.readFile(target,'utf8');
 if(!source.includes(mutant.before))throw new Error('Mutant anchor changed: '+mutant.name);
 await fs.writeFile(target,source.replace(mutant.before,mutant.after));
 const log=await fs.open(path.join(cwd,'result.log'),'w');
 const child=spawn(process.execPath,['--test','--test-name-pattern='+mutant.test,'test/repair/team-workbench.test.js'],{cwd,env:{...process.env,REPAIR_TEAM_PREVIEW:''},stdio:['ignore',log.fd,log.fd],timeout:60000});
 const result=await new Promise(resolve=>child.on('exit',(code,signal)=>resolve({code,signal})));await log.close();
 if(result.code!==1||result.signal)throw new Error('Mutant was not killed: '+mutant.name+' '+JSON.stringify(result));
 const failures=(await fs.readFile(path.join(cwd,'result.log'),'utf8')).split('\n').filter(line=>line.startsWith('not ok '));
 if(!failures.some(line=>line.includes(mutant.test)))throw new Error('Unexpected failure for mutant: '+mutant.name);
 results.push({name:mutant.name,killed:true,trigger:failures[0]});
 }finally{await fs.rm(cwd,{recursive:true,force:true});}
}
console.log(JSON.stringify({killed:results.length,mutants:results}));
