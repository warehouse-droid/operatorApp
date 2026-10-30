import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {query,closeDb} from '../../../src/db.js';
import {listStockRequestSalesOrders,applyStockRequestSalesOrderObservation as apply,withStockRequestRefreshSlot as slot} from '../../../src/stock-request-so-refresh-repository.js';
import {stockRequestSalesOrderObservation as observe} from '../../../src/stock-request-so-refresh-domain.js';
import {getSpecialStockCase} from '../../../src/special-stock-request-repository.js';
import {getScmStockRequest} from '../../../src/stock-request-repository.js';
import {canEditSpecialFulfillment} from '../../../public/special-stock-fulfillment.js';
import {backorderSalesOrderProgress} from '../../../src/backorder-sales-order-progress.js';
let sequence=8912000;
const stamp='2026-10-28 00:00:00.123456+00';
before(async()=>{
 assert.equal(process.env.MBT_TEST_ISOLATED,'1');assert.equal(process.env.NETSUITE_DIRECT_ACCESS_ENABLED,'false');
 await query("INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,yard_location_ids) VALUES('hourly-test','hourly-test','TEST','x','x','admin',ARRAY['admin'],ARRAY[1])");
 await query("INSERT INTO inventory_items(item_id,item_name,stock_unit) VALUES(8912999,'TEST hourly material','EA') ON CONFLICT DO NOTHING");
});
after(closeDb);
async function fixture({special=false,method=special?'yard_pickup':'pickup',completed=false,backorder=false}={}){
 const id=++sequence,ref='SO-HOURLY-'+id;
 await query("INSERT INTO sales_orders(netsuite_id,tranid,status,status_text,fulfillment_status,netsuite_active,synced_at,foreign_total,delivery_method_id) VALUES($1,$2,'B','Sales Order : Pending Fulfillment','not_fulfilled',true,$3,123.45,1)",[id,ref,stamp]);
 await query("INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_name,item_type,quantity,netsuite_active,unit,loaded_qty,packed_piece_qty) VALUES($1,17,8912999,'TEST','InvtPart',10,true,'EA',2,2)",[id]);
 const requestId=Number((await query(`INSERT INTO sales_stock_requests(request_ref,request_type,destination_location_id,destination_name,requested_by,status,workflow_version,regular_details)
  VALUES($1,$2,1,'3445','hourly-test',$3,2,$4::jsonb) RETURNING id`,['TEST-HOURLY-'+id,special&&!backorder?'special':'regular',completed?'completed':'active',JSON.stringify(special?backorder?{deliveryMethod:'backorder'}:{}:{deliveryMethod:method,salesOrderId:id,salesOrderRef:ref,handoffStatus:'complete'})])).rows[0].id);
 if(special){
  await query("INSERT INTO purchase_orders(netsuite_id,tranid,status,status_text,netsuite_active,receipt_status,received_at) VALUES($1,$2,'F','Purchase Order : Pending Bill',true,'received',now())",[id+100000,'PO-HOURLY-'+id]);
  await query(`INSERT INTO sales_special_stock_cases(request_id,inquiry_date,customer_name,vendor_name,fulfillment_method,operational_yard_location_id,sales_order_netsuite_id,sales_order_ref,sales_order_status,sales_order_approved,purchase_order_netsuite_id,purchase_order_ref,workflow_kind,sales_order_source,purchase_order_custom_linkage,delivery_address)
   VALUES($1,'2026-10-28','TEST','TEST',$2,1,$3,$4,'Pending Fulfillment',true,$5,$6,$7,'manual_link',$8,'TEST address')`,[requestId,method,id,ref,id+100000,'PO-HOURLY-'+id,backorder?'backorder':'special',backorder]);
 }else{
  await query("INSERT INTO regular_stock_handoffs(request_id,sales_order_id,sales_order_ref,plan,status) VALUES($1,$2,$3,'{}','complete')",[requestId,id,ref]);
  await query(`INSERT INTO sales_stock_request_lines(request_id,item_id,item_name,source_location_id,source_name,destination_location_id,destination_name,sales_qty,sales_uom,quantity_mode,status)
   VALUES($1,8912999,'TEST',28,'90',1,'3445',10,'EA','sales','converted')`,[requestId]);
 }
 return {id,ref,requestId};
}
const candidate=async f=>(await listStockRequestSalesOrders()).find(row=>row.id===f.id);
const observation=(f,fulfilled=10,status='F')=>observe(f,{id:f.id,tranid:f.ref,status,status_text:status==='F'?'Sales Order : Pending Billing':'Sales Order : Partially Fulfilled',
 lines:[{line_id:17,item_id:8912999,item_type:'InvtPart',quantity:10,netsuite_received_qty:fulfilled}]});
async function snapshot(f){return (await query(`SELECT jsonb_build_object('so',(SELECT to_jsonb(s) FROM sales_orders s WHERE netsuite_id=$1),
 'lines',(SELECT jsonb_agg(l) FROM sales_order_lines l WHERE sales_order_id=$1),'request',(SELECT to_jsonb(r) FROM sales_stock_requests r WHERE id=$2)) AS data`,[f.id,f.requestId])).rows[0].data;}
test('candidate scope includes Special, Backorder and routed Regular pickup but excludes Delivery and cancellation',async()=>{
 const pickup=await fixture(),routed=await fixture({completed:true}),special=await fixture({special:true}),backorder=await fixture({special:true,backorder:true});
 const delivery=await fixture({method:'delivery'}),sDelivery=await fixture({special:true,method:'mbt_delivery'}),cancelled=await fixture();
 await query("UPDATE sales_stock_requests SET status='cancelled' WHERE id=$1",[cancelled.requestId]);
 const ids=(await listStockRequestSalesOrders()).map(c=>c.id);
 for(const f of [pickup,routed,special,backorder])assert.ok(ids.includes(f.id));
 for(const f of [delivery,sDelivery,cancelled])assert.ok(!ids.includes(f.id));
});
test('full pickup progress completes Regular requests and preserves commercial and local packing fields',async()=>{
 const f=await fixture(),c=await candidate(f),before=await snapshot(f);
 assert.equal((await apply(c,observation(f))).updated,true);
 const after=await snapshot(f);assert.equal(after.so.foreign_total,before.so.foreign_total);
 for(const field of ['quantity','loaded_qty','packed_piece_qty'])assert.equal(after.lines[0][field],before.lines[0][field]);
 assert.deepEqual(after.lines,before.lines);assert.equal(after.request.regular_details.salesOrderProgress.lines[0].fulfilledQuantity,10);assert.equal(after.so.fulfillment_status,'fulfilled');
 assert.equal(after.request.status,'completed');assert.equal(after.request.regular_details.salesOrderProgress.completed,true);
 const detail=await getScmStockRequest(f.requestId);assert.equal(detail.statusSummary.status,'completed');assert.equal(detail.statusSummary.detail,'so_fulfilled');
 assert.equal(await candidate(f),undefined);
});
test('full Special pickup SO reconciles to Completed and cannot change delivery method',async()=>{
 const f=await fixture({special:true});assert.equal((await apply(await candidate(f),observation(f))).updated,true);
 const detail=await getSpecialStockCase(f.requestId,{audience:'sales'});
 assert.equal(detail.stage,'completed');assert.equal(detail.operationallyComplete,true);assert.equal(canEditSpecialFulfillment(detail),false);
 assert.equal(await candidate(f),undefined);
});
test('partial fulfillment keeps a pickup request active and does not invent a completion timestamp',async()=>{
 const f=await fixture();await apply(await candidate(f),observation(f,3,'D'));
 const result=await snapshot(f);assert.equal(result.request.status,'active');assert.equal(result.so.fulfillment_status,'partial_fulfilled');assert.equal(result.so.fulfilled_at,null);
 assert.equal(result.request.regular_details.salesOrderProgress.completed,false);assert.ok(await candidate(f));
});
for(const change of ['timestamp','revision','method','cancel','link'])test('stale observation is fenced after concurrent '+change,async()=>{
 const f=await fixture(),c=await candidate(f);
 if(change==='timestamp')await query("UPDATE sales_orders SET synced_at='2026-10-28 00:00:00.123457+00',status='D' WHERE netsuite_id=$1",[f.id]);
 else if(change==='revision')await query('UPDATE sales_stock_requests SET revision=revision+1 WHERE id=$1',[f.requestId]);
 else if(change==='method')await query(`UPDATE sales_stock_requests SET regular_details=jsonb_set(regular_details,'{deliveryMethod}','"delivery"') WHERE id=$1`,[f.requestId]);
 else if(change==='cancel')await query("UPDATE sales_stock_requests SET status='cancelled' WHERE id=$1",[f.requestId]);
 else await query("UPDATE regular_stock_handoffs SET sales_order_id=sales_order_id+10000 WHERE request_id=$1",[f.requestId]);
 const before=await snapshot(f);assert.equal((await apply(c,observation(f))).updated,false);assert.deepEqual(await snapshot(f),before);
});
test('a failed request update rolls back canonical status and request progress together',async()=>{
 const f=await fixture(),c=await candidate(f),before=await snapshot(f);
 await query(`CREATE FUNCTION hourly_test_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'TEST rollback'; END $$;
 CREATE TRIGGER hourly_test_reject BEFORE UPDATE ON sales_stock_requests FOR EACH ROW EXECUTE FUNCTION hourly_test_reject()`);
 try{await assert.rejects(apply(c,observation(f)),/TEST rollback/);assert.deepEqual(await snapshot(f),before);}
 finally{await query('DROP TRIGGER hourly_test_reject ON sales_stock_requests;DROP FUNCTION hourly_test_reject()');}
});
test('durable hourly gate rejects duplicate workers and restarts until exactly one hour; failed runs unlock',async()=>{
 await query("DELETE FROM delivery_audit_log WHERE action='stock_request.so_refresh.started'");
 const now=new Date('2111-01-01T00:00:00Z');let open,entered;
 const gate=new Promise(r=>{open=r;}),start=new Promise(r=>{entered=r;});
 const first=slot(now,async check=>{await check();entered();await gate;return {started:true};});await start;
 try{assert.equal((await slot(now,()=>assert.fail('overlap'))).reason,'already_running');}finally{open();await first;}
 assert.equal((await slot(new Date(+now+3599999),()=>assert.fail('too early'))).reason,'not_due');
 await assert.rejects(slot(new Date(+now+3600000),async()=>{throw Error('TEST failure');}),/TEST failure/);
 assert.equal((await slot(new Date(+now+7200000),async()=>({started:true}))).started,true);
});
test('a shared SO is fetched once and all eligible request links are reconciled',async()=>{
 const regular=await fixture(),special=await fixture({special:true});
 await query('UPDATE sales_special_stock_cases SET sales_order_netsuite_id=$2,sales_order_ref=$3 WHERE request_id=$1',[special.requestId,regular.id,regular.ref]);
 const rows=(await listStockRequestSalesOrders()).filter(c=>c.id===regular.id);assert.equal(rows.length,1);assert.equal(rows[0].links.length,2);
 const result=await apply(rows[0],observation(regular));assert.deepEqual(result.requestIds.sort((a,b)=>a-b),[regular.requestId,special.requestId].sort((a,b)=>a-b));
 assert.equal((await getScmStockRequest(regular.requestId)).status,'completed');assert.equal((await getSpecialStockCase(special.requestId)).stage,'completed');
});
for(const mismatch of ['missing line','item','quantity'])test('incomplete or changed remote '+mismatch+' cannot falsely complete a request',async()=>{
 const f=await fixture();
 if(mismatch==='missing line')await query("INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,quantity,netsuite_active) VALUES($1,18,8912999,7,true)",[f.id]);
 const c=await candidate(f),o=observation(f);if(mismatch==='item')o.lines[0].itemId++;
 if(mismatch==='quantity')o.lines[0].quantity++;
 const before=await snapshot(f);await assert.rejects(apply(c,o),/line.*match|incomplete/i);assert.deepEqual(await snapshot(f),before);
});
test('fully fulfilled SO does not invent a missing supplier arrival for a Special pickup',async()=>{
 const f=await fixture({special:true});await query("UPDATE purchase_orders SET receipt_status='not_received',received_at=NULL,status='B',status_text='Pending Receipt' WHERE netsuite_id=$1",[f.id+100000]);
 await apply(await candidate(f),observation(f));const d=await getSpecialStockCase(f.requestId);
 assert.equal(d.operationallyComplete,false);assert.equal(canEditSpecialFulfillment(d),false);
 assert.equal((await query('SELECT received_at FROM purchase_orders WHERE netsuite_id=$1',[f.id+100000])).rows[0].received_at,null);
});
test('reference-only non-delivery Backorders refresh without replacing their manual SO linkage',async()=>{
 const f=await fixture({special:true,backorder:true});
 await query("UPDATE sales_special_stock_cases SET sales_order_netsuite_id=NULL,sales_order_ref=NULL,sales_order_approved=false WHERE request_id=$1",[f.requestId]);
 await query("UPDATE sales_stock_requests SET regular_details=jsonb_set(regular_details,'{alreadyOrderedSalesOrderRef}',to_jsonb($2::text)) WHERE id=$1",[f.requestId,f.ref]);
 const c=await candidate(f);assert.ok(c,'Optional SO reference must be included');await apply(c,observation(f));
 const progress=await backorderSalesOrderProgress([{id:f.requestId,workflowKind:'backorder',alreadyOrderedSalesOrderRef:f.ref}]);
 assert.equal(progress.get(f.requestId).completed,true);
 const raw=(await query('SELECT sales_order_netsuite_id,sales_order_ref,sales_order_approved FROM sales_special_stock_cases WHERE request_id=$1',[f.requestId])).rows[0];
 assert.deepEqual(raw,{sales_order_netsuite_id:null,sales_order_ref:null,sales_order_approved:false});
});
