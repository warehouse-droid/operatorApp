import path from 'node:path';
import { runNodeTestFilesIsolated } from '../test/support/test-database-isolation.mjs';
import { buildIsolatedTestEnvironment } from '../test/support/test-foundation.mjs';

const environment = buildIsolatedTestEnvironment(process.env, { databaseUrl: process.env.DATABASE_URL });
process.exitCode = await runNodeTestFilesIsolated(process.argv.slice(2).map(file => path.resolve(file)), {
  environment, label: 'CO Operator'
});
