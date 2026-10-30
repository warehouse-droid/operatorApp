import {readdirSync} from 'node:fs';
import {runNodeTestFilesIsolated} from '../test/support/test-database-isolation.mjs';
const files=[];
const affected=/^(bin-(transport|availability|weight-warning|final-collection|workflow-edit|linked-delivery|order-workflow|planning|selection|dispatch|cargo)|driver-bin|dispatch-bin|aggregate-routing|pure-contracts)/u;
for(const directory of ['unit','integration','concurrency','property','adversarial']) {
  for(const file of readdirSync(`test/mbt/${directory}`).sort()) {
    if(file.endsWith('.test.js') && affected.test(file)) files.push(`test/mbt/${directory}/${file}`);
  }
}
for(const directory of ['unit','integration']) {
  for(const file of readdirSync(`test/dispatch/${directory}`).sort()) {
    if(file.endsWith('.test.js') && file.startsWith('dispatch-weight-')) files.push(`test/dispatch/${directory}/${file}`);
  }
}
if(process.env.BIN_PLANNING_REVERSE==='1') files.reverse();
process.exitCode=await runNodeTestFilesIsolated(files,{label:'bin-weight-warning',environment:{...process.env,NODE_OPTIONS:'--require=/app/tools/bin-order-workflow-browser-env.cjs'}});
