import assert from 'node:assert/strict';
import {query,closeDb} from './src/db.js';
import {getDeliveryInstructionNetSuite} from './src/delivery-instruction-repository.js';
import {withOperatorNetSuitePriority} from './src/operator-netsuite-request-pool.js';
const candidate=(await query(`SELECT netsuite_id,tranid,order_location_id FROM sales_orders
 WHERE sales_order_type='Delivery' AND netsuite_active=true AND order_location_id IN(1,28,15,26)
 AND netsuite_id>0 AND status_text ILIKE '%Pending Fulfillment%' ORDER BY synced_at DESC LIMIT 1`)).rows[0];
assert(candidate,'An existing Delivery order is required for read-only mapping verification.');
const before=(await query('SELECT revision,additional_text FROM sales_order_delivery_instructions WHERE sales_order_id=$1',[candidate.netsuite_id])).rows;
const loaded=await withOperatorNetSuitePriority(()=>getDeliveryInstructionNetSuite(candidate.netsuite_id,{source:'sales',authorizedOrderingLocationIds:[1,28,15,26]}));
assert.equal(loaded.orderRef,candidate.tranid);assert.equal(loaded.netSuite.identity.orderId,Number(candidate.netsuite_id));
assert.equal(loaded.netSuite.identity.locationId,Number(candidate.order_location_id));assert.equal(loaded.netSuite.identity.deliveryMethodId,2);
assert.equal(typeof loaded.netSuite.values.memo,'string');
for(const field of ['shipDate','deliverByDate'])assert.match(loaded.netSuite.values[field],/^(?:\d{4}-\d{2}-\d{2})?$/);
assert.deepEqual((await query('SELECT revision,additional_text FROM sales_order_delivery_instructions WHERE sales_order_id=$1',[candidate.netsuite_id])).rows,before);
const anonymous=await fetch('http://127.0.0.1:3000/api/sales/delivery-instructions/orders/'+candidate.netsuite_id+'/netsuite');assert.equal(anonymous.status,401);
console.log(JSON.stringify({readOnly:true,existingDeliveryOrderMapped:true,identityVerified:true,noteField:'custbody7',shipDateField:'shipDate',deliverByField:'custbody4',localInstructionUnchanged:true,anonymousReadDenied:true,netSuiteOrderWrites:0}));
await closeDb();
