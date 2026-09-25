import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { rentalItemDecision, projectSorOrder, sorReturnDraft, sorSignatureRefs, RENTAL_YARD } from '../../../src/sor-rental-policy.js';

const item = (patch = {}) => ({ itemId: 10493, itemName: 'Lift', itemType: 'Service', fullName: '05 MBR Equip : Lifts : Lift', quantity: 2, ...patch });
test('SOR-1 named hierarchy, day/month and inventory precedence', () => {
  for (const group of ['01 MBBS','02 MBT','03 MBR - Repair','05 MBR Equip','06 TM']) {
    assert.equal(rentalItemDecision(item({fullName:`${group} : machine`})).autoReturn, true);
  }
  for (const name of ['Lift/Day','Lift/Month','lift / month']) assert.equal(rentalItemDecision(item({fullName:'',itemName:name})).autoReturn,true);
  for (const type of ['InvtPart','Assembly','Serialized Inventory Item','Lot Numbered Inventory Item']) assert.equal(rentalItemDecision(item({itemType:type})).autoReturn,false);
  assert.equal(rentalItemDecision(item({itemType:'NonInvtPart',fullName:'SDLG-ER655H'})).autoReturn,false);
  assert.equal(rentalItemDecision(item({itemName:'Delivery Charge - Trucking',itemType:'OthCharge'}),{override:true}).autoReturn,false);
});
test('SOR-1 overrides control returns independently of physical rental cargo', () => {
  assert.deepEqual(rentalItemDecision(item(),{override:false}),{rentalEquipment:true,autoReturn:false,defaultAutoReturn:true,reason:'admin_disabled'});
  assert.equal(rentalItemDecision(item({itemType:'InvtPart'}),{override:true}).autoReturn,true);
});
test('SOR-3 rental pickup and SOR-4 exact rental-only return content', () => {
  const source = {id:'SOR00188',type:'SO',netsuiteId:188,address:'77 Customer Road',sourceYard:'Rental',items:[item(),item({itemId:22,itemType:'InvtPart',quantity:1})]};
  const projected=projectSorOrder(source);
  assert.equal(projected.sourceYard,'3445');assert.equal(projected.sourceAddress,RENTAL_YARD.address);
  const result=sorReturnDraft(projected);
  assert.equal(result.refNumber,'SOR00188-Return');assert.equal(result.pickupLocation,source.address);
  assert.equal(result.dropoffLocation,RENTAL_YARD.address);assert.equal(result.expectedDeliveryDate,'');
  assert.equal(result.lineSnapshot.length,1);assert.equal(result.lineSnapshot[0].quantity,2);
  assert.equal(source.sourceYard,'Rental');assert.equal(source.items[0].rentalEquipment,undefined);
  assert.equal(sorReturnDraft({...projected,deliveryMethod:'Pick-Up'}),null);
});
test('SOR-5 property: split quantities and suffixes survive projection', () => {
  fc.assert(fc.property(fc.integer({min:1,max:999}),fc.integer({min:1,max:1000}),fc.integer({min:1,max:100}), (number,qty,suffix)=>{
    const ref=`SOR${number.toString().padStart(5,'0')}-S${suffix}`;
    const order=projectSorOrder({id:ref,type:'SO',items:[item({quantity:qty})]});
    const result=sorReturnDraft(order);
    assert.equal(result.refNumber,`${ref}-Return`);assert.equal(result.lineSnapshot[0].quantity,qty);
    assert.equal(sorReturnDraft({...order,childOrders:[ref]}),null);
  }),{numRuns:100,seed:188});
});
test('SOR-8 customer signature scope includes sales and group members, excludes returns/pickups', () => {
  assert.deepEqual(sorSignatureRefs({stopType:'dropoff',orderRefs:['GOR-188S1-190'],orders:[{orderRef:'SOR00188-S1'},{orderRef:'SOR00190'},{orderRef:'SOB120921'}]}),['SOR00188-S1','SOR00190']);
  assert.deepEqual(sorSignatureRefs({stopType:'pickup',orderRefs:['SOR00188']}),[]);
  assert.deepEqual(sorSignatureRefs({stopType:'dropoff',orderRefs:['SOR00188-Return']}),[]);
});
test('SOR-1/4 property: classification, explicit overrides and mixed-order content agree with the item policy',()=>{
 const cases=[
  {name:'Lift/Day',type:'Service',full:'Lift/Day',rental:true,fee:false},
  {name:'Lift/Month',type:'NonInvtPart',full:'Lift/Month',rental:true,fee:false},
  {name:'Serial machine',type:'InvtPart',full:'05 MBR Equip : Serial machine',rental:false,fee:false},
  {name:'Unknown machine',type:'NonInvtPart',full:'Unknown machine',rental:false,fee:false},
  {name:'Delivery Charge',type:'OthCharge',full:'05 MBR Equip : Delivery Charge',rental:false,fee:true}
 ];
 fc.assert(fc.property(fc.constantFrom(...cases),fc.constantFrom(null,true,false),fc.integer({min:1,max:1000}),(row,override,quantity)=>{
  const decision=rentalItemDecision({itemName:row.name,itemType:row.type,fullName:row.full},{override});
  const expected=!row.fee && (override===null?row.rental:override);
  assert.equal(decision.autoReturn,expected);
  const order=projectSorOrder({id:'SOR00001',type:'SO',items:[{itemId:1,itemName:row.name,itemType:row.type,fullName:row.full,quantity},{itemId:2,itemName:'Delivery Charge',itemType:'OthCharge',quantity:1}]},new Map([['1',{override}]]));
  const draft=sorReturnDraft(order);
  assert.equal(Boolean(draft),expected);
  if(expected){assert.equal(draft.lineSnapshot.length,1);assert.equal(draft.salesQty,quantity);}
 }),{numRuns:200,seed:188});
});
test('SOR-3/5 grouped rental leaves use the physical pickup yard without changing other cargo',()=>{
 const rental={id:'SOR00188-S1',type:'SO',sourceYard:'Rental',pickupLocations:['Rental'],items:[item({lineRowId:101,quantity:1})]};
 const sale={id:'SOB120921',type:'SO',sourceYard:'55',pickupLocations:['55'],items:[{lineRowId:102,itemId:22,quantity:3}]};
 const group={id:'GOR-188S1-120921',type:'SO',sourceYard:'Rental',pickupLocations:['Rental','55'],childOrders:[rental.id,sale.id],childOrderDetails:[rental,sale],items:[...rental.items,...sale.items]};
 const result=projectSorOrder(group);
 assert.deepEqual(result.pickupLocations,['3445','55']);
 assert.equal(result.sourceYard,'3445');
 assert.equal(result.items[0].rentalEquipment,true);assert.equal(result.items[0].quantity,1);
 assert.equal(result.items[1].rentalEquipment,undefined);assert.equal(result.items[1].quantity,3);
 assert.equal(sorReturnDraft(result),null);
 const singleYard=projectSorOrder({...group,childOrderDetails:[rental],items:rental.items});
 assert.equal(singleYard.sourceAddress,RENTAL_YARD.address);assert.deepEqual(singleYard.pickupLocations,['3445']);
 assert.deepEqual(group.pickupLocations,['Rental','55']);
});
