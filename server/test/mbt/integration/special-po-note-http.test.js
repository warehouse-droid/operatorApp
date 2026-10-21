import assert from 'node:assert/strict';
import test, {before,after} from 'node:test';
import crypto from 'node:crypto';
import {fixture} from '../../support/operator-suiteql-fixture.mjs';
import {createOperator} from '../../../src/auth-repository.js';
import {query} from '../../../src/db.js';
import {app} from '../../../src/server.js';
import {createSpecialStockCase} from '../../../src/special-stock-request-repository.js';
import {upsertPurchaseOrders} from '../../../src/order-sync-repository.js';
import {upsertScmPurchaseOrderCatalog,getScmPurchaseOrderCatalogOrder} from '../../../src/scm-purchase-order-catalog-repository.js';

const run=crypto.randomUUID().replaceAll('-',''),poId=8_800_000_000_000+Date.now(),customerId=poId+1,ref='TEST-NOTE-'+run;
let transport,server,base,detail,gate;
const users={},calls=[];
const record={id:String(poId),tranId:ref,entity:{id:'331'},custbody7:'for SOB121819',memo:'Pickering Yard - Unilock'};
async function request(path,{role='scm',method='GET',body}={}) {
  const response=await fetch(base+path,{method,headers:{...(users[role]?{authorization:'Bearer '+users[role].token}:{}),
    ...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,payload:await response.json()};
}
before(async()=>{
  transport=await fixture();
  transport.state.handle=async req=>{
    calls.push(req);
    assert.equal(req.url.pathname,'/services/rest/record/v1/purchaseOrder/'+poId);
    if(req.method==='PATCH'){assert.deepEqual(Object.keys(req.body),['custbody7']);record.custbody7=req.body.custbody7;return{status:204};}
    assert.equal(req.method,'GET');return{data:{...record}};
  };
  gate=(await query("SELECT enabled FROM mbt_feature_flags WHERE flag_key='special_stock_request_workflow'")).rows[0].enabled;
  await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key='special_stock_request_workflow'");
  await query(`INSERT INTO netsuite_customers(netsuite_id,entity_number,legal_name,display_name,currency,active,source_modified_at,source_version,payload_hash)
    VALUES($1,$2,'TEST Note','TEST Note','CAD',true,now(),'test',repeat('d',64))`,[customerId,'TEST-NOTE-'+run]);
  for(const role of ['scm','sales','dispatcher']){
    const username='po-note-'+role+'-'+run;
    users[role]=await createOperator({username,displayName:'TEST Note '+role,password:'isolated-note-test',role,roles:[role],yardLocationIds:[1]});
    users[role].username=username;
  }
  detail=await createSpecialStockCase({storeLocationId:1,inquiryDate:'2099-01-01',customerId,customerName:'TEST Note',
    vendorId:331,vendorName:'TEST note vendor',fulfillmentMethod:'yard_pickup',
    lines:[{productName:'TEST Note material',quantity:24,uom:'PCS',rate:48.39,requiredDate:'2099-02-01'}]},
    {operatorId:users.scm.id,authorizedStoreLocationIds:[1]});
  await query(`UPDATE sales_special_stock_cases SET purchase_order_netsuite_id=$2,purchase_order_ref=$3,
    purchase_order_operation_status='linked' WHERE request_id=$1`,[detail.id,poId,ref]);
  await upsertPurchaseOrders([{id:poId,tranid:ref,trandate:'2099-01-01',vendor_id:331,vendor:'TEST note vendor',status:'B',
    status_text:'Pending Receipt',memo:record.memo,netsuite_note:record.custbody7,destination_location_id:1,destination_location:'3445'}]);
  await upsertScmPurchaseOrderCatalog({orders:[{id:ref,type:'PO',originalPoRef:ref,scm:{method:'MBT',status:'Hold',notes:''},items:[]}],source:'note-http-test'});
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  base='http://127.0.0.1:'+server.address().port;
  for(const role of Object.keys(users)){
    const response=await request('/api/auth/login',{role:'none',method:'POST',body:{username:users[role].username,password:'isolated-note-test'}});
    assert.equal(response.status,200);users[role].token=response.payload.token;
  }
});
after(async()=>{
  try {
  if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  if(detail)await query('DELETE FROM sales_stock_requests WHERE id=$1',[detail.id]);
  await query('DELETE FROM scm_transport_schedule WHERE order_ref=$1',[ref]);
  await query('DELETE FROM scm_purchase_order_catalog_entries WHERE order_ref=$1',[ref]);
  await query('DELETE FROM purchase_orders WHERE netsuite_id=$1',[poId]);
  for(const user of Object.values(users)){
    await query('DELETE FROM delivery_audit_log WHERE actor_operator_id=$1',[user.id]);
    await query('DELETE FROM operators WHERE id=$1',[user.id]);
  }
  await query('UPDATE netsuite_customers SET active=false WHERE netsuite_id=$1',[customerId]);
  if(gate!==undefined)await query("UPDATE mbt_feature_flags SET enabled=$1 WHERE flag_key='special_stock_request_workflow'",[gate]);
  } finally {await transport?.close();}
});

test('special Note routes require SCM access and SCM write access',async()=>{
  const path='/api/scm/special-stock-requests/'+detail.id+'/purchase-order/';
  assert.equal((await request(path+'note',{role:'none'})).status,401);
  assert.equal((await request(path+'note',{role:'sales'})).status,403);
  assert.equal((await request(path+'routing',{role:'dispatcher',method:'PUT',body:{}})).status,403);
  assert.equal(calls.length,0);
});

test('real HTTP Special Request Note saves reach NetSuite; PO Split saves only change the local schedule',async()=>{
  const path='/api/scm/special-stock-requests/'+detail.id+'/purchase-order/';
  const note=await request(path+'note');assert.equal(note.status,200);assert.equal(note.payload.note,'for SOB121819');
  const saved=await request(path+'routing',{method:'PUT',body:{expectedRevision:detail.revision,expectedUpdatedAt:null,
    expectedNote:note.payload.note,notes:'for SOB121819 | Call before pickup',remarkOverride:'Local routing Remark',method:'Vendor'}});
  assert.equal(saved.status,200,JSON.stringify(saved.payload));
  assert.equal(record.custbody7,'for SOB121819 | Call before pickup');
  assert.equal(record.memo,'Pickering Yard - Unilock');
  let order=await getScmPurchaseOrderCatalogOrder(ref);
  assert.equal(order.netSuiteNote,record.custbody7);assert.equal(order.scm.remark,'Local routing Remark');
  const writes=calls.filter(call=>call.method==='PATCH').length;
  const split=await request('/api/scm/schedule/'+ref+'?includeSchedule=false',{method:'PUT',body:{orderKind:'PO',
    expectedUpdatedAt:order.scm.updatedAt,notes:'Local PO Split Note',remarkOverride:'Local PO Split Remark'}});
  assert.equal(split.status,200,JSON.stringify(split.payload));
  assert.equal(calls.filter(call=>call.method==='PATCH').length,writes);
  assert.equal(record.custbody7,'for SOB121819 | Call before pickup');
  order=await getScmPurchaseOrderCatalogOrder(ref);
  assert.equal(order.scm.notes,'Local PO Split Note');assert.equal(order.scm.remark,'Local PO Split Remark');
  assert.equal((await request(path+'note')).payload.note,record.custbody7);
});

test('a stale NetSuite Note rolls back the entire local routing change',async()=>{
  const order=await getScmPurchaseOrderCatalogOrder(ref),previous=(await query('SELECT * FROM scm_transport_schedule WHERE order_ref=$1',[ref])).rows[0];
  record.custbody7='Another user changed the PO Note';
  const writes=calls.filter(call=>call.method==='PATCH').length;
  const result=await request('/api/scm/special-stock-requests/'+detail.id+'/purchase-order/routing',{method:'PUT',body:{
    expectedRevision:detail.revision,expectedUpdatedAt:order.scm.updatedAt,expectedNote:order.netSuiteNote,
    notes:'Stale overwrite',remarkOverride:'Must roll back',method:'Customer Pickup'}});
  assert.equal(result.status,409,JSON.stringify(result.payload));
  assert.equal(calls.filter(call=>call.method==='PATCH').length,writes);
  assert.equal(record.custbody7,'Another user changed the PO Note');
  assert.deepEqual((await query('SELECT * FROM scm_transport_schedule WHERE order_ref=$1',[ref])).rows[0],previous);
});

test('a missing request and a PO not yet synced return errors instead of saving',async()=>{
  assert.equal((await request('/api/scm/special-stock-requests/999999999999/purchase-order/note')).status,404);
  await query('DELETE FROM purchase_orders WHERE netsuite_id=$1',[poId]);
  const result=await request('/api/scm/special-stock-requests/'+detail.id+'/purchase-order/note');
  assert.equal(result.status,409);
  assert.match(result.payload.error,/Sync this PO/);
});
