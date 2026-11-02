import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import {classifyRegularStockLineClaim,releasedTransferState,assertDeliveryLinesUnclaimed,backorderedDeliveryLineIds} from '../../../src/regular-stock-line-claim-domain.js';

const transfer=(status,mirror={})=>({ref:'TO100',status,...mirror});
const claim=(overrides={})=>({remoteLineId:1,requestId:7,requestRef:'STREQ-000007',requestStatus:'active',deliveryApproval:'approved',
  claimedItemId:500,currentItemId:500,currentLineActive:true,lines:[{id:70,status:'converted',transfer:transfer('pending_fulfillment')}],...overrides});

test('an open TO for the same item keeps the SO line covered',()=>{
  for(const status of ['pending_local','creating','pending_approval','pending_fulfillment','partially_fulfilled','pending_receipt','received','attention']) {
    assert.equal(classifyRegularStockLineClaim(claim({lines:[{id:70,status:'converted',transfer:transfer(status)}]})).live,true,status);
  }
});

test('a closed, cancelled or rejected TO releases the line, from the request record or the webhook mirror',()=>{
  for(const [value,expected] of [[transfer('closed'),'closed'],[transfer('cancelled'),'cancelled'],
    [transfer('pending_fulfillment',{mirrorStatus:'H'}),'closed'],[transfer('pending_fulfillment',{mirrorStatus:'TrnfrOrd:H'}),'closed'],
    [transfer('pending_fulfillment',{mirrorStatusText:'Closed'}),'closed'],[transfer('pending_fulfillment',{mirrorStatus:'C'}),'rejected'],
    [transfer('pending_fulfillment',{mirrorStatusText:'Transfer Order : Rejected'}),'rejected'],[transfer('pending_receipt',{mirrorStatusText:'Cancelled'}),'cancelled']]) {
    assert.equal(releasedTransferState(value),expected);
    const state=classifyRegularStockLineClaim(claim({lines:[{id:70,status:'converted',transfer:value}]}));
    assert.deepEqual([state.live,state.reason],[false,'transfer_closed']);
  }
  for(const mirror of [{mirrorStatus:'B',mirrorStatusText:'Pending Fulfillment'},{mirrorStatus:'G',mirrorStatusText:'Received'},{mirrorStatusText:'Pending Receipt/Partially Fulfilled'}]) {
    assert.equal(releasedTransferState(transfer('pending_fulfillment',mirror)),null);
  }
});

test('a changed SKU on the SO line releases the line even while the old TO is open',()=>{
  const state=classifyRegularStockLineClaim(claim({currentItemId:501}));
  assert.deepEqual([state.live,state.reason],[false,'item_changed']);
  assert.equal(classifyRegularStockLineClaim(claim({currentItemId:null})).live,true,'An unsynced SO line keeps the claim');
  assert.equal(classifyRegularStockLineClaim(claim({claimedItemId:null,currentItemId:501})).live,true,'An unknown claimed item keeps the claim');
  assert.deepEqual(classifyRegularStockLineClaim(claim({currentLineActive:false})).reason,'so_line_removed');
});

test('cancelled or rejected requests release, while pending approval and unmapped claims stay covered',()=>{
  assert.equal(classifyRegularStockLineClaim(claim({requestStatus:'cancelled'})).reason,'request_cancelled');
  assert.equal(classifyRegularStockLineClaim(claim({deliveryApproval:'rejected'})).reason,'request_rejected');
  assert.equal(classifyRegularStockLineClaim(claim({lines:[{id:70,status:'rejected',transfer:null}]})).reason,'request_line_finished');
  for(const status of ['submitted','approved','converted']) {
    assert.deepEqual(classifyRegularStockLineClaim(claim({deliveryApproval:'pending',lines:[{id:70,status,transfer:null}]})).reason,'transfer_pending');
  }
  assert.deepEqual(classifyRegularStockLineClaim(claim({lines:[]})).reason,'unmapped');
});

test('a line split across request lines stays covered until every TO for it is released',()=>{
  const lines=[{id:70,status:'closed',transfer:transfer('closed')},{id:71,status:'converted',transfer:transfer('pending_receipt')}];
  assert.equal(classifyRegularStockLineClaim(claim({lines})).live,true);
  lines[1].transfer=transfer('cancelled');
  assert.equal(classifyRegularStockLineClaim(claim({lines})).live,false);
});

test('only lines with a live claim are rejected, and the message names the request and open TO',()=>{
  const order={ref:'SO900',lines:[{remoteLineId:1,itemId:500,itemName:'Paver A'},{remoteLineId:2,itemId:600,itemName:'Paver B'}]};
  const claims=[{...claim(),...classifyRegularStockLineClaim(claim())},{...claim({remoteLineId:2,currentItemId:601}),...classifyRegularStockLineClaim(claim({remoteLineId:2,currentItemId:601}))}];
  assert.doesNotThrow(()=>assertDeliveryLinesUnclaimed(order,[2],claims,()=>false));
  assert.throws(()=>assertDeliveryLinesUnclaimed(order,[1,2],claims,()=>false),error=>error.code==='REGULAR_SO_REUSED'
    && /Paver A \(SO line 1\) is already covered by STREQ-000007 \(TO100 pending fulfillment\)/.test(error.message) && !/Paver B/.test(error.message));
  assert.throws(()=>assertDeliveryLinesUnclaimed(order,[1],claims,()=>true),{code:'REGULAR_DELIVERY_SELECTION_CONFLICT'});
});

test('default Delivery lines are backordered material lines at Base Yard',()=>{
  const order={lines:[{remoteLineId:1,backorderedQuantity:5,locationId:1},{remoteLineId:2,backorderedQuantity:0,locationId:1},
    {remoteLineId:3,backorderedQuantity:5,locationId:28},{remoteLineId:4,backorderedQuantity:5,locationId:1,ancillary:true},
    {remoteLineId:5,backorderedQuantity:5,locationId:1,closed:true},{remoteLineId:6,backorderedQuantity:1,locationId:1}]};
  assert.deepEqual(backorderedDeliveryLineIds(order,1),[1,6]);
});

test('property: a claim is live exactly when nothing released it and some mapped line is still open',()=>{
  const status=fc.constantFrom('pending_fulfillment','pending_receipt','received','closed','cancelled',null);
  fc.assert(fc.property(fc.boolean(),fc.boolean(),fc.boolean(),fc.array(status,{minLength:1,maxLength:4}),(cancelled,rejected,changed,statuses)=>{
    const lines=statuses.map((value,index)=>({id:index,status:value===null?'approved':'converted',transfer:value===null?null:transfer(value)}));
    const state=classifyRegularStockLineClaim(claim({requestStatus:cancelled?'cancelled':'active',deliveryApproval:rejected?'rejected':'approved',
      currentItemId:changed?501:500,lines}));
    const open=statuses.some(value=>value===null||!['closed','cancelled'].includes(value));
    assert.equal(state.live,!cancelled&&!rejected&&!changed&&open);
  }));
});
