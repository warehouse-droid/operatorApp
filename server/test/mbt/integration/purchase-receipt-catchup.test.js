import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {query,withTransaction,closeDb} from '../../../src/db.js';
import {queueStalePurchaseReceiptRefreshes,enqueuePurchaseReceiptRefresh,applyPurchaseReceiptProgress} from '../../../src/purchase-receipt-refresh-repository.js';
after(closeDb);
const scenario=fn=>withTransaction(fn,{rollback:true});
async function linked(id,perLine=false) {
  await query("INSERT INTO purchase_orders(netsuite_id,tranid,status_text,netsuite_active,synced_at) VALUES($1,$2,'Pending Receipt',true,now()-interval '2 days')",[id,`PO-CATCH-${id}`]);
  await query("INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles) VALUES('receipt-user','receipt-user','Receipt','test','test','sales',ARRAY['sales']) ON CONFLICT DO NOTHING");
  const request=Number((await query("INSERT INTO sales_stock_requests(destination_location_id,destination_name,requested_by,status,workflow_version,regular_details) VALUES(1,'Yard','receipt-user','active',2,'{\"deliveryMethod\":\"backorder\"}') RETURNING id")).rows[0].id);
  await query(`INSERT INTO sales_special_stock_cases(request_id,inquiry_date,customer_name,vendor_name,workflow_kind,purchase_order_netsuite_id,purchase_order_ref,purchase_order_custom_linkage)
    VALUES($1,CURRENT_DATE,'Receipt customer','Receipt vendor','backorder',$2,$3,true)`,[request,perLine?null:id,perLine?null:`PO-CATCH-${id}`]);
  if(perLine) {
    await query("INSERT INTO inventory_items(item_id,item_name,stock_unit) VALUES(988000,'Receipt material','EA') ON CONFLICT DO NOTHING");
    await query(`INSERT INTO sales_special_stock_lines(request_id,line_number,product_name,requested_quantity,requested_uom,supply_status,backorder_po_number,regular_item_id,regular_item_code)
      VALUES($1,1,'Receipt material',10,'EA','already_ordered',$2,988000,'RECEIPT-MATERIAL')`,[request,`PO-CATCH-${id}`]);
  }
  return request;
}
test('catch-up covers header and per-line POs, caps ten, skips fresh attempts, cancelled and unlinked orders',()=>scenario(async()=>{
  for(let i=0;i<13;i++) await linked(988000+i,i%2===0);
  const cancelled=await linked(988020);await query("UPDATE sales_stock_requests SET status='cancelled' WHERE id=$1",[cancelled]);
  await query("INSERT INTO purchase_orders(netsuite_id,tranid,netsuite_active,synced_at) VALUES(988021,'UNLINKED',true,now()-interval '2 days')");
  const first=await queueStalePurchaseReceiptRefreshes({limit:999});
  assert.equal(first.length,10);assert(first.every(row=>row.netsuiteOrderId<988013));
  const second=await queueStalePurchaseReceiptRefreshes();assert.equal(second.length,3);
  assert.equal((await queueStalePurchaseReceiptRefreshes()).length,0);
  await query("UPDATE netsuite_delayed_status_refresh_jobs SET status='succeeded'");
  assert.equal((await queueStalePurchaseReceiptRefreshes()).length,0);
}));
test('unknown and cyclic split identities do not create jobs and failed writes roll back the queue',()=>scenario(async()=>{
  await linked(988031);
  await assert.rejects(withTransaction(async()=>{await enqueuePurchaseReceiptRefresh(988031);throw new Error('rollback receipt');}),/rollback receipt/);
  assert.equal((await query('SELECT count(*)::int AS n FROM netsuite_delayed_status_refresh_jobs')).rows[0].n,0);
  await query("INSERT INTO dispatch_scm_po_splits(source_po_id,source_po_ref,split_po_id,split_po_ref) VALUES(988031,'CYCLE',988031,'CYCLE')");
  assert.equal(await enqueuePurchaseReceiptRefresh(988031),null);
}));
test('authoritative snapshot retires missing lines but preserves successful local receipt evidence',()=>scenario(async()=>{
  await linked(988041);
  await query("INSERT INTO purchase_order_lines(purchase_order_id,line_id,quantity,netsuite_active) VALUES(988041,99,10,true)");
  await query("INSERT INTO receiving_receipt_records(order_id,receipt_status,payload) VALUES(988041,'received','{}')");
  await query("UPDATE purchase_orders SET receipt_status='received',received_at=now() WHERE netsuite_id=988041");
  const before=(await query('SELECT received_at FROM purchase_orders WHERE netsuite_id=988041')).rows[0].received_at;
  await applyPurchaseReceiptProgress({netsuiteOrderId:988041,lines:[{line_id:1,item_id:988041,item_name:'MATERIAL',item_type:'InvtPart',quantity:10,netsuite_received_qty:0,unit:'EA'}]});
  assert.equal((await query('SELECT netsuite_active FROM purchase_order_lines WHERE purchase_order_id=988041 AND line_id=99')).rows[0].netsuite_active,false);
  const header=(await query('SELECT receipt_status,received_at FROM purchase_orders WHERE netsuite_id=988041')).rows[0];
  assert.equal(header.receipt_status,'received');assert.deepEqual(header.received_at,before);
  assert.equal(await applyPurchaseReceiptProgress({netsuiteOrderId:988041,lines:[]}),null);
}));
