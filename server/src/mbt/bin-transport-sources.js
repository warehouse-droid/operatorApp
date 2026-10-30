// @ts-check
import {query} from '../db.js';
import {getDispatchOrderCatalogOrder} from '../dispatch-order-catalog-repository.js';
import {getDispatchCustomOrder,dispatchOrderFromCustomOrder} from '../dispatch-custom-order-repository.js';
import {rentalItemDecision} from '../sor-rental-policy.js';
import {canonicalSha256} from './canonical-json.js';
import {aggregateRoutingIds} from './aggregate-routing.js';
import {transportSourceKind,transportQuantity,transportQuantityText,transportError} from './bin-transport-domain.js';

/** @type {((input:any)=>Promise<any[]>) | undefined} */
let operationalSourceLoader;
/** The application supplies the same canonical loader used by Dispatch.
 * @param {((input:any)=>Promise<any[]>) | undefined} loader */
export function configureTransportSourceLoader(loader) {if (loader) {operationalSourceLoader=loader;}}

/** @param {string} ref */
async function customSource(ref) {
  const row=(await query(`SELECT c.id,c.mbt_source,r.pricing_snapshot FROM dispatch_custom_orders c
    LEFT JOIN mbt_frontdesk_charge_requests r ON r.charge_request_id=c.mbt_charge_request_id
    WHERE lower(c.ref_number)=lower($1) AND (c.order_kind='sor_rental_return' OR c.mbt_source='frontdesk_aggregate')`,[ref])).rows[0];
  if (!row) {return null;}
  const custom=await getDispatchCustomOrder(row.id);if (!custom) {return null;}
  const order=/** @type {any} */ (dispatchOrderFromCustomOrder(custom));
  if (row.mbt_source==='frontdesk_aggregate') {
    order.mbtSource=row.mbt_source;
    order.items=(row.pricing_snapshot?.calculation?.lines || []).filter((/** @type {any} */ l)=>l.lineType==='aggregate_material')
      .map((/** @type {any} */ l,/** @type {number} */ index)=>({lineRowId:`aggregate:${index}:${l.itemCode}`,itemId:l.itemCode,
        itemName:l.label,unit:'YARD',quantity:Number(l.quantityMilliUnits)/1000,lineWeight:Number(l.derivedWeightLbs)}));
  }
  return {...order,customOrderId:String(row.id),localDispatchStatus:custom.status};
}

/** @param {any} order */
function sourceLines(order) {
  return (order.items || []).filter((/** @type {any} */ item)=>Number(item.quantity ?? item.salesQty)>0
    && rentalItemDecision(item).reason!=='fee'
    && !['Discount','Subtotal','EndGroup','Description','Payment','TaxItem'].includes(item.itemType))
    .map((/** @type {any} */ item,/** @type {number} */ index)=>({key:String(item.lineRowId || item.lineUniqueKey || item.lineId || index+1),
      itemId:String(item.itemId ?? ''),description:String(item.itemName || item.description || item.sku || 'Item'),
      unit:String(item.unit || item.uom || 'EACH'),quantity:transportQuantityText(transportQuantity(item.quantity ?? item.salesQty)),
      lineWeight:Number(item.lineWeight || 0)}));
}

/** @param {string} ref @param {any} [boundary] */
export async function readTransportSource(ref,boundary={}) {
  if (!ref || ref.length>200) {throw transportError('Choose an original order reference.');}
  let order=await customSource(ref);
  const loadOrders=boundary.loadOrders || operationalSourceLoader;
  if (!order && loadOrders) {
    order=(await loadOrders({exactOrderRefs:[ref],search:ref,includeCompletedScmSearch:true}))
      .find((/** @type {any} */ row)=>String(row.id).toLowerCase()===ref.toLowerCase());
  }
  order ||= await getDispatchOrderCatalogOrder(ref);
  const kind=order && transportSourceKind(order,await aggregateRoutingIds());
  if (!order || !kind) {throw transportError('This order is not eligible for MBR/Agg BIN transport.');}
  return transportSourceFromOrder(order,kind);
}

/** @param {any} order */
function sourceWindow(order) {
  return {windowStart:String(order.windowStart || ''),windowEnd:String(order.windowEnd || ''),deliveryDate:order.expectedDeliveryDate || null};
}
/** @param {any} order */
function sourceLocation(order) {
  return {customer:String(order.customer || order.customerName || ''),
    address:String(order.address || order.dropoffLocation || order.dropAddress || ''),
    pickupLocations:order.pickupLocations || [order.pickupLocation || order.sourceYard || '3445'],
    sourceAddress:String(order.sourceAddress || order.pickupLocation || ''),
    ...sourceWindow(order)};
}
/** @param {any} order @param {string} kind */
export function transportSourceFromOrder(order,kind) {
  const snapshot={ref:String(order.id),kind,type:String(order.type || 'CUSTOM'),customOrderId:order.customOrderId || null,
    ...sourceLocation(order),lines:sourceLines(order)};
  return {order,snapshot,fingerprint:canonicalSha256(snapshot),sourceKey:snapshot.ref.toLowerCase()};
}
/** @param {any} order */
function sourceClosed(order) {
  return order.eligible===false || order.dispatchPlanningRestricted || order.needsAddress || order.sorReviewReason
    || ['completed','cancelled','closed'].includes(String(order.localDispatchStatus || order.status || '').toLowerCase())
    || order.dispatchCompletionStatus==='completed';
}

/** @param {any} source */
export async function assertTransportSourceOpen(source) {
  const order=source.order;
  if (sourceClosed(order) || !source.snapshot.address || !source.snapshot.lines.length) {
    throw transportError(order.dispatchPlanningRestrictionReason || 'This source order is closed, incomplete or awaiting review.');
  }
  if (order.isGrouped || order.globalGroupDefinition || (order.childOrders || []).length>1) {
    throw transportError('Ungroup independent orders before assigning one BIN.');
  }
  const assigned=await query(`SELECT 1 FROM dispatch_plan_order_assignments a JOIN dispatch_plans p ON p.id=a.plan_id
    WHERE lower(a.order_ref)=$1 AND p.status<>'cancelled' LIMIT 1`,[source.sourceKey]);
  if (assigned.rowCount) {throw transportError('This source order is already assigned in Dispatch. Unplan it before choosing BIN transport.');}
  const cargo=await query(`SELECT 1 FROM mbt_bin_cargo_plans b JOIN dispatch_custom_orders c ON c.id=b.custom_order_id
    WHERE lower(c.ref_number)=$1 AND b.completed_at IS NULL LIMIT 1`,[source.sourceKey]);
  if (cargo.rowCount) {throw transportError('This source order is already cargo on another BIN. Remove that cargo plan before choosing transport.');}
}

/** @param {any[]} lines @param {any[]} trips */
export function transportLineProgress(lines,trips) {
  return lines.map(line=>{
    let allocated=0n,delivered=0n;
    for (const trip of trips.filter(t=>t.status!=='cancelled')) {
      for (const row of trip.allocations.filter((/** @type {any} */ a)=>a.lineKey===line.key)) {
        const amount=transportQuantity(row.quantity);allocated+=amount;
        if (trip.cargo_delivered_at) {delivered+=amount;}
      }
    }
    const remaining=transportQuantity(line.quantity)-allocated;
    return {...line,allocated:transportQuantityText(allocated),planned:transportQuantityText(allocated-delivered),
      delivered:transportQuantityText(delivered),remaining:transportQuantityText(remaining<0n?0n:remaining)};
  });
}

/** @param {any} [input] @param {any} [boundary] */
export async function transportSourceOrders(input={},boundary={}) {
  const search=String(input.search || '').trim().slice(0,120);
  let orders;
  if (boundary.loadOrders) {orders=await boundary.loadOrders({type:'SO',search,includeCompletedScmSearch:Boolean(search)});}
  else {
    orders=(await query(`SELECT full_order FROM dispatch_order_catalog_entries WHERE ($1='' OR search_text ILIKE '%'||$1||'%')
      AND (order_ref ~* '^SOR[0-9]' OR mbt_bin_only_source(full_order))
      AND NOT EXISTS(SELECT 1 FROM dispatch_global_order_splits s WHERE s.active AND lower(s.parent_order_ref)=lower(order_ref))
      UNION ALL SELECT full_order FROM dispatch_global_order_splits WHERE active AND ($1='' OR search_text ILIKE '%'||$1||'%')
      AND (split_ref ~* '^SOR[0-9]' OR mbt_bin_only_source(full_order))`,[search])).rows.map((/** @type {any} */ r)=>r.full_order);
  }
  const customs=await query(`SELECT ref_number FROM dispatch_custom_orders WHERE (order_kind='sor_rental_return' OR mbt_source='frontdesk_aggregate')
    AND status<>'cancelled' AND ($1<>'' OR status='open') AND ($1='' OR ref_number ILIKE '%'||$1||'%')`,[search]);
  const byRef=new Map(orders.map((/** @type {any} */ o)=>[String(o.id).toLowerCase(),o]));
  for (const row of customs.rows) {byRef.set(row.ref_number.toLowerCase(),await customSource(row.ref_number));}
  const ids=await aggregateRoutingIds();
  return [...byRef.values()].filter(o=>transportSourceKind(o,ids) && (search || (o.eligible!==false
    && !['completed','cancelled'].includes(o.localDispatchStatus) && o.dispatchCompletionStatus!=='completed')));
}
