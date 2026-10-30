import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {query,withTransaction,beginRollbackContext,closeDb} from '../../../src/db.js';
import {createOperator} from '../../../src/auth-repository.js';
import * as requests from '../../../src/special-stock-request-repository.js';
import {createScmPurchaseOrderSplit,listScmSchedule} from '../../../src/dispatch-repository.js';

after(closeDb);
async function fixture(run) {
  assert.equal(process.env.MBT_TEST_ISOLATED,'1');
  const rollback=await beginRollbackContext();
  try {await rollback.run(async()=>{
    const operator=await createOperator({username:'test-child-po',displayName:'TEST child PO',password:'test-only-disposable-password',role:'sales',roles:['sales'],yardLocationIds:[1]});
    let detail=await requests.createSpecialStockCase({storeLocationId:1,inquiryDate:'2099-01-01',customerName:'TEST child PO',vendorId:330,vendorName:'TEST Vendor',fulfillmentMethod:'yard_pickup',lines:[{productName:'Richmond Grey',quantity:1968,uom:'SQFT',rate:5,requiredDate:'2099-01-02'}]},{operatorId:operator.id,authorizedStoreLocationIds:[1]});
    const parent=887700001,ref='TEST-POB03429';
    await query("INSERT INTO purchase_orders(netsuite_id,tranid,vendor_id,vendor,status,status_text,netsuite_active,destination_location_id,destination_location) VALUES($1,$2,330,'TEST Vendor','D','Purchase Order : Partially Received',true,1,'3445')",[parent,ref]);
    const line=(await query("INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_id,sku,item_name,item_description,quantity,unit,netsuite_active,netsuite_received_baseline_qty) VALUES($1,1,2055,'MBBS-Special Order','MBBS-Special Order','Richmond 80mm Grey Mix',6000,'SQFT',true,0) RETURNING id",[parent])).rows[0];
    const children=[];
    for(const [suffix,quantity] of [['L3-18Plt',1771.2],['L4',1968]]) {
      children.push((await createScmPurchaseOrderSplit({sourcePoRef:ref,newPoRef:`${ref} (${suffix})`,destinationLocationId:1,lines:[{lineRowId:line.id,salesQty:quantity}],createdBy:'test'})).split);
    }
    await query("INSERT INTO sales_orders(netsuite_id,tranid,status,status_text,netsuite_active) VALUES(887700002,'TEST-SO-CHILD','B','Pending Fulfillment',true)");
    await query("UPDATE sales_special_stock_cases SET purchase_order_netsuite_id=$2,purchase_order_ref=$3,purchase_order_custom_linkage=true,sales_order_source='manual_link',purchase_order_operation_status='linked',sales_order_netsuite_id=887700002,sales_order_ref='TEST-SO-CHILD',sales_order_operation_status='linked' WHERE request_id=$1",[detail.id,parent,ref]);
    detail=await requests.getSpecialStockCase(detail.id,{audience:'scm',dispatchPlans:[]});
    await run({detail,parent,ref,children});
  });}finally{await rollback.rollback();}
}

test('child attachment scopes automatic schedule remarks and leaves parent and siblings untouched',async()=>fixture(async({detail,parent,ref,children})=>{
  const before=(await query('SELECT * FROM purchase_orders WHERE netsuite_id=$1 OR netsuite_id=ANY($2::bigint[]) ORDER BY netsuite_id',[parent,children.map(c=>c.splitPoId)])).rows;
  const attach=()=>requests.linkSpecialPurchaseOrder(detail.id,{expectedRevision:detail.revision,purchaseOrderRef:ref,customLinkage:true,purchaseOrderSplitId:children[1].id});
  const linked=await attach();assert.equal(linked.purchaseOrderSplitId,Number(children[1].id));
  assert.equal(linked.purchaseOrderTargetRef,children[1].splitPoRef);assert.equal(linked.purchaseOrderId,parent);
  await assert.rejects(()=>requests.updateSpecialPurchaseReference(detail.id,{expectedRevision:linked.revision,
    reference:'OTHER',previousReference:children[1].splitPoRef}),{code:'SPECIAL_CHILD_PO_REFERENCE'});
  const rows=await listScmSchedule({search:ref});
  assert.match(rows.find(r=>r.orderRef===children[1].splitPoRef).remarkPrefix,/TEST-SO-CHILD/);
  for(const other of [ref,children[0].splitPoRef]) {assert.equal(rows.find(r=>r.orderRef===other).remarkPrefix,'');}
  assert.deepEqual((await query('SELECT * FROM purchase_orders WHERE netsuite_id=$1 OR netsuite_id=ANY($2::bigint[]) ORDER BY netsuite_id',[parent,children.map(c=>c.splitPoId)])).rows,before);
  await assert.rejects(attach,{status:409});
  await assert.rejects(()=>withTransaction(()=>query("UPDATE dispatch_scm_po_splits SET status='cancelled' WHERE id=$1",[children[1].id])),/attached|linked.*request/i);
}));

test('schedule includes the child product description and fractional quantity',async()=>fixture(async({children,ref})=>{
  const rows=await listScmSchedule({search:ref});const row=rows.find(r=>r.orderRef===children[0].splitPoRef);
  assert.match(row.content,/Richmond 80mm Grey Mix/);assert.match(row.content,/1771\.2 SQFT/);
  assert.match(rows.find(r=>r.orderRef===children[1].splitPoRef).content,/1968 SQFT/);
}));

test('cancelled and unrelated split IDs cannot attach and failed saves preserve revision',async()=>fixture(async({detail,children,ref})=>{
  await query("UPDATE dispatch_scm_po_splits SET status='cancelled',cancelled_at=now() WHERE id=$1",[children[0].id]);
  for(const id of [children[0].id,999999999,-1,'bad']) {
    await assert.rejects(()=>requests.linkSpecialPurchaseOrder(detail.id,{expectedRevision:detail.revision,purchaseOrderRef:ref,customLinkage:true,purchaseOrderSplitId:id}));
    assert.equal((await requests.getSpecialStockCase(detail.id,{audience:'scm',dispatchPlans:[]})).revision,detail.revision);
  }
}));

test('a real child of another source is rejected and receiving work prevents attachment',async()=>fixture(async({detail,children,ref})=>{
  await query("INSERT INTO purchase_orders(netsuite_id,tranid,netsuite_active) VALUES(887700099,'TEST-OTHER-SOURCE',true)");
  await query('UPDATE dispatch_scm_po_splits SET source_po_id=887700099 WHERE id=$1',[children[0].id]);
  await assert.rejects(()=>requests.linkSpecialPurchaseOrder(detail.id,{expectedRevision:detail.revision,purchaseOrderSplitId:children[0].id}),{code:'SPECIAL_PO_SPLIT_MISMATCH'});
  await query('UPDATE purchase_order_lines SET netsuite_received_qty=1 WHERE purchase_order_id=$1',[children[1].splitPoId]);
  await assert.rejects(()=>requests.linkSpecialPurchaseOrder(detail.id,{expectedRevision:detail.revision,purchaseOrderSplitId:children[1].id}),{code:'SPECIAL_PO_SPLIT_LOCKED'});
  assert.equal((await requests.getSpecialStockCase(detail.id,{audience:'scm',dispatchPlans:[]})).purchaseOrderTargetRef,ref);
}));

test('child routing target detaches atomically and completion uses only the attached child',async()=>fixture(async({detail,children})=>{
  const child=children[1];
  let linked=await requests.linkSpecialPurchaseOrder(detail.id,{expectedRevision:detail.revision,purchaseOrderSplitId:child.id});
  await query("UPDATE sales_orders SET fulfillment_status='fulfilled',fulfilled_at=now() WHERE netsuite_id=887700002");
  await query("UPDATE purchase_orders SET receipt_status='received',received_at=now() WHERE netsuite_id=$1",[children[0].splitPoId]);
  assert.equal((await query('SELECT completed FROM special_stock_completion_evidence WHERE request_id=$1',[detail.id])).rows[0].completed,false);
  await query("UPDATE purchase_orders SET receipt_status='received',received_at=now() WHERE netsuite_id=$1",[child.splitPoId]);
  assert.equal((await query('SELECT completed FROM special_stock_completion_evidence WHERE request_id=$1',[detail.id])).rows[0].completed,true);
  await query("UPDATE purchase_orders SET receipt_status='not_received',received_at=NULL WHERE netsuite_id=$1",[child.splitPoId]);
  linked=await requests.linkSpecialPurchaseOrder(detail.id,{expectedRevision:linked.revision,purchaseOrderSplitId:null});
  assert.equal(linked.purchaseOrderSplitId,null);assert.equal(linked.purchaseOrderTargetRef,linked.purchaseOrderRef);
}));

test('handoff refresh keeps the selected child even when an older worker supplies the source ID',async()=>fixture(async({detail,parent,children})=>{
  const child=children[1];
  await requests.linkSpecialPurchaseOrder(detail.id,{expectedRevision:detail.revision,purchaseOrderSplitId:child.id});
  await query(`INSERT INTO sales_special_stock_handoffs(request_id,status,sales_order_netsuite_id,purchase_order_netsuite_id,
    pickup_address,destination_address,operational_yard_location_id,line_snapshot)
    VALUES($1,'waiting_route',887700002,$2,'Vendor','3445',1,'[]')`,[detail.id,parent]);
  assert.equal(Number((await query('SELECT purchase_order_netsuite_id FROM sales_special_stock_handoffs WHERE request_id=$1',[detail.id])).rows[0].purchase_order_netsuite_id),Number(child.splitPoId));
  await query('UPDATE sales_special_stock_handoffs SET purchase_order_netsuite_id=$2 WHERE request_id=$1',[detail.id,parent]);
  assert.equal(Number((await query('SELECT purchase_order_netsuite_id FROM sales_special_stock_handoffs WHERE request_id=$1',[detail.id])).rows[0].purchase_order_netsuite_id),Number(child.splitPoId));
}));

test('initial child attachment preserves an existing allocation to the request SO',async()=>fixture(async({detail,parent,children})=>{
  const child=children[1];
  await query("INSERT INTO sales_orders(netsuite_id,tranid,netsuite_active) VALUES(887700003,'TEST-OTHER-SO',true)");
  const salesLine=(await query("INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,quantity,unit) VALUES(887700002,1,2055,1968,'SQFT') RETURNING id")).rows[0];
  const otherLine=(await query("INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,quantity,unit) VALUES(887700003,1,2055,1968,'SQFT') RETURNING id")).rows[0];
  const purchaseLine=(await query('SELECT id FROM purchase_order_lines WHERE purchase_order_id=$1 ORDER BY id LIMIT 1',[child.splitPoId])).rows[0];
  const allocation=(await query(`INSERT INTO dispatch_so_po_allocations(sales_order_id,sales_order_ref,sales_line_id,
    po_order_id,po_order_ref,po_line_id,item_id,allocated_sales_qty,dispatch_target_ref,dispatch_target_line_key)
    VALUES(887700003,'TEST-OTHER-SO',$1,$2,$3,$4,2055,1968,'TEST-OTHER-SO','TEST-OTHER-SO::TEST-OTHER-SO::'||$1::bigint::text) RETURNING id`,
  [otherLine.id,child.splitPoId,child.splitPoRef,purchaseLine.id])).rows[0];
  const attach=()=>requests.linkSpecialPurchaseOrder(detail.id,{expectedRevision:detail.revision,purchaseOrderSplitId:child.id});
  await assert.rejects(attach,{code:'SPECIAL_PO_SPLIT_LOCKED'});
  await query("UPDATE dispatch_so_po_allocations SET sales_order_id=887700002,sales_order_ref='TEST-SO-CHILD',sales_line_id=$2,dispatch_target_ref='TEST-SO-CHILD',dispatch_target_line_key='TEST-SO-CHILD::TEST-SO-CHILD::'||$2::bigint::text WHERE id=$1",[allocation.id,salesLine.id]);
  const before=(await query('SELECT * FROM dispatch_so_po_allocations WHERE id=$1',[allocation.id])).rows;
  const orders=(await query('SELECT * FROM purchase_orders WHERE netsuite_id=ANY($1::bigint[]) ORDER BY netsuite_id',[[parent,...children.map(item=>item.splitPoId)]])).rows;
  const attached=await attach();assert.equal(attached.purchaseOrderSplitId,Number(child.id));
  assert.deepEqual((await query('SELECT * FROM dispatch_so_po_allocations WHERE id=$1',[allocation.id])).rows,before);
  assert.deepEqual((await query('SELECT * FROM purchase_orders WHERE netsuite_id=ANY($1::bigint[]) ORDER BY netsuite_id',[[parent,...children.map(item=>item.splitPoId)]])).rows,orders);
  await assert.rejects(()=>requests.linkSpecialPurchaseOrder(detail.id,{expectedRevision:attached.revision,purchaseOrderSplitId:null}),{code:'SPECIAL_PO_SPLIT_LOCKED'});
}));
