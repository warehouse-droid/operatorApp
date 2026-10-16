import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import {driverOrderDetailsFromPlan,planJobsForDriver} from '../../../src/driver-repository.js';
import {dispatchPhysicalStopVisits} from '../../../src/dispatch-load-assignment.js';
import {dispatchCargoFrontend,assertCargo,expectedPickupItems} from '../../../tools/dispatch-history-cargo-oracle.mjs';

const line = (id,quantity) => ({itemId:id,sku:`SKU-${id}`,itemType:'InvtPart',quantity,pallets:quantity,unit:'PLT'});
function linkedOrder() {
  return {id:'SO-CARGO',type:'SO',sourceYard:'3445',pickupLocations:['3445','2967'],items:[line(42,10)],
    directPickupManifest:[{transferOrderRef:'TO-CARGO',salesOrderRef:'SO-CARGO',location:'2967',
      items:[{itemId:42,sku:'SKU-42',quantity:4,palletQty:4,unit:'PLT'}]}]};
}
const driverPallets = detail => detail.items.reduce((sum,item) => sum + item.units.filter(unit => unit.unit==='PLT').reduce((n,unit)=>n+unit.value,0),0);
test('a direct TO pickup at another yard is subtracted from the ordinary SO yard cargo',() => {
  const order=linkedOrder();
  const ui=dispatchCargoFrontend([order]);
  assertCargo(ui.tooltipItemsForOrder(order,{pickupLocation:'3445'}),[line(42,6)],{check:'ordinary SO yard excludes direct TO cargo'});
  assertCargo(ui.tooltipItemsForOrder(order,{pickupLocation:'2967'}),[line(42,4)],{check:'TO yard contains only linked cargo'});
});
test('driver SO pickup contents exclude the direct TO allocation collected elsewhere',() => {
  const order=linkedOrder();
  assert.equal(driverPallets(driverOrderDetailsFromPlan(order.id,order,{plan:{},stopType:'pickup',pickupLocation:'3445'})),6);
  assert.equal(driverPallets(driverOrderDetailsFromPlan(order.id,order,{plan:{},stopType:'dropoff'})),10);
});
test('Dispatch pickup capacity uses the residual cargo at the SO yard',() => {
  const order=linkedOrder();
  const load={id:'load',stops:[{id:'p-source',type:'pick',location:'3445',orderRefs:[order.id]},
    {id:'p-to',type:'pick',location:'2967',orderRefs:[order.id]},{id:'drop',type:'drop',orderId:order.id}]};
  const plan={orders:[order],trucks:[{id:'truck',driverLogin:'driver',loads:[load]}]};
  assert.deepEqual(dispatchPhysicalStopVisits(plan,plan.trucks[0],load).map(visit=>visit.pallets),[6,4,10]);
});
test('driver vendor pickups show each PO allocation at its own vendor',() => {
  const item={...line(42,10),poAllocatedSalesQty:5,poAllocatedPallets:5};
  const order={id:'SO-PO',type:'SO',sourceYard:'3445',pickupLocations:['3445','Vendor A','Vendor B'],items:[item],
    poPickupManifest:[{location:'Vendor A',poOrderRef:'PO-A',items:[line(42,2)]},
      {location:'Vendor B',poOrderRef:'PO-B',items:[line(42,3)]}]};
  assert.equal(driverPallets(driverOrderDetailsFromPlan(order.id,order,{plan:{},stopType:'pickup',pickupLocation:'Vendor A'})),2);
  assert.equal(driverPallets(driverOrderDetailsFromPlan(order.id,order,{plan:{},stopType:'pickup',pickupLocation:'Vendor B'})),3);
  assert.equal(driverPallets(driverOrderDetailsFromPlan(order.id,order,{plan:{},stopType:'pickup',pickupLocation:'3445'})),5);
});
test('a same-yard direct TO pickup contains SO residual and linked goods exactly once',() => {
  const order=linkedOrder(); order.directPickupManifest[0].location='3445'; order.pickupLocations=['3445'];
  const ui=dispatchCargoFrontend([order]);
  assertCargo(ui.tooltipItemsForOrder(order,{pickupLocation:'3445'}),[line(42,10)],{check:'same-yard direct allocation counted once'});
  assertCargo(expectedPickupItems(order,'3445'),[line(42,10)],{check:'independent oracle total'});
});
test('driver group pickups show only children physically supplied at that yard',() => {
  const children=[{id:'SO-A',type:'SO',sourceYard:'3445',pickupLocations:['3445'],items:[line(41,6)]},
    {id:'SO-B',type:'SO',sourceYard:'12441',pickupLocations:['12441'],items:[line(42,4)]}];
  const order={id:'GO-CARGO',type:'SO',sourceYard:'3445',pickupLocations:['3445','12441'],items:children.flatMap(c=>c.items),
    childOrders:children.map(c=>c.id),childOrderDetails:children};
  const plan={id:1,planDate:'2099-01-01',orders:[order],trucks:[{id:'truck',driverLogin:'driver',driver:'driver',loads:[{id:'load',stops:[
    {id:'p-a',type:'pick',location:'3445',orderRefs:[order.id]},
    {id:'p-b',type:'pick',location:'12441',orderRefs:[order.id]},{id:'drop',type:'drop',orderId:order.id}]}]}]};
  const jobs=planJobsForDriver(plan,'driver').filter(job=>job.stopType==='pickup');
  assert.deepEqual(jobs.map(job=>job.orderRefs),[['SO-A'],['SO-B']]);
});
test('a legacy retained TO dependency supplies its exact lines when the display manifest is absent',() => {
  const order=linkedOrder();
  delete order.directPickupManifest;
  order.orderDependencies=[{id:'dep',mode:'direct_to_customer',status:'packed',transferOrderRef:'TO-CARGO',
    salesOrderRef:order.id,sourceLocation:'2967',lines:[{itemId:42,itemName:'SKU-42',allocatedQuantity:4,palletQty:4,unit:'PLT'}]}];
  const ui=dispatchCargoFrontend([order]);
  assertCargo(ui.tooltipItemsForOrder(order,{pickupLocation:'2967'}),[line(42,4)],{check:'retained TO lines prove the pickup'});
  assert.equal(driverPallets(driverOrderDetailsFromPlan(order.id,order,{plan:{},stopType:'pickup',pickupLocation:'3445'})),6);
});
test('driver plan cargo excludes delivery charges from pickup and delivery',() => {
  const order={id:'SO-FEES',type:'SO',sourceYard:'3445',items:[line(42,6),{itemId:1987,sku:'Delivery Charge',itemType:'OthCharge',quantity:1}]};
  for(const stopType of ['pickup','dropoff']) {
    assert.deepEqual(driverOrderDetailsFromPlan(order.id,order,{plan:{},stopType,pickupLocation:'3445'}).items.map(item=>item.sku),['SKU-42']);
  }
});
test('a PO delivery resolves the retained destination line scope when the stop omits line IDs',() => {
  const items=[{...line(41,6),lineRowId:'a'},{...line(42,4),lineRowId:'b'}];
  const order={id:'PO-MULTI',type:'PO',items,poRouteProjection:{version:1,items,dropoffs:[
    {key:'a',destinationYard:'3445',lineRowIds:['a']},{key:'b',destinationYard:'12441',lineRowIds:['b']} ]}};
  const detail=driverOrderDetailsFromPlan(order.id,order,{stopType:'dropoff',dropLocation:'12441'});
  assert.deepEqual(detail.items.map(item=>item.sku),['SKU-42']);
});
test('a retained PO manifest establishes its vendor pickup even when pickupLocations contains only the SO yard',() => {
  const item={...line(42,4),poAllocatedPallets:4,poAllocatedSalesQty:4};
  const order={id:'SO-VENDOR',type:'SO',sourceYard:'3445',pickupLocations:['3445'],items:[item],
    poPickupManifest:[{location:'Vendor A',poOrderRef:'PO-A',items:[line(42,4)]}]};
  const load={id:'load',stops:[{id:'vendor',type:'pick',location:'Vendor A',orderId:order.id},{id:'drop',type:'drop',orderId:order.id}]};
  const ui=dispatchCargoFrontend([order]);
  assert.deepEqual(ui.pickupOrdersForStop(load,load.stops[0]).map(o=>o.id),[order.id]);
  const plan={id:1,planDate:'2099-01-01',orders:[order],trucks:[{id:'truck',driverLogin:'driver',driver:'driver',loads:[load]}]};
  assert.deepEqual(planJobsForDriver(plan,'driver').find(job=>job.stopType==='pickup').orderRefs,[order.id]);
});
test('Dispatch grouped pickup quantities and capacity are split by the child physical yard',() => {
  const children=[{id:'SO-A',type:'SO',sourceYard:'3445',items:[{...line(41,6),lineRowId:'a'}]},
    {id:'SO-B',type:'SO',sourceYard:'12441',items:[{...line(42,4),lineRowId:'b'}]}];
  const order={id:'GO-CARGO',type:'SO',sourceYard:'3445',pickupLocations:['3445'],items:children.flatMap(c=>c.items),
    childOrders:children.map(c=>c.id),childOrderDetails:children};
  const ui=dispatchCargoFrontend([order]);
  assertCargo(ui.tooltipItemsForOrder(order,{pickupLocation:'3445'}),[line(41,6)],{check:'group cargo at yard A'});
  assertCargo(ui.tooltipItemsForOrder(order,{pickupLocation:'12441'}),[line(42,4)],{check:'group cargo at yard B'});
  assert.deepEqual(new Set(ui.requiredPickupLocations(order)),new Set(['3445','12441']));
  const load={id:'load',stops:[{id:'a',type:'pick',location:'3445',orderRefs:[order.id]},
    {id:'b',type:'pick',location:'12441',orderRefs:[order.id]},{id:'drop',type:'drop',orderId:order.id}]};
  assert.deepEqual(dispatchPhysicalStopVisits({orders:[order]},{},load).map(visit=>visit.pallets),[6,4,10]);
});
test('a legacy PO without a route projection retains its vendor pickup cargo',()=>{
  const order={id:'PO-LEGACY',type:'PO',sourceYard:'Vendor A',pickupLocations:['Vendor A'],items:[line(42,6)]};
  assert.equal(driverPallets(driverOrderDetailsFromPlan(order.id,order,{plan:{},stopType:'pickup',pickupLocation:'Vendor A'})),6);
});
test('physical CO manifest quantities do not subtract source SO PO allocations',()=>{
  const order={id:'CO-CARGO',type:'CO',sourceYard:'3445',items:[{...line(42,6),poAllocatedPallets:6,poAllocatedSalesQty:6}]};
  assert.equal(driverPallets(driverOrderDetailsFromPlan(order.id,order,{plan:{},stopType:'pickup',pickupLocation:'3445'})),6);
});
test('duplicate SO item lines conserve direct TO allocations across pickup yards',()=>{
  fc.assert(fc.property(fc.integer({min:1,max:100}),fc.integer({min:1,max:100}),fc.nat(200),(first,second,wanted)=>{
    const allocated=Math.min(first+second,wanted);
    const order=linkedOrder(); order.items=[{...line(42,first),lineRowId:'first'},{...line(42,second),lineRowId:'second'}];
    order.directPickupManifest[0].items[0].quantity=allocated;order.directPickupManifest[0].items[0].palletQty=allocated;
    const ui=dispatchCargoFrontend([order]);
    const local=ui.tooltipItemsForOrder(order,{pickupLocation:'3445'}).reduce((sum,item)=>sum+item.quantity,0);
    const direct=ui.tooltipItemsForOrder(order,{pickupLocation:'2967'}).reduce((sum,item)=>sum+item.quantity,0);
    assert.equal(local+direct,first+second);
    assert.equal(driverPallets(driverOrderDetailsFromPlan(order.id,order,{plan:{},stopType:'pickup',pickupLocation:'3445'})),first+second-allocated);
  }),{numRuns:300,seed:20261002});
});
