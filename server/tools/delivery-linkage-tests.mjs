import {buildIsolatedTestEnvironment} from '../test/support/test-foundation.mjs';
import {runNodeTestFilesIsolated} from '../test/support/test-database-isolation.mjs';
if(process.env.MBT_TEST_ISOLATED!=='1') {throw new Error('Disposable infrastructure required.');}
const files=['unit/delivery-request-domain','property/delivery-request-domain.property','integration/delivery-requests',
  'integration/delivery-requests-http','integration/delivery-request-planning','integration/delivery-requests-browser',
  'integration/delivery-request-cards-browser','unit/delivery-request-expiry','unit/delivery-request-router',
  'integration/delivery-request-event-stream-browser','integration/delivery-instruction-repository','integration/delivery-instruction-http']
  .map(name=>`test/mbt/${name}.test.js`);
files.push('test/dispatch/unit/dispatch-planner-optimization.red.test.js','test/dispatch/integration/dispatch-order-catalog.red.test.js',
  'test/dispatch/frontend/dispatch-completion-ui.test.js','test/dispatch/frontend/dispatch-fulfilled-so-ui.test.js');
let seed=8102026;
for(let index=files.length-1;index>0;index--) {
  seed=(Math.imul(seed,1664525)+1013904223)>>>0;
  const swap=seed%(index+1);[files[index],files[swap]]=[files[swap],files[index]];
}
process.stdout.write('Suite shuffle seed: 8102026\n');
process.exitCode=await runNodeTestFilesIsolated(files,{environment:buildIsolatedTestEnvironment(process.env,{databaseUrl:process.env.DATABASE_URL || ''}),label:'Delivery SO linkage'});
