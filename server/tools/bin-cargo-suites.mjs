import {readdirSync} from 'node:fs';
import {runNodeTestFilesIsolated} from '../test/support/test-database-isolation.mjs';
const mode=process.argv[2] || 'all',files=[];
for(const directory of ['unit','integration','concurrency','property','adversarial']) {
  for(const file of readdirSync(`test/mbt/${directory}`).sort()) {
    const cargo=file.startsWith('bin-cargo');
    const affected=/^(bin-(order-workflow|selection|planning|dispatch)|driver-bin|dispatch-bin)/u.test(file);
    const adjacent=['scm-custom-orders-http.test.js','item-charge-basis-and-aggregate.test.js'].includes(file);
    if(file.endsWith('.test.js') && (cargo || (mode==='all' && (affected || adjacent)))) files.push(`test/mbt/${directory}/${file}`);
  }
}
if(mode==='all') files.push('test/dispatch/frontend/dispatch-co-vrma-custom.contract.test.js',
  'test/dispatch/integration/sor-rental-repository.test.js','test/dispatch/integration/dispatch-v2-command-flow.red.test.js',
  'test/dispatch/integration/dispatch-sor-return-date-conflict.test.js');
if(mode==='focused') files.push('test/mbt/integration/bin-order-workflow.test.js','test/mbt/integration/bin-selection.test.js');
if(process.env.BIN_PLANNING_REVERSE==='1') files.reverse();
process.exitCode=await runNodeTestFilesIsolated(files,{label:`bin-cargo-${mode}`,
  environment:{...process.env,NODE_OPTIONS:'--require=/app/tools/bin-order-workflow-browser-env.cjs'}});
