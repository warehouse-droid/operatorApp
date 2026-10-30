import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import {buildDirectPoReceiptDraft} from '../../../src/direct-po-auto-receipt-domain.js';

function fixture(amount=40, remaining=100) {
  return {
    requestId:'27182026-1027-4000-8000-000000000001',
    policy:{effective:true,functionKey:'receiving',transactionType:'IR',gateKey:'operator_netsuite_receiving_ir_3445',revision:4,locationId:1,yardCode:'3445'},
    order:{netsuite_id:1001,tranid:'PO-PARTIAL',source_po_id:1001,source_po_ref:'PO-PARTIAL'},
    evidence:{completionEventId:1,sourcePoId:1001,pickupJobIds:['pickup'],deliveryJobId:'delivery'},
    receiptQuantities:{'11':amount},
    lines:[
      {id:11,line_id:101,item_id:2055,sku:'MBBS-Special Order',item_type:'NonInvtPart',quantity:100,unit:'SQFT',location_id:1},
      {id:12,line_id:102,item_id:1784,sku:'PALLET',item_type:'InvtPart',quantity:3,unit:'EACH',location_id:1}
    ],
    source:{sourceNetSuiteId:1001,sourceOrderKind:'PO',status:'B',lines:[
      {sourceLineKey:'101',restOrderLine:1,itemId:2055,identityStatus:'exact',quantity:100,orderedQuantity:100,completedQuantity:100-remaining,remainingQuantity:remaining,location:1,unit:'SQFT',linkedTransactions:[]},
      {sourceLineKey:'102',restOrderLine:2,itemId:1784,identityStatus:'exact',quantity:3,orderedQuantity:3,completedQuantity:0,remainingQuantity:3,location:1,unit:'EACH',linkedTransactions:[]}
    ]},photoRefs:[]
  };
}
test('partial allocation receives its exact quantity and deselects unlinked pallets',()=>{
  const draft=buildDirectPoReceiptDraft(fixture());
  assert.deepEqual(draft.steps[0].payload.item.items,[
    {orderLine:1,quantity:40,itemReceive:true,location:1},
    {orderLine:2,itemReceive:false,location:1}
  ]);
  assert.equal(draft.localPayload.item.items[0].quantity,40);
  assert.equal(draft.localPayload.item.items.length,1);
});
test('completed selected lines reconcile without receiving an unlinked pallet',()=>{
  assert.equal(buildDirectPoReceiptDraft(fixture(40,0)).steps.length,0);
});
test('allocation-based system receipt rejects missing execution IDs and a mismatched receipt job',()=>{
  for(const variant of ['missing','empty','mismatch']) {
    const input=fixture();
    input.evidence={receiptJobId:variant==='mismatch'?'27182026-1027-4000-8000-000000000002':input.requestId,
      deliveryJobRecordId:7300,sourcePoId:1001,pickupJobIds:['pickup'],deliveryJobId:'delivery',
      ...(variant==='missing'?{}:{executionEventIds:variant==='empty'?[]:[239]})};
    assert.throws(()=>buildDirectPoReceiptDraft(input),/allocation|receipt|execution/i);
  }
});
test('allocation quantity must be positive, finite and within its PO line',()=>{
  for(const amount of [0,-1,NaN,Infinity,101]) {
    assert.throws(()=>buildDirectPoReceiptDraft(fixture(amount)),/quantity|positive|finite|exceed/i);
  }
  const input=fixture();input.receiptQuantities={'999':1};
  assert.throws(()=>buildDirectPoReceiptDraft(input),/line|quantity|receivable/i);
});
test('property: partial receipts preserve unallocated remainder and never select a pallet',()=>{
  fc.assert(fc.property(fc.integer({min:1,max:100}),fc.integer({min:0,max:100}),(amount,remaining)=>{
    const input=fixture(amount,remaining);
    input.lines[0].unit='EACH';input.source.lines[0].unit='EACH';
    const draft=buildDirectPoReceiptDraft(input);
    const selected=draft.steps.flatMap(step=>step.payload.item.items).filter(line=>line.itemReceive);
    assert.equal(selected.reduce((sum,line)=>sum+line.quantity,0),Math.min(amount,remaining));
    assert(selected.every(line=>line.orderLine===1));
  }),{seed:20261027,numRuns:120});
});
