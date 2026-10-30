import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import {dispatchRequiredPickupVisitLocations} from '../../../src/dispatch-pickup-visits.js';
import {destinationFunctions} from '../../support/dispatch-po-line-destination-functions.mjs';
import {applyOperatorLinkedQuantityProjection} from '../../../src/operator-linked-quantity-domain.js';
import {operatorSalesUi,operatorSalesServer} from '../../support/operator-sales-allocation-functions.mjs';

const zero = {pallets:0,layers:0,sections:0,pieces:0,quantity:0};
const number = value => Number(value || 0);
const balance = (value,used) => Math.max(number(value)-number(used),0);
function functions() {
  const browser=destinationFunctions('../../public/dispatch.js',['itemForPickupLocation'],{
    isOwnYardCode:location=>location==='3445',sameDispatchLocation:(a,b)=>a===b,
    directPickupAllocatedForItem:order=>order.direct || zero,positiveBalance:balance
  });
  const driver=destinationFunctions('../../src/driver-repository.js',['planItemForPickup'],{
    isOwnYard:(_plan,location)=>location==='3445',directAllocationForPlanItem:order=>order.direct || zero,
    positiveBalance:balance,numberValue:number
  });
  const server=destinationFunctions('../../src/dispatch-load-assignment.js',['dispatchItemForPickupLocation'],{
    text:value=>String(value||''),dispatchOwnYardLocationKeys:()=>new Set(['3445']),
    normalizedYardLocationText:value=>value,dispatchLocationsShareYard:(a,b)=>a===b,
    dispatchDirectPickupAllocatedForItem:order=>order.direct || zero,dispatchNumber:number
  });
  return {browser:(item,own,direct)=>browser.itemForPickupLocation(item,own?'3445':'Vendor',{sourceYard:'3445',direct}),
    driver:(item,own,direct)=>driver.planItemForPickup(item,{stopType:'pickup',pickupLocation:own?'3445':'Vendor',planOrder:{direct}}),
    server:(item,own,direct)=>server.dispatchItemForPickupLocation({}, {sourceYard:'3445',direct},item,own?'3445':'Vendor')};
}
const views=functions();
const fields=['quantity','salesQty','pallets','layers','sections','pieces'];
const quantities=item=>Object.fromEntries(fields.map(field=>[field,Number(item[field]||0)]));

test('GOB cached packing cannot create a second pickup for fully linked sales units',()=>{
  const item={lineRowId:541513,itemId:2055,sku:'MBBS-Special Order',unit:'SQFT',quantity:271.25,pallets:5,poAllocatedSalesQty:271.25,poAllocatedPallets:0};
  for(const [name,view] of Object.entries(views)) {
    assert.deepEqual(quantities(view(item,true,zero)),{quantity:0,salesQty:0,pallets:0,layers:0,sections:0,pieces:0},name);
  }
  const child={id:'SOB122647',type:'SO',sourceYard:'3445',pickupLocations:['3445','Techo'],items:[item],
    poPickupManifest:[{location:'Techo',items:[{quantity:271.25,unit:'SQFT',itemId:2055}]}]};
  const group={...child,id:'GOB-REPLAY',childOrders:[child.id],childOrderDetails:[child]};
  assert.deepEqual(dispatchRequiredPickupVisitLocations(group),['Techo']);
});

test('partial sales allocation scales the same cargo instead of retaining an independent pack balance',()=>{
  const item={itemId:100,quantity:100,pallets:4,layers:2,pieces:8,poAllocatedSalesQty:25,poAllocatedPallets:0};
  for(const [name,view] of Object.entries(views)) {
    assert.deepEqual(quantities(view(item,true,{...zero,quantity:25})),{quantity:50,salesQty:50,pallets:2,layers:1,sections:0,pieces:4},name);
    assert.deepEqual(quantities(view(item,false,zero)),{quantity:25,salesQty:25,pallets:1,layers:0.5,sections:0,pieces:2},name);
  }
});

test('explicit zero is empty while legacy packing without sales quantities remains known',()=>{
  for(const [name,view] of Object.entries(views)) {
    assert.equal(view({quantity:0,pallets:4},true,zero).pallets,0,name);
    assert.equal(view({pallets:4,poAllocatedPallets:1},true,zero).pallets,3,name);
    assert.equal(view({salesQty:10,pallets:2,poAllocatedSalesQty:10},true,zero).pallets,0,name);
  }
});

test('sales-unit projections conserve cargo across views for generated stale physical allocations',()=>{
  fc.assert(fc.property(fc.integer({min:1,max:10000}),fc.nat(20000),fc.nat(100),fc.nat(100),
    (total,allocated,packs,stale)=>{
      const item={quantity:total,pallets:packs,poAllocatedSalesQty:allocated,poAllocatedPallets:stale};
      const before=structuredClone(item);
      for(const view of Object.values(views)) {
        const own=view(item,true,zero),vendor=view(item,false,zero);
        assert.equal(own.quantity,Math.max(total-allocated,0));
        assert.equal(vendor.quantity,Math.min(total,allocated));
        assert.ok(Math.abs(own.pallets+vendor.pallets-packs)<1e-8);
      }
      assert.deepEqual(item,before);
    }),{seed:122647,numRuns:150});
});

test('sales-unit projections conserve Operator PO and TO splits through zero despite stale packing',()=>{
  fc.assert(fc.property(fc.integer({min:1,max:10000}),fc.nat(10000),fc.nat(100),
    (total,seed,pallets)=>{
      for(const full of [false,true]) {
        const po=seed%(total+1),direct=full?total-po:Math.floor((total-po)/2);
        const line=applyOperatorLinkedQuantityProjection({quantity:total,pallet_qty:pallets,piece_qty:0,
          to_plt:50,to_pcs:1,unit:'EA'}, {linkedPo:{sales:po},linkedDirectTo:{sales:direct}});
        const remaining=total-po-direct;
        assert.equal(line.quantity+po+direct,total);
        assert.equal(line.no_yard_load_required,remaining===0);
        assert.equal(operatorSalesServer.lineRequiredSalesQuantity(line),remaining);
        assert.equal(operatorSalesUi.lineRequiredSalesQty(line),remaining);
        assert.equal(operatorSalesUi.remainingValue(line,'pallets')*50+operatorSalesUi.remainingValue(line,'pieces'),remaining);
      }
    }),{seed:122650,numRuns:150});
});

