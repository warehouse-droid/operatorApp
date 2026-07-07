import { pool, query } from "./db.js";
import { enrichPurchaseOrderDispatch, enrichSalesOrderDispatch, enrichTransferDispatch } from "./dispatch-enrichment.js";

function toNumber(value) {
  return Number(value || 0) || 0;
}

const CUSTOMER_PICKUP_DELIVERY_METHOD = "Pick-Up";

function dispatchItemHasConversion(item) {
  return toNumber(item.toPlt) > 0 || toNumber(item.toLyr) > 0 || toNumber(item.toSec) > 0 || toNumber(item.toPcs) > 0;
}

function deriveDispatchUnitsFromSalesQty(item, salesQty) {
  if (!dispatchItemHasConversion(item)) return item;
  let remaining = Math.max(toNumber(salesQty), 0);
  const next = { ...item, pallets: 0, layers: 0, sections: 0, pieces: 0, quantity: remaining };
  const conversions = [
    ["pallets", "toPlt"],
    ["layers", "toLyr"],
    ["sections", "toSec"],
    ["pieces", "toPcs"]
  ];
  for (const [qtyField, conversionField] of conversions) {
    const conversion = toNumber(item[conversionField]);
    if (!conversion || remaining <= 0) continue;
    const units = Math.floor((remaining / conversion) + 0.000001);
    next[qtyField] = units;
    remaining = Math.round((remaining - (units * conversion)) * 1000000) / 1000000;
  }
  return next;
}

function normalizeDispatchItems(items = []) {
  return (items || []).map((item) => {
    if (toNumber(item.netsuiteReceivedQty) <= 0) return item;
    return deriveDispatchUnitsFromSalesQty(item, item.quantity);
  });
}

function dateOnly(value) {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value);
  return text.includes("T") ? text.slice(0, 10) : text;
}

function rowToDispatchOrder(row) {
  const totalPallets = toNumber(row.total_pallet_qty);
  const totalLayers = toNumber(row.total_layer_qty);
  const fallbackQty = toNumber(row.total_quantity);
  const allocationPickups = Array.isArray(row.allocation_pickup_locations)
    ? row.allocation_pickup_locations.filter(Boolean)
    : [];
  const basePickup = row.pickup_location ? [row.pickup_location] : [];
  const pickupLocations = row.transit_co_to_yard
    ? [row.transit_co_to_yard]
    : [...new Set([...basePickup, ...allocationPickups])];
  const address = row.dispatch_type === "PO"
    ? row.dispatch_address || row.source_address || row.drop_address || ""
    : row.drop_address || row.dispatch_address || "";
  const transitCo = row.transit_co_ref ? {
    id: row.transit_co_ref,
    fromYard: row.transit_co_from_yard || row.pickup_location || "",
    toYard: row.transit_co_to_yard || "",
    source: "local-db"
  } : null;
  return {
    id: row.tranid,
    netsuiteId: row.netsuite_id,
    type: row.dispatch_type,
    sourceTable: row.source_table,
    customer: row.party || "",
    address,
    sourceYard: row.pickup_location || "",
    sourceAddress: row.source_address || "",
    destinationAddress: row.drop_address || "",
    expectedDeliveryDate: dateOnly(row.expected_delivery_date),
    windowStart: row.dispatch_window_start || "",
    windowEnd: row.dispatch_window_end || "",
    instructions: row.dispatch_instructions || "",
    notes: row.dispatch_instructions || "",
    vendorYard: row.dispatch_vendor_yard || "",
    parseSource: row.dispatch_parse_source || "",
    pickupLocations,
    transitOriginalPickupLocations: transitCo?.fromYard ? [transitCo.fromYard] : [],
    transitCo,
    destinationYard: row.destination_location || "",
    pallets: totalPallets || Math.floor(fallbackQty / 100),
    layers: totalLayers,
    salesQty: fallbackQty,
    packed: {
      pallets: toNumber(row.total_packed_pallet_qty),
      layers: toNumber(row.total_packed_layer_qty),
      sections: toNumber(row.total_packed_section_qty),
      pieces: toNumber(row.total_packed_piece_qty)
    },
    weight: Math.round(toNumber(row.total_weight_lbs) * 1000) / 1000,
    items: normalizeDispatchItems(row.items || []),
    raw: row,
    netsuiteStatus: row.status || "",
    netsuiteStatusText: row.status_text || "",
    fulfillmentStatus: row.fulfillment_status || "",
    netsuiteActive: row.netsuite_active !== false,
    operatorStatus: row.operator_status || "",
    localYardOrderStatus: row.local_yard_order_status || "Open",
    dispatchPlanned: Boolean(row.dispatch_planned),
    dispatchPlanDate: dateOnly(row.dispatch_plan_date),
    dispatchTruckPlate: row.dispatch_truck_plate || "",
    dispatchLoadName: row.dispatch_load_name || "",
    dispatchParkingSpot: row.dispatch_parking_spot || ""
  };
}

function locationIdFromText(value) {
  const text = String(value || "").trim();
  if (text === "3445") return 1;
  if (text === "2967") return 28;
  if (text === "12441") return 15;
  if (text === "150") return 26;
  return null;
}

function locationTextFromId(value) {
  const text = String(value || "").trim();
  if (text === "1") return "3445";
  if (text === "13" || text === "28") return "2967";
  if (text === "15") return "12441";
  if (text === "26") return "150";
  return String(value || "").trim();
}

function yardAddressSql(field) {
  return `CASE
    WHEN ${field} = '3445' THEN '3445 Kennedy Road, Toronto, ON'
    WHEN ${field} = '2967' THEN '2967 Kennedy Road, Toronto, ON'
    WHEN ${field} = '12441' THEN '12441 Woodbine Avenue, Whitchurch-Stouffville, ON'
    ELSE ''
  END`;
}

export async function listDispatchOrders({ type = null } = {}) {
  const params = [];
  const typeClause = type ? `WHERE dispatch_type = $1` : "";
  if (type) params.push(type);
  const result = await query(
    `
    WITH so_alloc AS (
      SELECT sales_line_id,
             SUM(allocated_pallet_qty) AS allocated_pallet_qty,
             SUM(allocated_layer_qty) AS allocated_layer_qty,
             SUM(allocated_section_qty) AS allocated_section_qty,
             SUM(allocated_piece_qty) AS allocated_piece_qty,
             SUM(allocated_sales_qty) AS allocated_sales_qty
        FROM dispatch_so_po_allocations
       WHERE status = 'active'
       GROUP BY sales_line_id
    ),
    po_alloc AS (
      SELECT po_line_id,
             SUM(allocated_pallet_qty) AS allocated_pallet_qty,
             SUM(allocated_layer_qty) AS allocated_layer_qty,
             SUM(allocated_section_qty) AS allocated_section_qty,
             SUM(allocated_piece_qty) AS allocated_piece_qty,
             SUM(allocated_sales_qty) AS allocated_sales_qty
        FROM dispatch_so_po_allocations
       WHERE status = 'active'
       GROUP BY po_line_id
    ),
    delivery_order_source AS (
      SELECT
        netsuite_id,
        tranid,
        'sales_order'::text AS order_type,
        customer,
        NULL::text AS destination_location,
        expected_delivery_date,
        outbound_location,
        NULL::text AS source_location,
        NULL::bigint AS destination_location_id,
        dispatch_address,
        dispatch_window_start,
        dispatch_window_end,
        dispatch_instructions,
        dispatch_parse_source,
        operator_status,
        local_yard_order_status,
        dispatch_planned,
        dispatch_plan_date,
        dispatch_truck_plate,
        dispatch_load_name,
        dispatch_parking_spot,
        fulfillment_status,
        status,
        status_text,
        netsuite_active
      FROM sales_orders
      WHERE sales_order_type <> '${CUSTOMER_PICKUP_DELIVERY_METHOD.replaceAll("'", "''")}'
      UNION ALL
      SELECT
        netsuite_id,
        tranid,
        'transfer_order'::text AS order_type,
        NULL::text AS customer,
        to_location AS destination_location,
        expected_delivery_date,
        from_location AS outbound_location,
        from_location AS source_location,
        to_location_id AS destination_location_id,
        dispatch_address,
        dispatch_window_start,
        dispatch_window_end,
        dispatch_instructions,
        dispatch_parse_source,
        outbound_operator_status AS operator_status,
        local_yard_order_status,
        dispatch_planned,
        dispatch_plan_date,
        dispatch_truck_plate,
        dispatch_load_name,
        dispatch_parking_spot,
        fulfillment_status,
        status,
        status_text,
        netsuite_active
      FROM transfer_orders
      WHERE from_location_id IS NOT NULL
    ),
    delivery_line_source AS (
      SELECT
        sales_order_id AS order_id,
        id,
        line_id,
        item_id,
        item_name,
        sku,
        item_description,
        quantity,
        unit,
        item_weight,
        pallet_qty,
        layer_qty,
        section_qty,
        piece_qty,
        packed_pallet_qty,
        packed_layer_qty,
        packed_section_qty,
        packed_piece_qty,
        to_plt,
        to_lyr,
        to_sec,
        to_pcs,
        netsuite_active
      FROM sales_order_lines
      UNION ALL
      SELECT
        transfer_order_id AS order_id,
        id,
        line_id,
        item_id,
        item_name,
        sku,
        item_description,
        quantity,
        unit,
        item_weight,
        pallet_qty,
        layer_qty,
        section_qty,
        piece_qty,
        packed_pallet_qty,
        packed_layer_qty,
        packed_section_qty,
        packed_piece_qty,
        to_plt,
        to_lyr,
        to_sec,
        to_pcs,
        netsuite_active
      FROM transfer_order_lines
      WHERE line_stage = 'outbound'
    ),
    receiving_order_source AS (
      SELECT
        netsuite_id,
        tranid,
        'purchase_order'::text AS order_type,
        vendor,
        source_location,
        destination_location,
        expected_delivery_date,
        dispatch_vendor_yard,
        dispatch_address,
        dispatch_window_start,
        dispatch_window_end,
        dispatch_instructions,
        dispatch_parse_source,
        NULL::date AS dispatch_plan_date,
        NULL::text AS dispatch_truck_plate,
        NULL::text AS dispatch_load_name,
        NULL::text AS dispatch_parking_spot,
        status_text,
        netsuite_active
      FROM purchase_orders
      UNION ALL
      SELECT
        netsuite_id,
        tranid,
        'transfer_order'::text AS order_type,
        NULL::text AS vendor,
        from_location AS source_location,
        to_location AS destination_location,
        expected_delivery_date,
        NULL::text AS dispatch_vendor_yard,
        dispatch_address,
        dispatch_window_start,
        dispatch_window_end,
        dispatch_instructions,
        dispatch_parse_source,
        dispatch_plan_date,
        dispatch_truck_plate,
        dispatch_load_name,
        dispatch_parking_spot,
        status_text,
        netsuite_active
      FROM transfer_orders
      WHERE to_location_id IS NOT NULL
    ),
    receiving_line_source AS (
      SELECT
        purchase_order_id AS order_id,
        id,
        line_id,
        item_id,
        item_name,
        sku,
        item_description,
        quantity,
        unit,
        item_weight,
        pallet_qty,
        layer_qty,
        section_qty,
        piece_qty,
        netsuite_received_qty,
        to_plt,
        to_lyr,
        to_sec,
        to_pcs,
        netsuite_active
      FROM purchase_order_lines
      UNION ALL
      SELECT
        transfer_order_id AS order_id,
        id,
        line_id,
        item_id,
        item_name,
        sku,
        item_description,
        quantity,
        unit,
        item_weight,
        pallet_qty,
        layer_qty,
        section_qty,
        piece_qty,
        netsuite_received_qty,
        to_plt,
        to_lyr,
        to_sec,
        to_pcs,
        netsuite_active
      FROM transfer_order_lines
      WHERE line_stage = 'receiving'
    ),
    so_alloc_pickups AS (
      SELECT a.sales_order_id,
             jsonb_agg(DISTINCT COALESCE(NULLIF(po.dispatch_vendor_yard, ''), NULLIF(po.source_location, ''), NULLIF(po.vendor, ''))) FILTER (
               WHERE COALESCE(NULLIF(po.dispatch_vendor_yard, ''), NULLIF(po.source_location, ''), NULLIF(po.vendor, '')) IS NOT NULL
             ) AS pickup_locations
        FROM dispatch_so_po_allocations a
        JOIN purchase_orders po ON po.netsuite_id = a.po_order_id
       WHERE a.status = 'active'
       GROUP BY a.sales_order_id
    ),
    delivery AS (
      SELECT
        o.netsuite_id,
        o.tranid,
        CASE WHEN o.order_type = 'transfer_order' THEN 'TO' ELSE 'SO' END AS dispatch_type,
        CASE WHEN o.order_type = 'transfer_order' THEN 'transfer_orders' ELSE 'sales_orders' END AS source_table,
        COALESCE(o.customer, o.destination_location, '') AS party,
        o.expected_delivery_date,
        o.outbound_location AS pickup_location,
        NULL::text AS source_address,
        o.destination_location,
        CASE
          WHEN o.order_type = 'transfer_order' THEN ${yardAddressSql("o.destination_location")}
          ELSE o.dispatch_address
        END AS drop_address,
        o.dispatch_address,
        o.dispatch_window_start,
        o.dispatch_window_end,
        o.dispatch_instructions,
        NULL::text AS dispatch_vendor_yard,
        o.dispatch_parse_source,
        co.co_ref AS transit_co_ref,
        co.from_location AS transit_co_from_yard,
        co.to_location AS transit_co_to_yard,
        COALESCE(ap.pickup_locations, '[]'::jsonb) AS allocation_pickup_locations,
        o.operator_status,
        o.local_yard_order_status,
        o.dispatch_planned,
        o.dispatch_plan_date,
        o.dispatch_truck_plate,
        o.dispatch_load_name,
        o.dispatch_parking_spot,
        o.fulfillment_status,
        o.status,
        o.status_text,
        o.netsuite_active,
        COALESCE(SUM(l.pallet_qty), 0) AS total_pallet_qty,
        COALESCE(SUM(l.layer_qty), 0) AS total_layer_qty,
        COALESCE(SUM(l.quantity), 0) AS total_quantity,
        COALESCE(SUM(l.packed_pallet_qty), 0) AS total_packed_pallet_qty,
        COALESCE(SUM(l.packed_layer_qty), 0) AS total_packed_layer_qty,
        COALESCE(SUM(l.packed_section_qty), 0) AS total_packed_section_qty,
        COALESCE(SUM(l.packed_piece_qty), 0) AS total_packed_piece_qty,
        COALESCE(SUM(COALESCE(l.quantity, 0) * COALESCE(l.item_weight, 0)), 0) AS total_weight_lbs,
        jsonb_agg(jsonb_build_object(
          'lineRowId', l.id,
          'lineId', l.line_id,
          'itemId', l.item_id,
          'sku', COALESCE(l.sku, l.item_name),
          'itemName', l.item_name,
          'description', l.item_description,
          'pallets', COALESCE(l.pallet_qty, 0),
          'layers', COALESCE(l.layer_qty, 0),
          'sections', COALESCE(l.section_qty, 0),
          'pieces', COALESCE(l.piece_qty, 0),
          'quantity', COALESCE(l.quantity, 0),
          'itemWeight', COALESCE(l.item_weight, 0),
          'lineWeight', COALESCE(l.quantity, 0) * COALESCE(l.item_weight, 0),
          'netsuiteReceivedQty', 0,
          'poAllocatedPallets', COALESCE(sa.allocated_pallet_qty, 0),
          'poAllocatedLayers', COALESCE(sa.allocated_layer_qty, 0),
          'poAllocatedSections', COALESCE(sa.allocated_section_qty, 0),
          'poAllocatedPieces', COALESCE(sa.allocated_piece_qty, 0),
          'poAllocatedSalesQty', COALESCE(sa.allocated_sales_qty, 0),
          'toPlt', l.to_plt,
          'toLyr', l.to_lyr,
          'toSec', l.to_sec,
          'toPcs', l.to_pcs
        ) ORDER BY l.line_id NULLS LAST, l.id) FILTER (WHERE l.id IS NOT NULL) AS items
      FROM delivery_order_source o
      LEFT JOIN delivery_line_source l ON l.order_id = o.netsuite_id AND l.netsuite_active = true
      LEFT JOIN so_alloc sa ON sa.sales_line_id = l.id
      LEFT JOIN LATERAL (
        SELECT co_ref, from_location, to_location
          FROM co_orders
         WHERE source_order_ref = o.tranid
           AND status <> 'cancelled'
         ORDER BY updated_at DESC, id DESC
         LIMIT 1
      ) co ON true
      LEFT JOIN so_alloc_pickups ap ON ap.sales_order_id = o.netsuite_id
      WHERE (o.netsuite_active = true OR co.co_ref IS NOT NULL)
        AND (
          o.dispatch_planned = true
          OR COALESCE(o.local_yard_order_status, 'Open') IN ('Loaded', 'loaded', 'Shipped', 'shipped', 'Packed', 'packed')
          OR o.fulfillment_status IN ('fulfilled', 'partial_fulfilled', 'partially_fulfilled', 'shipped')
          OR (o.order_type = 'sales_order' AND (
            o.status = 'B'
            OR o.status_text ILIKE '%Pending Fulfillment%'
            OR o.status_text ILIKE '%Partially Fulfilled%'
            OR o.status_text ILIKE '%Pending Billing%'
            OR o.status_text ILIKE '%Billed%'
            OR o.status_text ILIKE '%Fulfilled%'
          ))
          OR (o.order_type = 'transfer_order' AND (
            o.status_text ILIKE '%Pending Fulfillment%'
            OR o.status_text ILIKE '%Partially Fulfilled%'
            OR o.status_text ILIKE '%Pending Receipt%'
            OR o.status_text ILIKE '%Partially Received%'
            OR o.status_text ILIKE '%Received%'
          ))
        )
      GROUP BY o.netsuite_id, o.tranid, o.order_type, o.customer, o.destination_location,
               o.expected_delivery_date, o.outbound_location, o.dispatch_address,
               o.dispatch_window_start, o.dispatch_window_end, o.dispatch_instructions,
               o.dispatch_parse_source, o.operator_status, o.local_yard_order_status,
               o.dispatch_planned, o.dispatch_plan_date, o.dispatch_truck_plate,
               o.dispatch_load_name, o.dispatch_parking_spot, o.fulfillment_status, o.status, o.status_text,
               o.netsuite_active, co.co_ref, co.from_location, co.to_location, ap.pickup_locations
      HAVING o.dispatch_planned = true OR COUNT(l.id) > 0
    ),
    receiving AS (
      SELECT
        o.netsuite_id,
        o.tranid,
        CASE WHEN o.order_type = 'transfer_order' THEN 'TO' ELSE 'PO' END AS dispatch_type,
        CASE WHEN o.order_type = 'transfer_order' THEN 'transfer_orders' ELSE 'purchase_orders' END AS source_table,
        COALESCE(o.vendor, o.source_location, '') AS party,
        o.expected_delivery_date,
        COALESCE(NULLIF(o.dispatch_vendor_yard, ''), NULLIF(o.source_location, ''), NULLIF(o.vendor, '')) AS pickup_location,
        NULLIF(o.dispatch_address, '') AS source_address,
        o.destination_location,
        ${yardAddressSql("o.destination_location")} AS drop_address,
        o.dispatch_address,
        o.dispatch_window_start,
        o.dispatch_window_end,
        o.dispatch_instructions,
        o.dispatch_vendor_yard,
        o.dispatch_parse_source,
        NULL::text AS transit_co_ref,
        NULL::text AS transit_co_from_yard,
        NULL::text AS transit_co_to_yard,
        '[]'::jsonb AS allocation_pickup_locations,
        NULL::text AS operator_status,
        'Open'::text AS local_yard_order_status,
        false AS dispatch_planned,
        o.dispatch_plan_date,
        o.dispatch_truck_plate,
        o.dispatch_load_name,
        o.dispatch_parking_spot,
        NULL::text AS fulfillment_status,
        NULL::text AS status,
        o.status_text,
        o.netsuite_active,
        COALESCE(SUM(GREATEST(COALESCE(l.pallet_qty, 0) - COALESCE(pa.allocated_pallet_qty, 0), 0)), 0) AS total_pallet_qty,
        COALESCE(SUM(GREATEST(COALESCE(l.layer_qty, 0) - COALESCE(pa.allocated_layer_qty, 0), 0)), 0) AS total_layer_qty,
        COALESCE(SUM(GREATEST(COALESCE(l.quantity, 0) - COALESCE(l.netsuite_received_qty, 0) - COALESCE(pa.allocated_sales_qty, 0), 0)), 0) AS total_quantity,
        0::numeric AS total_packed_pallet_qty,
        0::numeric AS total_packed_layer_qty,
        0::numeric AS total_packed_section_qty,
        0::numeric AS total_packed_piece_qty,
        COALESCE(SUM(
          GREATEST(COALESCE(l.quantity, 0) - COALESCE(l.netsuite_received_qty, 0) - COALESCE(pa.allocated_sales_qty, 0), 0)
          * COALESCE(l.item_weight, 0)
        ), 0) AS total_weight_lbs,
        jsonb_agg(jsonb_build_object(
          'lineRowId', l.id,
          'lineId', l.line_id,
          'itemId', l.item_id,
          'sku', COALESCE(l.sku, l.item_name),
          'itemName', l.item_name,
          'description', l.item_description,
          'pallets', GREATEST(COALESCE(l.pallet_qty, 0) - COALESCE(pa.allocated_pallet_qty, 0), 0),
          'layers', GREATEST(COALESCE(l.layer_qty, 0) - COALESCE(pa.allocated_layer_qty, 0), 0),
          'sections', GREATEST(COALESCE(l.section_qty, 0) - COALESCE(pa.allocated_section_qty, 0), 0),
          'pieces', GREATEST(COALESCE(l.piece_qty, 0) - COALESCE(pa.allocated_piece_qty, 0), 0),
          'quantity', GREATEST(COALESCE(l.quantity, 0) - COALESCE(l.netsuite_received_qty, 0) - COALESCE(pa.allocated_sales_qty, 0), 0),
          'itemWeight', COALESCE(l.item_weight, 0),
          'lineWeight', GREATEST(COALESCE(l.quantity, 0) - COALESCE(l.netsuite_received_qty, 0) - COALESCE(pa.allocated_sales_qty, 0), 0) * COALESCE(l.item_weight, 0),
          'netsuiteReceivedQty', COALESCE(l.netsuite_received_qty, 0),
          'poAllocatedPallets', COALESCE(pa.allocated_pallet_qty, 0),
          'poAllocatedLayers', COALESCE(pa.allocated_layer_qty, 0),
          'poAllocatedSections', COALESCE(pa.allocated_section_qty, 0),
          'poAllocatedPieces', COALESCE(pa.allocated_piece_qty, 0),
          'poAllocatedSalesQty', COALESCE(pa.allocated_sales_qty, 0),
          'toPlt', l.to_plt,
          'toLyr', l.to_lyr,
          'toSec', l.to_sec,
          'toPcs', l.to_pcs
        ) ORDER BY l.line_id NULLS LAST, l.id) FILTER (WHERE l.id IS NOT NULL) AS items
      FROM receiving_order_source o
      LEFT JOIN receiving_line_source l ON l.order_id = o.netsuite_id AND l.netsuite_active = true
      LEFT JOIN po_alloc pa ON pa.po_line_id = l.id
      WHERE o.netsuite_active = true
        AND (
          o.status_text ILIKE '%Pending Receipt%'
          OR o.status_text ILIKE '%Partially Received%'
          OR o.status_text ILIKE '%Received%'
          OR o.status_text ILIKE '%Pending Billing%'
          OR o.status_text ILIKE '%Billed%'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM transfer_orders d
          WHERE d.netsuite_id = o.netsuite_id
            AND d.netsuite_active = true
            AND d.fulfillment_status <> 'fulfilled'
        )
      GROUP BY o.netsuite_id, o.tranid, o.order_type, o.vendor, o.source_location,
               o.destination_location, o.expected_delivery_date, o.dispatch_vendor_yard,
               o.dispatch_address, o.dispatch_window_start, o.dispatch_window_end,
               o.dispatch_instructions, o.dispatch_parse_source, o.dispatch_plan_date,
               o.dispatch_truck_plate, o.dispatch_load_name, o.dispatch_parking_spot,
               o.status_text, o.netsuite_active
      HAVING o.dispatch_plan_date IS NOT NULL
          OR COALESCE(SUM(GREATEST(COALESCE(l.quantity, 0) - COALESCE(l.netsuite_received_qty, 0) - COALESCE(pa.allocated_sales_qty, 0), 0)), 0) > 0.000001
    ),
    local_co AS (
      SELECT
        co.delivery_order_id AS netsuite_id,
        co.co_ref AS tranid,
        'CO' AS dispatch_type,
        'local_co_orders' AS source_table,
        COALESCE(co.details->>'customer', 'Transit Depot') AS party,
        co.dispatch_plan_date AS expected_delivery_date,
        co.from_location AS pickup_location,
        ${yardAddressSql("co.from_location")} AS source_address,
        co.to_location AS destination_location,
        ${yardAddressSql("co.to_location")} AS drop_address,
        ${yardAddressSql("co.to_location")} AS dispatch_address,
        ''::text AS dispatch_window_start,
        ''::text AS dispatch_window_end,
        COALESCE(co.details->>'notes', 'Local transit depot order') AS dispatch_instructions,
        NULL::text AS dispatch_vendor_yard,
        'local-co'::text AS dispatch_parse_source,
        NULL::text AS transit_co_ref,
        NULL::text AS transit_co_from_yard,
        NULL::text AS transit_co_to_yard,
        '[]'::jsonb AS allocation_pickup_locations,
        NULL::text AS operator_status,
        COALESCE(co.status, 'planned') AS local_yard_order_status,
        (co.dispatch_plan_id IS NOT NULL OR co.dispatch_plan_date IS NOT NULL) AS dispatch_planned,
        co.dispatch_plan_date,
        co.dispatch_truck_plate,
        co.dispatch_load_name,
        co.dispatch_parking_spot,
        NULL::text AS fulfillment_status,
        co.status AS status,
        co.status AS status_text,
        true AS netsuite_active,
        COALESCE(SUM(l.pallet_qty), 0) AS total_pallet_qty,
        COALESCE(SUM(l.layer_qty), 0) AS total_layer_qty,
        COALESCE(SUM(l.quantity), 0) AS total_quantity,
        0::numeric AS total_packed_pallet_qty,
        0::numeric AS total_packed_layer_qty,
        0::numeric AS total_packed_section_qty,
        0::numeric AS total_packed_piece_qty,
        COALESCE(SUM(COALESCE(l.quantity, 0) * COALESCE(l.item_weight, 0)), 0) AS total_weight_lbs,
        jsonb_agg(jsonb_build_object(
          'sku', COALESCE(l.sku, l.item_name),
          'itemName', l.item_name,
          'description', l.item_description,
          'pallets', COALESCE(l.pallet_qty, 0),
          'layers', COALESCE(l.layer_qty, 0),
          'sections', COALESCE(l.section_qty, 0),
          'pieces', COALESCE(l.piece_qty, 0),
          'quantity', COALESCE(l.quantity, 0),
          'itemWeight', COALESCE(l.item_weight, 0),
          'lineWeight', COALESCE(l.quantity, 0) * COALESCE(l.item_weight, 0)
        ) ORDER BY l.line_id NULLS LAST, l.id) FILTER (WHERE l.id IS NOT NULL) AS items
      FROM co_orders co
      LEFT JOIN co_order_lines l ON l.co_id = co.id
      WHERE co.status IN ('pending_load', 'planned', 'received')
      GROUP BY co.id
    )
    SELECT * FROM (
      SELECT * FROM delivery
      UNION ALL
      SELECT * FROM receiving
      UNION ALL
      SELECT * FROM local_co
    ) orders
    ${typeClause}
    ORDER BY dispatch_window_start NULLS LAST, tranid DESC
    LIMIT 500
    `,
    params
  );
  return result.rows.map(rowToDispatchOrder);
}

export async function refreshDispatchEnrichment({ force = false, delivery: includeDelivery = true, receiving: includeReceiving = true } = {}) {
  let deliveryCount = 0;
  if (includeDelivery) {
    const delivery = await query(
      `SELECT netsuite_id, 'sales_order'::text AS order_type, memo,
              expected_delivery_date,
              outbound_location_id, outbound_location,
              NULL::bigint AS destination_location_id, NULL::text AS destination_location,
              NULL::bigint AS source_location_id, NULL::text AS source_location
         FROM sales_orders
        WHERE netsuite_active = true
          AND ($1::boolean OR dispatch_note_hash IS NULL OR dispatch_parse_source IS NULL)
       UNION ALL
       SELECT netsuite_id, 'transfer_order'::text AS order_type, memo,
              expected_delivery_date,
              from_location_id AS outbound_location_id, from_location AS outbound_location,
              to_location_id AS destination_location_id, to_location AS destination_location,
              from_location_id AS source_location_id, from_location AS source_location
         FROM transfer_orders
        WHERE netsuite_active = true
          AND from_location_id IS NOT NULL
          AND ($1::boolean OR dispatch_note_hash IS NULL OR dispatch_parse_source IS NULL)`,
      [force]
    );
    for (const row of delivery.rows) {
      const dispatch = row.order_type === "transfer_order"
        ? enrichTransferDispatch(row)
        : await enrichSalesOrderDispatch(row);
      await query(
        `UPDATE ${row.order_type === "transfer_order" ? "transfer_orders" : "sales_orders"}
            SET dispatch_address = $2,
                dispatch_window_start = $3,
                dispatch_window_end = $4,
                dispatch_instructions = $5,
                dispatch_parse_source = $6,
                dispatch_note_hash = $7,
                expected_delivery_date = CASE
                  WHEN expected_delivery_date IS NOT NULL THEN expected_delivery_date
                  WHEN $8::date IS NULL THEN expected_delivery_date
                  ELSE $8::date
                END,
                dispatch_parsed_at = now()
          WHERE netsuite_id = $1`,
        [
          row.netsuite_id,
          dispatch.dispatch_address,
          dispatch.dispatch_window_start,
          dispatch.dispatch_window_end,
          dispatch.dispatch_instructions,
          dispatch.dispatch_parse_source,
          dispatch.dispatch_note_hash,
          dispatch.expected_delivery_date || null
        ]
      );
      deliveryCount += 1;
    }
  }

  let receivingCount = 0;
  if (includeReceiving) {
    const receiving = await query(
      `SELECT netsuite_id, 'purchase_order'::text AS order_type, memo, vendor,
              source_location_id, source_location, destination_location_id, destination_location, tranid
         FROM purchase_orders
        WHERE netsuite_active = true
          AND ($1::boolean OR dispatch_note_hash IS NULL OR dispatch_parse_source IS NULL)
       UNION ALL
       SELECT netsuite_id, 'transfer_order'::text AS order_type, memo, NULL::text AS vendor,
              from_location_id AS source_location_id, from_location AS source_location,
              to_location_id AS destination_location_id, to_location AS destination_location, tranid
         FROM transfer_orders
        WHERE netsuite_active = true
          AND to_location_id IS NOT NULL
          AND ($1::boolean OR dispatch_note_hash IS NULL OR dispatch_parse_source IS NULL)`,
      [force]
    );
    for (const row of receiving.rows) {
      const dispatch = row.order_type === "transfer_order"
        ? enrichTransferDispatch(row)
        : await enrichPurchaseOrderDispatch(row);
      if (row.order_type === "transfer_order") {
        await query(
          `UPDATE transfer_orders
              SET dispatch_address = $2,
                  dispatch_window_start = $3,
                  dispatch_window_end = $4,
                  dispatch_instructions = $5,
                  dispatch_parse_source = $6,
                  dispatch_note_hash = $7,
                  dispatch_parsed_at = now()
            WHERE netsuite_id = $1`,
          [
            row.netsuite_id,
            dispatch.dispatch_address,
            dispatch.dispatch_window_start,
            dispatch.dispatch_window_end,
            dispatch.dispatch_instructions,
            dispatch.dispatch_parse_source,
            dispatch.dispatch_note_hash
          ]
        );
      } else {
        await query(
          `UPDATE purchase_orders
              SET dispatch_address = $2,
                  dispatch_window_start = $3,
                  dispatch_window_end = $4,
                  dispatch_instructions = $5,
                  dispatch_vendor_yard = $6,
                  dispatch_parse_source = $7,
                  dispatch_note_hash = $8,
                  dispatch_parsed_at = now()
            WHERE netsuite_id = $1`,
          [
            row.netsuite_id,
            dispatch.dispatch_address,
            dispatch.dispatch_window_start,
            dispatch.dispatch_window_end,
            dispatch.dispatch_instructions,
            dispatch.dispatch_vendor_yard,
            dispatch.dispatch_parse_source,
            dispatch.dispatch_note_hash
          ]
        );
      }
      receivingCount += 1;
    }
  }
  return { delivery: deliveryCount, receiving: receivingCount };
}

export async function reparseMissingSalesOrderDispatch({ limit = 200, dryRun = false, scope = "missing" } = {}) {
  const cleanLimit = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  const allNonShipped = scope === "non_shipped";
  const result = await query(
    `SELECT netsuite_id, tranid, memo, sales_order_type AS delivery_method, delivery_method_id,
            outbound_location_id, outbound_location,
            dispatch_address, dispatch_window_start, dispatch_window_end,
            dispatch_instructions, dispatch_parse_source, expected_delivery_date
       FROM sales_orders
      WHERE netsuite_active = true
        AND COALESCE(status_text, '') NOT ILIKE '%pending approval%'
        AND (
          delivery_method_id::text = '2'
          OR LOWER(COALESCE(sales_order_type, '')) = 'delivery'
          OR LOWER(COALESCE(sales_order_type, '')) LIKE '%delivery%'
        )
        AND LOWER(COALESCE(sales_order_type, '')) NOT LIKE '%pick%'
        AND COALESCE(local_yard_order_status, '') NOT IN ('loaded', 'shipped')
        AND COALESCE(status_text, '') NOT ILIKE '%pending billing%'
        AND COALESCE(status_text, '') NOT ILIKE '%closed%'
        AND COALESCE(status_text, '') NOT ILIKE '%cancel%'
        AND ($2::boolean OR (
          NULLIF(dispatch_address, '') IS NULL
          OR NULLIF(dispatch_window_start, '') IS NULL
          OR NULLIF(dispatch_window_end, '') IS NULL
          OR expected_delivery_date IS NULL
        ))
      ORDER BY expected_delivery_date NULLS LAST, tranid DESC
      LIMIT $1`,
    [cleanLimit, allNonShipped]
  );

  const details = [];
  let updated = 0;
  let resolvedTime = 0;
  let resolvedAddress = 0;
  let failed = 0;

  for (const row of result.rows) {
    try {
      const before = {
        address: row.dispatch_address || "",
        expectedDeliveryDate: dateOnly(row.expected_delivery_date),
        windowStart: row.dispatch_window_start || "",
        windowEnd: row.dispatch_window_end || "",
        parseSource: row.dispatch_parse_source || ""
      };
      const dispatch = await enrichSalesOrderDispatch(row);
      const after = {
        address: dispatch.dispatch_address || "",
        expectedDeliveryDate: dispatch.expected_delivery_date || before.expectedDeliveryDate,
        windowStart: dispatch.dispatch_window_start || "",
        windowEnd: dispatch.dispatch_window_end || "",
        parseSource: dispatch.dispatch_parse_source || ""
      };
      const hasTime = Boolean(after.windowStart && after.windowEnd);
      const hasAddress = Boolean(after.address);

      if (!dryRun) {
        await query(
          `UPDATE sales_orders
              SET dispatch_address = $2,
                  dispatch_window_start = $3,
                  dispatch_window_end = $4,
                  dispatch_instructions = $5,
                  dispatch_parse_source = $6,
                  dispatch_note_hash = $7,
                  expected_delivery_date = CASE
                    WHEN expected_delivery_date IS NOT NULL THEN expected_delivery_date
                    WHEN $8::date IS NULL THEN expected_delivery_date
                    ELSE $8::date
                  END,
                  dispatch_parsed_at = now()
            WHERE netsuite_id = $1`,
          [
            row.netsuite_id,
            dispatch.dispatch_address,
            dispatch.dispatch_window_start,
            dispatch.dispatch_window_end,
            dispatch.dispatch_instructions,
            dispatch.dispatch_parse_source,
            dispatch.dispatch_note_hash,
            dispatch.expected_delivery_date || null
          ]
        );
        updated += 1;
      }

      if (!before.windowStart && after.windowStart && after.windowEnd) resolvedTime += 1;
      if (!before.address && hasAddress) resolvedAddress += 1;
      details.push({
        tranid: row.tranid,
        netsuiteId: row.netsuite_id,
        before,
        after,
        resolvedTime: hasTime,
        resolvedAddress: hasAddress
      });
    } catch (error) {
      failed += 1;
      details.push({
        tranid: row.tranid,
        netsuiteId: row.netsuite_id,
        error: error.message
      });
    }
  }

  return {
    matched: result.rowCount,
    updated,
    failed,
    resolvedTime,
    resolvedAddress,
    dryRun,
    scope: allNonShipped ? "non_shipped" : "missing",
    limit: cleanLimit,
    details
  };
}

export async function setPurchaseOrderVendorYard(orderRef, vendorYardId) {
  const yard = await query(
    `SELECT id, vendor, yard, day_label, window_start, window_end, instructions, address
       FROM dispatch_vendor_yards
      WHERE id = $1 AND active = true`,
    [vendorYardId]
  );
  const selected = yard.rows[0];
  if (!selected) throw new Error("Vendor yard not found.");
  const result = await query(
    `UPDATE purchase_orders
        SET dispatch_address = $2,
            dispatch_window_start = $3,
            dispatch_window_end = $4,
            dispatch_instructions = $5,
            dispatch_vendor_yard = $6,
            dispatch_parse_source = 'manual-po-yard',
            dispatch_parsed_at = now()
      WHERE tranid = $1 OR netsuite_id::text = $1
      RETURNING netsuite_id, tranid`,
    [
      orderRef,
      selected.address || "",
      selected.window_start || "",
      selected.window_end || "",
      `${selected.day_label || ""}${selected.instructions ? ` | ${selected.instructions}` : ""}`.trim(),
      selected.yard
    ]
  );
  if (!result.rows[0]) throw new Error("Purchase order not found.");
  return result.rows[0];
}

export async function updateDispatchOrderDetails(orderRef, patch = {}) {
  const address = String(patch.address || "").trim();
  const windowStart = String(patch.windowStart || patch.window_start || "").trim();
  const windowEnd = String(patch.windowEnd || patch.window_end || "").trim();
  const expectedDate = String(patch.expectedDeliveryDate || patch.expected_delivery_date || "").trim() || null;
  const type = String(patch.type || "").toUpperCase();
  const sourceTable = String(patch.sourceTable || patch.source_table || "");
  const preferReceiving = sourceTable === "purchase_orders" || type === "PO";
  const preferDelivery = sourceTable === "sales_orders" || type === "SO";
  const preferTransfer = sourceTable === "transfer_orders" || type === "TO";
  const attempts = preferReceiving
    ? [{ table: "purchase_orders", orderType: "purchase_order" }, { table: "transfer_orders", orderType: "transfer_order" }]
    : preferTransfer
      ? [{ table: "transfer_orders", orderType: "transfer_order" }]
      : preferDelivery
        ? [{ table: "sales_orders", orderType: "sales_order" }, { table: "transfer_orders", orderType: "transfer_order" }]
        : [
            { table: "sales_orders", orderType: "sales_order" },
            { table: "purchase_orders", orderType: "purchase_order" },
            { table: "transfer_orders", orderType: "transfer_order" }
          ];

  for (const { table, orderType } of attempts) {
    const result = await query(
      `UPDATE ${table}
          SET dispatch_address = $2,
              dispatch_window_start = $3,
              dispatch_window_end = $4,
              expected_delivery_date = $5::date,
              dispatch_parse_source = 'manual-dispatch-details',
              dispatch_parsed_at = now()
        WHERE (tranid = $1 OR netsuite_id::text = $1)
        RETURNING netsuite_id, tranid, dispatch_address, dispatch_window_start,
                  dispatch_window_end, expected_delivery_date, '${table}'::text AS source_table`,
      [orderRef, address, windowStart, windowEnd, expectedDate]
    );
    if (result.rows[0]) return { ...result.rows[0], order_type: orderType };
  }

  throw new Error("Dispatch order not found.");
}

function positiveQuantity(value) {
  return Math.max(Number(value || 0) || 0, 0);
}

function hasConversion(row) {
  return positiveQuantity(row.to_plt) > 0
    || positiveQuantity(row.to_lyr) > 0
    || positiveQuantity(row.to_sec) > 0
    || positiveQuantity(row.to_pcs) > 0;
}

function hasCustomQuantity(row) {
  return positiveQuantity(row.pallet_qty) > 0
    || positiveQuantity(row.layer_qty) > 0
    || positiveQuantity(row.section_qty) > 0
    || positiveQuantity(row.piece_qty) > 0;
}

function lineSalesQty(row, qtys = {}) {
  const pallets = positiveQuantity(qtys.pallets);
  const layers = positiveQuantity(qtys.layers);
  const sections = positiveQuantity(qtys.sections);
  const pieces = positiveQuantity(qtys.pieces);
  const directSales = positiveQuantity(qtys.salesQty);
  const converted = (pallets * positiveQuantity(row.to_plt))
    + (layers * positiveQuantity(row.to_lyr))
    + (sections * positiveQuantity(row.to_sec))
    + (pieces * positiveQuantity(row.to_pcs));
  if (converted > 0) return converted;
  if (!hasConversion(row)) return directSales || pieces || sections || layers || pallets;
  return directSales;
}

function availableUnitQty(row, unit) {
  const required = positiveQuantity(row[`${unit}_qty`]);
  const allocated = positiveQuantity(row[`allocated_${unit}_qty`]);
  const byUnit = Math.max(required - allocated, 0);
  const conversion = unit === "pallet" ? positiveQuantity(row.to_plt)
    : unit === "layer" ? positiveQuantity(row.to_lyr)
      : unit === "section" ? positiveQuantity(row.to_sec)
        : unit === "piece" ? positiveQuantity(row.to_pcs)
          : 0;
  const remainingSales = Math.max(
    positiveQuantity(row.quantity) - positiveQuantity(row.netsuite_received_qty) - positiveQuantity(row.allocated_sales_qty),
    0
  );
  if (!conversion) return byUnit || (!hasCustomQuantity(row) && unit === "piece" ? remainingSales : byUnit);
  return Math.min(byUnit, Math.floor((remainingSales / conversion) + 0.000001));
}

function lineMatches(left, right) {
  if (left.item_id && right.item_id && String(left.item_id) === String(right.item_id)) return true;
  const leftSku = String(left.sku || left.item_name || "").trim().toLowerCase();
  const rightSku = String(right.sku || right.item_name || "").trim().toLowerCase();
  return Boolean(leftSku && rightSku && leftSku === rightSku);
}

function normalizeAllocationRow(row) {
  return {
    id: row.id,
    salesOrderId: row.sales_order_id,
    salesOrderRef: row.sales_order_ref,
    salesLineId: row.sales_line_id,
    poOrderId: row.po_order_id,
    poOrderRef: row.po_order_ref,
    poLineId: row.po_line_id,
    itemId: row.item_id,
    itemName: row.item_name,
    sku: row.sku,
    pallets: positiveQuantity(row.allocated_pallet_qty),
    layers: positiveQuantity(row.allocated_layer_qty),
    sections: positiveQuantity(row.allocated_section_qty),
    pieces: positiveQuantity(row.allocated_piece_qty),
    salesQty: positiveQuantity(row.allocated_sales_qty),
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at,
    poVendor: row.po_vendor || "",
    poVendorYard: row.po_vendor_yard || "",
    poAddress: row.po_address || ""
  };
}

export async function getSalesOrderPoAllocationOptions(orderRef) {
  const order = await query(
    `SELECT netsuite_id, tranid, customer, outbound_location
       FROM sales_orders
      WHERE tranid = $1 OR netsuite_id::text = $1
      LIMIT 1`,
    [String(orderRef || "").trim()]
  );
  if (!order.rows[0]) throw new Error("Sales order not found.");
  const salesOrder = order.rows[0];

  const salesLines = await query(
    `WITH alloc AS (
       SELECT sales_line_id,
              SUM(allocated_pallet_qty) AS allocated_pallet_qty,
              SUM(allocated_layer_qty) AS allocated_layer_qty,
              SUM(allocated_section_qty) AS allocated_section_qty,
              SUM(allocated_piece_qty) AS allocated_piece_qty,
              SUM(allocated_sales_qty) AS allocated_sales_qty
         FROM dispatch_so_po_allocations
        WHERE status = 'active'
        GROUP BY sales_line_id
     )
     SELECT l.*,
            COALESCE(a.allocated_pallet_qty, 0) AS allocated_pallet_qty,
            COALESCE(a.allocated_layer_qty, 0) AS allocated_layer_qty,
            COALESCE(a.allocated_section_qty, 0) AS allocated_section_qty,
            COALESCE(a.allocated_piece_qty, 0) AS allocated_piece_qty,
            COALESCE(a.allocated_sales_qty, 0) AS allocated_sales_qty
       FROM sales_order_lines l
       LEFT JOIN alloc a ON a.sales_line_id = l.id
      WHERE l.sales_order_id = $1
        AND l.netsuite_active = true
        AND COALESCE(l.item_type, '') IN ('InvtPart', 'NonInvtPart')
      ORDER BY l.line_id NULLS LAST, l.id`,
    [salesOrder.netsuite_id]
  );

  const itemIds = [...new Set(salesLines.rows.map((line) => line.item_id).filter(Boolean))];
  const itemNames = [...new Set(salesLines.rows.map((line) => String(line.sku || line.item_name || "").trim()).filter(Boolean))];
  const poParams = [itemIds, itemNames];
  const poLines = await query(
    `WITH alloc AS (
       SELECT po_line_id,
              SUM(allocated_pallet_qty) AS allocated_pallet_qty,
              SUM(allocated_layer_qty) AS allocated_layer_qty,
              SUM(allocated_section_qty) AS allocated_section_qty,
              SUM(allocated_piece_qty) AS allocated_piece_qty,
              SUM(allocated_sales_qty) AS allocated_sales_qty
         FROM dispatch_so_po_allocations
        WHERE status = 'active'
        GROUP BY po_line_id
     )
     SELECT l.*,
            o.tranid AS po_ref,
            o.vendor AS po_vendor,
            o.dispatch_vendor_yard AS po_vendor_yard,
            o.dispatch_address AS po_address,
            o.status_text AS po_status_text,
            COALESCE(a.allocated_pallet_qty, 0) AS allocated_pallet_qty,
            COALESCE(a.allocated_layer_qty, 0) AS allocated_layer_qty,
            COALESCE(a.allocated_section_qty, 0) AS allocated_section_qty,
            COALESCE(a.allocated_piece_qty, 0) AS allocated_piece_qty,
            COALESCE(a.allocated_sales_qty, 0) AS allocated_sales_qty
       FROM purchase_order_lines l
       JOIN purchase_orders o ON o.netsuite_id = l.purchase_order_id
       LEFT JOIN alloc a ON a.po_line_id = l.id
      WHERE o.netsuite_active = true
        AND (o.status_text ILIKE '%Pending Receipt%' OR o.status_text ILIKE '%Partially Received%')
        AND l.netsuite_active = true
        AND COALESCE(l.item_type, '') IN ('InvtPart', 'NonInvtPart')
        AND (
          (array_length($1::bigint[], 1) IS NOT NULL AND l.item_id = ANY($1::bigint[]))
          OR (array_length($2::text[], 1) IS NOT NULL AND COALESCE(l.sku, l.item_name) = ANY($2::text[]))
        )
      ORDER BY o.trandate DESC, o.tranid DESC, l.line_id NULLS LAST, l.id`,
    poParams
  );

  const allocations = await query(
    `SELECT a.*, po.vendor AS po_vendor, po.dispatch_vendor_yard AS po_vendor_yard, po.dispatch_address AS po_address
       FROM dispatch_so_po_allocations a
       LEFT JOIN purchase_orders po ON po.netsuite_id = a.po_order_id
      WHERE a.sales_order_id = $1
        AND a.status = 'active'
      ORDER BY a.created_at DESC, a.id DESC`,
    [salesOrder.netsuite_id]
  );

  return {
    order: {
      id: salesOrder.tranid,
      netsuiteId: salesOrder.netsuite_id,
      customer: salesOrder.customer || "",
      outboundLocation: salesOrder.outbound_location || ""
    },
    salesLines: salesLines.rows.map((line) => ({
      id: line.id,
      lineId: line.line_id,
      itemId: line.item_id,
      sku: line.sku || line.item_name,
      itemName: line.item_name,
      description: line.item_description || "",
      required: {
        pallets: positiveQuantity(line.pallet_qty),
        layers: positiveQuantity(line.layer_qty),
        sections: positiveQuantity(line.section_qty),
        pieces: positiveQuantity(line.piece_qty),
        salesQty: positiveQuantity(line.quantity),
        unit: line.unit || ""
      },
      allocated: {
        pallets: positiveQuantity(line.allocated_pallet_qty),
        layers: positiveQuantity(line.allocated_layer_qty),
        sections: positiveQuantity(line.allocated_section_qty),
        pieces: positiveQuantity(line.allocated_piece_qty),
        salesQty: positiveQuantity(line.allocated_sales_qty)
      },
      available: {
        pallets: availableUnitQty(line, "pallet"),
        layers: availableUnitQty(line, "layer"),
        sections: availableUnitQty(line, "section"),
        pieces: hasCustomQuantity(line) ? availableUnitQty(line, "piece") : 0,
        salesQty: Math.max(positiveQuantity(line.quantity) - positiveQuantity(line.allocated_sales_qty), 0)
      }
    })),
    poLines: poLines.rows.map((line) => ({
      id: line.id,
      orderId: line.purchase_order_id,
      poRef: line.po_ref,
      vendor: line.po_vendor || "",
      vendorYard: line.po_vendor_yard || "",
      address: line.po_address || "",
      lineId: line.line_id,
      itemId: line.item_id,
      sku: line.sku || line.item_name,
      itemName: line.item_name,
      description: line.item_description || "",
      statusText: line.po_status_text || "",
      required: {
        pallets: positiveQuantity(line.pallet_qty),
        layers: positiveQuantity(line.layer_qty),
        sections: positiveQuantity(line.section_qty),
        pieces: positiveQuantity(line.piece_qty),
        salesQty: positiveQuantity(line.quantity),
        unit: line.unit || ""
      },
      allocated: {
        pallets: positiveQuantity(line.allocated_pallet_qty),
        layers: positiveQuantity(line.allocated_layer_qty),
        sections: positiveQuantity(line.allocated_section_qty),
        pieces: positiveQuantity(line.allocated_piece_qty),
        salesQty: positiveQuantity(line.allocated_sales_qty)
      },
      available: {
        pallets: availableUnitQty(line, "pallet"),
        layers: availableUnitQty(line, "layer"),
        sections: availableUnitQty(line, "section"),
        pieces: hasCustomQuantity(line) ? availableUnitQty(line, "piece") : 0,
        salesQty: Math.max(positiveQuantity(line.quantity) - positiveQuantity(line.netsuite_received_qty) - positiveQuantity(line.allocated_sales_qty), 0)
      }
    })),
    allocations: allocations.rows.map(normalizeAllocationRow)
  };
}

async function createSalesOrderPoAllocationWithExecutor(executor, { salesOrderRef, salesLineId, poLineId, poRef = "", quantities = {}, createdBy = "" } = {}) {
  const sales = await executor.query(
    `WITH alloc AS (
       SELECT sales_line_id,
              SUM(allocated_pallet_qty) AS allocated_pallet_qty,
              SUM(allocated_layer_qty) AS allocated_layer_qty,
              SUM(allocated_section_qty) AS allocated_section_qty,
              SUM(allocated_piece_qty) AS allocated_piece_qty,
              SUM(allocated_sales_qty) AS allocated_sales_qty
         FROM dispatch_so_po_allocations
        WHERE status = 'active'
        GROUP BY sales_line_id
     )
     SELECT l.*, o.tranid AS sales_order_ref,
            COALESCE(a.allocated_pallet_qty, 0) AS allocated_pallet_qty,
            COALESCE(a.allocated_layer_qty, 0) AS allocated_layer_qty,
            COALESCE(a.allocated_section_qty, 0) AS allocated_section_qty,
            COALESCE(a.allocated_piece_qty, 0) AS allocated_piece_qty,
            COALESCE(a.allocated_sales_qty, 0) AS allocated_sales_qty
       FROM sales_order_lines l
       JOIN sales_orders o ON o.netsuite_id = l.sales_order_id
       LEFT JOIN alloc a ON a.sales_line_id = l.id
      WHERE (o.tranid = $1 OR o.netsuite_id::text = $1)
        AND l.id = $2
        AND l.netsuite_active = true`,
    [String(salesOrderRef || "").trim(), salesLineId]
  );
  const salesLine = sales.rows[0];
  if (!salesLine) throw new Error("Sales order line not found.");

  const poParams = poLineId ? [poLineId] : [String(poRef || "").trim(), salesLine.item_id || null, salesLine.sku || salesLine.item_name || ""];
  const poWhere = poLineId
    ? "l.id = $1"
    : `(o.tranid = $1 OR o.netsuite_id::text = $1)
        AND (
          ($2::bigint IS NOT NULL AND l.item_id = $2::bigint)
          OR COALESCE(l.sku, l.item_name) = $3
        )`;
  const po = await executor.query(
    `WITH alloc AS (
       SELECT po_line_id,
              SUM(allocated_pallet_qty) AS allocated_pallet_qty,
              SUM(allocated_layer_qty) AS allocated_layer_qty,
              SUM(allocated_section_qty) AS allocated_section_qty,
              SUM(allocated_piece_qty) AS allocated_piece_qty,
              SUM(allocated_sales_qty) AS allocated_sales_qty
         FROM dispatch_so_po_allocations
        WHERE status = 'active'
        GROUP BY po_line_id
     )
     SELECT l.*, o.tranid AS po_order_ref, o.status_text, o.vendor, o.dispatch_vendor_yard, o.dispatch_address,
            COALESCE(a.allocated_pallet_qty, 0) AS allocated_pallet_qty,
            COALESCE(a.allocated_layer_qty, 0) AS allocated_layer_qty,
            COALESCE(a.allocated_section_qty, 0) AS allocated_section_qty,
            COALESCE(a.allocated_piece_qty, 0) AS allocated_piece_qty,
            COALESCE(a.allocated_sales_qty, 0) AS allocated_sales_qty
       FROM purchase_order_lines l
       JOIN purchase_orders o ON o.netsuite_id = l.purchase_order_id
       LEFT JOIN alloc a ON a.po_line_id = l.id
      WHERE o.netsuite_active = true
        AND (o.status_text ILIKE '%Pending Receipt%' OR o.status_text ILIKE '%Partially Received%')
        AND ${poWhere}
        AND l.netsuite_active = true
      ORDER BY o.trandate DESC, o.tranid DESC, l.line_id NULLS LAST, l.id
      LIMIT 1`,
    poParams
  );
  const poLine = po.rows[0];
  if (!poLine) throw new Error("Purchase order line not found.");
  if (!lineMatches(salesLine, poLine)) throw new Error("Selected PO line item does not match the SO line item.");

  const pallets = positiveQuantity(quantities.pallets);
  const layers = positiveQuantity(quantities.layers);
  const sections = positiveQuantity(quantities.sections);
  const pieces = positiveQuantity(quantities.pieces);
  const conversionLine = hasConversion(salesLine) ? salesLine : poLine;
  const salesQty = lineSalesQty(conversionLine, { ...quantities, pallets, layers, sections, pieces });
  if (pallets + layers + sections + pieces + salesQty <= 0) throw new Error("Allocation quantity is required.");

  const checks = [
    ["pallet", pallets, "PLT"],
    ["layer", layers, "LYR"],
    ["section", sections, "SEC"],
    ["piece", pieces, "PCS"]
  ];
  const itemLabel = salesLine.sku || salesLine.item_name || poLine.sku || poLine.item_name || "item";
  for (const [unit, value, label] of checks) {
    if (!value) continue;
    const salesAvailable = availableUnitQty(salesLine, unit);
    const poAvailable = availableUnitQty(poLine, unit);
    if (value > salesAvailable) throw new Error(`${itemLabel}: SO open quantity is only ${salesAvailable} ${label}.`);
    if (value > poAvailable) throw new Error(`${itemLabel}: PO ${poLine.po_order_ref} only has ${poAvailable} ${label} available.`);
  }
  const salesRemaining = Math.max(positiveQuantity(salesLine.quantity) - positiveQuantity(salesLine.allocated_sales_qty), 0);
  const poRemaining = Math.max(positiveQuantity(poLine.quantity) - positiveQuantity(poLine.netsuite_received_qty) - positiveQuantity(poLine.allocated_sales_qty), 0);
  if (salesQty > salesRemaining) throw new Error(`${itemLabel}: SO open sales quantity is only ${salesRemaining}.`);
  if (salesQty > poRemaining) throw new Error(`${itemLabel}: PO ${poLine.po_order_ref} only has ${poRemaining} sales quantity available.`);

  const inserted = await executor.query(
    `INSERT INTO dispatch_so_po_allocations (
       sales_order_id, sales_order_ref, sales_line_id, po_order_id, po_order_ref, po_line_id,
       item_id, item_name, sku, allocated_pallet_qty, allocated_layer_qty, allocated_section_qty,
       allocated_piece_qty, allocated_sales_qty, created_by, details
     ) VALUES (
       $1, $2, $3, $4, $5, $6,
       $7, $8, $9, $10, $11, $12,
       $13, $14, $15, $16::jsonb
     )
     RETURNING *`,
    [
      salesLine.sales_order_id,
      salesLine.sales_order_ref,
      salesLine.id,
      poLine.purchase_order_id,
      poLine.po_order_ref,
      poLine.id,
      salesLine.item_id || poLine.item_id || null,
      salesLine.item_name || poLine.item_name || "",
      salesLine.sku || poLine.sku || salesLine.item_name || "",
      pallets,
      layers,
      sections,
      pieces,
      salesQty,
      createdBy || null,
      JSON.stringify({
        poVendor: poLine.vendor || "",
        poVendorYard: poLine.dispatch_vendor_yard || "",
        poAddress: poLine.dispatch_address || ""
      })
    ]
  );
  return normalizeAllocationRow({
    ...inserted.rows[0],
    po_vendor: poLine.vendor,
    po_vendor_yard: poLine.dispatch_vendor_yard,
    po_address: poLine.dispatch_address
  });
}

export async function createSalesOrderPoAllocation(options = {}) {
  return createSalesOrderPoAllocationWithExecutor({ query }, options);
}

export async function createSalesOrderPoAllocations({ salesOrderRef, poRef = "", lines = [], createdBy = "" } = {}) {
  const cleaned = (Array.isArray(lines) ? lines : [])
    .map((line) => ({
      salesLineId: line.salesLineId,
      quantities: line.quantities || line
    }))
    .filter((line) => {
      const q = line.quantities || {};
      return positiveQuantity(q.pallets) + positiveQuantity(q.layers) + positiveQuantity(q.sections) + positiveQuantity(q.pieces) + positiveQuantity(q.salesQty) > 0;
    });
  if (!cleaned.length) throw new Error("At least one SO item quantity is required.");
  if (!String(poRef || "").trim()) throw new Error("Purchase order number is required.");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const executor = { query: (text, params) => client.query(text, params) };
    const created = [];
    for (const line of cleaned) {
      created.push(await createSalesOrderPoAllocationWithExecutor(executor, {
        salesOrderRef,
        salesLineId: line.salesLineId,
        poRef,
        quantities: line.quantities,
        createdBy
      }));
    }
    await client.query("COMMIT");
    return created;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => null);
    throw error;
  } finally {
    client.release();
  }
}

export async function cancelSalesOrderPoAllocation(allocationId, { cancelledBy = "" } = {}) {
  const result = await query(
    `UPDATE dispatch_so_po_allocations
        SET status = 'cancelled',
            cancelled_by = $2,
            cancelled_at = now(),
            updated_at = now()
      WHERE id = $1
        AND status = 'active'
      RETURNING *`,
    [allocationId, cancelledBy || null]
  );
  return result.rows[0] ? normalizeAllocationRow(result.rows[0]) : null;
}

export async function upsertLocalCoOrder({ sourceOrderRef, fromYard, toYard, order = {}, plan = {}, requestedBy = "" } = {}) {
  const sourceRef = String(sourceOrderRef || order.id || "").trim();
  const fromText = locationTextFromId(fromYard || order.sourceYard || order.pickupLocations?.[0]);
  const toText = locationTextFromId(toYard || "12441");
  if (!sourceRef) throw new Error("Source order is required for CO.");
  if (!fromText || !toText || fromText === toText) throw new Error("CO source and destination yard must be different.");
  const coRef = String(order.transitCo?.id || `CO-${sourceRef}`).trim();
  const details = {
    customer: order.customer || "",
    notes: order.notes || `Local transit depot order for ${sourceRef}.`,
    sourceOrderId: sourceRef,
    sourceOrderType: order.sourceOrderType || order.type || "",
    childOrderIds: Array.isArray(order.childOrders) ? order.childOrders : [],
    childOrderDetails: Array.isArray(order.childOrderDetails) ? order.childOrderDetails : [],
    weight: order.weight || 0,
    salesQty: order.salesQty || 0
  };
  const hasDispatchAssignment = Boolean(plan.truckPlate || plan.loadName || plan.parkingSpot);
  const inserted = await query(
    `INSERT INTO local_co_orders (
       co_ref, source_order_ref, from_location_id, from_location, to_location_id, to_location,
       status, dispatch_plan_id, dispatch_plan_date, dispatch_truck_plate, dispatch_load_name,
       dispatch_parking_spot, created_by, details
     ) VALUES (
       $1, $2, $3, $4, $5, $6,
       'pending_load', $7, $8::date, $9, $10,
       $11, $12, $13::jsonb
     )
     ON CONFLICT (co_ref) DO UPDATE SET
       source_order_ref = EXCLUDED.source_order_ref,
       from_location_id = EXCLUDED.from_location_id,
       from_location = EXCLUDED.from_location,
       to_location_id = EXCLUDED.to_location_id,
       to_location = EXCLUDED.to_location,
       status = CASE WHEN local_co_orders.status = 'cancelled' THEN 'pending_load' ELSE local_co_orders.status END,
       dispatch_plan_id = COALESCE(EXCLUDED.dispatch_plan_id, local_co_orders.dispatch_plan_id),
       dispatch_plan_date = COALESCE(EXCLUDED.dispatch_plan_date, local_co_orders.dispatch_plan_date),
       dispatch_truck_plate = CASE
         WHEN EXCLUDED.dispatch_plan_id IS NULL AND EXCLUDED.dispatch_plan_date IS NULL THEN local_co_orders.dispatch_truck_plate
         ELSE EXCLUDED.dispatch_truck_plate
       END,
       dispatch_load_name = CASE
         WHEN EXCLUDED.dispatch_plan_id IS NULL AND EXCLUDED.dispatch_plan_date IS NULL THEN local_co_orders.dispatch_load_name
         ELSE EXCLUDED.dispatch_load_name
       END,
       dispatch_parking_spot = CASE
         WHEN EXCLUDED.dispatch_plan_id IS NULL AND EXCLUDED.dispatch_plan_date IS NULL THEN local_co_orders.dispatch_parking_spot
         ELSE EXCLUDED.dispatch_parking_spot
       END,
       details = EXCLUDED.details,
       updated_at = now()
     RETURNING *`,
    [
      coRef,
      sourceRef,
      locationIdFromText(fromText),
      fromText,
      locationIdFromText(toText),
      toText,
      hasDispatchAssignment ? plan.id || null : null,
      hasDispatchAssignment ? plan.planDate || null : null,
      hasDispatchAssignment ? plan.truckPlate || "" : "",
      hasDispatchAssignment ? plan.loadName || "" : "",
      hasDispatchAssignment ? plan.parkingSpot || "" : "",
      requestedBy || null,
      JSON.stringify(details)
    ]
  );
  const co = inserted.rows[0];
  if (!co.delivery_order_id) {
    await query("UPDATE local_co_orders SET delivery_order_id = $2 WHERE id = $1", [co.id, -Number(co.id)]);
    co.delivery_order_id = -Number(co.id);
  }

  const items = Array.isArray(order.items) ? order.items : [];
  const activeLineIds = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index] || {};
    const lineId = Number(item.lineId || item.line_id || index + 1);
    activeLineIds.push(lineId);
    await query(
      `INSERT INTO local_co_order_lines (
         co_id, line_id, item_id, item_name, item_type, item_type_text, item_description, sku,
         quantity, unit, item_weight, pallet_qty, layer_qty, piece_qty, section_qty, to_plt, to_lyr, to_sec, to_pcs, raw
       ) VALUES (
         $1, $2, $3, $4, COALESCE($5, 'InvtPart'), $6, $7, $8,
         $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20::jsonb
       )
       ON CONFLICT (co_id, line_id) DO UPDATE SET
         item_id = EXCLUDED.item_id,
         item_name = EXCLUDED.item_name,
         item_type = EXCLUDED.item_type,
         item_type_text = EXCLUDED.item_type_text,
         item_description = EXCLUDED.item_description,
         sku = EXCLUDED.sku,
         quantity = EXCLUDED.quantity,
         unit = EXCLUDED.unit,
         item_weight = EXCLUDED.item_weight,
         pallet_qty = EXCLUDED.pallet_qty,
         layer_qty = EXCLUDED.layer_qty,
         piece_qty = EXCLUDED.piece_qty,
         section_qty = EXCLUDED.section_qty,
         to_plt = EXCLUDED.to_plt,
         to_lyr = EXCLUDED.to_lyr,
         to_sec = EXCLUDED.to_sec,
         to_pcs = EXCLUDED.to_pcs,
         raw = EXCLUDED.raw`,
      [
        co.id,
        lineId,
        item.itemId || item.item_id || null,
        item.itemName || item.item_name || item.sku || "",
        item.itemType || item.item_type || "InvtPart",
        item.itemTypeText || item.item_type_text || "Inventory Item",
        item.description || item.itemDescription || item.item_description || "",
        item.sku || item.itemName || item.item_name || "",
        item.quantity || item.salesQty || 0,
        item.unit || "",
        item.itemWeight || item.item_weight || 0,
        item.pallets || item.pallet_qty || 0,
        item.layers || item.layer_qty || 0,
        item.pieces || item.piece_qty || 0,
        item.sections || item.section_qty || 0,
        item.toPlt || item.to_plt || null,
        item.toLyr || item.to_lyr || null,
        item.toSec || item.to_sec || null,
        item.toPcs || item.to_pcs || null,
        JSON.stringify(item)
      ]
    );
  }
  if (activeLineIds.length) {
    await query(
      `DELETE FROM local_co_order_lines
       WHERE co_id = $1
         AND NOT (line_id = ANY($2::bigint[]))`,
      [co.id, activeLineIds]
    );
  }
  return getLocalCoOrder(coRef);
}

export async function cancelLocalCoOrder(coRef, { requestedBy = "" } = {}) {
  const result = await query(
    `UPDATE local_co_orders
        SET status = 'cancelled',
            updated_at = now(),
            details = details || $2::jsonb
      WHERE co_ref = $1
        AND status NOT IN ('received', 'loaded')
      RETURNING *`,
    [coRef, JSON.stringify({ cancelledBy: requestedBy || null, cancelledAt: new Date().toISOString() })]
  );
  return result.rows[0] || null;
}

export async function getLocalCoOrder(coRefOrId) {
  const result = await query(
    `SELECT *
       FROM local_co_orders
      WHERE co_ref = $1 OR delivery_order_id::text = $1 OR id::text = $1`,
    [String(coRefOrId)]
  );
  const co = result.rows[0];
  if (!co) return null;
  const lines = await query(
    `SELECT *
       FROM local_co_order_lines
      WHERE co_id = $1
      ORDER BY line_id, id`,
    [co.id]
  );
  return { ...co, lines: lines.rows };
}

export async function createDispatchOperatorRequest({ requestType, orderRef, sourceOrderType, requestedBy = "", details = {} } = {}) {
  if (!requestType || !orderRef) throw new Error("Request type and order reference are required.");
  const result = await query(
    `INSERT INTO dispatch_operator_requests (
       request_type, order_ref, source_order_type, requested_by, details
     ) VALUES ($1, $2, $3, $4, $5::jsonb)
     RETURNING *`,
    [
      requestType,
      orderRef,
      sourceOrderType || null,
      requestedBy || null,
      JSON.stringify(details || {})
    ]
  );
  return result.rows[0];
}

export async function listDispatchOperatorRequests({ status = "open", locationId = null, orderType = null } = {}) {
  await query(
    `WITH delivery_request_orders AS (
       SELECT netsuite_id, tranid, 'sales_order'::text AS order_type,
              operator_status, outbound_location_id, outbound_location
         FROM sales_orders
       UNION ALL
       SELECT netsuite_id, tranid, 'transfer_order'::text AS order_type,
              outbound_operator_status AS operator_status,
              from_location_id AS outbound_location_id,
              from_location AS outbound_location
         FROM transfer_orders
     )
     UPDATE dispatch_operator_requests r
        SET status = 'resolved',
            resolved_at = now(),
            details = r.details || '{"autoResolved":"order_not_packed"}'::jsonb
       FROM delivery_request_orders d
      WHERE r.status = 'open'
        AND r.request_type = 'unpack_for_split'
        AND (d.tranid = r.order_ref OR d.netsuite_id::text = r.order_ref)
        AND d.operator_status <> 'packed'`
  );

  const params = [status];
  const clauses = ["r.status = $1"];
  if (locationId) {
    params.push(locationId);
    clauses.push(`(d.outbound_location_id = $${params.length} OR d.outbound_location_id IS NULL)`);
  }
  if (orderType) {
    params.push(orderType);
    clauses.push(`(d.order_type = $${params.length} OR d.order_type IS NULL)`);
  }
  clauses.push(`(
    r.request_type <> 'unpack_for_split'
    OR d.operator_status = 'packed'
  )`);
  const result = await query(
    `WITH delivery_request_orders AS (
       SELECT netsuite_id, tranid, 'sales_order'::text AS order_type,
              operator_status, outbound_location_id, outbound_location
         FROM sales_orders
       UNION ALL
       SELECT netsuite_id, tranid, 'transfer_order'::text AS order_type,
              outbound_operator_status AS operator_status,
              from_location_id AS outbound_location_id,
              from_location AS outbound_location
         FROM transfer_orders
     )
     SELECT r.*,
            d.netsuite_id,
            d.tranid,
            d.operator_status,
            d.outbound_location_id,
            d.outbound_location
       FROM dispatch_operator_requests r
       LEFT JOIN delivery_request_orders d
         ON d.tranid = r.order_ref
         OR d.netsuite_id::text = r.order_ref
      WHERE ${clauses.join(" AND ")}
      ORDER BY r.requested_at DESC, r.id DESC
      LIMIT 100`,
    params
  );
  return result.rows;
}

export async function resolveDispatchOperatorRequestsForOrder(orderRef, operatorId = "") {
  const result = await query(
    `WITH delivery_request_orders AS (
       SELECT netsuite_id, tranid FROM sales_orders
       UNION ALL
       SELECT netsuite_id, tranid FROM transfer_orders
     )
     UPDATE dispatch_operator_requests
        SET status = 'resolved',
            resolved_by = $2,
            resolved_at = now()
      WHERE status = 'open'
        AND (order_ref = $1 OR order_ref IN (
          SELECT tranid FROM delivery_request_orders WHERE netsuite_id::text = $1
        ))
      RETURNING *`,
    [String(orderRef), operatorId || null]
  );
  return result.rows;
}
