// Run through stdin with cwd=/app in the live app container. NetSuite access is read-only.
import assert from 'node:assert/strict';
import {query,withTransaction,closeDb} from './src/db.js';
import {fetchTransactionProgressFromNetSuite} from './src/netsuite.js';
import {getSpecialStockCase,reconcileSpecialOrderWebhook} from './src/special-stock-request-repository.js';
import {canEditSpecialFulfillment} from './public/special-stock-fulfillment.js';

const apply=process.argv.includes('--apply');
try {
 const remote=await fetchTransactionProgressFromNetSuite(1073070,'SalesOrd');
 assert.equal(Number(remote?.id),1073070);assert.equal(remote.tranid,'SOA10517');assert.equal(remote.status,'F');
 assert.equal(remote.lines.length,1);
 const line=remote.lines[0];assert.equal(Number(line.line_id),5155457);assert.equal(Number(line.item_id),2055);
 assert.equal(Math.abs(Number(line.quantity)),135.39);assert.equal(Math.abs(Number(line.netsuite_received_qty)),135.39);
 const evidence={salesOrderId:1073070,salesOrderRef:'SOA10517',status:remote.status,statusText:remote.status_text,
  fulfilledLines:[{lineId:5155457,itemId:2055,quantity:135.39,fulfilledQuantity:135.39}],observedAt:new Date().toISOString()};
 const result=await withTransaction(async()=>{
  if(!apply)await query('SET TRANSACTION READ ONLY');
  await query("SET LOCAL statement_timeout='15s'");
  const row=(await query(`SELECT r.id,r.request_ref,r.revision,c.fulfillment_method,c.close_status,c.sales_order_netsuite_id,c.purchase_order_netsuite_id,
   s.delivery_method_id,s.status AS sales_status,p.received_at FROM sales_stock_requests r JOIN sales_special_stock_cases c ON c.request_id=r.id
   JOIN sales_orders s ON s.netsuite_id=c.sales_order_netsuite_id JOIN purchase_orders p ON p.netsuite_id=c.purchase_order_netsuite_id
   WHERE r.request_ref='SPREQ-000080' AND r.id=199 ${apply?'FOR UPDATE OF r,c':''}`)).rows[0];
  assert(row);assert.equal(Number(row.sales_order_netsuite_id),1073070);assert.equal(Number(row.purchase_order_netsuite_id),1049528);
  assert.equal(Number(row.delivery_method_id),1);assert.equal(row.sales_status,'F');assert(row.received_at);
  const before=await getSpecialStockCase(199,{audience:'sales'});
  if(before.fulfillmentMethod==='yard_pickup'&&before.stage==='completed')return{alreadyCorrect:true,requestRef:before.requestRef,stage:before.stage};
  assert.equal(Number(row.revision),13);assert.equal(row.fulfillment_method,'mbt_delivery');assert.equal(row.close_status,'active');
  assert.equal(before.stage,'dispatch_arrangement');assert.equal(before.operationallyComplete,false);
  if(!apply)return{readOnly:true,requestRef:row.request_ref,revision:Number(row.revision),before:{method:row.fulfillment_method,stage:before.stage},target:{method:'yard_pickup',stage:'completed'},evidence};
  const snapshot=async()=>(await query(`SELECT jsonb_build_object(
   'so',(SELECT to_jsonb(s) FROM sales_orders s WHERE netsuite_id=1073070),
   'po',(SELECT to_jsonb(p) FROM purchase_orders p WHERE netsuite_id=1049528),
   'soLines',(SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM sales_order_lines l WHERE sales_order_id=1073070),
   'poLines',(SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM purchase_order_lines l WHERE purchase_order_id=1049528),
   'requestLines',(SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM sales_special_stock_lines l WHERE request_id=199)) AS value`)).rows[0].value;
  const protectedBefore=await snapshot();
  await query("UPDATE sales_special_stock_cases SET fulfillment_method='yard_pickup',updated_at=now() WHERE request_id=199");
  await query(`INSERT INTO sales_special_stock_events(request_id,event_type,actor_id,audience,details)
    VALUES(199,'special_fulfillment_method_reconciled',NULL,'all',$1::jsonb)`,[JSON.stringify({
     source:'explicit_user_requested_local_pickup_correction',before:'mbt_delivery',fulfillmentMethod:'yard_pickup',evidence,
     reason:'Match the linked Pickup SO, already fully fulfilled, and reconcile the locally stale Dispatch arrangement stage.'})]);
  const reconciliation=await reconcileSpecialOrderWebhook({orderKind:'sales_order',orderId:1073070});
  assert.equal(reconciliation.requestId,199);assert.equal(reconciliation.attention,false);
  const after=await getSpecialStockCase(199,{audience:'sales'});
  assert.equal(after.fulfillmentMethod,'yard_pickup');assert.equal(after.stage,'completed');assert.equal(after.operationallyComplete,true);
  assert.equal(canEditSpecialFulfillment(after),false);assert.deepEqual(await snapshot(),protectedBefore);
  return{repaired:true,requestRef:after.requestRef,before:{method:before.fulfillmentMethod,stage:before.stage,revision:before.revision},
   after:{method:after.fulfillmentMethod,stage:after.stage,revision:after.revision,operationallyComplete:after.operationallyComplete,editable:false},
   sourceOrdersUnchanged:true,netSuiteWrites:0,evidence};
 });
 console.log(JSON.stringify(result));
}finally{await closeDb();}
