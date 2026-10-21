import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { app } from '../../../src/server.js';
import { createOperator } from '../../../src/auth-repository.js';
import { query, withTransaction, closeDb } from '../../../src/db.js';
import { createSpecialStockCase } from '../../../src/special-stock-request-repository.js';
import { updatePurchaseOrderDispatchRef, updateScmScheduleEntry } from '../../../src/dispatch-repository.js';
import { listSpecialPoReferenceAlerts, acknowledgeSpecialPoReferenceAlert } from '../../../src/special-po-reference-alerts.js';

const run = crypto.randomUUID(), users = {}, cases = [], pos = [];
let server, base, flag, originalFetch, remoteCalls=0;
const context = (audience='sales', name='sales') => ({ audience, operatorId: users[name].id, authorizedStoreLocationIds: [1] });
async function notices(audience='sales', name=audience==='sales'?'sales':'dispatch') {
  return (await listSpecialPoReferenceAlerts(context(audience,name))).alerts.filter(alert=>cases.includes(alert.requestId));
}
async function newCase(method='vendor_pickup', ref='SN1401857') {
  const detail = await createSpecialStockCase({ storeLocationId:1,inquiryDate:'2099-01-01',customerName:'TEST PO Ref',vendorName:'TEST Vendor',
    fulfillmentMethod:method,deliveryAddress:'Test delivery address',lines:[{productName:'Stone',quantity:1,uom:'PLT',rate:10,requiredDate:'2099-02-01'}] },
  { operatorId:users.sales.id,authorizedStoreLocationIds:[1] });
  cases.push(detail.id);
  const poId = 880000000+detail.id, native = 'TEST-POREF-'+run+'-'+detail.id; pos.push(poId);
  await query("INSERT INTO purchase_orders(netsuite_id,tranid,dispatch_ref,dispatch_ref_updated_at,status,status_text,netsuite_active) VALUES($1,$2,NULLIF($3,''),now(),'B','Pending Receipt',true)",[poId,native,ref?ref+'-'+detail.id:'']);
  await query('UPDATE sales_special_stock_cases SET purchase_order_netsuite_id=$2,purchase_order_ref=$3 WHERE request_id=$1',[detail.id,poId,native]);
  return { ...detail,poId,native,reference:ref?ref+'-'+detail.id:'' };
}
async function call(audience, path='', body=null, name=audience==='sales'?'sales':'dispatch') {
  const response=await fetch(`${base}/api/${audience}/special-stock-requests/po-reference-alerts${path}`,{
    method:body?'POST':'GET',headers:{'content-type':'application/json',...(users[name]?.token?{authorization:'Bearer '+users[name].token}:{})},
    ...(body?{body:JSON.stringify(body)}:{})});
  return {status:response.status,data:await response.json()};
}
before(async()=>{
  assert.equal(process.env.MBT_TEST_ISOLATED,'1');
  const database=new URL(process.env.DATABASE_URL);assert.equal(database.hostname,'db');assert.equal(database.username,'mbt_test');
  assert.match(database.pathname,/^\/mbt_test(?:_file_[a-f0-9]{12}_[a-z0-9]+)?$/);
  const migration=await readFile('migrations/250_special_po_reference_alerts.sql','utf8').catch(()=>null);
  if(migration) await query(migration);
  flag=(await query("SELECT enabled FROM mbt_feature_flags WHERE flag_key='special_stock_request_workflow'")).rows[0].enabled;
  await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key='special_stock_request_workflow'");
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base='http://127.0.0.1:'+server.address().port;
  originalFetch=globalThis.fetch;globalThis.fetch=(url,options)=>{if(String(url).startsWith(base+'/'))return originalFetch(url,options);remoteCalls++;throw Error('No remote calls in PO reference alerts');};
  for(const [name,role,yards] of [['sales','sales',[1]],['other','sales',[1]],['outside','sales',[28]],['dispatch','dispatcher',[]],['admin','admin',[]],['scm','scm',[]]]){
    const username='po-ref-'+name+'-'+run,password=crypto.randomUUID();users[name]=await createOperator({username,password,displayName:'TEST '+name,role,roles:[role],yardLocationIds:yards});
    const response=await fetch(base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username,password})});
    assert.equal(response.status,200);users[name].token=(await response.json()).token;
  }
});
after(async()=>{
  try{
    assert.equal(remoteCalls,0);if(originalFetch)globalThis.fetch=originalFetch;
    if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    await query('DELETE FROM sales_stock_requests WHERE id=ANY($1::bigint[])',[cases]);
    await query('DELETE FROM purchase_orders WHERE netsuite_id=ANY($1::bigint[])',[pos]);
    for(const user of Object.values(users))await query('DELETE FROM operators WHERE id=$1',[user.id]);
    if(flag!==undefined)await query("UPDATE mbt_feature_flags SET enabled=$1 WHERE flag_key='special_stock_request_workflow'",[flag]);
  }finally{await closeDb();}
});

test('committed SCM refs notify the submitting Sales user for all methods and Dispatch for delivery or our-yard pickup',async()=>{
  const vendor=await newCase(),yard=await newCase('yard_pickup'),delivery=await newCase('mbt_delivery'),empty=await newCase('vendor_pickup','');
  const sales=await notices(),dispatch=await notices('dispatch');
  assert.ok(sales.some(a=>a.requestId===vendor.id && a.displayRef===vendor.native+' / '+vendor.reference && a.fulfillmentMethod==='vendor_pickup'));
  for(const detail of [yard,delivery])assert.ok(sales.some(a=>a.requestId===detail.id && a.audience==='sales'));
  assert.ok(!sales.some(a=>a.requestId===empty.id));
  for(const detail of [yard,delivery])assert.ok(dispatch.some(a=>a.requestId===detail.id && a.audience==='dispatch'));
  assert.equal((await notices('sales','other')).length,0);assert.equal((await notices('sales','outside')).length,0);
  for(const alert of [...sales,...dispatch])assert.match(alert.noticeKey,/^[a-f0-9]{64}$/);
});
test('acknowledgement survives reload, is per user, and an unchanged save stays dismissed while ref or method changes alert again',async()=>{
  const detail=await newCase();let notice=(await notices()).find(a=>a.requestId===detail.id);
  assert.ok(notice);
  assert.deepEqual(await acknowledgeSpecialPoReferenceAlert(detail.id,{noticeKey:notice.noticeKey},context()),{acknowledged:true});
  assert.ok(!(await notices()).some(a=>a.requestId===detail.id));
  await updatePurchaseOrderDispatchRef({poRef:detail.native,newRef:detail.reference,updatedBy:users.scm.id});
  assert.ok(!(await notices()).some(a=>a.requestId===detail.id));
  await updateScmScheduleEntry({orderKind:'PO',orderRef:detail.reference,patch:{packingSlipRef:'CHANGED-'+detail.id},updatedBy:users.scm.id});
  notice=(await notices()).find(a=>a.requestId===detail.id);assert.ok(notice);assert.equal(notice.displayRef,detail.native+' / CHANGED-'+detail.id);
  await acknowledgeSpecialPoReferenceAlert(detail.id,{noticeKey:notice.noticeKey},context());
  await query("UPDATE sales_special_stock_cases SET fulfillment_method='yard_pickup' WHERE request_id=$1",[detail.id]);
  assert.ok((await notices()).some(a=>a.requestId===detail.id && a.fulfillmentMethod==='yard_pickup'));
  const current=(await notices('dispatch')).find(a=>a.requestId===detail.id);assert.ok(current);assert.notEqual(current.noticeKey,notice.noticeKey);
  await acknowledgeSpecialPoReferenceAlert(detail.id,{noticeKey:current.noticeKey},context('dispatch','dispatch'));
  assert.ok(!(await notices('dispatch')).some(a=>a.requestId===detail.id));
  assert.ok((await notices('dispatch','admin')).some(a=>a.requestId===detail.id));
});
test('Sales delivery alert: Dispatch acknowledgement preserves the owner Sales notice and receipts are per audience',async()=>{
  const detail=await newCase('mbt_delivery');
  const dispatchNotice=(await notices('dispatch')).find(alert=>alert.requestId===detail.id);
  await acknowledgeSpecialPoReferenceAlert(detail.id,{noticeKey:dispatchNotice.noticeKey},context('dispatch','dispatch'));
  const salesResult=await call('sales');assert.equal(salesResult.status,200);
  const salesNotice=salesResult.data.alerts.find(alert=>alert.requestId===detail.id);assert.ok(salesNotice);
  assert.equal(salesNotice.audience,'sales');assert.equal(salesNotice.noticeKey,dispatchNotice.noticeKey);
  const unassigned={...context(),authorizedStoreLocationIds:[28]};
  assert.ok(!(await listSpecialPoReferenceAlerts(unassigned)).alerts.some(alert=>alert.requestId===detail.id));
  await assert.rejects(acknowledgeSpecialPoReferenceAlert(detail.id,{noticeKey:salesNotice.noticeKey},unassigned),{status:404});
  for(const name of ['other','outside']) {
    assert.ok(!(await call('sales','',null,name)).data.alerts.some(alert=>alert.requestId===detail.id));
    assert.equal((await call('sales',`/${detail.id}/ack`,{noticeKey:salesNotice.noticeKey},name)).status,404);
  }
  // A dual-role operator's Dispatch acknowledgement must not acknowledge their Sales copy.
  await acknowledgeSpecialPoReferenceAlert(detail.id,{noticeKey:dispatchNotice.noticeKey},context('dispatch','sales'));
  assert.ok((await notices()).some(alert=>alert.requestId===detail.id));
  assert.equal((await call('sales',`/${detail.id}/ack`,{noticeKey:salesNotice.noticeKey})).status,200);
  assert.ok(!(await notices()).some(alert=>alert.requestId===detail.id));
  await updatePurchaseOrderDispatchRef({poRef:detail.native,newRef:'REVISED-'+detail.id,updatedBy:users.scm.id});
  for(const audience of ['sales','dispatch'])assert.ok((await notices(audience)).some(alert=>alert.requestId===detail.id));
});
test('Sales delivery alert: a reference is required and only authoritative Queued status alerts all three methods',async()=>{
  for(const method of ['vendor_pickup','yard_pickup','mbt_delivery']) {
    const detail=await newCase(method);
    for(const status of ['Hold','Planned','Completed','Cancelled','Queued']) {
      await query(`INSERT INTO scm_transport_schedule(order_kind,order_ref,source_id,status) VALUES('PO',$1,$2,$3)
        ON CONFLICT(order_kind,order_ref) DO UPDATE SET status=EXCLUDED.status`,[detail.reference,detail.poId,status]);
      const result=await call('sales');assert.equal(result.status,200);
      const found=result.data.alerts.find(alert=>alert.requestId===detail.id);
      assert.equal(Boolean(found),status==='Queued',`${method}: ${status}`);
      if(found)assert.equal(found.audience,'sales');
    }
    await query('DELETE FROM scm_transport_schedule WHERE source_id=$1',[detail.poId]);
    await query("UPDATE purchase_orders SET dispatch_ref='' WHERE netsuite_id=$1",[detail.poId]);
    assert.ok(!(await notices()).some(alert=>alert.requestId===detail.id));
  }
});
test('stale acknowledgements cannot hide a newer reference, concurrent duplicate acknowledgements are idempotent',async()=>{
  const detail=await newCase(),first=(await notices()).find(a=>a.requestId===detail.id);assert.ok(first);
  await updatePurchaseOrderDispatchRef({poRef:detail.native,newRef:'NEXT-'+detail.id,updatedBy:users.scm.id});
  const stale=await call('sales','/'+detail.id+'/ack',{noticeKey:first.noticeKey});assert.equal(stale.status,409);
  const current=(await notices()).find(a=>a.requestId===detail.id);assert.ok(current);
  const responses=await Promise.all([call('sales','/'+detail.id+'/ack',{noticeKey:current.noticeKey}),call('sales','/'+detail.id+'/ack',{noticeKey:current.noticeKey})]);
  assert.deepEqual(responses.map(r=>r.status),[200,200]);
  assert.equal((await query('SELECT count(*)::int AS count FROM special_po_reference_alert_receipts WHERE request_id=$1',[detail.id])).rows[0].count,1);
});
test('reference rollback and acknowledgement rollback preserve pending notices and business rows',async()=>{
  const detail=await newCase(),notice=(await notices()).find(a=>a.requestId===detail.id);assert.ok(notice);
  const snapshot=async()=>({request:(await query('SELECT * FROM sales_stock_requests WHERE id=$1',[detail.id])).rows,
    lines:(await query('SELECT * FROM sales_special_stock_lines WHERE request_id=$1',[detail.id])).rows,
    po:(await query('SELECT * FROM purchase_orders WHERE netsuite_id=$1',[detail.poId])).rows});
  const before=await snapshot();
  await assert.rejects(withTransaction(async()=>{await updatePurchaseOrderDispatchRef({poRef:detail.native,newRef:'ROLLBACK-'+detail.id});throw Error('rollback');}),/rollback/);
  assert.equal((await notices()).find(a=>a.requestId===detail.id).noticeKey,notice.noticeKey);
  await assert.rejects(withTransaction(async()=>{await acknowledgeSpecialPoReferenceAlert(detail.id,{noticeKey:notice.noticeKey},context());throw Error('rollback');}),/rollback/);
  assert.ok((await notices()).some(a=>a.requestId===detail.id));assert.deepEqual(await snapshot(),before);
});
test('closed, completed, cancelled, closure-pending and skipped cases stop notifying',async()=>{
  for(const patch of ["close_status='closed'","close_status='closure_pending'","operationally_complete=true","sales_order_skipped=true,purchase_order_skipped=true,purchase_order_netsuite_id=NULL,purchase_order_ref=NULL"]){
    const detail=await newCase();assert.ok((await notices()).some(a=>a.requestId===detail.id));
    await query('UPDATE sales_special_stock_cases SET '+patch+' WHERE request_id=$1',[detail.id]);
    assert.ok(!(await notices()).some(a=>a.requestId===detail.id),patch);
  }
  const detail=await newCase();await query("UPDATE sales_stock_requests SET status='cancelled' WHERE id=$1",[detail.id]);assert.ok(!(await notices()).some(a=>a.requestId===detail.id));
});
test('HTTP requires private role, workflow, owner and authorized Sales yard for both list and acknowledgement',async()=>{
  const detail=await newCase(),notice=(await notices()).find(a=>a.requestId===detail.id);assert.ok(notice);
  for(const audience of ['sales','dispatch']){
    assert.equal((await call(audience,'',null,'anonymous')).status,401);
    assert.equal((await call(audience,'/'+detail.id+'/ack',{noticeKey:notice.noticeKey},'anonymous')).status,401);
    assert.equal((await call(audience,'',null,'scm')).status,403);
  }
  assert.equal((await call('dispatch','',null,'sales')).status,403);
  assert.equal((await call('sales','',null,'dispatch')).status,403);
  for(const name of ['other','outside'])assert.equal((await call('sales','/'+detail.id+'/ack',{noticeKey:notice.noticeKey},name)).status,404);
  for(const body of [{},{noticeKey:null},{noticeKey:'bad'}])assert.equal((await call('sales','/'+detail.id+'/ack',body)).status,400);
  assert.equal((await call('sales','/invalid/ack',{noticeKey:notice.noticeKey})).status,400);
  const valid=await call('sales');assert.equal(valid.status,200);assert.ok(valid.data.alerts.some(a=>a.requestId===detail.id));
  const dispatch=await call('dispatch');assert.equal(dispatch.status,200);assert.ok(Array.isArray(dispatch.data.alerts));
  await query("UPDATE mbt_feature_flags SET enabled=false WHERE flag_key='special_stock_request_workflow'");
  try{assert.equal((await call('sales')).status,404);assert.equal((await call('sales','/'+detail.id+'/ack',{noticeKey:notice.noticeKey})).status,404);}
  finally{await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key='special_stock_request_workflow'");}
});

test('Dispatch acknowledges its own delivery notice over HTTP; wrong routing and stale references remain pending',async()=>{
  const detail=await newCase('mbt_delivery'),result=await call('dispatch');assert.equal(result.status,200);
  const notice=result.data.alerts.find(alert=>alert.requestId===detail.id);assert.ok(notice);assert.equal(notice.fulfillmentMethod,'mbt_delivery');
  assert.equal((await call('dispatch','/'+detail.id+'/ack',{noticeKey:notice.noticeKey},'sales')).status,403);
  assert.equal((await call('dispatch','/'+detail.id+'/ack',{noticeKey:'0'.repeat(64)})).status,409);
  assert.ok((await notices('dispatch')).some(alert=>alert.requestId===detail.id));
  const ack=await call('dispatch','/'+detail.id+'/ack',{noticeKey:notice.noticeKey});assert.equal(ack.status,200);assert.deepEqual(ack.data,{acknowledged:true});
  assert.ok(!(await notices('dispatch')).some(alert=>alert.requestId===detail.id));
  assert.equal((await call('dispatch','/'+detail.id+'/ack',{noticeKey:notice.noticeKey})).status,200);
  const vendor=await newCase();const salesNotice=(await notices()).find(alert=>alert.requestId===vendor.id);assert.ok(salesNotice);
  assert.equal((await call('dispatch','/'+vendor.id+'/ack',{noticeKey:salesNotice.noticeKey})).status,404);
});
