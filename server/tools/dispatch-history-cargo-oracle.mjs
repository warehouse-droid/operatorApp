// Independent test oracle: do not import production cargo or pickup projection helpers.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {compileFunction} from 'node:vm';
import {fileURLToPath} from 'node:url';
import {driverOrderDetailsFromPlan} from '../src/driver-repository.js';

export const cargoFields = ['quantity','pallets','layers','sections','pieces'];
const number = value => Number(value || 0);
export const yard = value => String(value || '').split(/\s*:\s*/u)[0].trim().toLowerCase();
const sameItem = (a,b) => a.itemId && b.itemId ? String(a.itemId) === String(b.itemId)
  : String(a.sku || a.itemName || '').toLowerCase() === String(b.sku || b.itemName || '').toLowerCase();
export function material(item = {}) {
  if (item.rentalEquipment) {return true;}
  if (item.dispatchServiceFee) {return false;}
  if (item.rentalEquipment || item.isSpecial || item.salesQuantityOnly || Number(item.itemId) === 2055) {return true;}
  return !/delivery\s*(charge|fee)|shipping\s*(charge|fee)|sales\s*credit|discount/i.test(`${item.sku || ''} ${item.itemName || ''}`)
    && !/oth\s*charge|other\s*charge|service|discount|description|subtotal|payment|markup/i.test(`${item.itemType || ''} ${item.itemTypeText || ''}`);
}
export function amounts(item = {}, direct = false) {
  return { ...item,quantity: number(item.quantity ?? item.salesQty),
    pallets: number(direct ? item.palletQty ?? item.pallets : item.pallets ?? item.pallet_qty),
    layers: number(direct ? item.layerQty ?? item.layers : item.layers ?? item.layer_qty),
    sections: number(direct ? item.sectionQty ?? item.sections : item.sections ?? item.section_qty),
    pieces: number(direct ? item.pieceQty ?? item.pieces : item.pieces ?? item.piece_qty) };
}
const positive = item => cargoFields.some(field => number(item[field]) > 0);
export function cargoRows(items = []) {
  const grouped = new Map();
  for (const raw of items.filter(material)) {
    const item = amounts(raw);
    if (!positive(item)) {continue;}
    const key = `${String(item.itemId || item.item_id || item.sku || item.itemName || '').toLowerCase()}|${item.unit || ''}`;
    const row = grouped.get(key) || Object.fromEntries(cargoFields.map(field => [field,0]));
    for (const field of cargoFields) {row[field] += number(item[field]);}
    grouped.set(key,row);
  }
  return [...grouped].sort(([a],[b]) => a.localeCompare(b)).map(([key,row]) =>
    [key,...cargoFields.map(field => Math.round(row[field] * 1e6) / 1e6)]);
}
export function retainedRouteItems(order = {}) {
  const projection = order.type === 'TO' ? order.toRouteProjection : order.type === 'PO' ? order.poRouteProjection : null;
  return (projection?.items || order.items || []).filter(material).map(item => amounts(item));
}
export function expectedDropItems(order = {}, stop = {}) {
  const projection = order.type === 'TO' ? order.toRouteProjection : order.type === 'PO' ? order.poRouteProjection : null;
  const dropoffs = projection?.dropoffs || order.dropoffs || [];
  const dropoff = dropoffs.find(drop => stop.dropoffKey && drop.key === stop.dropoffKey)
    || dropoffs.find(drop => stop.dropLocation && yard(drop.destinationYard) === yard(stop.dropLocation))
    || (dropoffs.length === 1 ? dropoffs[0] : null);
  const ids = new Set((stop.lineRowIds?.length ? stop.lineRowIds : dropoff?.lineRowIds || []).map(String));
  if (dropoffs.length > 1 && !ids.size) {throw Object.assign(new Error('Retained multi-drop order has no line scope'),{code:'HISTORY_CARGO_SCOPE_MISSING'});}
  return retainedRouteItems(order).filter(item => !ids.size || ids.has(String(item.lineRowId)));
}
export function expectedPickupItems(order = {}, location = '') {
  const wanted = yard(location);
  const source = yard(order.transitCo?.toYard || order.sourceYard || order.outboundLocation || '3445');
  const items = retainedRouteItems(order);
  if (['PO','CO'].includes(order.type) || order.toRouteProjection || order.type === 'CUSTOM') {
    return source === wanted || order.type === 'PO' && (order.pickupLocations || []).some(p => yard(p) === wanted) ? items : [];
  }
  const manifests = order.directPickupManifest?.length ? order.directPickupManifest : (order.orderDependencies || [])
    .filter(dep => dep.mode === 'direct_to_customer' && dep.status !== 'cancelled')
    .map(dep => ({location:dep.sourceLocation,items:(dep.lines || []).map(line=>({...line,quantity:line.allocatedQuantity}))}));
  const direct = manifests.flatMap(entry => (entry.items || []).map(item =>
    ({...amounts(item,true),location:yard(entry.location),supply:'TO'})));
  const po = (order.poPickupManifest || []).flatMap(entry => (entry.items || []).map(item =>
    ({...amounts(item),location:yard(entry.location),supply:'PO'})));
  if (!po.length) {
    const legacyVendors = [...new Set((order.pickupLocations || []).map(yard))]
      .filter(vendorLocation => vendorLocation !== source && !['3445','2967','12441','150','195'].includes(vendorLocation));
    if (legacyVendors.length === 1) {
      po.push(...items.map(item => ({...item,location:legacyVendors[0],supply:'PO',quantity:number(item.poAllocatedSalesQty),
        pallets:number(item.poAllocatedPallets),layers:number(item.poAllocatedLayers),
        sections:number(item.poAllocatedSections),pieces:number(item.poAllocatedPieces)})).filter(positive));
    } else if (legacyVendors.length > 1 && items.some(item => number(item.poAllocatedSalesQty))) {
      throw Object.assign(new Error('Legacy PO allocation has multiple vendors without retained per-vendor manifests'),{code:'HISTORY_CARGO_SCOPE_MISSING'});
    }
  }
  const picked = [...direct,...po].filter(item => item.location === wanted);
  const children = order.childOrderDetails || [];
  const grouped = !order.transitCo?.toYard && children.some(child => child.items?.length);
  const baseItems = grouped ? items.filter(item => children.some(child =>
    yard(child.transitCo?.toYard || child.sourceYard || order.sourceYard) === wanted && (child.items || []).some(member =>
      item.lineRowId && member.lineRowId ? String(item.lineRowId) === String(member.lineRowId)
        : item.lineId && member.lineId ? String(item.lineId) === String(member.lineId) : sameItem(item,member)))) : items;
  if (!grouped && wanted !== source) {return picked;}
  const remaining = new Map();
  const residualByItem = new Map();
  for (const item of items) {
    const allocated = direct.filter(entry => sameItem(entry,item));
    const result = {...item};
    const poFields = {quantity:'poAllocatedSalesQty',pallets:'poAllocatedPallets',layers:'poAllocatedLayers',sections:'poAllocatedSections',pieces:'poAllocatedPieces'};
    const key=String(item.itemId || item.sku || item.itemName);
    if(!remaining.has(key)) {remaining.set(key,Object.fromEntries(cargoFields.map(field=>[field,allocated.reduce((sum,entry)=>sum+entry[field],0)])));}
    const pool=remaining.get(key);
    for(const field of cargoFields) {
      const available=Math.max(number(item[field])-number(item[poFields[field]]),0);
      const taken=Math.min(available,pool[field]);result[field]=available-taken;pool[field]-=taken;
    }
    residualByItem.set(item,result);
  }
  const residual=baseItems.map(item=>residualByItem.get(item));
  return [...residual,...picked].filter(positive);
}

const uiNames = [
    'poRouteProjectionForOrder','routeItemsForOrder','routeDropoffsForOrder','dropoffForStop','dropItemsForStop',
    'positiveBalance','isOwnYardCode','retainedDirectPickupManifest','groupPickupSourceItems','directPickupEntriesForLocation','directPickupItemsForLocation',
    'poPickupEntriesForLocation','poPickupItemsForLocation','directPickupAllocatedForItem','spreadDirectPickupAllocation','itemForPickupLocation',
    'dispatchLocationHierarchyRoot','normalizedPickupLocation','sameDispatchLocation','uniqueDispatchLocationLabels',
    'isMbbsSpecialLinkLine','isOperationalDispatchItem','itemHasQuantity','tooltipItemsForOrder',
    'requiredPickupLocations','orderRequiresPickupLocation','pickupStopOrderRefs','pickupOrdersForStop'
];
const frontendSource = readFileSync(new URL('../public/dispatch.js',import.meta.url),'utf8');
const uiSpans = uiNames.map(name => {
  const start = frontendSource.search(new RegExp(`^function ${name}\\(`,'m'));
  assert.ok(start >= 0,`Missing production function ${name}`);
  const tail = frontendSource.slice(start);
  return {start,end:start+tail.search(/^}/m)+1};
});
let uiBody=frontendSource.replace(/[^\n\r]/g,' ');
for(const span of uiSpans) {uiBody=uiBody.slice(0,span.start)+frontendSource.slice(span.start,span.end)+uiBody.slice(span.end);}
const frontendFactory = compileFunction(`${uiBody}\nreturn {${uiNames.join(',')}};`,['ownYardForLocation','stopOrder','orderById'],
  {filename:fileURLToPath(new URL('../public/dispatch.js',import.meta.url))});
export function dispatchCargoFrontend(orders, ownYards = ['3445','2967','12441','150','195']) {
  const byId = id => orders.find(order => String(order.id).toLowerCase() === String(id).toLowerCase());
  return frontendFactory(location => [...ownYards,'195'].some(code => yard(code) === yard(location)),stop => byId(stop.orderId),byId);
}

export function assertCargo(actual,expected,context) {
  assert.deepEqual(cargoRows(actual),cargoRows(expected),JSON.stringify(context));
}

function expectedDisplayRows(items = []) {
  const rows = [];
  for (const item of items.filter(material).map(raw=>amounts(raw)).filter(positive)) {
    const units = [['PLT',item.pallets],['LYR',item.layers],['SEC',item.sections],['PCS',item.pieces]].filter(([,value])=>value > 0);
    for (const [unit,value] of units.length ? units : [[item.unit || 'UOM',item.quantity]]) {
      rows.push([String(item.sku || item.itemName || item.name || '').toLowerCase(),unit,Math.round(value*1e6)/1e6]);
    }
  }
  return rows.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
function driverDisplayRows(detail) {
  return detail.items.flatMap(item=>item.units.map(unit=>[String(item.sku || item.itemName || '').toLowerCase(),unit.unit,Math.round(unit.value*1e6)/1e6]))
    .sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
function dependencyRouteIssues(plan) {
  const issues=[];
  const stops=(plan.trucks || []).flatMap((truck,truckIndex)=>(truck.loads || []).flatMap((load,loadIndex)=>
    (load.stops || []).map((stop,index)=>({truck,load,truckIndex,loadIndex,index,stop}))));
  for (const order of plan.orders || []) {
    const sales=stops.filter(entry=>entry.stop.type==='drop' && entry.stop.orderId===order.id);
    if (!sales.length) {continue;}
    for (const dependency of order.orderDependencies || []) {
      if (dependency.status==='cancelled' || dependency.mode!=='yard_replenishment' || dependency.transferReceived) {continue;}
      const transfer=stops.filter(entry=>entry.stop.type==='drop' && entry.stop.orderId===dependency.transferOrderRef);
      const earlierDate=String(dependency.plannedDate || '').slice(0,10);
      if (!transfer.length) {
        if (earlierDate && earlierDate < plan.planDate) {continue;}
        issues.push({check:'replenishment_evidence_missing',orderRef:order.id,transferOrderRef:dependency.transferOrderRef});continue;
      }
      for(const sale of sales) {
        const pickup=stops.find(entry=>entry.load===sale.load && entry.stop.type==='pick' && entry.index<sale.index
          && yard(entry.stop.location)===yard(order.transitCo?.toYard || order.sourceYard));
        const precedes=transfer.some(entry=> {
          if (entry.load===sale.load) {return pickup && entry.index<pickup.index;}
          const finish=entry.load.timing?.finish ?? entry.stop.timing?.depart;
          const start=pickup?.stop.timing?.arrival;
          if (Number.isFinite(finish) && Number.isFinite(start)) {return finish<=start;}
          return entry.truck===sale.truck && entry.loadIndex<sale.loadIndex;
        });
        if(!precedes) {issues.push({check:'replenishment_before_so_pickup',orderRef:order.id,transferOrderRef:dependency.transferOrderRef,loadId:sale.load.id});}
      }
    }
  }
  return issues;
}

export function auditRetainedBoard(plan) {
  const ui = dispatchCargoFrontend(plan.orders || [],plan.ownYardCodes);
  const byId = id => (plan.orders || []).find(order => String(order.id).toLowerCase() === String(id).toLowerCase());
  const result = {loads:0,pickups:0,deliveries:0,contentChecks:0,driverContentChecks:0,toLinkedDeliveries:0,poLinkedDeliveries:0,
    evidenceGaps:[],routeIssues:dependencyRouteIssues(plan)};
  for (const truck of plan.trucks || []) {for (const load of truck.loads || []) {
    if (load.returnOnly) {continue;}
    result.loads++;
    const picked = new Set();
    for (const [index,stop] of (load.stops || []).entries()) {
      if (stop.type === 'pick') {
        result.pickups++;
        for (const order of ui.pickupOrdersForStop(load,stop)) {
          const context = {planId:plan.id,loadId:load.id,stopId:stop.id,orderRef:order.id,location:stop.location,check:'dispatch_pickup_content'};
          assertCargo(ui.tooltipItemsForOrder(order,{pickupLocation:stop.location}),expectedPickupItems(order,stop.location),context);
          result.contentChecks++;
          const ordinaryYard = yard(order.transitCo?.toYard || order.sourceYard)===yard(stop.location);
          if (ordinaryYard || (order.poPickupManifest || []).some(entry=>yard(entry.location)===yard(stop.location))) {
            const expected=order.type === 'PO' ? (order.items || []).filter(material) : expectedPickupItems(order,stop.location).filter(item=>item.supply!=='TO');
            assert.deepEqual(driverDisplayRows(driverOrderDetailsFromPlan(order.id,order,{plan,stopType:'pickup',pickupLocation:stop.location})),
              expectedDisplayRows(expected),JSON.stringify({...context,check:'driver_pickup_content'}));
            result.driverContentChecks++;
          }
          const key = `${order.id}|${yard(stop.location)}`;
          if (picked.has(key)) {result.routeIssues.push({...context,check:'duplicate_pickup'});}
          picked.add(key);
        }
      } else if (stop.type === 'drop') {
        result.deliveries++;
        const order = byId(stop.orderId);
        assert.ok(order,JSON.stringify({planId:plan.id,orderRef:stop.orderId,check:'missing_card'}));
        const context = {planId:plan.id,loadId:load.id,stopId:stop.id,orderRef:order.id,check:'dispatch_delivery_content'};
        const expected = expectedDropItems(order,stop);
        if (!expected.length) {result.evidenceGaps.push({...context,reason:'Retained card contains no material cargo; empty content is not independent evidence of correctness.'});}
        assertCargo(ui.tooltipItemsForOrder(order,{stop}),expected,context);
        result.contentChecks++;
        assert.deepEqual(driverDisplayRows(driverOrderDetailsFromPlan(order.id,order,{plan,stopType:'dropoff',lineRowIds:stop.lineRowIds,
          dropLocation:stop.dropLocation || order.destinationYard,dropoffKey:stop.dropoffKey})),expectedDisplayRows(expected),
        JSON.stringify({...context,check:'driver_delivery_content'}));
        result.driverContentChecks++;
        if (order.directPickupManifest?.length) {result.toLinkedDeliveries++;}
        if (order.poPickupManifest?.length) {result.poLinkedDeliveries++;}
        const locations = [...new Set([order.transitCo?.toYard || order.sourceYard || order.outboundLocation || '3445',
          ...(order.pickupLocations || []),...(order.directPickupManifest || []).map(entry=>entry.location),
          ...(order.poPickupManifest || []).map(entry=>entry.location)].filter(Boolean))];
        for (const location of locations) {
          if (!expectedPickupItems(order,location).some(positive)) {continue;}
          if (!picked.has(`${order.id}|${yard(location)}`)) {result.routeIssues.push({...context,check:'pickup_before_delivery',location,index});}
        }
      }
    }
  }}
  return result;
}
