import { query } from './db.js';
import { completedCoArrivalSql } from './co-source-packing-handoff.js';
import { outboundYardLocationId } from './outbound-location-domain.js';

function safeAlias(alias) {
  if (!/^[a-z_][a-z0-9_]*$/iu.test(alias)) {throw new TypeError('Invalid CO routing SQL alias.');}
  return alias;
}

/** The open COs that can route an order, read once per query. Every query using
 * operatorCoRouteJoinSql lists this in its WITH clause. Reading CO details (TOAST) once
 * instead of once per candidate order keeps the operator delivery list fast. */
export function operatorCoCandidatesSql() {
  return `operator_co_candidates AS MATERIALIZED (
    SELECT co.id, co.co_ref, co.source_order_ref, co.details->'childOrderIds' AS child_order_ids,
      co.from_location_id, lower(btrim(split_part(co.from_location,':',1))) AS from_location_key,
      co.to_location_id, co.to_location, co.received_at, co.created_at,
      jsonb_build_object('driverCompletionJobId', co.details->'driverCompletionJobId',
        'driverCompletionRecordId', co.details->'driverCompletionRecordId') AS details
    FROM local_co_orders co
    WHERE co.status <> 'cancelled'
  )`;
}

export function operatorCoRouteJoinSql(orderAlias) {
  const order = safeAlias(orderAlias);
  return `LEFT JOIN LATERAL (
    SELECT co.co_ref AS route_co_ref, co.to_location_id AS route_location_id,
      co.to_location AS route_location, ${completedCoArrivalSql('co')} AS route_arrived_at
    FROM operator_co_candidates co
    WHERE (co.source_order_ref=${order}.tranid OR co.child_order_ids ? ${order}.tranid)
      AND (co.from_location_id=${order}.outbound_location_id
        OR co.from_location_key=lower(btrim(split_part(${order}.outbound_location,':',1))))
    ORDER BY co.created_at DESC, co.id DESC LIMIT 1
  ) operator_co_route ON true`;
}

export function operatorCoYardColumnsSql(orderAlias) {
  const order = safeAlias(orderAlias);
  return `COALESCE(operator_co_route.route_location_id,${order}.outbound_location_id) AS outbound_location_id,
    COALESCE(operator_co_route.route_location,${order}.outbound_location) AS outbound_location`;
}

export async function routeOperatorSalesOrders(orders = []) {
  const ids = orders.filter(order => order.order_type === 'sales_order' && !order.is_dispatch_group)
    .map(order => order.netsuite_id);
  if (!ids.length) {return orders;}
  const routes = (await query(`WITH ${operatorCoCandidatesSql()}
    SELECT source.netsuite_id, ${operatorCoYardColumnsSql('source')},
    source.outbound_location_id AS route_source_location_id,
    operator_co_route.route_co_ref, operator_co_route.route_arrived_at
    FROM sales_orders source ${operatorCoRouteJoinSql('source')}
    WHERE source.netsuite_id=ANY($1::bigint[])`, [ids])).rows;
  const byId = new Map(routes.map(route => [String(route.netsuite_id), route]));
  return orders.map(order => {
    const route = byId.get(String(order.netsuite_id));
    return !route?.route_co_ref ? order : { ...order,
      outbound_location_id: route.outbound_location_id, outbound_location: route.outbound_location,
      transit_co_ref: route.route_co_ref, co_waiting_for_arrival: !route.route_arrived_at,
      ...(order.lines ? { lines: order.lines.map(line =>
        outboundYardLocationId(line.location_id ?? route.route_source_location_id) === outboundYardLocationId(route.route_source_location_id)
          ? { ...line, co_original_location_id: line.location_id, location_id: route.outbound_location_id, location: route.outbound_location }
          : line) } : {}) };
  });
}
