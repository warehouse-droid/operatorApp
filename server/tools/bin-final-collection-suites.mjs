import {readdirSync} from 'node:fs';
import {runNodeTestFilesIsolated} from '../test/support/test-database-isolation.mjs';
const mode=process.argv[2] || 'all',files=[];
for(const dir of ['unit','integration','concurrency','property','adversarial']) {
 for(const name of readdirSync(`test/mbt/${dir}`).sort()) {
  const selected=mode==='focused' ? name.startsWith('bin-final-collection') : /^(bin-(final-collection|workflow-edit|linked-delivery|order-workflow|planning|selection|dispatch|cargo)|driver-bin|dispatch-bin)/u.test(name);
  if(selected && name.endsWith('.test.js')) files.push(`test/mbt/${dir}/${name}`);
 }
}
if(process.env.BIN_PLANNING_REVERSE==='1') files.reverse();
process.exitCode=await runNodeTestFilesIsolated(files,{label:`bin-final-collection-${mode}`,environment:{...process.env,NODE_OPTIONS:'--require=/app/tools/bin-order-workflow-browser-env.cjs'}});
