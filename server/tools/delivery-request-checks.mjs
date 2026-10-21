import {spawn,spawnSync} from 'node:child_process';
import {buildIsolatedTestEnvironment} from '../test/support/test-foundation.mjs';
import {runNodeTestFilesIsolated} from '../test/support/test-database-isolation.mjs';

if(process.env.MBT_TEST_ISOLATED!=='1') {throw new Error('Delivery checks require disposable isolated test infrastructure.');}
if(!process.env.DELIVERY_REQUEST_COVERAGE_CHILD) {
  const result=spawnSync('node_modules/.bin/c8',['--config=tools/delivery-request-c8.json',process.execPath,'tools/delivery-request-checks.mjs'],
    {stdio:'inherit',env:{...process.env,DELIVERY_REQUEST_COVERAGE_CHILD:'1'}});
  process.exitCode=result.status ?? 1;
} else {
  const watchdog=spawn(process.execPath,['tools/delivery-request-watchdog.cjs','120000','test-artifacts/delivery-requests/focused-timeouts.log'],{stdio:'inherit'});
  try {
    const files=[
      'test/mbt/unit/delivery-request-domain.test.js',
      'test/mbt/unit/delivery-request-expiry.test.js',
      'test/mbt/unit/delivery-request-router.test.js',
      'test/mbt/property/delivery-request-domain.property.test.js',
      'test/mbt/integration/delivery-requests.test.js',
      'test/mbt/integration/delivery-requests-http.test.js',
      'test/mbt/integration/delivery-request-planning.test.js',
      'test/mbt/integration/delivery-requests-browser.test.js',
      'test/mbt/integration/delivery-request-event-stream-browser.test.js',
      'test/mbt/integration/boss-approval-browser.test.js',
      'test/mbt/integration/boss-history-browser.test.js',
      'test/mbt/integration/delivery-instruction-repository.test.js',
      'test/mbt/integration/delivery-instruction-http.test.js'
    ].map(file=>new URL(`../${file}`,import.meta.url).pathname);
    // A recorded shuffle also checks that test files do not depend on run order.
    let seed=5102026;
    for(let index=files.length-1;index>0;index--) {
      seed=(Math.imul(seed,1664525)+1013904223)>>>0;
      const swap=seed%(index+1);[files[index],files[swap]]=[files[swap],files[index]];
    }
    process.stdout.write('Delivery suite order seed: 5102026\n');
    const environment=buildIsolatedTestEnvironment(process.env,{databaseUrl:process.env.DATABASE_URL || ''});
    process.exitCode=await runNodeTestFilesIsolated(files,{environment,label:'Delivery requests'});
  } finally {watchdog.kill('SIGTERM');}
}
