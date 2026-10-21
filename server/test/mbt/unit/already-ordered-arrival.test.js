import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import {purchaseOrderArrived} from '../../../src/backorder-arrival-status.js';
import {regularStockStatusSummary,parseRegularStatusFilters,matchesRegularStatusSummary} from '../../../public/regular-stock-status.js';
const order={netsuite_active:true,status_text:'Pending Receipt'};
test('arrival requires a full receipt, never a partial, cancelled, unknown or merely closed PO',()=>{
  assert.equal(purchaseOrderArrived(order,[{quantity:10,netsuite_received_qty:9}]),false);
  assert.equal(purchaseOrderArrived(order,[{quantity:10,netsuite_received_qty:10},{quantity:2,netsuite_received_qty:0}]),false);
  assert.equal(purchaseOrderArrived(order,[{quantity:10,netsuite_received_qty:10}]),true);
  assert.equal(purchaseOrderArrived({...order,status_text:'Fully Received'},[]),true);
  for(const header of [null,{...order,netsuite_active:false},{...order,status_text:'Cancelled'}])assert.equal(purchaseOrderArrived(header,[{quantity:10,netsuite_received_qty:10}]),false);
  for(const status_text of ['Partially Received','Closed','Pending Receipt'])assert.equal(purchaseOrderArrived({...order,status_text},[]),false);
  for(const quantity of [0,-1,NaN,Infinity])assert.equal(purchaseOrderArrived(order,[{quantity,netsuite_received_qty:10}]),false);
  assert.equal(purchaseOrderArrived(order,[{quantity:10,netsuite_received_qty:0,received_sales_qty:10}]),false);
});
test('generated receipt totals are arrived exactly when every positive PO line is fully received',()=>{
  fc.assert(fc.property(fc.array(fc.record({quantity:fc.integer({min:1,max:10000}),netsuite_received_qty:fc.integer({min:0,max:10000})}),{minLength:1,maxLength:20}),lines=>{
    assert.equal(purchaseOrderArrived(order,lines),lines.every(line=>line.netsuite_received_qty>=line.quantity));
  }),{numRuns:200});
});
test('Completed retains independent Waiting for arrival and Arrived filters',()=>{
  const request={workflowKind:'backorder',stage:'completed',regular:{deliveryMethod:'backorder'},lines:[{id:1,supplyStatus:'already_ordered'}]};
  for(const status of ['arrival','arrived']){
    const summary=regularStockStatusSummary({...request,alreadyOrderedArrival:{status}});
    assert.equal(summary.status,'completed');assert.deepEqual(summary.waitingReasons,[status]);
    assert.equal(matchesRegularStatusSummary(summary,parseRegularStatusFilters({unifiedStatus:'completed',waitingReason:status})),true);
  }
  assert.deepEqual(regularStockStatusSummary({...request,stage:'closed',closeStatus:'closed',alreadyOrderedArrival:{status:'arrived'}}).waitingReasons,[]);
});
test('generated receipt headers cannot make inactive or cancelled orders arrive',()=>{
  fc.assert(fc.property(fc.constantFrom('Cancelled','Canceled'),fc.integer({min:1,max:10000}),fc.boolean(),(status,quantity,inactive)=>{
    assert.equal(purchaseOrderArrived({status_text:inactive?'Fully Received':status,netsuite_active:!inactive},[{quantity,netsuite_received_qty:quantity}]),false);
    assert.equal(purchaseOrderArrived({status_text:'Partially Received',netsuite_active:true},[{quantity,netsuite_received_qty:quantity-1}]),false);
  }),{numRuns:200});
});
test('NetSuite prefixed PO labels preserve full, partial and cancelled receipt meanings',()=>{
  assert.equal(purchaseOrderArrived({netsuite_active:true,status_text:'Purchase Order : Fully Received'},[]),true);
  assert.equal(purchaseOrderArrived({netsuite_active:true,status_text:'Purchase Order : Partially Received'},[{quantity:10,netsuite_received_qty:9}]),false);
  assert.equal(purchaseOrderArrived({netsuite_active:true,status_text:'Purchase Order : Cancelled'},[{quantity:10,netsuite_received_qty:10}]),false);
  assert.equal(purchaseOrderArrived({netsuite_active:true,status_text:'Purchase Order : Fully Billed'},[{quantity:10,netsuite_received_qty:10}]),true);
  assert.equal(purchaseOrderArrived({netsuite_active:true,status_text:'Purchase Order : Fully Billed'},[{quantity:10,netsuite_received_qty:9}]),false);
});
test('only active receivable PO materials contribute to full receipt after billing',()=>{
  const received={quantity:5,netsuite_received_qty:5,netsuite_active:true,item_type:'InvtPart'};
  for(const excluded of [{quantity:2,netsuite_received_qty:0,netsuite_active:false,item_type:'InvtPart'},{quantity:1,netsuite_received_qty:0,netsuite_active:true,item_type:'Service'}]){
    assert.equal(purchaseOrderArrived({...order,status_text:'Purchase Order : Fully Billed'},[received,excluded]),true);
    assert.equal(purchaseOrderArrived(order,[excluded]),false);
  }
  assert.equal(purchaseOrderArrived(order,[received,{quantity:1,netsuite_received_qty:0,netsuite_active:true,item_type:'NonInvtPart'}]),false);
});
