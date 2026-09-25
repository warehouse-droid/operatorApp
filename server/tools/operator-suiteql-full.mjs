import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildIsolatedTestEnvironment } from '../test/support/test-foundation.mjs';
import { runNodeTestFilesIsolated } from '../test/support/test-database-isolation.mjs';

const lane = Number(process.argv[2]), lanes = Number(process.argv[3]);
assert.ok(Number.isInteger(lane) && Number.isInteger(lanes) && lane >= 0 && lane < lanes);
assert.equal(process.env.MBT_TEST_ISOLATED, '1');
assert.match(process.env.DATABASE_URL, /\/mbt_test$/u);
const files = [];
async function visit(folder) {
  for (const entry of (await fs.readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(folder, entry.name);
    if (entry.isDirectory()) { await visit(file); }
    else if (/\.test\.(?:js|mjs)$/u.test(entry.name)) { files.push(file); }
  }
}
for (const group of ['infrastructure', 'unit', 'contracts', 'property', 'integration', 'adversarial', 'concurrency']) {
  await visit(path.resolve('test/mbt', group));
}
console.log(JSON.stringify({ suite: 'All npm test files, using the same per-file database isolation', lane, lanes, totalFiles: files.length }));
process.exitCode = await runNodeTestFilesIsolated(files.filter((_, index) => index % lanes === lane), {
  environment: buildIsolatedTestEnvironment(process.env, { databaseUrl: process.env.DATABASE_URL }), label: 'MBT main'
});
