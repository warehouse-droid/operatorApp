import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import {firstSplitFulfillmentLines} from '../../../src/sales-order-fulfillment-first-split.js';
test('property: first-split quantities require exact identity and stay bounded to the source',()=>{
 fc.assert(fc.property(fc.integer({min:1,max:10000}),fc.integer({min:1,max:10000}),(a,b)=>{
  const quantity=Math.min(a,b),total=Math.max(a,b);
  const lines=[{local_line_id:'101',local_order_line:'501',item_id:'1784',target_quantity:total}];
  const items=[{lineId:501,lineRowId:101,itemId:1784,itemType:'InvtPart',splitQty:quantity}];
  assert.equal(firstSplitFulfillmentLines(lines,items)[0].target_quantity,quantity);
  assert.equal(lines[0].target_quantity,total);
  for(const change of [{splitQty:total+1},{lineId:999},{lineRowId:999},{itemId:999},{splitQty:NaN},{splitQty:-1}])
   assert.throws(()=>firstSplitFulfillmentLines(lines,[{...items[0],...change}]));
  assert.throws(()=>firstSplitFulfillmentLines(lines,[items[0],items[0]]));
  assert.throws(()=>firstSplitFulfillmentLines([lines[0],lines[0]],items));
 }),{seed:20261003,numRuns:100});
});
test('non-first-split work is untouched; fees do not expand a split',()=>{
 const lines=[{local_line_id:1,local_order_line:1,item_id:1,target_quantity:2}];
 assert.equal(firstSplitFulfillmentLines(lines,null),lines);
 assert.deepEqual(firstSplitFulfillmentLines(lines,[{itemType:'OthCharge',quantity:1}]),[]);
});
