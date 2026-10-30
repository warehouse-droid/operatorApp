import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import {fixture} from '../helpers/backorder-already-ordered.js';

let f;
before(async()=>{f=await fixture({sku:88999441});});
after(async()=>{await f?.close();});
async function reviewed() {
  let d=await f.create();
  for(let i=0;i<d.lines.length;i++) d=await f.review(d,i);
  return d;
}
const attach=(d,ref='SO-OPTIONAL-REVIEW')=>f.http('sales',f.path(d,'sales','already-ordered/sales-order'),
  {expectedRevision:d.revision,salesOrderRef:ref});

test('fully reviewed materials accept the customer decision with an optional SO, preserving quantity and quote',async()=>{
  let d=await reviewed();
  d=await f.action(d,'sales','quotation/link',{quotationNumber:'ESTB-KEEP-REVIEW'});
  const before={status:d.status,salesOrderId:d.salesOrderId,purchaseOrderId:d.purchaseOrderId,estimateNumber:d.estimateNumber};
  const commercial=lines=>lines.map(({id,quantity,uom,originalRate,packageQuantity,reviewedPackageQuantity,subtotal,quotedSubtotal,responseRevision})=>({id,quantity,uom,originalRate,packageQuantity,reviewedPackageQuantity,subtotal,quotedSubtotal,responseRevision}));
  const materials=commercial(d.lines);
  const result=await attach(d,'  SO-OPTIONAL-REVIEW  ');
  assert.equal(result.status,200,JSON.stringify(result.body));
  const saved=result.body;
  assert.equal(saved.alreadyOrderedSalesOrderRef,'SO-OPTIONAL-REVIEW');
  assert.equal(saved.revision,d.revision+1);
  for(const [key,value] of Object.entries(before)) assert.deepEqual(saved[key],value,key);
  assert.deepEqual(commercial(saved.lines),materials);
  assert.deepEqual(saved.lines.map(line=>line.salesDecision),['accepted','accepted']);
  assert.equal(saved.stage,'confirmed');
  assert(saved.events.some(event=>event.eventType==='backorder_sales_order_attached'));
  assert(saved.events.some(event=>event.eventType==='backorder_so_customer_accepted'));
  assert.equal((await f.query('SELECT stage FROM special_stock_workflow_stages WHERE request_id=$1',[d.id])).rows[0].stage,'confirmed');
});

test('incomplete persisted SCM replies reject attachment even with forged review fields',async()=>{
  let d=await f.create();d=await f.review(d,0);
  d=await f.detail(d);
  const result=await f.http('sales',f.path(d,'sales','already-ordered/sales-order'),{expectedRevision:d.revision,
    salesOrderRef:'SO-NO',lines:d.lines.map(line=>({...line,supplyStatus:'in_stock',stockCheckedAt:new Date().toISOString()}))});
  assert.equal(result.status,409);
  const saved=await f.detail(d);
  assert.equal(saved.revision,d.revision);assert.equal(saved.alreadyOrderedSalesOrderRef,null);
  assert.deepEqual(saved.events,d.events);
});

test('reviewed attachment retains role, yard, revision, invalid-input and concurrent-save protection',async()=>{
  let d=await reviewed();
  for(const role of ['foreign','scm']) {
    const result=await f.http(role,f.path(d,role==='foreign'?'sales':role,'already-ordered/sales-order'),{expectedRevision:d.revision,salesOrderRef:'SO-NO'});
    assert.equal(result.status,403);
  }
  for(const salesOrderRef of ['',null,{},'x'.repeat(121),'SO\nBAD']) assert.equal((await attach(d,salesOrderRef)).status,400);
  const attempts=await Promise.all(['SO-OPTION-A','SO-OPTION-B'].map(ref=>attach(d,ref)));
  assert.deepEqual(attempts.map(result=>result.status).sort(),[200,409]);
  d=await f.detail(d);
  assert.equal(d.stage,'confirmed');
  assert.deepEqual(d.lines.map(line=>line.salesDecision),['accepted','accepted']);
  assert.equal(d.events.filter(event=>event.eventType==='backorder_sales_order_attached').length,1);
  const closed=await f.action(d,'sales','close',{reason:'Test terminal protection'});
  assert.equal((await attach(closed)).status,409);
});
