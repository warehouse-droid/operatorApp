import fs from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
const [log,pid]=process.argv.slice(2);let previous='',since=Date.now();
while(fs.existsSync('/proc/'+pid)){
 const text=fs.existsSync(log)?fs.readFileSync(log,'utf8'):'';
 const current=[...text.matchAll(/^\[isolation\].* (\/app\/test\/\S+)$/gm)].at(-1)?.[1];
 if(current!==previous){previous=current;since=Date.now();}
 if(current && Date.now()-since>120000){
  const processes=[];
  for(const id of fs.readdirSync('/proc').filter(n=>/^\d+$/.test(n))){
   try{const stat=fs.readFileSync(`/proc/${id}/stat`,'utf8').split(') ')[1].split(' ');
    processes.push({id:Number(id),parent:Number(stat[1]),cmd:fs.readFileSync(`/proc/${id}/cmdline`,'utf8').split('\0')});
   }catch{/* Process exited during observation. */}
  }
  const roots=processes.filter(p=>p.cmd.includes('--test') && p.cmd.includes(current)).map(p=>p.id);
  const targets=descendants(processes,roots);
  if(targets.size){
   console.log(JSON.stringify({file:current,timeoutMs:120000,terminated:targets.size}));
   terminate(targets);
  }
  since=Date.now();
 }
 await delay(5000);
}

function descendants(processes,roots){
 const targets=new Set(roots);let added=true;
 while(added){
  added=false;
  for(const p of processes){
   if(targets.has(p.parent)&&!targets.has(p.id)){targets.add(p.id);added=true;}
  }
 }
 return targets;
}
function terminate(targets){
 for(const id of [...targets].reverse()){
  try{process.kill(id,'SIGTERM');}catch{/* Already exited. */}
 }
}
