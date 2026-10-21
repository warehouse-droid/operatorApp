import { buildIsolatedTestEnvironment } from '../test/support/test-foundation.mjs';
import { runNodeTestFilesIsolated } from '../test/support/test-database-isolation.mjs';

const environment = buildIsolatedTestEnvironment(process.env, {databaseUrl: process.env.DATABASE_URL});
process.exitCode = await runNodeTestFilesIsolated([
  '/app/test/mbt/unit/receiving-split-balance-ui.test.js',
  '/app/test/mbt/integration/special-workflow-description-race.test.js',
  '/app/test/mbt/integration/special-workflow-pricing.test.js'
], {environment, label: 'Receiving live rebase baseline'});
