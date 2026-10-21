import {readdirSync,mkdirSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {buildIsolatedTestEnvironment} from '../test/support/test-foundation.mjs';
import {runNodeTestFilesIsolated} from '../test/support/test-database-isolation.mjs';
const out='test-artifacts/regular-waitlist',groups=['unit','property','integration','adversarial'];let files=[];
for(const group of groups)files.push(...readdirSync('test/mbt/'+group).filter(f=>f.startsWith('regular-waitlist')&&f.endsWith('.test.js')).map(f=>'test/mbt/'+group+'/'+f));
if(process.argv.includes('--file'))files=[process.argv[process.argv.indexOf('--file')+1]];
if(process.argv.includes('--shuffle')){
  let seed=261002;
  for(let i=files.length-1;i>0;i--){seed=(Math.imul(seed,1664525)+1013904223)>>>0;const j=seed%(i+1);[files[i],files[j]]=[files[j],files[i]];}
}
const environment=buildIsolatedTestEnvironment(process.env,{databaseUrl:process.env.DATABASE_URL});
if(!process.argv.includes('--no-coverage')){rmSync(out+'/coverage/raw',{recursive:true,force:true});mkdirSync(out+'/coverage/raw',{recursive:true});environment.NODE_V8_COVERAGE=resolve(out+'/coverage/raw');}
process.exitCode=await runNodeTestFilesIsolated(files,{environment,label:'focused waitlist'});
