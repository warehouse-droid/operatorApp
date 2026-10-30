import {readdirSync} from 'node:fs';
import {runNodeTestFilesIsolated} from '../test/support/test-database-isolation.mjs';
const mode=process.argv[2] || 'all',files=[];
const focused=/^(bin-(transport|availability)|aggregate-routing|dispatch-management-permissions)/u;
const regression=/^(bin-(final-collection|workflow-edit|linked-delivery|order-workflow|planning|selection|dispatch|cargo)|driver-bin|dispatch-bin|asset-registry|asset-csv-import|rate-card-csv-import|rate-card-configuration|customer-charge-request-workflow|sor-)/u;
for (const directory of ['unit','integration','concurrency','property','adversarial']) {
  for (const file of readdirSync(`test/mbt/${directory}`).sort()) {
    if (file.endsWith('.test.js') && (focused.test(file) || (mode==='all' && regression.test(file)))) {files.push(`test/mbt/${directory}/${file}`);}
  }
}
if(mode==='all') for(const directory of ['unit','integration']) {
  for(const file of readdirSync(`test/dispatch/${directory}`).sort()) {
    if(file.endsWith('.test.js') && /^(sor-|dispatch-sor-|sales-split-allocation-unsplit|resplit-sibling-group-allocations)/u.test(file)) files.push(`test/dispatch/${directory}/${file}`);
  }
}
if (process.env.BIN_PLANNING_REVERSE==='1') {files.reverse();}
process.exitCode=await runNodeTestFilesIsolated(files,{label:`mbr-aggregate-${mode}`,environment:{...process.env,
  NODE_OPTIONS:'--require=/app/tools/bin-order-workflow-browser-env.cjs'}});
