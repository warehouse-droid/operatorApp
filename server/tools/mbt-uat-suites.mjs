// Full MBT tester-pack regression selection. Each file receives a fresh database.
import { readdirSync } from 'node:fs';
import { runNodeTestFilesIsolated } from '../test/support/test-database-isolation.mjs';

const mbt = /^(bin-|driver-bin-|dispatch-bin-|frontdesk-|customer-charge-|asset-registry|asset-csv-import|rate-card-|dump-site-|item-owned-dump|item-charge-basis|aggregate-routing|dispatch-management-permissions|mbt-bin-cancellation|shadow-billing|billing-read-model|multibin-billing-isolation|pure-contracts)/u;
const dispatch = /^(sor-|dispatch-sor-|dispatch-weight-|sales-split-allocation-unsplit|resplit-sibling-group-allocations)/u;
let files = [];
for (const [area, directories, pattern] of [
  ['mbt', ['unit', 'integration', 'concurrency', 'property', 'adversarial', 'contracts'], mbt],
  ['dispatch', ['unit', 'integration'], dispatch]
]) {
  for (const directory of directories) {
    for (const file of readdirSync(`test/${area}/${directory}`).sort()) {
      if (file.endsWith('.test.js') && pattern.test(file)) files.push(`test/${area}/${directory}/${file}`);
    }
  }
}
if (process.env.MBT_UAT_FILES) {
  const selected = JSON.parse(process.env.MBT_UAT_FILES);
  if (!Array.isArray(selected) || selected.some(file => !files.includes(file))) throw new Error('Unknown UAT test file');
  files = selected;
}
if (process.env.MBT_UAT_REVERSE === '1') files.reverse();
process.exitCode = await runNodeTestFilesIsolated(files, {
  label: 'mbt-uat',
  environment: { ...process.env, NODE_OPTIONS: '--require=/app/tools/bin-order-workflow-browser-env.cjs' }
});
