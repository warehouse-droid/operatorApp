import test from 'node:test';
import assert from 'node:assert/strict';
import {regularStockStatusSummary as summary,regularStockSalesAction as salesAction,REGULAR_STATUS_DETAILS} from '../../../public/regular-stock-status.js';

const request=(lines=[{supplyStatus:'in_stock',salesDecision:'accepted'}],extra={})=>({
  status:'active',workflowKind:'backorder',regular:{deliveryMethod:'backorder'},stage:'confirmed',
  salesOrderId:1071650,purchaseOrderId:null,lines:lines.map(line=>({stockCheckedAt:'2099-01-01',...line})),...extra
});

test('STREQ-000163 processes its linked SO while retaining its production badge',()=>{
  const d=request([{id:272,supplyStatus:'in_stock',salesDecision:'accepted'},
    {id:273,supplyStatus:'production',salesDecision:'accepted'}]);
  const before=structuredClone(d),s=summary(d);
  assert.equal(s.status,'in_progress');assert.equal(s.detail,'processing');
  assert.deepEqual(s.waitingReasons,['production']);assert.equal(s.counts.pending_scm,0);
  assert.equal(s.counts.in_progress,2);assert.equal(salesAction(d),null);assert.deepEqual(d,before);
  assert.deepEqual(REGULAR_STATUS_DETAILS.awaiting_po,['Awaiting PO','等待 PO']);
});

test('every reviewed supply state processes the linked SO before and after PO linkage',()=>{
  for(const supplyStatus of ['in_stock','low_inventory','production','vendor_transfer','allocation','no_stock']){
    const d=request([{supplyStatus,salesDecision:'accepted'}]);
    assert.equal(summary(d).status,'in_progress',supplyStatus);
    assert.equal(summary(d).detail,'processing',supplyStatus);
    assert.equal(summary({...d,purchaseOrderId:2}).status,
      'in_progress',supplyStatus);
  }
});

test('unanswered Sales confirmation, reply and missing SO remain Sales actions',()=>{
  for(const [d,detail] of [
    [request([{supplyStatus:'in_stock',salesDecision:'pending'}],{salesOrderId:null}),'sales_confirmation'],
    [request(undefined,{informationRequest:{status:'pending'}}),'sales_reply'],
    [request(undefined,{salesOrderId:null}),'awaiting_so']
  ]){
    assert.equal(summary(d).status,'pending_sales');assert.equal(summary(d).detail,detail);
    assert.equal(salesAction(d).reason,detail);
  }
  assert.equal(summary(request([{supplyStatus:null,salesDecision:'pending'}])).detail,'review');
  assert.equal(summary(request([{supplyStatus:'in_stock',salesDecision:'request_update'}])).detail,'review');
});

test('Already Ordered and other terminal outcomes do not wait for another PO',()=>{
  for(const [supplyStatus,salesDecision,status] of [
    ['already_ordered','pending','in_progress'],['in_stock','declined','closed'],['production','closed','closed']
  ])assert.equal(summary(request([{supplyStatus,salesDecision}])).status,status);
  assert.equal(summary(request(undefined,{stage:'completed'})).status,'in_progress');
  for(const extra of [{linkedSalesOrderProgress:{completed:true}},{operationallyComplete:true}])assert.equal(summary(request(undefined,extra)).status,'completed');
  assert.equal(summary(request(undefined,{stage:'closed'})).status,'closed');
  assert.equal(summary(request(undefined,{status:'cancelled'})).status,'closed');
});

test('linked PO dispatch and non-Backorder handoffs retain their existing status',()=>{
  const d=request(undefined,{purchaseOrderId:2,purchaseOrderReference:'REF',purchaseOrderDispatchStatus:'Queued'});
  assert.equal(summary(d).status,'in_progress');assert.equal(summary(d).detail,'processing');
  assert.equal(summary({...d,salesOrderId:null}).status,'in_progress');
  assert.equal(summary({status:'active',regular:{deliveryMethod:'delivery',deliveryVersion:1,handoffStatus:'complete'},
    lines:[{status:'pending_to'}],transfers:[{status:'pending_fulfillment'}]}).status,'in_progress');
});

test('mixed material requests retain outstanding Sales alerts alongside SCM work',()=>{
  const d=request([{supplyStatus:null,salesDecision:'pending'},
    {supplyStatus:'production',salesDecision:'pending'},{supplyStatus:'already_ordered',salesDecision:'pending'}],{salesOrderId:null});
  for(const lines of [d.lines,d.lines.slice().reverse()]){
    const mixed={...d,lines};assert.equal(summary(mixed).status,'pending_scm');
    assert.equal(summary(mixed).counts.completed,1);assert.equal(salesAction(mixed).reason,'sales_confirmation');
  }
});
