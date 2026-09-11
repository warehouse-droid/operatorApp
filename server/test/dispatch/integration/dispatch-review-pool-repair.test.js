import assert from "node:assert/strict";
import test, { after } from "node:test";
import { closeDb, query, withTransaction } from "../../../src/db.js";
import { listDispatchOrders, listScmPurchaseOrders } from "../../../src/dispatch-repository.js";
import { enrichScmScheduleWithReconciliation, reconcileScmOrderFamily, storeLinkedScmReconciliationTransactions } from "../../../src/scm-reconciliation-repository.js";
import { assertNoRestrictedScmDispatchOrders, loadDispatchOrdersForResponse } from "../../../src/server.js";

after(closeDb);

async function family() {
  const id = Date.now() + Math.floor(Math.random() * 100000);
  const parentRef = `POB-REVIEW-${id}`;
  const childRef = `SN${id}`;
  const residualRef = `SN${id + 1}`;
  await query(`INSERT INTO purchase_orders (netsuite_id,tranid,dispatch_ref,trandate,status,status_text,vendor,destination_location_id,destination_location,initial_scm_status,netsuite_active)
    VALUES ($1,$2,$3,CURRENT_DATE,'B','Pending Receipt','Review fixture vendor',1,'3445','Queued',true),
    ($4,$5,$5,CURRENT_DATE,'B','Pending Receipt','Review fixture vendor',1,'3445','Queued',true)`, [id,parentRef,residualRef,-id,childRef]);
  const inserted = await query(`INSERT INTO purchase_order_lines (purchase_order_id,line_id,item_id,item_name,sku,quantity,pallet_qty,to_plt,item_weight,unit,location_id,location,netsuite_active,raw)
    VALUES ($1,1,992233,'Review fixture material','REVIEW-MATERIAL',100,10,10,10,'EA',1,'3445',true,'{"sourceLineAliases":["1"],"orderLine":"1","orderLineAliases":["1"],"identityStatus":"exact"}'),
    ($2,-1,992233,'Review fixture material','REVIEW-MATERIAL',60,6,10,10,'EA',1,'3445',true,'{"identityStatus":"exact"}') RETURNING id,purchase_order_id`, [id,-id]);
  const parentLine = inserted.rows.find(row => Number(row.purchase_order_id) === id).id;
  const childLine = inserted.rows.find(row => Number(row.purchase_order_id) === -id).id;
  const split = await query(`INSERT INTO dispatch_scm_po_splits (source_po_id,source_po_ref,split_po_id,split_po_ref,status,created_by)
    VALUES ($1,$2,$3,$4,'active','dispatch-review-regression') RETURNING id`,[id,parentRef,-id,childRef]);
  await query(`INSERT INTO dispatch_scm_po_split_lines (split_id,source_line_id,split_line_id,item_id,item_name,sku,sales_qty,requested_sales_qty,pallet_qty,requested_pallet_qty,unit)
    VALUES ($1,$2,$3,992233,'Review fixture material','REVIEW-MATERIAL',60,60,6,6,'EA')`,[split.rows[0].id,parentLine,childLine]);
  await query(`INSERT INTO scm_transport_schedule (order_kind,source_table,source_id,order_ref,status,method,pickup_point,dropoff_point)
    VALUES ('PO','purchase_orders',$1,$2,'Queued','MBT','Review fixture vendor','3445'),
    ('PO','purchase_orders',$3,$4,'Queued','MBT','Review fixture vendor','3445')`,[id,residualRef,-id,childRef]);
  await storeLinkedScmReconciliationTransactions({
    order:{kind:"PO",id,tranid:parentRef},source:"manual",
    transactions:[{ref:childRef,quantity:60},{ref:residualRef,quantity:40}].map((receipt,index)=>({
      sourceOrderId:id,sourceOrderRef:parentRef,sourceOrderLine:1,sourceLineKey:"1",
      transactionId:id+index+10,transactionType:"ItemRcpt",transactionRef:`IR-${id}-${index}`,
      transactionMemo:receipt.ref,status:"B",statusText:"Posted",transactionDate:"2026-09-10",
      lastModifiedAt:"2026-09-10T01:00:00Z",transactionLine:1,transactionLineKey:"1",
      itemId:992233,itemName:"Review fixture material",quantity:receipt.quantity,unit:"EA",locationId:15,location:"12441"
    }))
  });
  return {id,parentRef,childRef,residualRef,splitId:split.rows[0].id};
}

test("an explicit residual receipt clears family review and preserves child quantities and operational status on replay", async()=>{
  await withTransaction(async()=>{
    const f=await family();
    const run=()=>reconcileScmOrderFamily({kind:"PO",sourceOrderId:f.id,source:"manual",actor:"dispatch-review-regression"});
    const first=await run();
    assert.equal(first.reconciliationStatus,"ok",first.reconciliationReason);
    assert.equal(first.targets[f.childRef].received,60);
    assert.equal(first.targets[f.residualRef].received,40);
    assert.equal(first.targets[f.childRef].applicationStatus,"Queued");
    assert.equal(first.targets[f.residualRef].applicationStatus,"Completed");
    const second=await run();
    assert.deepEqual(second.targets,first.targets);
    const schedules=await query("SELECT order_ref,status,dropoff_point,reconciliation_blocked FROM scm_transport_schedule WHERE order_ref=ANY($1::text[]) ORDER BY order_ref",[[f.childRef,f.residualRef]]);
    assert.ok(schedules.rows.every(row=>row.status==="Queued" && row.dropoff_point==="3445" && row.reconciliation_blocked===false));
    const reviews=await query("SELECT count(*) FROM scm_reconciliation_review_cases review JOIN scm_reconciliation_order_state state ON state.id=review.order_state_id WHERE state.source_order_netsuite_id=$1 AND review.status='open'",[f.id]);
    assert.equal(Number(reviews.rows[0].count),0);
  },{rollback:true});
});

test("ordinary Dispatch and explicit search preserve active split authority while the parent is under review", async()=>{
  await withTransaction(async()=>{
    const f=await family();
    await reconcileScmOrderFamily({kind:"PO",sourceOrderId:f.id,source:"manual",actor:"dispatch-review-regression"});
    await query("UPDATE scm_reconciliation_order_state SET reconciliation_status='review',reconciliation_reason='Another target needs review' WHERE source_order_netsuite_id=$1",[f.id]);
    const orders=await listDispatchOrders({type:"PO",search:f.childRef,exactOrderRefs:[f.childRef],includeHiddenScm:true});
    const child=orders.find(order=>order.id===f.childRef);
    assert.ok(child);
    assert.equal(child.isScmSplit,true);
    const source=orders.find(order=>Number(order.netsuiteId)===f.id);
    if(source) assert.equal(source.isScmSplit,false);
    const scm=(await listScmPurchaseOrders({search:f.childRef,includeAllDiscoverable:true})).find(order=>order.id===f.childRef);
    assert.equal(scm.isScmSplit,true);
    const [enriched]=await enrichScmScheduleWithReconciliation([{orderKind:"PO",orderRef:child.id,sourceId:child.netsuiteId,isScmSplit:child.isScmSplit,status:child.scm.status}],{view:"dispatch"});
    assert.equal(enriched.reconciliationStatus,"ok");
    assert.equal(enriched.calculatedStatus,"Queued");
    const response=(await loadDispatchOrdersForResponse({type:"PO",search:f.childRef,exactOrderRefs:[f.childRef],includeCompletedScmSearch:true})).find(order=>order.id===f.childRef);
    assert.ok(response);
    assert.equal(response.scm.status,"Queued");
    assert.equal(response.reconciliationBlocked,false);
    assert.notEqual(response.dispatchPlanningRestricted,true);
    await assert.doesNotReject(()=>assertNoRestrictedScmDispatchOrders([f.childRef],"be planned"));
    await query("UPDATE dispatch_scm_po_splits SET status='cancelled' WHERE id=$1",[f.splitId]);
    const cancelled=(await listDispatchOrders({type:"PO",search:f.childRef,exactOrderRefs:[f.childRef],includeHiddenScm:true})).find(order=>order.id===f.childRef);
    if(cancelled) assert.equal(cancelled.isScmSplit,false);
  },{rollback:true});
});
