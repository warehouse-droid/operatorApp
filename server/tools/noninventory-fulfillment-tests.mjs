import { readdirSync } from 'node:fs';
import { runNodeTestFilesIsolated } from '../test/support/test-database-isolation.mjs';
import { buildIsolatedTestEnvironment } from '../test/support/test-foundation.mjs';

const files = [];
function visit(folder) {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const file = `${folder}/${entry.name}`;
    if (entry.isDirectory()) { visit(file); }
    else if (/\.test\.(?:js|mjs)$/u.test(file) && !file.endsWith('/noninventory-fulfillment.test.js')
      && /operator-netsuite-posting|operator-linked|sales-order-auto-fulfillment|operator-kit|netsuite-order-line|pickup-existing-if|child-location-fulfillment|consolidation-load|receiving-posting-status|operator-posting|special-approval-fulfillment|load-followup-posting/u.test(file)) { files.push(file); }
  }
}
for (const group of ['infrastructure', 'unit', 'contracts', 'property', 'integration', 'adversarial', 'concurrency']) { visit(`test/mbt/${group}`); }
if (process.env.NONINVENTORY_REVERSE === '1') { files.reverse(); }
const environment = buildIsolatedTestEnvironment(process.env, { databaseUrl: process.env.DATABASE_URL });
process.exitCode = await runNodeTestFilesIsolated(files, { environment, label: 'Noninventory regression' });
