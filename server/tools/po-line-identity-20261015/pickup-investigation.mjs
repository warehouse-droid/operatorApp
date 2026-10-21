import { query, withTransaction, closeDb } from "./src/db.js";
import { dispatchRequiredPickupVisitLocations } from "./src/dispatch-pickup-visits.js";
import { dispatchRequiredPickupLocations } from "./src/dispatch-load-assignment.js";

const refs = ["GOA-9948-9949-9998", "SOA09948", "SOA09949", "SOA09998"];
const fields = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
function orderShape(order = {}) {
  return {
    ...fields(order, ["id", "type", "sourceYard", "outboundLocation", "pickupLocations", "transitCo", "childOrders",
      "dependencyDirectPickup", "dependencyWaitingForTransfer", "dependencyUncovered", "dependencyUncoveredQuantity"]),
    pickupOverride: /3445/.test(String(order.pickupAddressOverride || "")) ? "3445" : order.pickupAddressOverride ? "other" : "",
    required: dispatchRequiredPickupVisitLocations(order, { orders: [order] }),
    requiredByCargo: dispatchRequiredPickupLocations({ orders: [order] }, order),
    items: (order.items || []).map(item => fields(item, ["id", "lineRowId", "lineId", "itemId", "sku", "description", "unit", "quantity",
      "pallets", "layers", "sections", "pieces", "poAllocatedPallets", "poAllocatedLayers", "poAllocatedSections", "poAllocatedPieces", "poAllocatedSalesQty",
      "dependencyAllocatedQuantity", "dispatchServiceFee"])),
    poPickupManifest: (order.poPickupManifest || []).map(entry => ({ ...fields(entry, ["poOrderRef", "location"]),
      items: entry.items || [] })),
    directPickupManifest: (order.directPickupManifest || []).map(entry => ({ ...fields(entry, ["dependencyId", "transferOrderRef", "location"]),
      items: entry.items || [] })),
    childOrderDetails: (order.childOrderDetails || []).map(orderShape)
  };
}
try {
  const evidence = await withTransaction(async () => {
    await query("SET TRANSACTION READ ONLY");
    await query("SET LOCAL statement_timeout='20s'");
    const history = (await query(`SELECT h.id,h.revision,h.archived_at,h.archive_reason,
      (SELECT jsonb_agg(entry) FROM jsonb_array_elements(h.orders) entry WHERE entry->>'id'=ANY($1::text[])) AS orders,
      (SELECT jsonb_agg(load || jsonb_build_object('truckId',truck->>'id'))
        FROM jsonb_array_elements(h.trucks) truck
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(truck->'loads','[]'::jsonb)) load
        WHERE load->>'id'=$2) AS loads
      FROM dispatch_plan_snapshot_history h WHERE h.plan_id=359
        AND (h.id=ANY($3::bigint[]) OR h.archived_at BETWEEN '2026-10-14T21:49:00Z' AND '2026-10-14T22:03:00Z')
      ORDER BY h.id LIMIT 80`, [refs, "T4-L1792010089382-f5c487c3143cc8", [19701,19703,19704]])).rows;
    const groups = (await query(`SELECT group_ref,active,updated_at,full_order FROM dispatch_global_order_groups
      WHERE group_ref=$1`, [refs[0]])).rows;
    const canonical = (await query(`SELECT tranid,outbound_location_id,outbound_location
      FROM sales_orders WHERE tranid=ANY($1::text[])`, [refs.slice(1)])).rows;
    return { readOnly: true, history: history.map(row => ({ ...row, orders: (row.orders || []).map(orderShape),
      loads: (row.loads || []).map(load => ({ ...fields(load, ["id", "truckId", "pickupVisitSchemaVersion"]),
        stops: (load.stops || []).map(stop => fields(stop, ["id", "type", "orderId", "orderRefs", "location"])) })) })),
    groups: groups.map(row => ({ ...fields(row, ["group_ref", "active", "updated_at"]), order: orderShape(row.full_order) })),
    canonical: canonical.map(row => fields(row, ["tranid", "outbound_location_id", "outbound_location", "pickup_address_override"])) };
  });
  console.log(JSON.stringify(evidence));
} finally {
  await closeDb();
}
