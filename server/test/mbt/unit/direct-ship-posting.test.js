import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { fetchSalesOrderFulfillmentStateFromNetSuite } from '../../../src/netsuite.js';
import { buildOperatorNetSuitePostingDraft } from '../../../src/operator-netsuite-posting-domain.js';
import { createOperatorNetSuitePostingAdapter } from '../../../src/operator-netsuite-posting-netsuite-adapter.js';
import { buildDirectPoReceiptDraft, assertDirectPoReceiptStepCurrent } from '../../../src/direct-po-auto-receipt-domain.js';
import { isFulfillableNetSuiteLine, isCompletedNetSuitePostingOrder, assertDispatchFulfillmentStepCurrent } from '../../../src/netsuite-fulfillable-items.js';
import * as directRuntime from '../../../src/direct-po-auto-receipt.js';

const requestId='27182026-1001-4000-8000-000000000001';
function fixture({received=0, quantity=270.78}={}) {
  return { requestId, policy:{effective:true,functionKey:'receiving',transactionType:'IR',gateKey:'operator_netsuite_receiving_ir_150',revision:4,locationId:26,yardCode:'150'},
    order:{netsuite_id:1009063,tranid:'POB03915',dispatch_ref:'LOINC-036776',source_po_id:1009063,source_po_ref:'POB03915'},
    evidence:{completionEventId:20051,sourcePoId:1009063,pickupJobIds:['pickup-5369'],deliveryJobId:'drop-5398'},
    lines:[{id:473754,line_id:5004774,source_line_key:'5004774',item_id:2055,sku:'MBBS-Special Order',item_type:'NonInvtPart',quantity,location_id:26}],
    source:{sourceNetSuiteId:1009063,sourceOrderKind:'PO',sourceOrderRef:'POB03915',status:'B',statusText:'Pending Receipt',
      lines:[{sourceLineKey:'5004774',restOrderLine:1,itemId:2055,itemType:'NonInvtPart',itemName:'MBBS-Special Order',identityStatus:'exact',
        quantity,orderedQuantity:quantity,completedQuantity:received,remainingQuantity:quantity-received,location:26,linkedTransactions:[]}]},photoRefs:[] };
}

test('special-order item is fulfillable while service and explicit ineligible items are excluded',()=>{
  assert.equal(isFulfillableNetSuiteLine({item_type:'NonInvtPart',sku:'MBBS-Special Order'}),true);
  assert.equal(isFulfillableNetSuiteLine({item_type:'NonInvtPart',item_name:'MBBS-Special Order',is_fulfillable:'T'}),true);
  assert.equal(isFulfillableNetSuiteLine({item_type:'NonInvtPart',item_name:'MBBS-Special Order',is_fulfillable:'F'}),false);
  assert.equal(isFulfillableNetSuiteLine({item_type:'NonInvtPart',sku:'Service'}),false);
  assert.equal(isFulfillableNetSuiteLine({item_type:'InvtPart',sku:'DELIVERY CHARGE 150'}),false);
  assert.equal(isFulfillableNetSuiteLine({item_type:'Discount',is_fulfillable:'T'}),false);
});

test('NetSuite SO reader retains exact special-order REST line and native quantity',async()=>{
  let queryText='';
  const state=await fetchSalesOrderFulfillmentStateFromNetSuite(1008824,{query:async sql=>{queryText=sql;return {items:[
    {id:'1008824',tranid:'SOM06662',status:'B',order_line:'5004139',rest_order_line:'1',item_id:'2055',item_name:'MBBS-Special Order',item_type:'NonInvtPart',is_fulfillable:'T',quantity:'-270.78',fulfilled_quantity:'0',location_id:'26',line_closed:'F'},
    {id:'1008824',tranid:'SOM06662',status:'B',order_line:'5004452',rest_order_line:'10',item_id:'2022',item_name:'10% discount',item_type:'Discount',quantity:0}
  ]};},fetchItems:async()=>[{orderLine:1,item:{id:'2055'}}]});
  assert.equal(state.lines.length,1);assert.equal(state.lines[0].orderLine,1);
  assert.equal(state.lines[0].quantity,270.78);assert.equal(state.lines[0].remainingQuantity,270.78);
  assert.match(queryText,/isfulfillable/iu);
});

test('completed live SO and PO statuses prohibit new posting even if a line counter is stale',()=>{
  for(const [kind,status] of [['SO','F'],['SO','G'],['SO','H'],['PO','F'],['PO','G'],['PO','H']]) {
    assert.equal(isCompletedNetSuitePostingOrder(kind,{status}),true);
  }
  for(const kind of ['SO','PO']) {for(const status of ['B','D','E']) {assert.equal(isCompletedNetSuitePostingOrder(kind,{status}),false);}}
  assert.equal(isCompletedNetSuitePostingOrder('SO',{statusText:'Pending Billing/Partially Fulfilled'}),false);
  assert.equal(isCompletedNetSuitePostingOrder('SO',{statusText:'Pending Billing'}),true);
  assert.equal(isCompletedNetSuitePostingOrder('PO',{closed:true}),true);
  assert.equal(isCompletedNetSuitePostingOrder('PO',{status_text:'Purchase Order : Fully Received'}),true);
  assert.equal(isCompletedNetSuitePostingOrder('SO',{statusText:'Sales Order : Closed'}),true);
  assert.equal(isCompletedNetSuitePostingOrder('SO',{}),false);
  assert.equal(isFulfillableNetSuiteLine({itemType:'InvtPart',isFulfillable:true}),true);
  assert.equal(isFulfillableNetSuiteLine({itemType:'NonInvtPart',itemName:'Service',isfulfillable:'F'}),false);
});

test('direct PO receipt uses parent ID, exact REST line, native special-order quantity and system provenance',()=>{
  const draft=buildDirectPoReceiptDraft(fixture());
  assert.equal(draft.actorOperatorId,null);assert.equal(draft.localOperation.kind,'direct_po_receipt');
  assert.equal(draft.steps[0].sourceNetSuiteId,1009063);
  assert.deepEqual(draft.steps[0].payload.item.items,[{orderLine:1,quantity:270.78,itemReceive:true,location:26}]);
  assert.equal(draft.inputSnapshot.directDeliveryEvidence.completionEventId,20051);
  assert.ok(draft.claims.includes('receiving:purchase_order:1009063'));
  assert.ok(draft.claims.includes('source:IR:PO:1009063'));
  assert.equal(draft.steps[0].lineSnapshot[0].directCompletionEventId,20051);
});

test('existing receipt progress limits a new IR to live remaining and fully received lines reconcile',()=>{
  assert.equal(buildDirectPoReceiptDraft(fixture({received:70.78})).steps[0].payload.item.items[0].quantity,200);
  assert.equal(buildDirectPoReceiptDraft(fixture({received:270.78})).steps.length,0);
  const input=fixture();input.source.status='F';
  assert.throws(()=>buildDirectPoReceiptDraft(input),/complete/iu);
});

test('split PO uses exact positive parent identity and fails closed on mismatched or ambiguous lines',()=>{
  const input=fixture();input.order.netsuite_id=-42;input.order.tranid='POB03915-S2';
  assert.equal(buildDirectPoReceiptDraft(input).steps[0].sourceNetSuiteId,1009063);
  input.source.sourceNetSuiteId=1009064;assert.throws(()=>buildDirectPoReceiptDraft(input),/parent identity/iu);
  input.source.sourceNetSuiteId=1009063;
  input.source.lines[0].itemId=1784;assert.throws(()=>buildDirectPoReceiptDraft(input),/item|identity|mapping/iu);
  input.source.lines[0].itemId=2055;input.source.lines[0].identityStatus='ambiguous';
  assert.throws(()=>buildDirectPoReceiptDraft(input),/identity|mapping/iu);
});

test('ordinary Operator posting cannot omit its Operator or fabricate system receipt evidence',()=>{
  const draft=buildDirectPoReceiptDraft(fixture());
  assert.throws(()=>buildOperatorNetSuitePostingDraft({...draft,actorOperatorId:null,localOperation:{kind:'receiving_receipt',orderId:'1009063',orderType:'purchase_order'},targets:[]}),/Operator ID/iu);
  const input=fixture();input.evidence.pickupJobIds=[];assert.throws(()=>buildDirectPoReceiptDraft(input),/evidence|pickup/iu);
});

test('last moment IR recheck refuses complete orders, zero remaining, and changed items',()=>{
  const draft=buildDirectPoReceiptDraft(fixture()),step=draft.steps[0];
  assertDirectPoReceiptStepCurrent(step,{status:'B',lines:[{restLineId:1,itemId:2055,quantity:270.78,receivedQuantity:0,locationId:26}]});
  assert.throws(()=>assertDirectPoReceiptStepCurrent(step,{status:'F',lines:[]}),/complete/iu);
  assert.throws(()=>assertDirectPoReceiptStepCurrent(step,{status:'B',lines:[{restLineId:1,itemId:2055,quantity:270.78,receivedQuantity:270.78,locationId:26}]}),/remaining/iu);
  assert.throws(()=>assertDirectPoReceiptStepCurrent(step,{status:'B',lines:[{restLineId:1,itemId:1784,quantity:270.78,receivedQuantity:0,locationId:26}]}),/item|identity/iu);
});

test('real IR adapter rechecks direct receipt before issuing a transform',async()=>{
  let transforms=0;
  const adapter=createOperatorNetSuitePostingAdapter({findTransactionByExternalId:async()=>null,transformSalesOrderToItemFulfillment:async()=>{},
    transformTransferOrderToItemFulfillment:async()=>{},transformTransferOrderToItemReceipt:async()=>{},
    transformPurchaseOrderToItemReceipt:async()=>{transforms++;return {id:1};},fetchItemFulfillment:async()=>{},fetchItemReceipt:async()=>{},
    fetchDirectReceiptSource:async()=>({status:'F',lines:[]})});
  const step=buildDirectPoReceiptDraft(fixture()).steps[0];
  await assert.rejects(adapter.transform(step),/complete/iu);assert.equal(transforms,0);
});

test('SO adapter checks live status and line remainder immediately before a Dispatch IF',async()=>{
  let transforms=0,live={id:1008824,status:'F',fulfillmentComplete:true,lines:[]};
  const adapter=createOperatorNetSuitePostingAdapter({findTransactionByExternalId:async()=>null,
    transformSalesOrderToItemFulfillment:async()=>{transforms++;return {id:1};},
    transformTransferOrderToItemFulfillment:async()=>{},transformTransferOrderToItemReceipt:async()=>{},
    transformPurchaseOrderToItemReceipt:async()=>{},fetchItemFulfillment:async()=>{},fetchItemReceipt:async()=>{},
    fetchDispatchFulfillmentSource:async()=>live});
  const step={sourceNetSuiteId:1008824,sourceOrderKind:'SO',transactionType:'IF',dispatchAutoFulfillment:true,
    lineSnapshot:[{orderLine:1,itemId:2055}],payload:{item:{items:[{orderLine:1,quantity:270.78,itemReceive:true,location:26}]}}};
  await assert.rejects(adapter.transform(step),/complete/iu);assert.equal(transforms,0);
  live={id:1008824,status:'B',lines:[{orderLine:1,itemId:2055,remainingQuantity:0,location:26}]};
  await assert.rejects(adapter.transform(step),/remaining/iu);assert.equal(transforms,0);
  live.lines[0].remainingQuantity=200;
  await assert.rejects(adapter.transform(step),/remaining/iu);assert.equal(transforms,0);
  live.lines[0].remainingQuantity=270.78;live.lines[0].itemId=1784;
  await assert.rejects(adapter.transform(step),/item|identity/iu);assert.equal(transforms,0);
  live.lines[0].itemId=2055;
  await adapter.transform(step);assert.equal(transforms,1);
});

test('completed SO header skips REST line loading',async()=>{
  const result=await fetchSalesOrderFulfillmentStateFromNetSuite(1008824,{query:async()=>({items:[{id:'1008824',tranid:'SOM06662',status:'F'}]}),
    fetchItems:async()=>assert.fail('completed order must not load or transform REST lines')});
  assert.equal(result.fulfillmentComplete,true);assert.deepEqual(result.lines,[]);
});

test('receipt quantity conservation under arbitrary partial receipt progress',()=>{
  fc.assert(fc.property(fc.integer({min:1,max:1000000}),fc.integer({min:0,max:1000000}),(units,receivedUnits)=>{
    const quantity=units/1000,received=Math.min(units,receivedUnits)/1000;
    const draft=buildDirectPoReceiptDraft(fixture({quantity,received}));
    const posted=draft.steps.flatMap(s=>s.payload.item.items).filter(i=>i.itemReceive).reduce((sum,i)=>sum+i.quantity,0);
    assert.ok(Math.abs(posted-(quantity-received))<0.000001);assert.ok(posted>=0&&posted<=quantity);
  }),{numRuns:150,seed:36776});
});

test('hostile receipt inputs stop before building a financial transaction',()=>{
  for(const quantity of [0,-1,NaN,Infinity]) {assert.throws(()=>buildDirectPoReceiptDraft(fixture({quantity})),/positive|finite/iu);}
  const input=fixture();input.order.source_po_id=-1;assert.throws(()=>buildDirectPoReceiptDraft(input),/parent/iu);
  input.order.source_po_id=1009063;input.lines[0].quantity=300;assert.throws(()=>buildDirectPoReceiptDraft(input),/exceeds/iu);
  input.lines[0].quantity=270.78;input.lines[0].location_id=28;assert.throws(()=>buildDirectPoReceiptDraft(input),/location/iu);
  input.lines[0].location_id=26;input.source.lines=[];assert.throws(()=>buildDirectPoReceiptDraft(input),/mapping/iu);
  input.lines=[];assert.throws(()=>buildDirectPoReceiptDraft(input),/receivable/iu);
  delete input.lines;assert.throws(()=>buildDirectPoReceiptDraft(input),/receivable/iu);
  const other=fixture();other.source.sourceOrderKind='SO';assert.throws(()=>buildDirectPoReceiptDraft(other),/parent/iu);
  other.source.sourceOrderKind='PO';delete other.source.lines;assert.throws(()=>buildDirectPoReceiptDraft(other),/mapping/iu);
  assert.throws(()=>isCompletedNetSuitePostingOrder('TO',{status:'B'}),/SO or PO/iu);
});

test('exact source aliases work while missing or changed line identities and locations refuse posting',()=>{
  const input=fixture();delete input.order.source_po_id;delete input.lines[0].source_line_key;
  input.source.lines[0].sourceLineKey='parent-alias';input.source.lines[0].sourceLineAliases=['5004774'];
  const step=buildDirectPoReceiptDraft(input).steps[0];assert.equal(step.sourceNetSuiteId,1009063);
  const live={status:'B',lines:[{restLineId:1,itemId:2055,quantity:270.78,receivedQuantity:0,locationId:28}]};
  assert.throws(()=>assertDirectPoReceiptStepCurrent(step,live),/location/iu);
  live.lines[0].locationId=26;live.lines[0].closed=true;
  assert.throws(()=>assertDirectPoReceiptStepCurrent(step,live),/remaining/iu);
  const so={payload:{item:{items:[{orderLine:1,quantity:1,itemReceive:true,location:26},{orderLine:2,itemReceive:false}]}},lineSnapshot:[{orderLine:1,itemId:2055}]};
  assert.throws(()=>assertDispatchFulfillmentStepCurrent(so,null),/complete|unavailable/iu);
  assert.throws(()=>assertDispatchFulfillmentStepCurrent(so,{status:'B',lines:[]}),/identity/iu);
  assert.throws(()=>assertDispatchFulfillmentStepCurrent(so,{status:'B',lines:[{orderLine:1,itemId:2055,remainingQuantity:1,location:28}]}),/location/iu);
  assert.throws(()=>assertDispatchFulfillmentStepCurrent(so,{status:'B',lines:[{orderLine:1,itemId:2055,remainingQuantity:NaN,location:26}]}),/remaining/iu);
  const closed={status:'B',lines:[{orderLine:1,itemId:2055,remainingQuantity:1,location:26,lineClosed:true}]};
  assert.throws(()=>assertDispatchFulfillmentStepCurrent(so,closed),/remaining/iu);
  closed.lines[0].lineClosed=false;so.payload.item.items[0].quantity=NaN;
  assert.throws(()=>assertDispatchFulfillmentStepCurrent(so,closed),/remaining/iu);
  so.payload.item.items[0].quantity=0;assert.throws(()=>assertDispatchFulfillmentStepCurrent(so,closed),/remaining/iu);
  so.payload.item.items[0].quantity=1;delete so.lineSnapshot;
  assert.throws(()=>assertDispatchFulfillmentStepCurrent(so,closed),/identity/iu);
});

test('direct source reader checks live header before fetching any PO lines',async()=>{
  assert.equal(typeof directRuntime.createDirectPoSourceFetcher,'function');
  const calls=[];
  const reader=directRuntime.createDirectPoSourceFetcher({fetchStatus:async()=>({status:'F'}),fetchSource:async()=>assert.fail('completed PO must skip line reads')});
  assert.deepEqual(await reader({sourceOrderKind:'PO',sourceNetSuiteId:1009063}),{sourceOrderKind:'PO',sourceNetSuiteId:1009063,status:'F',lines:[]});
  const open=directRuntime.createDirectPoSourceFetcher({fetchStatus:async()=>({status:'B'}),fetchSource:async input=>{calls.push(input);return {lines:[1]};}});
  assert.deepEqual(await open({sourceOrderKind:'PO',sourceNetSuiteId:1009063}),{lines:[1]});assert.equal(calls.length,1);
  const missing=directRuntime.createDirectPoSourceFetcher({fetchStatus:async()=>null,fetchSource:async()=>assert.fail()});
  await assert.rejects(missing({sourceOrderKind:'PO',sourceNetSuiteId:1009063}),/absent/iu);
});
