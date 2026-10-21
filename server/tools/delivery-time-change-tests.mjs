import {buildIsolatedTestEnvironment} from '../test/support/test-foundation.mjs';
import {runNodeTestFilesIsolated} from '../test/support/test-database-isolation.mjs';
if(process.env.MBT_TEST_ISOLATED!=='1') {throw new Error('Disposable infrastructure required.');}
const names=process.argv.length>2?process.argv.slice(2):['unit/delivery-request-domain','property/delivery-request-domain.property','integration/delivery-requests',
  'integration/delivery-requests-http','integration/delivery-requests-browser'];
const files=names.map(name=>`test/mbt/${name}.test.js`);
process.exitCode=await runNodeTestFilesIsolated(files,{environment:buildIsolatedTestEnvironment(process.env,{databaseUrl:process.env.DATABASE_URL}),label:'Delivery time change'});
