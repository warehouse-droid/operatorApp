import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
export async function requireMutationBaseline({cwd,pattern,testFile}){
 if(process.env.MBT_TEST_ISOLATED!=='1')throw new Error('Mutation baselines require the bounded disposable runner.');
 const {default:pg}=await import('pg'),client=new pg.Client({connectionString:process.env.DATABASE_URL});await client.connect();
 const reset=()=>client.query('TRUNCATE repair_commands,repair_notifications,repair_vehicles,repair_parts,repair_purchases CASCADE');
 try{await reset();const logPath=path.join(cwd,'baseline.log'),log=await fs.open(logPath,'w'),child=spawn(process.execPath,['--test','--test-name-pattern='+pattern,testFile],{cwd,env:process.env,stdio:['ignore',log.fd,log.fd],timeout:60000});const result=await new Promise(resolve=>child.on('exit',(code,signal)=>resolve({code,signal})));await log.close();if(result.code!==0||result.signal)throw new Error('Unmodified mutation baseline failed: '+pattern+' '+(await fs.readFile(logPath,'utf8')).slice(-2200));await reset();}finally{await client.end();}
}
