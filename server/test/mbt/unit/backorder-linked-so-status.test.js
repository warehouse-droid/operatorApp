import test from 'node:test';
import assert from 'node:assert/strict';
import {linkedSalesOrderCompletion as complete} from '../../../src/backorder-sales-order-progress.js';
import {regularStockStatusSummary as summary,regularStockSalesAction as action} from '../../../public/regular-stock-status.js';

const order={netsuite_active:true,status_text:'Sales Order : Pending Fulfillment',fulfillment_status:'not_fulfilled',operator_status:'loaded',local_yard_order_status:'Loaded'};
const cargo=[{item_type:'InvtPart',quantity:10,loaded_qty:10,unit:'EA',netsuite_active:true}];
test('fulfilled orders and fully loaded cargo provide completion independently',()=>{
  for(const text of ['Fulfilled','Fully Fulfilled','Sales Order : Billed','Pending Billing']) assert.equal(complete({...order,status_text:text},[]),'so_fulfilled');
  assert.equal(complete({...order,fulfillment_status:'fulfilled'},[]),'so_fulfilled');
  assert.equal(complete(order,cargo),'so_loaded');
  assert.equal(complete(order,[...cargo,{item_type:'OthCharge',quantity:1,loaded_qty:0}]),'so_loaded');
  assert.equal(complete(order,[{...cargo[0],quantity:2.34,loaded_qty:2.335,unit:'SQFT'}]),'so_loaded');
});
test('partial, missing, invalid, inactive and reopened evidence cannot complete an SO',()=>{
  for(const lines of [[],[{...cargo[0],loaded_qty:9}], [...cargo,{...cargo[0],loaded_qty:0}], [{...cargo[0],quantity:NaN}], [{...cargo[0],loaded_qty:Infinity}]]) assert.equal(complete(order,lines),null);
  assert.equal(complete({...order,operator_status:'partial_loaded',local_yard_order_status:'Partial Loaded'},cargo),null);
  assert.equal(complete({...order,status_text:'Partially Fulfilled',fulfilled_at:'2026-10-23'},[]),null);
  for(const change of [{netsuite_active:false},{locally_reopened:true},{status_text:'Closed'},{status_text:'Cancelled'}]) assert.equal(complete({...order,fulfillment_status:'fulfilled',...change},cargo),null);
  assert.equal(complete(null,cargo),null);
});
test('attached SOs clear false Sales input while genuine outstanding responses remain actionable',()=>{
  const d={workflowKind:'backorder',regular:{deliveryMethod:'backorder'},status:'active',closeStatus:'active',alreadyOrderedSalesOrderRef:'SO-A',
    lines:[{id:1,supplyStatus:'already_ordered',salesDecision:'pending',stockCheckedAt:'2026-10-23'},{id:2,supplyStatus:'production',salesDecision:'pending',stockCheckedAt:'2026-10-23'}]};
  assert.equal(summary(d).status,'in_progress');assert.equal(action(d),null);assert.deepEqual(summary(d).waitingReasons,['production']);
  const pending={...d,lines:[d.lines[0],{id:2,supplyStatus:null,salesDecision:'pending'}]};
  assert.equal(summary(pending).status,'pending_scm');
  assert.equal(summary({...d,informationRequest:{status:'pending'}}).status,'pending_sales');
  assert.equal(summary({...d,lines:[d.lines[0],{...d.lines[1],salesDecision:'request_update'}]}).status,'pending_scm');
  for(const change of [{status:'cancelled'},{closeStatus:'closed'},{stage:'closed'}]) assert.equal(summary({...d,...change,linkedSalesOrderProgress:{completed:true}}).status,'closed');
});
