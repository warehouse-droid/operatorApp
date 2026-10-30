import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from '../helpers/backorder-already-ordered.js';
import {submitRegularStockRequest,decideRegularStockRequest} from '../../../src/regular-stock-request-service.js';
import {getScmStockRequest} from '../../../src/stock-request-repository.js';
import {createStockCheckRepository} from '../../../src/stock-check/repository.js';
import {createRequestStockChecks} from '../../../src/stock-check/request-checks.js';
const itemId=985711,ids=[];
let f,context,scm,repo,checks,product;
const deps={refreshAvailability:async()=>{},loadPolicies:async()=>[{itemId,sourceLocationId:28,availableQuantity:10000,safetyQuantity:0}],
 loadPurchaseStock:async()=>({available:10000,onHand:10000}),loadPurchasePolicy:async()=>({item_id:itemId,item_name:'Urban Slab',stock_unit:'SQFT',to_plt:52.31,vendor_id:331,vendor:'Unilock',vendor_yard_id:331,vendor_yard:'Ayr',plant:'Ayr'})};
before(async()=>{
 f=await fixture({sku:itemId});context={operatorId:f.users.sales.id,authorizedDestinationLocationIds:[1],allowOverAvailability:true};scm={operatorId:f.users.scm.id};
 await f.query("UPDATE inventory_items SET stock_unit='SQFT',to_plt=52.31,to_pcs=1,vendor='Unilock',vendor_id=331 WHERE item_id=$1",[itemId]);
 await f.query('UPDATE scm_smart_settings SET regular_stock_auto_approval_enabled=true WHERE id=1');
 await f.query("INSERT INTO inventory_balances(item_id,location_id,location,quantity_available,quantity_on_hand,synced_at) VALUES($1,28,'2967',10000,10000,now())",[itemId]);
 repo=createStockCheckRepository({credentialKey:async()=>Buffer.alloc(32,7)});checks=createRequestStockChecks(repo);
 product=await repo.upsertScrapedProduct(1,{sku:'URBAN-TEST',name:'Urban Slab',colour:'INDIANA BUFF',size:'18 x 36',pickupLocation:'Ayr',url:'https://ontario.order.unilock.com/products/products/urban?child=URBAN-TEST'});
 await repo.saveAccount(1,{label:'Fixture',username:'fixture',password:'fixture'},scm.operatorId);
});
after(async()=>{if(f){await f.query('DELETE FROM sales_stock_requests WHERE id=ANY($1::bigint[])',[ids]);await f.close();}});
async function regular(method='pickup',count=2){
 const r=await submitRegularStockRequest({deliveryMethod:method,stockingType:method==='stocking'?'purchase':'transfer',destinationLocationId:1,
  lines:Array.from({length:count},()=>({itemId,sourceLocationId:28,pallets:20}))},context,deps);ids.push(r.id);return r;
}
async function backorder(count=1){
 const result=await f.http('sales','/api/sales/stock-requests',{deliveryMethod:'backorder',customerName:'TEST Customer',destinationLocationId:1,fulfillmentMethod:'yard_pickup',lines:Array.from({length:count},()=>({itemId,pallets:20}))});
 assert.equal(result.status,201,JSON.stringify(result.body));ids.push(result.body.id);return result.body;
}
test('SCM rejects expired approved lines without stock refresh or extending the remaining approval',async()=>{
 let r=await regular();assert.equal(r.lines[0].status,'approved');
 await f.query("UPDATE sales_stock_requests SET regular_details=regular_details||'{\"approvalExpiresAt\":\"2000-01-01T00:00:00Z\"}'::jsonb WHERE id=$1",[r.id]);
 let refreshes=0;
 r=await decideRegularStockRequest(r.id,{expectedRevision:r.revision,lineIds:[r.lines[0].id],decision:'reject',reason:'Expired approval no longer needed'},scm,{...deps,refreshAvailability:async()=>{refreshes++;}});
 assert.equal(refreshes,0);assert.equal(r.lines[0].status,'rejected');assert.equal(r.lines[1].status,'approved');
 assert.equal(r.regular.approvalExpiresAt,'2000-01-01T00:00:00Z');
 assert.equal(r.events[0].details.decision,'reject');
});
test('manual destination-yard stock completion changes only the selected uncommitted line',async()=>{
 let r=await regular('stocking');
 r=await decideRegularStockRequest(r.id,{expectedRevision:r.revision,lineIds:[r.lines[0].id],decision:'yard_stock'},scm,deps);
 assert.equal(r.lines[0].status,'closed');assert.equal(r.lines[0].yardStock.destinationLocationId,1);assert.equal(r.lines[0].yardStock.completedBy,scm.operatorId);
 assert.equal(r.lines[1].status,'submitted');assert.equal(r.status,'active');
 assert.equal(r.statusSummary.counts.completed,1);assert.ok(r.statusSummary.outcomes.includes('yard_stock'));
 r=await decideRegularStockRequest(r.id,{expectedRevision:r.revision,lineIds:[r.lines[1].id],decision:'yard_stock'},scm,deps);
 assert.equal(r.status,'completed');assert.equal(r.statusSummary.status,'completed');assert.equal(r.statusSummary.outcome,'yard_stock');
 assert.equal((await f.query('SELECT 1 FROM regular_stock_purchase_demands WHERE request_line_id=ANY($1::bigint[])',[r.lines.map(line=>line.id)])).rowCount,0);
 assert.deepEqual(r.transfers,[]);
});
test('Backorder manual yard stock completes selected material and is visible to Sales',async()=>{
 let r=await backorder(2),lineId=r.lines[0].id;
 r=await f.action(r,'scm',`lines/${lineId}/yard-stock`);
 assert.equal(r.lines[0].yardStock.destinationLocationId,1);assert.equal(r.lines[0].completed,true);
 assert.equal(r.statusSummary.counts.completed,1);assert.notEqual(r.statusSummary.status,'completed');
 assert.equal((await f.detail(r,'sales')).lines[0].yardStock.completedBy,scm.operatorId);
 r=await f.action(r,'scm',`lines/${r.lines[1].id}/yard-stock`);
 assert.equal(r.statusSummary.status,'completed');assert.equal(r.stage,'completed');
 assert.equal(r.salesOrderId,null);assert.equal(r.purchaseOrderId,null);
 assert.ok(r.events.some(e=>e.eventType==='backorder_yard_stock_completed'));
 for(const role of ['sales','scm'])for(const [stage,included] of [['completed',true],['closed',false]])for(const filter of ['','&unifiedStatus=completed']){
  const result=await f.http(role,`/api/${role}/stock-requests?type=backorder&stage=${stage}&search=${r.requestRef}${filter}`);
  assert.equal(result.status,200);assert.equal(result.body.requests.some(row=>row.id===r.id),included,`${role} ${stage} filter`);
 }
});
test('STREQ-166 quantity is sent as 20 whole pallets and old one-pallet results are stale',async()=>{
 const r=await backorder(1);
 await f.query("UPDATE sales_special_stock_lines SET requested_quantity=1046.2,scm_reviewed_quantity=1046.2,requested_uom='SQFT',pack_pallet_qty=20,brand='Unilock',response_vendor_name='Unilock' WHERE request_id=$1",[r.id]);
 let data=await checks.get(r.id),line=data.lines[0];
 data=await checks.start(r.id,{lines:[{lineId:line.lineId,productId:product.id,fingerprint:line.fingerprint}]},scm.operatorId);
 assert.equal(data.lines[0].job.payload.quantity,20);
 await repo.finishJob(data.lines[0].job.id,{status:'low_stock'},'completed');
 await f.query('UPDATE sales_special_stock_lines SET scm_reviewed_quantity=1046.21 WHERE request_id=$1',[r.id]);
 data=await checks.get(r.id);assert.equal(data.lines[0].stale,true);
 assert.equal(data.lines[0].checkQuantity,21);
});
test('Sales linking SO accepts all reviewed lines atomically and records the SO as the reason',async()=>{
 let r=await backorder(2);r=await f.review(r,0);r=await f.review(r,1);
 r=await f.action(r,'sales','already-ordered/sales-order',{salesOrderRef:'SOA10895-TEST'});
 assert.deepEqual(r.lines.map(l=>l.salesDecision),['accepted','accepted']);
 assert.ok(r.events.some(e=>e.eventType==='backorder_so_customer_accepted'&&e.details.salesOrderRef==='SOA10895-TEST'));
 assert.equal((await getScmStockRequest(r.id)).alreadyOrderedSalesOrderRef,'SOA10895-TEST');
});

test('canonical SO linking rolls acceptance back on failure and a later SCM response needs fresh acceptance',async()=>{
 let r=await backorder(2);r=await f.review(r,0);r=await f.review(r,1);
 const prior=await f.detail(r);
 const failed=await f.http('sales',f.path(r,'sales','sales-order/link'),{expectedRevision:r.revision,salesOrderRef:'SO-NOT-IN-MIRROR'});
 assert.equal(failed.status,404);assert.deepEqual(await f.detail(r),prior);
 await f.query("INSERT INTO sales_orders(netsuite_id,tranid,customer_id,order_location_id,status_text,netsuite_active) VALUES(985711,'SO-CANONICAL-ACCEPT',18,1,'Pending Fulfillment',true)");
 r=await f.action(r,'sales','sales-order/link',{salesOrderRef:'SO-CANONICAL-ACCEPT'});
 assert.equal(r.salesOrderId,985711);assert.deepEqual(r.lines.map(l=>l.salesDecision),['accepted','accepted']);
 assert.equal(r.revision,prior.revision+1);
 r=await f.review(r,0);
 assert.deepEqual(r.lines.map(l=>l.salesDecision),['pending','accepted']);
});

test('missing pallet conversion requires explicit whole pallets and prevents a conflicting active check',async()=>{
 const r=await backorder(1);
 await f.query("UPDATE sales_special_stock_lines SET requested_uom='EA',pack_pallet_qty=NULL,brand='Unilock',response_vendor_name='Unilock' WHERE request_id=$1",[r.id]);
 const data=await checks.get(r.id),line=data.lines[0];assert.equal(line.checkQuantity,null);
 const input=quantity=>({lines:[{lineId:line.lineId,productId:product.id,fingerprint:line.fingerprint,quantity}]});
 for(const quantity of [undefined,null,0,-1,1.5,100000,true])await assert.rejects(checks.start(r.id,input(quantity),scm.operatorId),{code:'STOCK_CHECK_QUANTITY_INVALID'});
 const saved=await checks.start(r.id,input(20),scm.operatorId);
 assert.equal(saved.lines[0].job.payload.quantity,20);assert.equal(saved.lines[0].job.payload.requestLine.quantitySource,'manual');
 assert.equal((await checks.start(r.id,input(20),scm.operatorId)).lines[0].job.id,saved.lines[0].job.id);
 await assert.rejects(checks.start(r.id,input(21),scm.operatorId),error=>error.status===409);
});
