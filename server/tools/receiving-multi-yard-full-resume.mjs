import { readFileSync } from 'node:fs';
import { buildIsolatedTestEnvironment } from '../test/support/test-foundation.mjs';
import { runNodeTestFilesIsolated } from '../test/support/test-database-isolation.mjs';

const log=readFileSync('test-artifacts/receiving-multi-yard/full-baseline-prefix.log','utf8');
const files=[...log.matchAll(/\[isolation\] MBT main \d+\/\d+ (.+)/g)].map(match=>match[1]);
const { readdir }=await import('node:fs/promises');
async function visit(directory) {
  const found=[];
  for(const entry of (await readdir(directory,{withFileTypes:true})).sort((left,right)=>left.name.localeCompare(right.name))) {
    const target=directory+'/'+entry.name;
    if(entry.isDirectory()) {found.push(...await visit(target));}
    else if(/\.test\.(?:js|mjs)$/.test(entry.name)) {found.push(target);}
  }
  return found;
}
const all=[];
for(const group of ['infrastructure','unit','contracts','property','integration','adversarial','concurrency']) {
  all.push(...await visit('/app/test/mbt/'+group));
}
const start=all.indexOf(files.at(-1));
if(start<0) {throw new Error('Cannot identify the interrupted baseline file.');}
const environment=buildIsolatedTestEnvironment(process.env,{databaseUrl:process.env.DATABASE_URL});
process.exitCode=await runNodeTestFilesIsolated(all.slice(start),{environment,label:'MBT baseline remainder'});
