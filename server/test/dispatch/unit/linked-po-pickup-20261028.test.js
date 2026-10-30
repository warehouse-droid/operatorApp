import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {reconcileAuthoritativeDispatchOrderProjection,stripDispatchPoAllocationProjection} from '../../../src/dispatch-plan-order-projection.js';
import {driverOrderDetailsFromPlan} from '../../../src/driver-repository.js';
import {materializeDriverOfflineJobs} from '../../../src/driver-offline-repository.js';
import {destinationFunctions} from '../../support/dispatch-po-line-destination-functions.mjs';

function fixture(allocated = 21) {
  const child = {id:'SO-PALLET-S1',type:'SO',sourceYard:'150',pickupLocations:['150','Vendor'],
    items:[{itemId:1784,sku:'PALLET',unit:'EACH',quantity:21,pieces:0,pallets:0,poAllocatedPieces:allocated,poAllocatedSalesQty:allocated}],
    poPickupManifest:[{poOrderRef:'PO-ONE',location:'Vendor',items:[{itemId:1784,sku:'PALLET',unit:'EACH',quantity:allocated,pieces:allocated}]}]};
  const order = {...child,id:'GROUP',childOrders:[child.id],childOrderDetails:[child]};
  return {id:1,orders:[order],trucks:[{id:'truck',loads:[{id:'load',routeEstimate:{minutes:123},stops:[
    {id:'vendor',type:'pick',location:'Vendor',orderId:'GROUP',orderRefs:['GROUP']},
    {id:'empty',type:'pick',location:'150',orderId:'GROUP',orderRefs:['GROUP']},
    {id:'drop',type:'drop',orderId:'GROUP',location:'Customer'}]}]}]};
}
const reconcile = (plan,activity=[]) => reconcileAuthoritativeDispatchOrderProjection({plan,projectedOrders:plan.orders,activity}).plan;
const stops = plan => plan.trucks[0].loads[0].stops;

test('fully linked PALLET group removes saved empty 150 visit and invalidates future timing',()=>{
  const input=fixture(),before=structuredClone(input),result=reconcile(input);
  assert.deepEqual(stops(result).map(s=>s.id),['vendor','drop']);
  assert.equal(result.trucks[0].loads[0].routeEstimate,undefined);
  assert.equal(result.trucks[0].loads[0].routeProjectionRefreshRequired,true);
  assert.deepEqual(input,before);
  assert.deepEqual(reconcile(result),result);
});

test('partial links, unknown quantities, custom orders and pickup overrides keep the yard visit',()=>{
  for(const setup of [p=>{p.orders[0]=fixture(20).orders[0];},
    p=>{delete p.orders[0].items[0].quantity;},p=>{p.orders[0].type='CUSTOM';},
    p=>{p.orders[0].pickupAddressOverride='A deliberate address';},p=>{p.orders[0].poPickupManifest=[];}]) {
    const plan=fixture();setup(plan);assert.ok(stops(reconcile(plan)).some(s=>s.id==='empty'));
  }
});

test('shared source visit retains the unlinked order and correct primary reference',()=>{
  const plan=fixture();plan.orders.push({id:'OTHER',type:'SO',sourceYard:'150',pickupLocations:['150'],items:[{quantity:2,unit:'EACH'}]});
  stops(plan)[1].orderRefs.push('OTHER');stops(plan).push({id:'other-drop',type:'drop',orderId:'OTHER'});
  stops(plan)[1].dependencyTargetRefs=['GROUP','OTHER'];
  const source=stops(reconcile(plan)).find(s=>s.id==='empty');
  assert.deepEqual(source.orderRefs,['OTHER']);assert.equal(source.orderId,'OTHER');
  assert.deepEqual(source.dependencyTargetRefs,['OTHER']);
});

test('clearing stale PO projection preserves native and direct-transfer pickup evidence',()=>{
  const order=fixture().orders[0];
  order.directPickupManifest=[{location:'Vendor',toOrderRef:'TO-ONE',items:[{quantity:1}]}];
  const before=structuredClone(order),clean=stripDispatchPoAllocationProjection(order);
  assert.deepEqual(clean.pickupLocations,['150','Vendor']);
  assert.deepEqual(clean.directPickupManifest,order.directPickupManifest);
  assert.equal(clean.poPickupManifest,undefined);
  assert.equal(clean.items[0].poAllocatedSalesQty,undefined);
  assert.equal(clean.childOrderDetails[0].poPickupManifest,undefined);
  assert.deepEqual(order,before);
});

test('installed Driver shell caches the same new PO-reference script as driver.html',async()=>{
  const root=new URL('../../../public/',import.meta.url),events={},stored=[];
  const cache={addAll:async requests=>stored.push(...requests.map(r=>r.url)),put:async()=>{}};
  runInNewContext(readFileSync(new URL('driver-service-worker.js',root),'utf8'),{
    importScripts:()=>{},URL,Request,Response,
    caches:{open:async name=>{assert.equal(name,'mbbs-driver-shell-v54');return cache;}},
    self:{location:{origin:'https://driver.test'},addEventListener:(name,handler)=>{events[name]=handler;},skipWaiting:()=>{}}
  },{filename:new URL('driver-service-worker.js',root).pathname});
  let installed;events.install({waitUntil:promise=>{installed=promise;}});await installed;
  const asset='/driver.js?v=20261028-linked-po-pickup';
  assert.ok(stored.includes('https://driver.test'+asset));
  assert.ok(readFileSync(new URL('driver.html',root),'utf8').includes(asset));
  assert.equal(stored.filter(url=>new URL(url).pathname==='/driver.js').length,1);
});

test('recorded pickup, completed prefix and active travel are protected',()=>{
  for(const activity of [
    {status:'in_progress',stop_id:'empty',stop_type:'pickup'},
    {status:'complete',stop_id:'drop',stop_type:'dropoff'},
    {status:'in_progress',stop_id:'travel-empty',stop_type:'travel',job_details:{toStopId:'empty'}}
  ]) {
    const plan=fixture();const result=reconcile(plan,[{load_id:'load',...activity}]);
    assert.deepEqual(stops(result),stops(plan));
  }
});

test('generated sales-UOM residual controls saved visits regardless of packing annotation',()=>{
  fc.assert(fc.property(fc.integer({min:1,max:10000}),fc.nat(10000),fc.nat(200),
    (total,seed,packing)=>{
      const allocated=seed%(total+1),plan=fixture(allocated),item=plan.orders[0].items[0];
      Object.assign(item,{quantity:total,pallets:packing,poAllocatedPieces:0,poAllocatedSalesQty:allocated});
      const result=reconcile(plan);
      assert.equal(stops(result).some(s=>s.id==='empty'),allocated<total);
      assert.deepEqual(reconcile(result),result);
      assert.equal(result.orders[0].items[0].quantity,total);
    }),{seed:68946895,numRuns:200});
});

test('pickup PO references are scoped, unique, kept offline, and absent on delivery',()=>{
  const plan=fixture(),order=plan.orders[0];
  order.poPickupManifest.push({...order.poPickupManifest[0]}, {poOrderRef:'PO-TWO',location:'Elsewhere',items:[]});
  const detail=driverOrderDetailsFromPlan(order.id,order,{plan,stopType:'pickup',pickupLocation:'Vendor'});
  assert.deepEqual(detail.poRefs,['PO-ONE']);
  const job={jobId:'1:truck:load:vendor',planId:1,planDate:'2098-01-01',stopType:'pickup',orders:[detail],orderRefs:['GROUP']};
  assert.deepEqual(materializeDriverOfflineJobs([job],'test-driver')[0].snapshot.orders[0].poRefs,['PO-ONE']);
  assert.deepEqual(driverOrderDetailsFromPlan(order.id,order,{plan,stopType:'dropoff'}).poRefs,[]);
  assert.deepEqual(driverOrderDetailsFromPlan(order.id,order,{plan,stopType:'pickup',pickupLocation:'150'}).poRefs,[]);
});

test('driver pickup card renders escaped linked PO references without changing SO heading',()=>{
  const escapeHtml=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  const {renderOrders}=destinationFunctions('../../public/driver.js',['renderOrders'],{escapeHtml,t:(_key,fallback)=>fallback,unitPills:()=>''});
  const orders=[{orderRef:'SO-ONE',poRefs:['PO-ONE','<img onerror=bad>'],items:[]}];
  const html=renderOrders({stopType:'pickup',orders});
  assert.match(html,/<h3>SO-ONE<\/h3>/);assert.match(html,/PO Ref/);assert.match(html,/PO-ONE/);
  assert.match(html,/&lt;img onerror=bad&gt;/);assert.doesNotMatch(html,/<img/);
  assert.doesNotMatch(renderOrders({stopType:'dropoff',orders}),/PO-ONE/);
});
