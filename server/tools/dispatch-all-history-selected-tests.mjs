import assert from 'node:assert/strict';
import { buildIsolatedTestEnvironment } from '../test/support/test-foundation.mjs';
import { runNodeTestFilesIsolated } from '../test/support/test-database-isolation.mjs';

assert.equal(process.env.MBT_TEST_ISOLATED,'1');
const files = process.argv.slice(2);
assert.ok(files.length);
const environment = buildIsolatedTestEnvironment(process.env,{databaseUrl: process.env.DATABASE_URL});
process.exitCode = await runNodeTestFilesIsolated(files,{environment,label: 'Additional baseline'});
