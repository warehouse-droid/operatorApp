// Repeat a suspected flaky test against an independently mounted source snapshot.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const { buildIsolatedTestEnvironment } = await import(pathToFileURL(path.resolve('test/support/test-foundation.mjs')));
const { runNodeTestFilesIsolated } = await import(pathToFileURL(path.resolve('test/support/test-database-isolation.mjs')));
const file = process.argv[2], count = Number(process.argv[3] || 5);
if (!file?.startsWith('test/mbt/') || !Number.isInteger(count) || count < 1 || count > 10) { throw new Error('Specify an isolated test file and 1–10 repeats.'); }
const environment = buildIsolatedTestEnvironment(process.env, { databaseUrl: process.env.DATABASE_URL });
if (process.argv[4]) {
  if (file !== 'test/mbt/integration/stock-return-draft-insert.test.js'
    || !['--expired-return-cache', '--fresh-return-cache'].includes(process.argv[4])) { throw new Error('Unknown replay fixture.'); }
  const { query, closeDb } = await import(pathToFileURL(path.resolve('src/db.js')));
  const expired = process.argv[4] === '--expired-return-cache';
  await query("UPDATE return_reason_cache SET fetched_at=now()-($1::int * interval '1 minute')", [expired ? 11 : 0]);
  await closeDb();
  console.log(`Disposable return-reason cache fixture: ${expired ? 'expired (11 minutes)' : 'fresh'}`);
}
let failures = 0;
for (let attempt = 1; attempt <= count; attempt += 1) {
  console.log(`Regression replay ${attempt}/${count}: ${file}`);
  if (await runNodeTestFilesIsolated([path.resolve(file)], { environment, label: 'MBT main' })) { failures += 1; }
}
console.log(`Regression replays failed: ${failures}/${count}`);
process.exitCode = failures ? 1 : 0;
