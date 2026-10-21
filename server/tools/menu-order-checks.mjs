import {mkdirSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {buildIsolatedTestEnvironment} from '../test/support/test-foundation.mjs';
import {runNodeTestFilesIsolated} from '../test/support/test-database-isolation.mjs';

mkdirSync('test-artifacts/menu-order-20261006',{recursive:true});
const files=['test/mbt/unit/menu-order.test.js','test/mbt/integration/menu-order-http.test.js',
  'test/mbt/integration/menu-order-browser.test.js'].map(name=>new URL(`../${name}`,import.meta.url).pathname);
const result=await runNodeTestFilesIsolated(files,{environment:buildIsolatedTestEnvironment(process.env,{databaseUrl:process.env.DATABASE_URL}),label:'Menu order'});
if(result) {process.exit(result);}
const staticCheck=spawnSync(process.execPath,['tools/menu-order-static.mjs'],{stdio:'inherit'});
if(staticCheck.status) {process.exit(staticCheck.status);}
const delivery=spawnSync(process.execPath,['tools/delivery-request-checks.mjs'],{encoding:'utf8',timeout:180000,maxBuffer:8*1024*1024});
writeFileSync('test-artifacts/menu-order-20261006/delivery-regression.log',`${delivery.stdout || ''}${delivery.stderr || ''}`);
process.exitCode=delivery.status ?? 1;
console.log(JSON.stringify({menuChecks:0,deliveryRegression:delivery.status}));
