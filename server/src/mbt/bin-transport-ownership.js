// @ts-check
import {query} from '../db.js';
import {aggregateRoutingIds} from './aggregate-routing.js';
import {transportSourceKind,transportError} from './bin-transport-domain.js';

/** @param {any} order */
function reference(order) {return String(order.id || order.orderId || order.refNumber || '').toLowerCase();}

/** @param {any[]} orders */
export async function filterOrdinaryTransportOrders(orders) {
  if (!orders.length) {return [];}
  const refs=orders.map(reference),rules=await aggregateRoutingIds();
  const {rows}=await query(`SELECT source_key AS ref FROM mbt_transport_sources WHERE claimed AND source_key=ANY($1::text[])
    UNION SELECT lower(ref_number) AS ref FROM dispatch_custom_orders WHERE mbt_source='frontdesk_aggregate' AND lower(ref_number)=ANY($1::text[])`,[refs]);
  const claimed=new Set(rows.map((/** @type {any} */ r)=>r.ref));
  return orders.filter(order=>!claimed.has(reference(order)) && !['aggregate','frontdesk_aggregate'].includes(transportSourceKind(order,rules) || ''));
}

/** @param {any} child */
function childReference(child) {return String(typeof child==='object'?child.id:child).toLowerCase();}

/** @param {any} plan */
function ordinaryReferences(plan) {
  const refs=new Set();
  const stops=(plan.trucks || []).flatMap((/** @type {any} */ truck)=>truck.loads || [])
    .flatMap((/** @type {any} */ load)=>load.stops || []);
  for (const stop of stops) {
    if (stop.mbt) {continue;}
    for (const value of [stop.orderId,stop.orderRef,...(stop.orderIds || []),...(stop.orderRefs || [])].filter(Boolean)) {
      refs.add(String(value).toLowerCase());
    }
  }
  for (const order of plan.orders || []) {
    if (!refs.has(reference(order))) {continue;}
    for (const child of order.childOrders || []) {refs.add(childReference(child));}
  }
  return refs;
}

/** Canonical catalog/source rows decide routing, never client-provided items.
 * Existing routes are retained for review; this guard rejects new assignments.
 * @param {any} previous @param {any} next */
export async function assertTransportOrderOwnership(previous,next) {
  const prior=ordinaryReferences(previous || {}),refs=[...ordinaryReferences(next)].filter(ref=>!prior.has(ref));
  if (!refs.length) {return;}
  const {rows}=await query(`WITH refs AS (
    SELECT unnest($1::text[]) AS ref UNION SELECT lower(member_order_ref) FROM dispatch_global_order_group_members WHERE lower(group_ref)=ANY($1::text[])
  ), orders AS (
    SELECT order_ref AS ref,full_order FROM dispatch_order_catalog_entries WHERE lower(order_ref) IN (SELECT ref FROM refs)
    UNION ALL SELECT split_ref,full_order FROM dispatch_global_order_splits WHERE active AND lower(split_ref) IN (SELECT ref FROM refs)
    UNION ALL SELECT group_ref,full_order FROM dispatch_global_order_groups WHERE active AND lower(group_ref) IN (SELECT ref FROM refs)
  ) SELECT ref,'MBT_TRANSPORT_ALREADY_CLAIMED' AS code FROM refs JOIN mbt_transport_sources s ON s.source_key=refs.ref WHERE s.claimed
    UNION SELECT ref,'MBT_TRANSPORT_BIN_REQUIRED' FROM orders WHERE mbt_bin_only_source(full_order)
    UNION SELECT lower(c.ref_number),'MBT_TRANSPORT_BIN_REQUIRED' FROM dispatch_custom_orders c
      WHERE c.mbt_source='frontdesk_aggregate' AND lower(c.ref_number) IN (SELECT ref FROM refs)
    UNION SELECT lower(so.tranid),'MBT_TRANSPORT_BIN_REQUIRED' FROM sales_orders so JOIN sales_order_lines l ON l.sales_order_id=so.netsuite_id
      JOIN mbt_aggregate_routing_items r ON r.item_id=l.item_id AND r.bin_only WHERE lower(so.tranid) IN (SELECT ref FROM refs)
    ORDER BY code LIMIT 1`,[refs]);
  const conflict=rows[0];
  if (conflict) {throw transportError(conflict.code==='MBT_TRANSPORT_ALREADY_CLAIMED'
    ? `${conflict.ref} is already assigned to BIN transport. Manage its trips in MBT Planning.`
    : `${conflict.ref} contains loose aggregate and must be planned with a BIN in MBR/Agg.`,conflict.code);}
}
