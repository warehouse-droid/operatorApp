import test from 'node:test';
import assert from 'node:assert/strict';
import {transportSourceKind,allocateTransportLines,transportTripWeight} from '../../../src/mbt/bin-transport-domain.js';
const seeds=new Set(['9909','9910']);
test('MBR/Agg sources: SOR sales, rentals and returns share BIN/flatbed; loose aggregate and Front Desk aggregate are BIN-only',()=>{
  assert.equal(transportSourceKind({id:'SOR00123',type:'SO'},seeds),'sor_delivery');
  assert.equal(transportSourceKind({id:'SOR00123-S2',type:'SO'},seeds),'sor_delivery');
  assert.equal(transportSourceKind({id:'SOR00123-Return',orderKind:'sor_rental_return'},seeds),'sor_return');
  assert.equal(transportSourceKind({id:'SO123',type:'SO',items:[{itemId:9909},{itemId:10233}]},seeds),'aggregate');
  assert.equal(transportSourceKind({id:'MBT-AGG-1',mbtSource:'frontdesk_aggregate'},seeds),'frontdesk_aggregate');
  assert.equal(transportSourceKind({id:'SO123',type:'SO',items:[{itemId:10233,itemName:'Aggregate gravel bag'}]},seeds),null);
  assert.equal(transportSourceKind({id:'BIN00001D',type:'BIN',items:[{itemId:9909}]},seeds),null);
});
const lines=[{key:'a',quantity:'2.5',itemId:'9909',description:'Screening',unit:'YD3'},
  {key:'b',quantity:'1',itemId:'machine',description:'Machine',unit:'EACH'}];
test('transport quantities: exact fractional allocation retains original line identities and remaining quantities',()=>{
  const result=allocateTransportLines(lines,[{lineKey:'a',quantity:'1.25'}],[{lineKey:'a',quantity:'0.75'},{lineKey:'b',quantity:'1'}]);
  assert.deepEqual(result.map(r=>[r.lineKey,r.quantity,r.remaining]),[['a','0.75','0.5'],['b','1','0']]);
  assert.equal(result[0].itemId,'9909');assert.equal(result[1].description,'Machine');
});
test('transport quantities: duplicate, negative, malformed, unknown, excessive and over-allocated quantities reject',()=>{
  for(const requested of [[{lineKey:'a',quantity:'2.500001'}],[{lineKey:'a',quantity:'-1'}],
    [{lineKey:'a',quantity:'NaN'}],[{lineKey:'x',quantity:'1'}],[{lineKey:'a',quantity:'1e3'}],
    [{lineKey:'a',quantity:'0.0000001'}],[{lineKey:'a',quantity:'1'},{lineKey:'a',quantity:'1'}],[]]) {
    assert.throws(()=>allocateTransportLines(lines,[],requested),e=>e.code==='MBT_TRANSPORT_ALLOCATION_INVALID');
  }
  assert.throws(()=>allocateTransportLines(lines,[{lineKey:'a',quantity:'2'}],[{lineKey:'a',quantity:'0.500001'}]),e=>e.code==='MBT_TRANSPORT_ALLOCATION_INVALID');
});
test('transport weight: prorated normalized line weights, missing-weight prompt and payload capacity',()=>{
  assert.equal(transportTripWeight({lines:[{quantity:'2',lineWeight:400}],allocations:[{quantity:'0.5',sourceQuantity:'2',lineWeight:400}],maximumPayloadLbs:500}),100);
  assert.throws(()=>transportTripWeight({allocations:[{quantity:'1',sourceQuantity:'1',lineWeight:0}],maximumPayloadLbs:500}),/weight/i);
  assert.equal(transportTripWeight({allocations:[{quantity:'1',sourceQuantity:'1',lineWeight:0}],weightLbs:450,maximumPayloadLbs:500}),450);
  assert.throws(()=>transportTripWeight({allocations:[{quantity:'1',sourceQuantity:'1',lineWeight:0}],weightLbs:501,maximumPayloadLbs:500}),/capacity|payload/i);
});
test('transport weight: missing machine weight still requires the known material weight to fit',()=>{
  const allocations=[{quantity:'1',sourceQuantity:'1',lineWeight:400},{quantity:'1',sourceQuantity:'1',lineWeight:0}];
  assert.throws(()=>transportTripWeight({allocations,weightLbs:300,maximumPayloadLbs:500}),e=>e.code==='MBT_TRANSPORT_CAPACITY');
  assert.throws(()=>transportTripWeight({allocations,maximumPayloadLbs:500}),e=>e.code==='MBT_TRANSPORT_WEIGHT_REQUIRED');
  assert.equal(transportTripWeight({allocations,weightLbs:450,maximumPayloadLbs:500}),450);
});
