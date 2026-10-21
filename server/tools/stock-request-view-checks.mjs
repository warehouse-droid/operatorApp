import {spawnSync} from 'node:child_process';
import {buildIsolatedTestEnvironment} from '../test/support/test-foundation.mjs';
import {runNodeTestFilesIsolated} from '../test/support/test-database-isolation.mjs';

const staticCheck=spawnSync(process.execPath,['tools/stock-request-view-static.mjs'],{stdio:'inherit'});
if(staticCheck.status) process.exit(staticCheck.status);
const files=[
  'unit/stock-request-view.test.js','unit/special-workflow-queue.test.js','unit/special-status-following.test.js',
  'unit/stock-request-ui-contract.test.js','unit/stock-request-yard-filter.test.js',
  'integration/stock-request-view-browser.test.js','integration/stock-request-repository.test.js',
  'integration/special-stock-updates-browser.test.js','integration/special-stock-alert-browser.test.js',
  'integration/special-sales-alert-browser.test.js','integration/special-po-routing-browser.test.js',
  'unit/menu-order.test.js','integration/menu-order-http.test.js','integration/menu-order-browser.test.js'
].map(name=>new URL('../test/mbt/'+name,import.meta.url).pathname);
process.exitCode=await runNodeTestFilesIsolated(files,{environment:buildIsolatedTestEnvironment(process.env,{databaseUrl:process.env.DATABASE_URL}),label:'Stock Request view'});
