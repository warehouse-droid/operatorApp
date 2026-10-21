import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeDeliveryNetSuiteValues, readDeliveryNetSuite, updateDeliveryNetSuite } from '../../../src/delivery-instruction-netsuite.js';

export const values = { memo: 'Delivery Address: 12 Main St\nCall at rear gate.', shipDate: '2026-09-30', deliverByDate: '2026-10-01' };
export function boundary() {
  const record = {id:'123',tranId:'SOB123',location:{id:'1'},custbody3:{id:'2'},status:{id:'B'},custbody7:values.memo,shipDate:values.shipDate,custbody4:values.deliverByDate};
  const calls=[];
  const rest=async (path,options={})=>{
    assert.equal(path,'/record/v1/salesOrder/123');
    calls.push({path,...structuredClone(options)});
    if(options.method==='PATCH')Object.assign(record,options.body);
    return {data:structuredClone(record)};
  };
  return {record,calls,rest};
}

test('reads complete native instruction and exact calendar dates',async()=>{
  const b=boundary(); const snapshot=await readDeliveryNetSuite(123,b);
  assert.deepEqual(snapshot.values,values);
  assert.equal(snapshot.identity.orderRef,'SOB123');
  assert.equal(snapshot.identity.locationId,1);
  assert.equal(snapshot.editable,true);
});
test('patches only changed mapped fields, verifies readback and makes retry idempotent',async()=>{
  const b=boundary(),expected=await readDeliveryNetSuite(123,b);
  const target={memo:'Leave by gate <safe>',shipDate:'2028-02-29',deliverByDate:''};
  const result=await updateDeliveryNetSuite({orderId:123,expected,values:target},b);
  assert.deepEqual(result.values,target);
  assert.deepEqual(b.calls.filter(c=>c.method==='PATCH').map(c=>c.body),[{custbody7:target.memo,shipDate:target.shipDate,custbody4:null}]);
  await updateDeliveryNetSuite({orderId:123,expected,values:target},b);
  assert.equal(b.calls.filter(c=>c.method==='PATCH').length,1);
});
test('preserves untouched fields and rejects stale values or wrong identity without writing',async()=>{
  for(const mutate of [r=>r.custbody7='Other edit',r=>r.shipDate='2026-10-02',r=>r.location.id='28',r=>r.tranId='SOB124',r=>r.custbody3.id='1',r=>r.status.id='H']){
    const b=boundary(),expected=await readDeliveryNetSuite(123,b);mutate(b.record);
    await assert.rejects(()=>updateDeliveryNetSuite({orderId:123,expected,values:{...values,memo:'Desired'}},b),e=>e.status===409);
    assert.equal(b.calls.filter(c=>c.method==='PATCH').length,0);
  }
  const b=boundary(),expected=await readDeliveryNetSuite(123,b);
  await updateDeliveryNetSuite({orderId:123,expected,values:{...values,memo:''}},b);
  assert.deepEqual(b.calls.find(c=>c.method==='PATCH').body,{custbody7:null});
});
test('validates field types, length, real dates and strict allowed keys',()=>{
  for(const bad of [null,{}, {...values,rate:100},{...values,memo:{}},{...values,memo:'x'.repeat(5001)},...['2027-02-29','2026-09-31','09/30/2026','2026-09-30T00:00:00Z','0000-01-01'].map(shipDate=>({...values,shipDate}))])assert.throws(()=>normalizeDeliveryNetSuiteValues(bad),e=>e.status===400);
  assert.deepEqual(normalizeDeliveryNetSuiteValues({...values,memo:'  preserve  \r\nline  ',shipDate:'2028-02-29'}),{...values,memo:'  preserve  \nline  ',shipDate:'2028-02-29'});
});
test('recovers lost PATCH response through readback and reports unverified saves',async()=>{
  const b=boundary(),expected=await readDeliveryNetSuite(123,b),target={...values,memo:'Saved despite lost response'};
  const transport={rest:async(path,options)=>{const result=await b.rest(path,options);if(options?.method==='PATCH')throw Error('timeout');return result;}};
  assert.deepEqual((await updateDeliveryNetSuite({orderId:123,expected,values:target},transport)).values,target);
  const c=boundary(),baseline=await readDeliveryNetSuite(123,c);
  await assert.rejects(()=>updateDeliveryNetSuite({orderId:123,expected:baseline,values:target},{rest:async(path,options)=>options?.method==='PATCH'?Promise.reject(Error('denied')):c.rest(path,options)}),e=>e.status===502&&/not saved/i.test(e.message));
});

test('rejects invalid identities and protects closed or non-delivery records',async()=>{
 for(const id of [0,-1,'123',1.5,Number.MAX_SAFE_INTEGER+1])await assert.rejects(()=>readDeliveryNetSuite(id,boundary()),e=>e.status===400);
 for(const mutate of [r=>delete r.id,r=>r.id='124',r=>delete r.location,r=>delete r.status,r=>delete r.custbody3,r=>delete r.tranId]){
  const b=boundary();mutate(b.record);await assert.rejects(()=>readDeliveryNetSuite(123,b),e=>e.status===502);
 }
 for(const [field,value]of[['status','C'],['status','H'],['custbody3','1']]){
  const b=boundary();b.record[field].id=value;const snapshot=await readDeliveryNetSuite(123,b);assert.equal(snapshot.editable,false);assert.match(snapshot.lockReason,/closed, cancelled, or no longer/);
  await assert.rejects(()=>updateDeliveryNetSuite({orderId:123,expected:snapshot,values:{...values,memo:'blocked'}},b),e=>e.status===409);
 }
});
test('unavailable readback or unexpected remote values never reports a successful save',async()=>{
 for(const fault of ['readback-down','changed-after-patch']){
  const b=boundary(),expected=await readDeliveryNetSuite(123,b);let applied=false;
  const rest=async(path,options)=>{
   if(applied&&fault==='readback-down')throw Error('offline');
   const result=await b.rest(path,options);
   if(options?.method==='PATCH'){applied=true;if(fault==='changed-after-patch')b.record.custbody7='NetSuite workflow changed note';}
   return result;
  };
  await assert.rejects(()=>updateDeliveryNetSuite({orderId:123,expected,values:{...values,memo:'desired'}},{rest}),e=>fault==='readback-down'?e.status===502&&/could not be verified/.test(e.message):e.status===409&&/different values/.test(e.message));
 }
});
