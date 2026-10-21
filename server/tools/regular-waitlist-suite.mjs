import {readdir} from 'node:fs/promises';
import path from 'node:path';
import {buildIsolatedTestEnvironment} from '../test/support/test-foundation.mjs';
import {runNodeTestFilesIsolated} from '../test/support/test-database-isolation.mjs';
const files=[];
async function visit(directory){
  for(const entry of (await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
    const file=path.join(directory,entry.name);
    if(entry.isDirectory())await visit(file);
    else if(/\.test\.(js|mjs)$/.test(entry.name)&&(!process.argv.includes('--baseline')||!entry.name.startsWith('regular-waitlist')))files.push(file);
  }
}
for(const group of ['infrastructure','unit','contracts','property','integration','adversarial','concurrency']){
  try{await visit('test/mbt/'+group);}catch(error){if(error.code!=='ENOENT')throw error;}
}
if(process.argv.includes('--affected'))files.splice(0,files.length,...files.filter(file=>/regular-stock|stock-request|special.*customer|special.*units/.test(file)));
const environment=buildIsolatedTestEnvironment(process.env,{databaseUrl:process.env.DATABASE_URL});
process.exitCode=await runNodeTestFilesIsolated(files,{environment,label:'Waitlist '+(process.argv.includes('--baseline')?'baseline':'final')});
