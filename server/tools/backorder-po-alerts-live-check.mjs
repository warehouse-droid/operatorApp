// Run through docker exec stdin from /app; every operation is read-only.
import assert from 'node:assert/strict';
import {query,withTransaction,closeDb} from './src/db.js';
import {getBackorderRequest,backorderAlerts} from './src/backorder-request-service.js';
import {specialPurchaseOrderDisplayRef} from './public/special-stock-po-reference.js';
try {
  const result=await withTransaction(async()=>{
    await query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    await query("SET LOCAL statement_timeout='15s'");
    const request=(await query('SELECT id,request_ref,requested_by,destination_location_id FROM sales_stock_requests WHERE request_ref=$1',['STREQ-000198'])).rows[0];
    assert(request);
    const detail=await getBackorderRequest(request.id,{audience:'sales',authorizedStoreLocationIds:[Number(request.destination_location_id)]});
    const alerts=await backorderAlerts({operatorId:request.requested_by,authorizedDestinationLocationIds:[Number(request.destination_location_id)]});
    const po=(await query('SELECT netsuite_id,tranid,dispatch_ref FROM purchase_orders WHERE tranid=$1',['POB04147'])).rows[0];
    assert(po);
    const line=detail.lines.find(line=>line.poNumber==='POB04147');assert(line);
    const order=detail.alreadyOrderedArrival.orders.find(order=>order.purchaseOrderId===Number(po.netsuite_id));assert(order);
    const saved=(await query('SELECT backorder_po_number,backorder_po_ref_number FROM sales_special_stock_lines WHERE id=$1',[line.id])).rows[0];
    assert.equal(line.poRefNumber,String(po.dispatch_ref||'').trim()||saved.backorder_po_ref_number||'');
    assert.equal(line.poPlanning.planned,order.planned);
    if (!String(po.dispatch_ref||'').trim()) assert(!detail.poProgressNotices.some(notice=>notice.action==='po_reference'&&notice.purchaseOrderId===Number(po.netsuite_id)));
    return {request:request.request_ref,purchaseOrder:po.tranid,poReference:po.dispatch_ref||null,
      lineDisplay:specialPurchaseOrderDisplayRef({purchaseOrderRef:line.poNumber,purchaseOrderReference:line.poRefNumber}),
      planned:line.poPlanning.planned,plans:line.poPlanning.plans,
      unreadActions:alerts.requests.filter(row=>row.id===detail.id).map(row=>row.action),
      savedReviewReference:saved.backorder_po_ref_number||null,readOnly:true};
  });
  console.log(JSON.stringify(result));
} finally {await closeDb();}
