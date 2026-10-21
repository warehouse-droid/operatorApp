import assert from 'node:assert/strict';
import {buildIsolatedTestEnvironment} from '../test/support/test-foundation.mjs';
import {runNodeTestFilesIsolated} from '../test/support/test-database-isolation.mjs';
assert.equal(process.env.MBT_TEST_ISOLATED,'1');
const files=['test/mbt/unit/special-po-reference.test.js','test/mbt/integration/special-po-reference-http.test.js',
  'test/mbt/integration/special-po-reference-browser.test.js','test/mbt/integration/special-sales-alert-browser.test.js'];
process.exitCode=await runNodeTestFilesIsolated(files,{environment:buildIsolatedTestEnvironment(process.env,{databaseUrl:process.env.DATABASE_URL}),label:'Special PO Sales alerts'});
