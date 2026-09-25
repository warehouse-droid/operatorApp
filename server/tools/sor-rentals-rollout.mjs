// Scoped local rollout: SuiteQL reads metadata; no NetSuite transaction writes.
import assert from 'node:assert/strict';
import {query,withTransaction,closeDb} from '/app/src/db.js';
import {DISPATCH_FLEET_PLANNING_LOCK} from '/app/src/dispatch-fleet-status.js';
import {loadDispatchOrdersForResponse} from '/app/src/server.js';
import {refreshSorItemMetadata,sorSourceDrafts,runSorReturnQueue} from '/app/src/sor-rental-service.js';
import {getSorSignatureSettings} from '/app/src/sor-rental-repository.js';
import {listDispatchOrderPool,upsertDispatchOrderCatalog,removeDispatchOrderCatalogOrder} from '/app/src/dispatch-order-catalog-repository.js';
const mode=/* SOR_MODE */ "check";
const expected=['SOR00188','SOR00186','SOR00185','SOR00183','SOR00179','SOR00177','SOR00176','SOR00174','SOR00173','SOR00172','SOR00170','SOR00169','SOR00165','SOR00151'].map(ref=>ref+'-Return').sort();
async function proposal(orders=null){
 orders??=await loadDispatchOrdersForResponse({type:'SO'});
 const refs=new Set();
 function collect(order){if(/^SOR\d+(?:-S\d+)?$/u.test(order.id)){refs.add(order.id.replace(/-S\d+$/u,''));}for(const child of order.childOrderDetails||[]){collect(child);}}
 orders.forEach(collect);
 const drafts=[];
 for(const ref of refs){drafts.push(...(await sorSourceDrafts(ref,orders)).drafts);}
 return drafts;
}
async function refresh(refs){
 const orders=await loadDispatchOrdersForResponse({type:'SO',exactOrderRefs:refs});
 if(orders.length){await upsertDispatchOrderCatalog({orders,source:'sor-rollout'});}
 for(const ref of refs){if(!orders.some(order=>order.id===ref)){await removeDispatchOrderCatalogOrder(ref);}}
}
async function check(){
 const rows=(await query("SELECT ref_number,parent_order_ref,pickup_location,dropoff_location,line_snapshot,sales_qty,billing_disposition,status,sor_review_reason FROM dispatch_custom_orders WHERE order_kind='sor_rental_return' ORDER BY ref_number")).rows;
 assert.deepEqual(rows.map(row=>row.ref_number),expected);
 const pool=await listDispatchOrderPool({type:'SO',search:'SOR',limit:200});
 const allPool=await listDispatchOrderPool({search:'SOR',limit:200});
 const deliveries=await loadDispatchOrdersForResponse({type:'SO',exactOrderRefs:rows.map(row=>row.parent_order_ref)});
 const leaves=new Map();
 function collectDelivery(order){leaves.set(order.id,order);for(const child of order.childOrderDetails||[]){collectDelivery(child);}}
 deliveries.forEach(collectDelivery);
 for(const row of rows){
  assert.equal(row.status,'open');assert.equal(row.billing_disposition,'linked_parent_no_charge');
  assert.match(row.dropoff_location,/3445 Kennedy Road/);
  assert.ok(row.line_snapshot.length);assert.ok(row.line_snapshot.every(item=>item.sorAutoReturn===true));
  assert.equal(Number(row.sales_qty),row.line_snapshot.reduce((sum,item)=>sum+Number(item.quantity??item.salesQty),0));
  const card=pool.orders.find(order=>order.id===row.ref_number);assert.ok(card,row.ref_number+' must be in SO pool');
  assert.ok(allPool.orders.some(order=>order.id===row.ref_number),row.ref_number+' must be in All pool');
  const delivery=leaves.get(row.parent_order_ref);assert.ok(delivery,row.parent_order_ref+' delivery must remain visible');
  assert.equal(delivery.sourceYard,'3445');assert.match(delivery.sourceAddress,/3445 Kennedy Road/);
  assert.equal(row.pickup_location,String(delivery.address||delivery.destinationAddress||'').trim());
  assert.ok(!card.expectedDeliveryDate);
  if(!row.pickup_location){assert.equal(card.dispatchPlanningRestricted,true);}
 }
 const errors=(await query("SELECT source_ref,attempts,last_error FROM sor_return_reconcile_queue WHERE last_error<>''")).rows;
 assert.deepEqual(errors,[]);
 const settings=await getSorSignatureSettings();
 return {enabled:settings.returnsEnabled,termsRevision:settings.revision,itemCount:Number((await query('SELECT count(*) FROM sor_item_policies')).rows[0].count),
  returns:rows.map(row=>({ref:row.ref_number,parent:row.parent_order_ref,quantity:Number(row.sales_qty),items:row.line_snapshot.length,needsAddress:!row.pickup_location})),
  pending:Number((await query('SELECT count(*) FROM sor_return_reconcile_queue')).rows[0].count),errors,
  allPoolVisible:rows.length,deliveryPickupsAt3445:rows.length,returnPickupsMatchDeliveries:true};
}
try {
 if(mode==='preview' || mode==='activate'){await refreshSorItemMetadata({force:true});}
 let result;
 if(mode==='preview'){
  const drafts=await proposal();
  result={enabled:(await getSorSignatureSettings()).returnsEnabled,proposed:drafts.map(draft=>({ref:draft.refNumber,quantity:draft.salesQty,items:draft.lineSnapshot.length,needsAddress:!draft.pickupLocation}))};
 }else if(mode==='activate'){
  result=await withTransaction(async()=>{
   await query("SET LOCAL lock_timeout='10s'");
   await query("SET LOCAL statement_timeout='60s'");
   await query('SELECT pg_advisory_xact_lock(hashtext($1))',[DISPATCH_FLEET_PLANNING_LOCK]);
   const sourceOrders=await loadDispatchOrdersForResponse({type:'SO'});
   const drafts=await proposal(sourceOrders);assert.deepEqual(drafts.map(draft=>draft.refNumber).sort(),expected,'Open SOR work changed since preflight; review the new preview');
   await query('UPDATE sor_signature_settings SET returns_enabled=true WHERE singleton=true');
   const pending=Number((await query('SELECT count(*) FROM sor_return_reconcile_queue')).rows[0].count);
   console.error('SOR rollout: reconciling',pending,'sources from one guarded snapshot');
   const changedRefs=new Set(drafts.flatMap(draft=>[draft.parentOrderRef,draft.refNumber]));
   // Source selection is still per-ref in sorSourceDrafts. Defer catalog writes
   // until every source is reconciled, within this same guarded transaction.
   await runSorReturnQueue({loadOrders:async()=>sourceOrders,
    refreshRefs:async refs=>{refs.forEach(ref=>changedRefs.add(ref));},limit:pending+5});
   console.error('SOR rollout: refreshing',changedRefs.size,'affected catalog refs');
   await refresh([...changedRefs]);
   return check();
  });
 }else {result=await check();}
 console.log(JSON.stringify(result));
} finally {await closeDb();}
