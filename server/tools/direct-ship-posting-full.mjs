import { readFileSync,readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { buildIsolatedTestEnvironment } from '/app/test/support/test-foundation.mjs';

// The existing full runner can hang indefinitely in an unrelated browser test.
// Bound every file equally for both source trees; a timeout is a failed file.
const require=createRequire(import.meta.url);
let isolation=readFileSync('test/support/test-database-isolation.mjs','utf8');
isolation=isolation.replace('from "pg"','from '+JSON.stringify(pathToFileURL(require.resolve('pg')).href));
isolation=isolation.replace('env: environment,','env: environment, detached: true,');
isolation=isolation.replace('let stdout = "";',`const deadline=setTimeout(()=>{
 process.stderr.write('TIMEOUT '+file+' after 120 seconds\\n');
 try {process.kill(-child.pid,'SIGKILL');} catch {}
},120000);
let stdout = "";`);
isolation=isolation.replace('child.once("exit", (code, signal) => {','child.once("exit", (code, signal) => { clearTimeout(deadline);');
const {runNodeTestFilesIsolated}=await import('data:text/javascript;base64,'+Buffer.from(isolation).toString('base64'));
const files=[];
function visit(directory){
 for(const entry of readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
  const target=path.join(directory,entry.name);
  if(entry.isDirectory()){visit(target);}else if(/\.test\.(?:js|mjs)$/u.test(entry.name)){files.push(target);}
 }
}
for(const group of ['infrastructure','unit','contracts','property','integration','adversarial','concurrency']){visit('test/mbt/'+group);}
const environment=buildIsolatedTestEnvironment(process.env,{databaseUrl:process.env.DATABASE_URL});
const first=Number(process.argv[2]||1),last=Number(process.argv[3]||files.length);
process.exitCode=await runNodeTestFilesIsolated(files.slice(first-1,last),{environment,label:`direct-ship bounded full regression ${first}-${last}`});
