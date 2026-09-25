import path from 'node:path';
import { buildIsolatedTestEnvironment } from './test-foundation.mjs';
import { runNodeTestFilesIsolated } from './test-database-isolation.mjs';

const file = path.resolve('test/mbt/integration/stock-return-draft-insert.test.js');
const environment = buildIsolatedTestEnvironment(process.env, { databaseUrl: process.env.DATABASE_URL });
const results = [];
for (let run = 0; run < 5; run += 1) {
  results.push(await runNodeTestFilesIsolated([file], { environment, label: `stock-return-repeat-${run + 1}` }));
}
console.log(JSON.stringify({ file, results }));
