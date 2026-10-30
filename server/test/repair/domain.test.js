import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {RepairError,money,quantity,amount,quoteLines,decideLines,totals,canApprove,canChangeCondition,canViewCosts,fleetBlocked} from '../../public/repair/domain.js';

const job={company:'MBT',requesterType:'driver',requesterId:'driver-a',yardId:1,data:{equipmentType:'truck',equipmentTypeConfirmed:true}};
const staff=(role,id='staff-a')=>({id,role,roles:[role],yardLocationIds:[1]});
test('money and quantities are exact bounded decimal values',()=>{
 assert.equal(money('150.09'),15009);assert.equal(money('0'),0);assert.equal(quantity('1.125'),1125);
 for(const value of ['-1','NaN','1e3','0.001','',null,{},'Infinity']) assert.throws(()=>money(value));
 assert.throws(()=>quantity('0'));assert.throws(()=>quantity('1.0001'));
});
test('quotes retain separate quantity, selling price and per-line tax',()=>{
 const [line]=quoteLines([{id:'line-1',kind:'part',description:'Hydraulic hose',quantity:'3',unitPrice:'10.05',taxBps:1300,itemId:'10555'}]);
 assert.equal(line.amountMinor,3015);assert.equal(line.taxMinor,392);assert.equal(line.quantityMilli,3000);
 assert.throws(()=>quoteLines([{id:'a',kind:'part',description:'',quantity:'1',unitPrice:'1'}]));
});
test('decisions must cover every quote line once and never imply approval',()=>{
 const lines=quoteLines([{id:'one',kind:'labor',description:'Repair',quantity:'1',unitPrice:'1000'}]);
 assert.equal(lines[0].decision,'pending');
 assert.throws(()=>decideLines(lines,[]));assert.throws(()=>decideLines(lines,[{id:'other',status:'approved'}]));
 assert.equal(decideLines(lines,[{id:'one',status:'approved'}])[0].decision,'approved');
 assert.throws(()=>decideLines(lines,[{id:'one',status:'approved'},{id:'one',status:'rejected'}]));
});
test('rejection bills inspection, acceptance credits it once, invoiced inspection leaves 850',()=>{
 const lines=quoteLines([{id:'a',kind:'labor',description:'Repair',quantity:'1',unitPrice:'1000',taxBps:1300}]);
 const rejected=totals(decideLines(lines,[{id:'a',status:'rejected'}]),15000,1300);
 assert.equal(rejected.subtotalMinor,15000);assert.equal(rejected.totalMinor,16950);
 const accepted=totals(decideLines(lines,[{id:'a',status:'approved'}]),15000,1300,15000);
 assert.equal(accepted.creditMinor,15000);assert.equal(accepted.subtotalMinor,100000);
 assert.equal(accepted.remainingMinor,85000);assert.equal(accepted.totalMinor,113000);
});
test('mixed line decisions are refused instead of partially accepting a quote',()=>{
 const lines=quoteLines([{id:'a',kind:'labor',description:'A',quantity:'1',unitPrice:'100'},{id:'b',kind:'part',description:'B',quantity:'2',unitPrice:'50'}]);
 assert.throws(()=>decideLines(lines,[{id:'a',status:'approved'},{id:'b',status:'rejected'}]),/whole|entire/i);
});
test('approval routing includes yard scope and MBR Sales, excludes office',()=>{
 assert.equal(canApprove(staff('dispatcher'),job),true);assert.equal(canApprove(staff('repair_office'),job),false);
 assert.equal(canApprove(staff('yard_manager'),{...job,company:'MBBS',data:{equipmentType:'forklift',equipmentTypeConfirmed:true}}),true);
 assert.equal(canApprove({...staff('yard_manager'),yardLocationIds:[28]},{...job,company:'MBBS',data:{equipmentType:'forklift',equipmentTypeConfirmed:true}}),false);
 assert.equal(canApprove(staff('mbr_sales'),{...job,company:'MBR'}),true);
 assert.equal(canApprove(staff('mbr_sales'),job),false);
});
test('condition changes allow office, requester and technicians; unrelated drivers remain forbidden',()=>{
 assert.equal(canChangeCondition(staff('driver','driver-a'),job),true);
 assert.equal(canChangeCondition(staff('driver','driver-b'),job),false);
 assert.equal(canChangeCondition(staff('repair_technician'),job),true);
 assert.equal(canChangeCondition(staff('repair_office'),{...job,requesterType:'staff',requesterId:'staff-a'}),true);
});
test('quote approval authority does not confer purchase financial visibility',()=>{
 assert.equal(canViewCosts(staff('repair_office')),true);assert.equal(canViewCosts(staff('admin')),true);
 for(const role of ['dispatcher','yard_manager','mbr_sales','repair_technician','operator','driver']) assert.equal(canViewCosts(staff(role)),false);
});
test('unrepaired handover retains block; repaired received and cancelled release only their hold',()=>{
 const hold={condition:'out_of_service',receipt:'pending',outcome:'repaired',status:'completed'};
 assert.equal(fleetBlocked([hold]),true);assert.equal(fleetBlocked([{...hold,receipt:'accepted'}]),false);
 assert.equal(fleetBlocked([{...hold,receipt:'accepted',outcome:'declined'}]),true);
 assert.equal(fleetBlocked([{...hold,status:'cancelled'}]),false);
 assert.equal(fleetBlocked([{...hold,condition:'can_operate'}]),false);
 assert.equal(fleetBlocked([{...hold,receipt:'accepted'},hold]),true);
});
test('inspection-credit properties preserve accepted totals for small and large quotes',()=>{
 fc.assert(fc.property(fc.integer({min:0,max:100000000}),fc.integer({min:0,max:100000}), (amount,fee)=>{
  const result=totals([{decision:'approved',amountMinor:amount,taxMinor:0}],fee,0);
  assert.equal(result.subtotalMinor,amount);assert.equal(result.creditMinor,fee);assert.ok(result.totalMinor>=0);
 }),{numRuns:300,seed:20261026});
});
test('property: fractional labor and part amounts round to the nearest cent, including half-cent boundaries',()=>{
 assert.equal(amount(125,999),125);assert.equal(amount(500,1),1);
 fc.assert(fc.property(fc.integer({min:1,max:1000000}),fc.integer({min:0,max:1000000}),(qty,price)=>{
  const cents=amount(qty,price),exact=qty*price/1000;assert.ok(cents-exact<=0.5);assert.ok(cents-exact> -0.5);assert.equal(cents,Math.floor(exact+0.5));
 }),{numRuns:300,seed:20261026});
});
test('property: hostile quote and decision payloads fail with a validation error, never a runtime crash',()=>{
 for(const rows of [[null],[false],['text'],[{id:'constructor'}],[{id:'x" onfocus="alert(1)'}]])assert.throws(()=>quoteLines(rows),RepairError);
 const line=quoteLines([{id:'a',kind:'labor',description:'Safe',quantity:'1',unitPrice:'1'}]);assert.throws(()=>decideLines(line,[null]),RepairError);
 fc.assert(fc.property(fc.jsonValue(),value=>{try{quoteLines(value);}catch(error){assert.ok(error instanceof RepairError);}}),{numRuns:300,seed:20261026});
});
