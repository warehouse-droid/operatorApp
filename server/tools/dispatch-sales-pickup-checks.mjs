import {runNodeTestFilesIsolated} from '../test/support/test-database-isolation.mjs';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
const operator=['test/mbt/integration/operator-linked-quantity-repository.red.test.js','test/mbt/unit/operator-delivery-reference.test.js'];
const focused=['test/dispatch/unit/sales-pickup-authority.test.js','test/dispatch/integration/gob122647-empty-pickup.test.js',...operator];
const regression=[
 ...operator, 'test/mbt/unit/operator-linked-fulfillment.red.test.js',
 'test/mbt/property/operator-linked-fulfillment.property.test.js',
 'test/mbt/unit/pickup-remaining-packs.test.js','test/mbt/integration/pickup-remaining-packs.test.js',
 'test/mbt/unit/operator-shared-pack-balance.test.js',
 'test/dispatch/unit/linked-stop-cargo.test.js','test/dispatch/unit/historical-group-pickups.test.js',
 'test/dispatch/unit/dispatch-group-member-po.test.js','test/dispatch/unit/dispatch-po-count.test.js',
 'test/dispatch/unit/dispatch-repeat-pickup-visits.red.test.js','test/dispatch/adversarial/dispatch-repeat-pickup-visits.adversarial.test.js',
 'test/dispatch/frontend/dispatch-required-pickups.test.js','test/dispatch/frontend/dispatch-group-pickup-card.test.js',
 'test/dispatch/frontend/dispatch-repeat-pickup-visits.red.test.js','test/dispatch/frontend/dispatch-pickup-address-grouping.test.js',
 'test/dispatch/frontend/dispatch-co-cargo-preservation.test.js','test/dispatch/integration/dispatch-required-pickups-save.test.js',
 'test/dispatch/integration/dispatch-co-cargo-preservation.test.js','test/mbt/unit/driver-repeat-pickup-visits.red.test.js',
 'test/mbt/unit/driver-instruction-route-comparison.test.js','src/dispatch-load-assignment-harness.js',
 'src/dispatch-driver-order-harness.js','src/dispatch-pickup-override-harness.js'
];
export {focused,regression};
if(process.argv[1]?.endsWith('/dispatch-sales-pickup-checks.mjs')){
 const mode=process.argv[2]||'focused';
 const selected=mode==='operator'?operator:mode==='focused'?focused:mode==='property'?[focused[0]]:mode==='regression'?regression:[...new Set([...regression,...focused])];
 const shuffled=[...selected].sort((a,b)=>crypto.createHash('sha256').update(`122647:${a}`).digest('hex')
  .localeCompare(crypto.createHash('sha256').update(`122647:${b}`).digest('hex')));
 process.exitCode=mode==='property'
  ? spawnSync(process.execPath,['--test','--test-name-pattern=sales-unit projections conserve',focused[0]],{stdio:'inherit'}).status
  : await runNodeTestFilesIsolated(shuffled,{environment:process.env,label:'sales-pickup-authority'});
}
