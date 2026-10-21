import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import {verifyReviewedExisting} from '../../../tools/netsuite-attention-20261003/verify-reviewed-existing.mjs';
function fixture(quantity=2,factor=1.35) {
 return {step:{sourceOrderKind:'SO',transactionType:'IF',sourceNetSuiteId:100,externalId:'existing-1',
  payload:{item:{items:[{orderLine:1,itemReceive:true,quantity:quantity*factor,location:26}]}},
  lineSnapshot:[{orderLine:1,sourceLineKey:'501'}]},
  record:{id:200,tranId:'IF200',externalId:'existing-1',transactionType:'IF',createdFrom:{id:'100'},
   item:{items:[{orderLine:1,itemReceive:true,quantity,location:{id:'26'},item:{id:'9917'},units:'886'}]}},
  sourceLines:[{source_id:'100',source_line_key:'501',order_line:'1',item_id:'9917',item_type:'InvtPart',
   location_id:'26',quantity:-quantity*factor,fulfilled_quantity:quantity*factor,unit_id:'886',conversion_rate:factor}],
  allowLegacyBase:true,confirmedExtraLines:[]};
}
test('reviewed original base units reconcile to exact source sales units without changing original intent',()=>{
 const input=fixture(),before=structuredClone(input),result=verifyReviewedExisting(input);
 assert.equal(result.verified.id,200);assert.equal(result.adjustments[0].quantity,2);
 assert.deepEqual(input,before);
});
test('reviewed full extra noninventory line requires a specific independently confirmed source key',()=>{
 const input=fixture(2,1);input.sourceLines.push({...input.sourceLines[0],source_line_key:'502',order_line:'2',item_id:'2055',item_type:'NonInvtPart'});
 input.record.item.items.push({...input.record.item.items[0],orderLine:2,item:{id:'2055'}});
 input.confirmedExtraLines=['502'];
 assert.equal(verifyReviewedExisting(input).verified.id,200);
 input.confirmedExtraLines=[];assert.throws(()=>verifyReviewedExisting(input));
});
test('property: normalization preserves exact quantity and rejects any positive or negative drift or wrong identity',()=>{
 fc.assert(fc.property(fc.integer({min:1,max:10000}),fc.constantFrom(1,1.3,1.35,2.5),fc.integer({min:1,max:100}),
  (quantity,factor,delta)=>{
   const input=fixture(quantity,factor);
   assert.equal(verifyReviewedExisting(input).verified.id,200);
   for(const mutate of [x=>x.record.item.items[0].quantity+=delta,x=>x.record.item.items[0].quantity-=delta,
    x=>x.record.externalId='other',x=>x.record.createdFrom.id='101',x=>x.record.item.items[0].item.id='999',
    x=>x.record.item.items[0].units='887',x=>x.sourceLines.push({...x.sourceLines[0]}),
    x=>x.record.item.items.push({...x.record.item.items[0]})]) {
    const bad=structuredClone(input);mutate(bad);assert.throws(()=>verifyReviewedExisting(bad));
   }
  }),{seed:20261003,numRuns:100});
});
test('legacy conversion needs the original stable source line and cannot authorize extra inventory',()=>{
 for(const mutate of [x=>x.allowLegacyBase=false,x=>x.step.lineSnapshot[0].sourceLineKey='other',
  x=>x.sourceLines[0].conversion_rate=0,x=>x.sourceLines[0].fulfilled_quantity=0]) {
  const bad=fixture();mutate(bad);assert.throws(()=>verifyReviewedExisting(bad));
 }
 const extra=fixture(2,1);extra.sourceLines.push({...extra.sourceLines[0],source_line_key:'502',order_line:'2'});
 extra.record.item.items.push({...extra.record.item.items[0],orderLine:2});extra.confirmedExtraLines=['502'];
 assert.throws(()=>verifyReviewedExisting(extra));
});
