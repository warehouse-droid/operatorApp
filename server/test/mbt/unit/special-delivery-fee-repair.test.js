import assert from 'node:assert/strict';
import test from 'node:test';
import {repairPlan} from '../../../tools/special-delivery-fee-000024-plan.mjs';
const fixture = () => {
 const tuples = [[5065607,2055,144,17.95,'Arcana MODENA 24 x 24 72.00SQFT/PLT','Arcana MODENA 24 x 24 \n72.00SQFT/PLT','PC'],[5065608,2055,162,17.95,'Arcana MODENA 18 x 24','Arcana MODENA 18 x 24\n54SQFT/PLT','PC'],[5065609,2055,108,17.95,'Arcana MODENA 12 x 24','Arcana MODENA 12 x 24\n36SQFT/PLT','PC'],[5065610,1784,8,40,'PALLET','PALLET','EACH']];
 const saved=tuples.map(([remoteLineId,itemId,quantity,rate,description],i)=>({id:59+i*2,remoteLineId,itemId,quantity,rate,description}));
 const canonical=tuples.map(([remoteLineId,itemId,quantity,rate,,description,uom],i)=>({id:498297+i,lineId:remoteLineId,itemId,quantity,rate,description,uom,active:true}));
 canonical.push({id:498343,lineId:5065720,itemId:1987,quantity:1,rate:235,description:'',uom:null,active:true});
 const remote={id:1033108,ref:'SOB121882',customerId:2008,locationId:1,lines:canonical.map(l=>({...l,remoteLineId:l.lineId,open:true,locationId:1}))};
 return {saved,canonical,remote};
};
test('repair adopts only the observed descriptions and existing customer delivery charge',()=>{
 const plan=repairPlan(fixture());assert.equal(plan.delivery.rate,235);assert.equal(plan.delivery.remoteLineId,5065720);
 assert.equal(plan.descriptions.length,3);assert.deepEqual(plan.descriptions.map(x=>x.remoteLineId),[5065607,5065608,5065609]);
});
test('repair rejects changed rates, quantities, identities, descriptions and extra charges',()=>{
 for(const mutate of [f=>f.remote.lines[0].rate=18,f=>f.remote.lines[0].quantity=145,f=>f.canonical[1].description='Other product',f=>f.remote.customerId=1,f=>f.remote.lines.push({...f.remote.lines[4]}),f=>f.canonical[4].itemId=4980,f=>f.saved[0].rate=1,f=>f.canonical[0].active=false]){
  const data=fixture();mutate(data);assert.throws(()=>repairPlan(data));
 }
});
