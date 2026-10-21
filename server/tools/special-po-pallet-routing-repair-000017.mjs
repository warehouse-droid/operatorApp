import assert from 'node:assert/strict';
import {query,withTransaction,closeDb} from '../src/db.js';
import {getSpecialStockCase,reconcileSpecialOrderWebhook} from '../src/special-stock-request-repository.js';

const select=`SELECT r.id,r.revision,c.close_status,c.sales_order_netsuite_id,c.purchase_order_netsuite_id,
 c.pallet_total,c.pallet_rate,c.quantity_review,c.vendor_discount_review,c.attention,c.attention_reason
 FROM sales_stock_requests r JOIN sales_special_stock_cases c ON c.request_id=r.id
 WHERE r.request_ref='SPREQ-000017' AND r.id=83`;
const snapshot=async()=> (await query(`SELECT json_build_object(
 'so',(SELECT json_agg(to_jsonb(l)-'updated_at' ORDER BY id) FROM sales_special_stock_order_lines l WHERE request_id=83 AND order_kind='sales_order'),
 'canonicalPO',(SELECT json_agg(to_jsonb(l) ORDER BY id) FROM purchase_order_lines l WHERE purchase_order_id=1030348),
 'poHeader',(SELECT to_jsonb(p) FROM purchase_orders p WHERE netsuite_id=1030348),
 'materialPO',(SELECT json_agg(to_jsonb(l)-'updated_at' ORDER BY id) FROM sales_special_stock_order_lines l WHERE request_id=83 AND order_kind='purchase_order' AND item_id<>1784)) AS value`)).rows[0].value;
try {
  const result=await withTransaction(async()=>{
    const row=(await query(select+' FOR UPDATE OF r,c')).rows[0];assert(row);
    assert.equal(Number(row.sales_order_netsuite_id),1030576);assert.equal(Number(row.purchase_order_netsuite_id),1030348);
    assert.equal(row.close_status,'active');assert.equal(Number(row.pallet_total),1);assert.equal(Number(row.pallet_rate),40);
    assert.deepEqual(row.quantity_review,{});
    const lines=(await query("SELECT * FROM purchase_order_lines WHERE purchase_order_id=1030348 AND netsuite_active=true ORDER BY id FOR SHARE")).rows;
    assert.equal(lines.length,2);assert.equal(lines.filter(line=>Number(line.item_id)===2055).length,1);
    const pallet=lines.find(line=>Number(line.item_id)===1784);assert(pallet);
    assert.equal(Number(pallet.line_id),5059460);assert.equal(Number(pallet.quantity),1);assert.equal(pallet.unit,'EACH');assert.equal(Number(pallet.rate),35);
    assert.equal(pallet.item_description,'**PALLET DEPOSIT** INTERLOCK,CEMENT, CONCRETE');
    const saved=(await query("SELECT * FROM sales_special_stock_order_lines WHERE request_id=83 AND order_kind='purchase_order' AND item_id=1784 FOR UPDATE")).rows;
    const before=await snapshot();
    if(!process.argv.includes('--apply'))return {requestRef:'SPREQ-000017',poRef:'POB03976',quantity:1,purchaseCost:35,alreadyReviewed:saved.length===1,attention:row.attention,readOnly:true};
    assert.ok(saved.length<=1);
    if(!saved.length) {
      assert.equal(row.attention,true);assert.match(row.attention_reason,/Purchase Order has 1 unreviewed item line/);
      await query(`INSERT INTO sales_special_stock_order_lines(request_id,order_kind,ancillary,item_id,item_name,description,quantity,uom,unit_purchase_cost,remote_line_id)
        VALUES(83,'purchase_order',true,1784,'PALLET',$1,1,'EACH',35,5059460)`,[pallet.item_description]);
      await query(`UPDATE sales_special_stock_cases SET vendor_discount_review=vendor_discount_review || $1::jsonb WHERE request_id=83`,
        [JSON.stringify({pallet:{quantity:1,unitPurchaseCost:35,verifiedExistingLine:true}})]);
      await query(`INSERT INTO sales_special_stock_events(request_id,event_type,actor_id,audience,details)
        VALUES(83,'special_purchase_pallet_reconciled',NULL,'sales_scm',$1::jsonb)`,[JSON.stringify({
        source:'user_requested_pallet_fix',purchaseOrderId:1030348,remoteLineId:5059460,quantity:1,uom:'EACH',unitPurchaseCost:35})]);
    } else {
      assert.equal(Number(saved[0].remote_line_id),5059460);assert.equal(Number(saved[0].unit_purchase_cost),35);
      assert.equal(Number(saved[0].quantity),1);assert.equal(saved[0].ancillary,true);
    }
    await reconcileSpecialOrderWebhook({orderKind:'purchase_order',orderId:1030348});
    const detail=await getSpecialStockCase(83,{audience:'scm'});
    assert.equal(detail.attention,false);assert.deepEqual(await snapshot(),before,'SO, PO materials and synced NetSuite order must remain unchanged');
    const reviewed=detail.purchaseOrderLines.filter(line=>line.itemId===1784);assert.equal(reviewed.length,1);
    assert.deepEqual([reviewed[0].quantity,reviewed[0].unitPurchaseCost,reviewed[0].remoteLineId],[1,35,5059460]);
    return {repaired:true,requestRef:detail.requestRef,poRef:detail.purchaseOrderRef,revision:detail.revision,
      attention:detail.attention,palletQuantity:1,palletPurchaseCost:35,remoteOrdersChanged:false,existingPALLETLinked:true};
  });
  console.log(JSON.stringify(result));
} finally {await closeDb();}
