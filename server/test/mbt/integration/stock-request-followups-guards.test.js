import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from '../helpers/backorder-already-ordered.js';
import {submitRegularStockRequest,decideRegularStockRequest} from '../../../src/regular-stock-request-service.js';
import {getScmStockRequest} from '../../../src/stock-request-repository.js';
let f;const ids=[],itemId=985720;
const deps={refreshAvailability:async()=>{},loadPolicies:async()=>[{itemId,sourceLocationId:28,availableQuantity:10000,safetyQuantity:0}]};
before(async()=>{f=await fixture({sku:itemId});await f.query('UPDATE scm_smart_settings SET regular_stock_auto_approval_enabled=true WHERE id=1');await f.query("INSERT INTO inventory_balances(item_id,location_id,location,quantity_available,quantity_on_hand,synced_at) VALUES($1,28,'2967',10000,10000,now())",[itemId]);});
after(async()=>{if(f){await f.query('DELETE FROM regular_stock_handoffs WHERE request_id=ANY($1::bigint[])',[ids]);await f.query('DELETE FROM sales_stock_requests WHERE id=ANY($1::bigint[])',[ids]);await f.close();}});
async function create(method='stocking'){
 const r=await submitRegularStockRequest({deliveryMethod:method,destinationLocationId:1,lines:[{itemId,sourceLocationId:28,salesQty:20},{itemId,sourceLocationId:28,salesQty:30}]},
  {operatorId:f.users.sales.id,authorizedDestinationLocationIds:[1],allowOverAvailability:true},deps);ids.push(r.id);return r;
}
const decision=(r,overrides={})=>decideRegularStockRequest(r.id,{expectedRevision:r.revision,lineIds:[r.lines[0].id],decision:'yard_stock',...overrides},{operatorId:f.users.scm.id},deps);
test('Sales cannot complete stock through SCM API; stale, foreign and malformed selections do not write',async()=>{
 const r=await create(),foreign=await create(),before=await getScmStockRequest(r.id);
 const denied=await f.http('sales',`/api/scm/stock-requests/${r.id}/line-decisions`,{expectedRevision:r.revision,lineIds:[r.lines[0].id],decision:'yard_stock'});assert.equal(denied.status,403);
 for(const input of [{lineIds:[]},{lineIds:[999999]},{lineIds:[r.lines[0].id,foreign.lines[0].id]},{expectedRevision:r.revision+1},{expectedRevision:null},{lineIds:[-1]},{lineIds:[1.5]}])await assert.rejects(decision(r,input));
 assert.deepEqual(await getScmStockRequest(r.id),before);
});
test('two concurrent completions make one decision and stale retries cannot replace it',async()=>{
 const r=await create(),outcomes=await Promise.allSettled([decision(r),decision(r)]);
 assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);assert.equal(outcomes.filter(x=>x.status==='rejected').length,1);
 const saved=await getScmStockRequest(r.id);assert.equal(saved.revision,r.revision+1);assert.equal(saved.lines[0].yardStock.completedBy,f.users.scm.id);
 assert.equal(saved.events.filter(e=>e.details?.decision==='yard_stock').length,1);assert.equal(saved.lines[1].status,'submitted');
});
test('expired rejection needs a reason and unused approval; a handoff blocks it and manual completion',async()=>{
 let r=await create('pickup');await assert.rejects(decision(r,{decision:'reject',reason:'Still valid'}));
 await f.query("UPDATE sales_stock_requests SET regular_details=regular_details||'{\"approvalExpiresAt\":\"2000-01-01T00:00:00Z\"}' WHERE id=$1",[r.id]);
 await assert.rejects(decision(r,{decision:'reject',reason:''}),{code:'REGULAR_REASON_REQUIRED'});
 await f.query("INSERT INTO regular_stock_handoffs(request_id,sales_order_id,sales_order_ref,plan) VALUES($1,123,'SO-GUARD','{}')",[r.id]);
 await assert.rejects(decision(r,{decision:'reject',reason:'Cannot touch a handoff'}));
 r=await create();await f.query("INSERT INTO regular_stock_handoffs(request_id,sales_order_id,sales_order_ref,plan) VALUES($1,124,'SO-GUARD-2','{}')",[r.id]);
 await assert.rejects(decision(r),{code:'REGULAR_RESOLUTION_LOCKED'});assert.equal((await getScmStockRequest(r.id)).revision,r.revision);
});
test('Backorder cannot be completed by Sales or after PO commitment, and linking SO preserves declined lines',async()=>{
 let r=await f.create(2);const url=f.path(r,'sales',`lines/${r.lines[0].id}/yard-stock`);
 assert.equal((await f.http('sales',url,{expectedRevision:r.revision})).status,403);
 await f.query("UPDATE sales_special_stock_cases SET purchase_order_netsuite_id=985720,purchase_order_ref='PO-COMMITTED',purchase_order_custom_linkage=true WHERE request_id=$1",[r.id]);
 assert.equal((await f.http('scm',f.path(r,'scm',`lines/${r.lines[0].id}/yard-stock`),{expectedRevision:r.revision})).status,409);
 r=await f.create(2);r=await f.review(r,0);r=await f.review(r,1);r=await f.action(r,'sales',`lines/${r.lines[0].id}/decision`,{decision:'declined',reason:'Customer declined'});
 r=await f.action(r,'sales','already-ordered/sales-order',{salesOrderRef:'SO-ACCEPT-GUARD'});
 assert.deepEqual(r.lines.map(l=>l.salesDecision),['declined','accepted']);
 const before=JSON.stringify(r.lines);assert.equal((await f.http('sales',f.path(r,'sales','already-ordered/sales-order'),{expectedRevision:r.revision-1,salesOrderRef:'SO-STALE'})).status,409);
 assert.equal(JSON.stringify((await f.detail(r)).lines),before);
});

test('Backorder yard completion and PO linking serialize so a material is never both purchased and completed from yard stock',async()=>{
 await f.query("INSERT INTO purchase_orders(netsuite_id,tranid,vendor_id,destination_location_id,status_text,netsuite_active) VALUES(985723,'PO-YARD-RACE',331,1,'Pending Receipt',true)");
 let r=await f.create(1);r=await f.review(r);r=await f.action(r,'sales',`lines/${r.lines[0].id}/decision`,{decision:'accepted'});
 const attempts=await Promise.all([
  f.http('scm',f.path(r,'scm',`lines/${r.lines[0].id}/yard-stock`),{expectedRevision:r.revision}),
  f.http('scm',f.path(r,'scm','purchase-order/link'),{expectedRevision:r.revision,purchaseOrderRef:'PO-YARD-RACE'})
 ]);
 assert.deepEqual(attempts.map(result=>result.status).sort(),[200,409]);
 const saved=await f.detail(r,'scm');assert.equal(saved.revision,r.revision+1);
 assert.notEqual(Boolean(saved.lines[0].yardStock),Boolean(saved.purchaseOrderId));
});
