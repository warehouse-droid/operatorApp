import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { buildIsolatedTestEnvironment } from '../test/support/test-foundation.mjs';
import { runNodeTestFilesIsolated } from '../test/support/test-database-isolation.mjs';

assert.equal(process.env.MBT_TEST_ISOLATED, '1');
const files = [
  'test/dispatch/integration/to-dependency-packing-independent.test.js',
  'test/dispatch/integration/retained-history-save.test.js',
  'test/dispatch/integration/historical-missing-order-snapshot.test.js',
  'test/dispatch/unit/historical-replay-fixture-classification.test.js',
  'test/dispatch/unit/historical-group-pickups.test.js',
  'test/dispatch/unit/executed-prefix-historical-reflexivity.test.js',
  'test/dispatch/property/historical-planning-safety.property.test.js',
  'test/mbt/integration/link-to-fix.test.js',
  'test/dispatch/integration/scm-to-untouched-lines.test.js',
  'test/dispatch/integration/scm-dependency-preview-blockers.red.test.js',
  'test/dispatch/integration/transfer-completed-unlink.test.js',
  'test/dispatch/integration/dispatch-required-pickups-save.test.js'
];
const seed = 20261002;
let state = seed;
for (let index = files.length - 1; index > 0; index -= 1) {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  const other = state % (index + 1);
  [files[index], files[other]] = [files[other], files[index]];
}
const environment = buildIsolatedTestEnvironment(process.env, { databaseUrl: process.env.DATABASE_URL });
const startedAt = new Date().toISOString();
const exit = await runNodeTestFilesIsolated(files, { environment, label: 'Historical shuffled safety tests' });
await writeFile('test-artifacts/dispatch-all-history-20261002/suite-health.json',
  JSON.stringify({ seed, files, startedAt, completedAt: new Date().toISOString(), exit }, null, 2), { mode: 0o600 });
process.exitCode = exit;
