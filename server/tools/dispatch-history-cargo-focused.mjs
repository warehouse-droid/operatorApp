import {buildIsolatedTestEnvironment} from '../test/support/test-foundation.mjs';
import {runNodeTestFilesIsolated} from '../test/support/test-database-isolation.mjs';
const files=[
  'test/dispatch/unit/linked-stop-cargo.test.js','test/dispatch/integration/linked-driver-stop-content.test.js',
  'test/dispatch/integration/to-dependency-packing-independent.test.js','test/dispatch/integration/retained-history-save.test.js',
  'test/dispatch/integration/historical-missing-order-snapshot.test.js','test/dispatch/unit/historical-replay-fixture-classification.test.js',
  'test/dispatch/unit/historical-group-pickups.test.js','test/dispatch/unit/executed-prefix-historical-reflexivity.test.js',
  'test/dispatch/property/historical-planning-safety.property.test.js','test/mbt/integration/link-to-fix.test.js',
  'test/dispatch/integration/scm-to-untouched-lines.test.js','test/dispatch/integration/scm-dependency-preview-blockers.red.test.js',
  'test/dispatch/integration/transfer-completed-unlink.test.js','test/dispatch/integration/dispatch-required-pickups-save.test.js',
  'test/dispatch/integration/co-direct-to.test.js','test/dispatch/integration/dispatch-po-split-link-target.test.js',
  'test/dispatch/frontend/dispatch-required-pickups.test.js','test/dispatch/frontend/direct-to-same-yard.test.js',
  'test/dispatch/frontend/direct-ship-quantities.test.js','test/dispatch/property/direct-ship-quantities.test.js',
  'test/dispatch/unit/dispatch-po-route-residual.red.test.js','test/dispatch/integration/order-dependency-multi-to-extension.red.test.js',
  'test/dispatch/integration/dispatch-co-cargo-preservation.test.js','test/mbt/integration/driver-direct-pickup-online-offline.test.js'
];
if(process.argv.includes('--shuffle')) {
  let seed=20261002;
  for(let index=files.length-1;index>0;index--){seed=(Math.imul(seed,1664525)+1013904223)>>>0;const other=seed%(index+1);[files[index],files[other]]=[files[other],files[index]];}
}
const environment=buildIsolatedTestEnvironment(process.env,{databaseUrl:process.env.DATABASE_URL});
process.exitCode=await runNodeTestFilesIsolated(files,{environment,label:'Linked cargo focused'});
