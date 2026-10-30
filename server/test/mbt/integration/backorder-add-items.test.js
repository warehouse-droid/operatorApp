import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import {fixture} from '../helpers/backorder-already-ordered.js';
import {runBackorderAction} from '../../../src/backorder-request-service.js';

const sku=88999513,extraSku=88999514;
let f;
before(async()=>{
  f=await fixture({sku});
  await f.query("INSERT INTO inventory_items(item_id,item_name,display_name,stock_unit,vendor) VALUES($1,'TEST-BO-ADD-TON','Backorder add Ton','Ton','Extra Vendor')",[extraSku]);
});
after(async()=>{await f?.close();});
const item=(extra={})=>({itemId:extraSku,salesQty:5.5,quantityMode:'direct',requiredDate:'2099-02-01',...extra});
const add=(d,lines=[item()],role='sales',extra={})=>f.http(role,f.path(d,role==='scm'?'scm':'sales','items'),{expectedRevision:d.revision,lines,...extra});
const rows=async d=>(await f.query('SELECT to_jsonb(line) AS value FROM sales_special_stock_lines line WHERE request_id=$1 ORDER BY line_number',[d.id])).rows.map(row=>row.value);
async function reviewed(){
  let d=await f.create(1);
  d=await f.action(d,'sales',`lines/${d.lines[0].id}/edit`,{rate:12.5,discountPercent:5});
  d=await f.review(d,0);
  return f.action(d,'sales',`lines/${d.lines[0].id}/decision`,{decision:'accepted',customerNote:'Keep customer note'});
}

test('Backorder Add item returns to New enquiry and preserves every existing SQL line field',async()=>{
  const d=await reviewed();assert.equal(d.stage,'confirmed');
  const before=await rows(d);
  const result=await add(d);assert.equal(result.status,200,JSON.stringify(result.body));
  const saved=result.body;assert.equal(saved.stage,'new_enquiry');assert.equal(saved.revision,d.revision+1);
  assert.equal(saved.status,'submitted');assert.equal(saved.customerName,d.customerName);assert.equal(saved.destinationLocationId,d.destinationLocationId);
  assert.deepEqual((await rows(saved)).slice(0,1),before);
  assert.equal(saved.lines[1].itemId,extraSku);assert.equal(saved.lines[1].uom,'Ton');assert.equal(saved.lines[1].quantity,5.5);
  assert.equal(saved.lines[1].vendorName,'Extra Vendor');assert.equal(saved.lines[1].destinationLocationId,1);
  assert.equal(saved.lines[1].originalRate,null);assert.equal(saved.lines[1].supplyStatus,null);assert.equal(saved.lines[1].salesDecision,'pending');
  assert.equal(saved.events.filter(event=>event.eventType==='backorder_items_added').length,1);
  assert.equal((await f.detail(saved,'scm')).stage,'new_enquiry');
  const listed=await f.http('sales','/api/sales/stock-requests?bucket=pending&requestTypeFilter=backorder');
  assert.equal(listed.status,200);assert.ok(listed.body.requests.some(row=>row.id===saved.id && row.stage==='new_enquiry'));
});

test('Backorder additions supersede pending information and stage overrides with audit evidence',async()=>{
  let d=await f.create(1);d=await f.action(d,'scm','information/request',{question:'Original question'});
  assert.equal(d.stage,'pending_update');
  await f.query("UPDATE sales_special_stock_cases SET line_edit_state=$2 WHERE request_id=$1",[d.id,JSON.stringify({stage:'await_customer_confirmation',revision:d.revision})]);
  const r=await add(d);assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.stage,'new_enquiry');
  const event=r.body.events.find(e=>e.eventType==='backorder_items_added');
  assert.equal(event.details.previousInformationRequest.question,'Original question');
});

test('Backorder additions reject role, yard, stale, malformed and invalid material submissions atomically',async()=>{
  const d=await f.create(1),before=await rows(d);
  await assert.rejects(runBackorderAction(d.id,'items',{expectedRevision:d.revision,lines:[item()]},{audience:'sales',authorizedStoreLocationIds:[1]}),error=>error.status===401);
  for(const [lines,role,extra,status] of [
    [[item()],'foreign',{},403],[[item()],'scm',{},403],[[item()],'sales',{expectedRevision:d.revision-1},409],
    [[], 'sales',{},400],[[null],'sales',{},400],[[item({id:d.lines[0].id})],'sales',{},400],
    [[item({itemId:2055})],'sales',{},400],[[item({salesQty:0})],'sales',{},400],
    [[item({itemId:88999599})],'sales',{},404],[[item({destinationLocationId:28})],'sales',{},403],
    [[item({requiredDate:'2001-01-01'})],'sales',{},400],[[item()],'sales',{palletTotal:2},400]
  ]) {const r=await add(d,lines,role,extra);assert.equal(r.status,status,JSON.stringify(r.body));}
  assert.deepEqual(await rows(d),before);assert.equal((await f.detail(d)).revision,d.revision);
});

test('Backorder add enforces the total limit and commits only one concurrent submission',async()=>{
  const d=await f.create(99);
  assert.equal((await add(d,[item(),item()])).status,400);
  const results=await Promise.all([add(d),add(d)]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  const saved=await f.detail(d);assert.equal(saved.lines.length,100);assert.equal(saved.revision,d.revision+1);
  assert.equal((await add(saved)).status,409);
});

test('Backorder add rejects closed, completed, order references and pending operations',async()=>{
  const closed=await f.action(await f.create(1),'sales','close',{reason:'Test closed'});
  assert.equal((await add(closed)).status,409);
  const complete=await f.ordered(await f.create(1));assert.equal(complete.stage,'completed');assert.equal((await add(complete)).status,409);
  const d=await reviewed();
  await f.query("UPDATE sales_special_stock_cases SET sales_order_source='manual_link',purchase_order_custom_linkage=true WHERE request_id=$1",[d.id]);
  for(const kind of ['sales_order','purchase_order']) {
    await f.query(`UPDATE sales_special_stock_cases SET ${kind}_netsuite_id=88999550,${kind}_ref='TEST-ORDER' WHERE request_id=$1`,[d.id]);
    const r=await add(d);assert.equal(r.status,409,kind);assert.equal(r.body.code,'BACKORDER_ITEMS_LOCKED');
    await f.query(`UPDATE sales_special_stock_cases SET ${kind}_netsuite_id=NULL,${kind}_ref=NULL WHERE request_id=$1`,[d.id]);
  }
  await f.query("UPDATE sales_special_stock_cases SET sales_order_operation_status='creating' WHERE request_id=$1",[d.id]);
  assert.equal((await add(d)).body.code,'BACKORDER_ITEMS_LOCKED');
  await f.query("UPDATE sales_special_stock_cases SET sales_order_operation_status='idle' WHERE request_id=$1",[d.id]);
  const attached=await f.action(d,'sales','already-ordered/sales-order',{salesOrderRef:'SO-MANUAL'});
  assert.equal((await add(attached)).body.code,'BACKORDER_ITEMS_LOCKED');
  assert.equal((await f.detail(d)).lines.length,1);
});

test('adding to an open Backorder preserves its Already Ordered material and PO references',async()=>{
  const d=await f.ordered(await f.create(2),0,{poNumber:'PO-SAVED',poRefNumber:'REF-SAVED'}),before=await rows(d);
  const r=await add(d);assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.stage,'new_enquiry');
  assert.deepEqual((await rows(d)).slice(0,2),before);assert.equal(r.body.lines[0].poNumber,'PO-SAVED');
});

test('Backorder add rolls back earlier inserts when a later insert fails',async()=>{
  const d=await f.create(1),before=await rows(d);
  await f.query(`CREATE FUNCTION fail_added_material() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.request_id=${d.id} AND NEW.line_number=3 THEN RAISE EXCEPTION 'test insert failure'; END IF; RETURN NEW; END $$`);
  try {
    await f.query('CREATE TRIGGER fail_added_material BEFORE INSERT ON sales_special_stock_lines FOR EACH ROW EXECUTE FUNCTION fail_added_material()');
    assert.equal((await add(d,[item(),item()])).status,500);
    assert.deepEqual(await rows(d),before);assert.equal((await f.detail(d)).revision,d.revision);
  } finally {await f.query('DROP TRIGGER IF EXISTS fail_added_material ON sales_special_stock_lines');await f.query('DROP FUNCTION fail_added_material()');}
});
