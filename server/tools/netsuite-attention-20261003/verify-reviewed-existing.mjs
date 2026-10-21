// Offline verification only. No network or posting capability.
import assert from 'node:assert/strict';
import {verifyOperatorNetSuitePostingRecord} from '../../src/operator-netsuite-posting-adapter.js';
const same=(left,right)=>Number.isFinite(Number(left))&&Number.isFinite(Number(right))&&Math.abs(Number(left)-Number(right))<=0.000001;
export function verifyReviewedExisting({step,record,sourceLines,allowLegacyBase=false,confirmedExtraLines=[]}) {
 const reviewed=structuredClone(step),adjustments=[];
 assert.equal(step.sourceOrderKind,'SO');assert.equal(step.transactionType,'IF');
 const originalItems=step.payload.item.items.filter(i=>i.itemReceive!==false&&Number(i.quantity)>0);
 const expected=new Map(originalItems.map(i=>[Number(i.orderLine),i]));
 const actualItems=record.item.items.filter(i=>i.itemReceive!==false&&Number(i.quantity)>0);
 reviewed.lineSnapshot ||= [];
 for(const actual of actualItems) {
  const line=Number(actual.orderLine),matches=sourceLines.filter(s=>Number(s.source_id)===Number(step.sourceNetSuiteId)&&Number(s.order_line)===line);
  assert.equal(matches.length,1,'Source line must be unique');const source=matches[0];
  assert.equal(String(actual.item.id),String(source.item_id),'Item identity');
  assert.equal(String(actual.units??''),String(source.unit_id??''),'Transaction unit identity');
  assert.equal(Number(actual.location?.id??actual.location),Number(source.location_id),'Inventory location');
  const factor=source.unit_id?Number(source.conversion_rate):1;
  assert.ok(Number.isFinite(factor)&&factor>0,'Authoritative conversion factor');
  const sourceQuantity=Math.abs(Number(source.quantity))/factor;
  assert.ok(actual.quantity<=sourceQuantity+0.000001,'Quantity cannot exceed source');
  assert.ok(Number(source.fulfilled_quantity)/factor+0.000001>=actual.quantity,'Source confirms fulfillment');
  reviewed.lineSnapshot.push({orderLine:line,itemId:Number(source.item_id)});
  const original=expected.get(line);
  if(original) {
   if(same(original.quantity,actual.quantity))continue;
   assert.equal(allowLegacyBase,true,'Historical unit conversion must be explicitly reviewed');
   assert.ok(step.lineSnapshot.some(s=>Number(s.orderLine)===line&&String(s.sourceLineKey)===String(source.source_line_key)),'Original stable source key');
   assert.ok(same(original.quantity,Math.abs(Number(source.quantity))),'Original quantity must equal source base units');
   const quantity=Number(original.quantity)/factor;
   assert.ok(same(actual.quantity,quantity),'Converted quantity must match exactly');
   reviewed.payload.item.items.find(i=>Number(i.orderLine)===line).quantity=quantity;
   adjustments.push({kind:'historical_base_units',orderLine:line,sourceLineKey:source.source_line_key,
    originalQuantity:original.quantity,quantity,factor});
  }else{
   assert.equal(source.item_type,'NonInvtPart','Extra inventory is never accepted');
   assert.ok(confirmedExtraLines.includes(String(source.source_line_key)),'Extra line requires reviewed physical or billing evidence');
   assert.ok(same(actual.quantity,sourceQuantity),'Extra quantity must match the authoritative source');
   reviewed.payload.item.items.push({orderLine:line,quantity:sourceQuantity,itemReceive:true,location:Number(source.location_id)});
   adjustments.push({kind:'confirmed_source_noninventory',orderLine:line,sourceLineKey:source.source_line_key,quantity:sourceQuantity});
  }
 }
 return {verified:verifyOperatorNetSuitePostingRecord(reviewed,record),adjustments,reviewed};
}
