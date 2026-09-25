import { readdirSync } from 'node:fs';
import path from 'node:path';
import { runNodeTestFilesIsolated } from '../test/support/test-database-isolation.mjs';
import { buildIsolatedTestEnvironment } from '../test/support/test-foundation.mjs';
const files = [];
function visit(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) { visit(file); }
    else if (/\.test\.(?:js|mjs)$/.test(file) && /(?:child-location|operator-netsuite-posting|sales-order-auto-fulfillment|operator-yard-access|consolidation-load)/.test(file)) { files.push(path.resolve(file)); }
  }
}
visit('test/mbt');
files.sort();
if (process.argv.includes('--reverse')) { files.reverse(); }
process.exitCode = await runNodeTestFilesIsolated(files, { environment: buildIsolatedTestEnvironment(process.env, { databaseUrl: process.env.DATABASE_URL }), label: 'Child location focused' });
