import crypto from "node:crypto";
import { pool, query, withTransaction } from "./db.js";
import { isNetSuiteSandboxEnvironment } from "./config.js";
import {
  createPurchaseOrderDispatchEnricher,
  enrichPurchaseOrderDispatch,
  enrichSalesOrderDispatch,
  enrichTransferDispatch,
  useNetSuiteAddressMappingValue
} from "./dispatch-enrichment.js";
import { resolveDispatchSalesTarget } from "./dispatch-order-target-repository.js";

function toNumber(value) {
  return Number(value || 0) || 0;
}

const CUSTOMER_PICKUP_DELIVERY_METHOD = "Pick-Up";
const DEFAULT_DISPATCH_ORDERS_PER_TYPE = 500;
const MAX_DISPATCH_ORDERS_PER_TYPE = 2000;
const SCM_VRMA_OWN_YARDS = [
  { code: "3445", name: "3445", address: "3445 Kennedy Road, Toronto, ON" },
  { code: "2967", name: "2967", address: "2967 Kennedy Road, Toronto, ON" },
  { code: "12441", name: "12441", address: "12441 Woodbine Avenue, Whitchurch-Stouffville, ON" },
  { code: "150", name: "150", address: "150 Clark Blvd, Brampton, ON L6T 4Y8, Canada" }
];
const SCM_VRMA_OWN_YARD_CODES = new Set(SCM_VRMA_OWN_YARDS.map((yard) => yard.code));
const SCM_VRMA_FALLBACK_UNITS = new Set(["PLT", "SQFT", "PC"]);

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

function dispatchItemHasQuantity(item = {}) {
  return toNumber(item.pallets) > 0
    || toNumber(item.layers) > 0
    || toNumber(item.sections) > 0
    || toNumber(item.pieces) > 0
    || toNumber(item.quantity) > 0;
}

function purchaseOrderDropoffs(items = [], {
  destinationLocationId = null,
  destinationYard = "",
  destinationAddress = ""
} = {}) {
  const groups = new Map();
  for (const item of items.filter(dispatchItemHasQuantity)) {
    const locationId = normalizeScmDestinationLocationId(item.destinationLocationId)
      || normalizeScmDestinationLocationId(destinationLocationId);
    const yard = locationTextFromId(locationId)
      || String(item.destinationYard || destinationYard || "").trim();
    const key = locationId ? `location:${locationId}` : `yard:${yard.toLowerCase()}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        destinationLocationId: locationId || null,
        destinationYard: yard,
        address: SCM_VRMA_OWN_YARDS.find((candidate) => candidate.code === yard)?.address
          || destinationAddress
          || yard,
        lineRowIds: [],
        pallets: 0,
        layers: 0,
        sections: 0,
        pieces: 0,
        salesQty: 0,
        weight: 0
      });
    }
    const group = groups.get(key);
    if (item.lineRowId !== undefined && item.lineRowId !== null) group.lineRowIds.push(item.lineRowId);
    group.pallets += toNumber(item.pallets);
    group.layers += toNumber(item.layers);
    group.sections += toNumber(item.sections);
    group.pieces += toNumber(item.pieces);
    group.salesQty += toNumber(item.quantity);
    group.weight += toNumber(item.lineWeight);
  }
  if (!groups.size && (destinationYard || destinationLocationId)) {
    const locationId = normalizeScmDestinationLocationId(destinationLocationId)
      || normalizeScmDestinationLocationId(destinationYard);
    const yard = locationTextFromId(locationId) || String(destinationYard || "").trim();
    const key = locationId ? `location:${locationId}` : `yard:${yard.toLowerCase()}`;
    groups.set(key, {
      key,
      destinationLocationId: locationId || null,
      destinationYard: yard,
      address: destinationAddress || SCM_VRMA_OWN_YARDS.find((candidate) => candidate.code === yard)?.address || yard,
      lineRowIds: [],
      pallets: 0,
      layers: 0,
      sections: 0,
      pieces: 0,
      salesQty: 0,
      weight: 0
    });
  }
  return [...groups.values()].map((dropoff) => ({
    ...dropoff,
    pallets: Math.round(dropoff.pallets * 1000000) / 1000000,
    layers: Math.round(dropoff.layers * 1000000) / 1000000,
    sections: Math.round(dropoff.sections * 1000000) / 1000000,
    pieces: Math.round(dropoff.pieces * 1000000) / 1000000,
    salesQty: Math.round(dropoff.salesQty * 1000000) / 1000000,
    weight: Math.round(dropoff.weight * 1000) / 1000
  }));
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
  const visibleRef = row.dispatch_type === "PO" && row.dispatch_ref ? row.dispatch_ref : row.tranid;
  const allocationPickups = Array.isArray(row.allocation_pickup_locations)
    ? row.allocation_pickup_locations.filter(Boolean)
    : [];
  const basePickup = row.pickup_location ? [row.pickup_location] : [];
  const pickupLocations = row.transit_co_to_yard
    ? [row.transit_co_to_yard]
    : [...new Set([...basePickup, ...allocationPickups])];
  const address = row.dispatch_type === "PO"
    ? row.drop_address || row.dispatch_address || row.source_address || ""
    : row.drop_address || row.dispatch_address || "";
  const items = normalizeDispatchItems(row.items || []);
  const salesByUnit = new Map();
  for (const item of items) {
    const unit = String(item.unit || "Qty").trim() || "Qty";
    salesByUnit.set(unit, toNumber(salesByUnit.get(unit)) + toNumber(item.quantity));
  }
  const salesQuantities = [...salesByUnit.entries()].map(([unit, quantity]) => ({ unit, quantity }));
  const transitCo = row.transit_co_ref ? {
    id: row.transit_co_ref,
    fromYard: row.transit_co_from_yard || row.pickup_location || "",
    toYard: row.transit_co_to_yard || "",
    source: "local-db"
  } : null;
  const destinationYard = row.destination_location || "";
  const destinationAddress = row.drop_address || row.dispatch_address || "";
  const dropoffs = row.dispatch_type === "PO"
    ? purchaseOrderDropoffs(items, {
        destinationLocationId: row.destination_location_id,
        destinationYard,
        destinationAddress
      })
    : [];
  return {
    id: visibleRef,
    netsuiteId: row.netsuite_id,
    type: row.dispatch_type,
    sourceTable: row.source_table,
    originalPoRef: row.dispatch_type === "PO" ? row.tranid : "",
    dispatchRef: row.dispatch_ref || "",
    customer: row.party || "",
    address,
    sourceYard: row.pickup_location || "",
    sourceAddress: row.pickup_address_override || row.source_address || "",
    defaultSourceAddress: row.source_address || "",
    pickupAddressOverride: row.pickup_address_override || "",
    destinationAddress: row.drop_address || "",
    destinationLocationId: row.destination_location_id || null,
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
    destinationYard,
    dropoffs,
    pallets: row.source_table === "scm_vrma_orders"
      ? totalPallets
      : totalPallets || Math.floor(fallbackQty / 100),
    layers: totalLayers,
    salesQty: fallbackQty,
    salesQuantities,
    packed: {
      pallets: toNumber(row.total_packed_pallet_qty),
      layers: toNumber(row.total_packed_layer_qty),
      sections: toNumber(row.total_packed_section_qty),
      pieces: toNumber(row.total_packed_piece_qty)
    },
    weight: Math.round(toNumber(row.total_weight_lbs) * 1000) / 1000,
    items,
    raw: row,
    netsuiteStatus: row.status || "",
    netsuiteStatusText: row.status_text || "",
    fulfillmentStatus: row.fulfillment_status || "",
    netsuiteActive: row.netsuite_active !== false,
    testFixture: isNetSuiteSandboxEnvironment() && /^TSTDEP-SO-/i.test(String(row.tranid || "")),
    operatorStatus: row.operator_status || "",
    localYardOrderStatus: row.local_yard_order_status || "Open",
    dispatchPlanned: Boolean(row.dispatch_planned),
    dispatchPlanDate: dateOnly(row.dispatch_plan_date),
    dispatchTruckPlate: row.dispatch_truck_plate || "",
    dispatchLoadName: row.dispatch_load_name || "",
    dispatchParkingSpot: row.dispatch_parking_spot || "",
    childOrders: Array.isArray(row.scm_child_orders) ? row.scm_child_orders.filter(Boolean) : [],
    scm: {
      method: row.scm_method || "MBT",
      status: row.scm_status || "Queued",
      isSpecialOrder: Boolean(row.scm_is_special_order),
      groupRef: row.scm_group_ref || "",
      packingSlipRef: row.scm_packing_slip_ref || "",
      etaDate: dateOnly(row.scm_eta_date),
      etaTime: row.scm_eta_time || "",
      driver: row.scm_driver || "",
      notes: row.scm_notes || ""
    }
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

function normalizeScmDestinationLocationId(value) {
  const id = Number(value || 0);
  if ([1, 15, 28, 26].includes(id)) return id;
  const text = String(value || "").trim();
  return locationIdFromText(text);
}

function yardAddressSql(field) {
  return `CASE
    WHEN ${field} = '3445' THEN '3445 Kennedy Road, Toronto, ON'
    WHEN ${field} = '2967' THEN '2967 Kennedy Road, Toronto, ON'
    WHEN ${field} = '12441' THEN '12441 Woodbine Avenue, Whitchurch-Stouffville, ON'
    WHEN ${field} = '150' THEN '150 Clark Blvd, Brampton, ON L6T 4Y8, Canada'
    ELSE ''
  END`;
}

export async function listDispatchOrders({
  type = null, includeHiddenScm = false, search = "", perTypeLimit = DEFAULT_DISPATCH_ORDERS_PER_TYPE
} = {}) {
  const searchTerm = String(search || "").trim().slice(0, 120);
  const cleanPerTypeLimit = Math.min(Math.max(Number(perTypeLimit) || DEFAULT_DISPATCH_ORDERS_PER_TYPE, 1), MAX_DISPATCH_ORDERS_PER_TYPE);
  const normalizedType = String(type || "").trim().toUpperCase();
  const params = [Boolean(includeHiddenScm), isNetSuiteSandboxEnvironment(), searchTerm, cleanPerTypeLimit, normalizedType];
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
    scm_po_split_alloc AS (
      SELECT l.source_line_id,
             SUM(l.pallet_qty) AS split_pallet_qty,
             SUM(l.layer_qty) AS split_layer_qty,
             SUM(l.section_qty) AS split_section_qty,
             SUM(l.piece_qty) AS split_piece_qty,
             SUM(l.sales_qty) AS split_sales_qty
        FROM dispatch_scm_po_split_lines l
        JOIN dispatch_scm_po_splits s ON s.id = l.split_id
       WHERE s.status = 'active'
       GROUP BY l.source_line_id
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
        dispatch_pickup_address,
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
        CASE WHEN $2::boolean AND COALESCE(is_test_fixture, false) THEN true ELSE netsuite_active END AS netsuite_active
      FROM sales_orders
      WHERE sales_order_type <> '${CUSTOMER_PICKUP_DELIVERY_METHOD.replaceAll("'", "''")}'
        AND (COALESCE(is_test_fixture, false) = false OR $2::boolean)
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
        dispatch_pickup_address,
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
        CASE WHEN $2::boolean AND COALESCE(o.is_test_fixture, false) THEN true ELSE l.netsuite_active END AS netsuite_active
      FROM sales_order_lines l
      JOIN sales_orders o ON o.netsuite_id = l.sales_order_id
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
        dispatch_ref,
        'purchase_order'::text AS order_type,
        vendor,
        source_location,
        destination_location,
        destination_location_id,
        expected_delivery_date,
        dispatch_vendor_yard,
        dispatch_address,
        dispatch_pickup_address,
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
        NULL::text AS dispatch_ref,
        'transfer_order'::text AS order_type,
        NULL::text AS vendor,
        from_location AS source_location,
        to_location AS destination_location,
        to_location_id AS destination_location_id,
        expected_delivery_date,
        NULL::text AS dispatch_vendor_yard,
        dispatch_address,
        dispatch_pickup_address,
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
        netsuite_received_baseline_qty,
        to_plt,
        to_lyr,
        to_sec,
        to_pcs,
        location_id,
        location,
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
        netsuite_received_qty AS netsuite_received_baseline_qty,
        to_plt,
        to_lyr,
        to_sec,
        to_pcs,
        location_id,
        location,
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
        NULL::text AS dispatch_ref,
        CASE WHEN o.order_type = 'transfer_order' THEN 'TO' ELSE 'SO' END AS dispatch_type,
        CASE WHEN o.order_type = 'transfer_order' THEN 'transfer_orders' ELSE 'sales_orders' END AS source_table,
        COALESCE(o.customer, o.destination_location, '') AS party,
        o.expected_delivery_date,
        o.outbound_location AS pickup_location,
        o.dispatch_pickup_address AS pickup_address_override,
        NULL::text AS source_address,
        o.destination_location,
        o.destination_location_id,
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
        'MBT'::text AS scm_method,
        'Queued'::text AS scm_status,
        false AS scm_is_special_order,
        NULL::text AS scm_group_ref,
        NULL::text AS scm_packing_slip_ref,
        NULL::date AS scm_eta_date,
        NULL::text AS scm_eta_time,
        NULL::text AS scm_driver,
        NULL::text AS scm_notes,
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
          'unit', l.unit,
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
      GROUP BY o.netsuite_id, o.tranid, o.order_type, o.customer, o.destination_location, o.destination_location_id,
               o.expected_delivery_date, o.outbound_location, o.dispatch_address, o.dispatch_pickup_address,
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
        o.dispatch_ref,
        CASE WHEN o.order_type = 'transfer_order' THEN 'TO' ELSE 'PO' END AS dispatch_type,
        CASE WHEN o.order_type = 'transfer_order' THEN 'transfer_orders' ELSE 'purchase_orders' END AS source_table,
        COALESCE(o.vendor, o.source_location, '') AS party,
        o.expected_delivery_date,
        COALESCE(NULLIF(scm.pickup_point, ''), NULLIF(o.dispatch_vendor_yard, ''), NULLIF(o.source_location, ''), NULLIF(o.vendor, '')) AS pickup_location,
        o.dispatch_pickup_address AS pickup_address_override,
        COALESCE(NULLIF(schedule_pickup_yard.address, ''), NULLIF(o.dispatch_address, '')) AS source_address,
        COALESCE(NULLIF(scm.dropoff_point, ''), o.destination_location) AS destination_location,
        CASE
          WHEN COALESCE(NULLIF(scm.dropoff_point, ''), o.destination_location) = '3445' THEN 1
          WHEN COALESCE(NULLIF(scm.dropoff_point, ''), o.destination_location) = '2967' THEN 28
          WHEN COALESCE(NULLIF(scm.dropoff_point, ''), o.destination_location) = '12441' THEN 15
          WHEN COALESCE(NULLIF(scm.dropoff_point, ''), o.destination_location) = '150' THEN 26
          ELSE o.destination_location_id
        END AS destination_location_id,
        ${yardAddressSql("COALESCE(NULLIF(scm.dropoff_point, ''), o.destination_location)")} AS drop_address,
        o.dispatch_address,
        COALESCE(NULLIF(schedule_pickup_yard.window_start, ''), o.dispatch_window_start) AS dispatch_window_start,
        COALESCE(NULLIF(schedule_pickup_yard.window_end, ''), o.dispatch_window_end) AS dispatch_window_end,
        COALESCE(
          NULLIF(trim(concat_ws(' ', schedule_pickup_yard.day_label, NULLIF(schedule_pickup_yard.instructions, ''))), ''),
          o.dispatch_instructions
        ) AS dispatch_instructions,
        COALESCE(NULLIF(scm.pickup_point, ''), o.dispatch_vendor_yard) AS dispatch_vendor_yard,
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
        COALESCE(scm.method, 'MBT') AS scm_method,
        COALESCE(scm.status, 'Queued') AS scm_status,
        COALESCE(scm.is_special_order, false) AS scm_is_special_order,
        scm.group_ref AS scm_group_ref,
        scm.packing_slip_ref AS scm_packing_slip_ref,
        scm.eta_date AS scm_eta_date,
        scm.eta_time AS scm_eta_time,
        scm.driver AS scm_driver,
        scm.notes AS scm_notes,
        COALESCE(SUM(GREATEST(COALESCE(l.pallet_qty, 0) - COALESCE(pa.allocated_pallet_qty, 0) - COALESCE(spa.split_pallet_qty, 0), 0)), 0) AS total_pallet_qty,
        COALESCE(SUM(GREATEST(COALESCE(l.layer_qty, 0) - COALESCE(pa.allocated_layer_qty, 0) - COALESCE(spa.split_layer_qty, 0), 0)), 0) AS total_layer_qty,
        COALESCE(SUM(GREATEST(COALESCE(l.quantity, 0) - COALESCE(l.netsuite_received_baseline_qty, l.netsuite_received_qty, 0) - COALESCE(pa.allocated_sales_qty, 0) - COALESCE(spa.split_sales_qty, 0), 0)), 0) AS total_quantity,
        0::numeric AS total_packed_pallet_qty,
        0::numeric AS total_packed_layer_qty,
        0::numeric AS total_packed_section_qty,
        0::numeric AS total_packed_piece_qty,
        COALESCE(SUM(
          GREATEST(COALESCE(l.quantity, 0) - COALESCE(l.netsuite_received_baseline_qty, l.netsuite_received_qty, 0) - COALESCE(pa.allocated_sales_qty, 0) - COALESCE(spa.split_sales_qty, 0), 0)
          * COALESCE(l.item_weight, 0)
        ), 0) AS total_weight_lbs,
        jsonb_agg(jsonb_build_object(
          'lineRowId', l.id,
          'lineId', l.line_id,
          'itemId', l.item_id,
          'destinationLocationId', COALESCE(l.location_id, o.destination_location_id),
          'destinationYard', COALESCE(NULLIF(l.location, ''), o.destination_location),
          'sku', COALESCE(l.sku, l.item_name),
          'itemName', l.item_name,
          'description', l.item_description,
          'pallets', GREATEST(COALESCE(l.pallet_qty, 0) - COALESCE(pa.allocated_pallet_qty, 0) - COALESCE(spa.split_pallet_qty, 0), 0),
          'layers', GREATEST(COALESCE(l.layer_qty, 0) - COALESCE(pa.allocated_layer_qty, 0) - COALESCE(spa.split_layer_qty, 0), 0),
          'sections', GREATEST(COALESCE(l.section_qty, 0) - COALESCE(pa.allocated_section_qty, 0) - COALESCE(spa.split_section_qty, 0), 0),
          'pieces', GREATEST(COALESCE(l.piece_qty, 0) - COALESCE(pa.allocated_piece_qty, 0) - COALESCE(spa.split_piece_qty, 0), 0),
          'quantity', GREATEST(COALESCE(l.quantity, 0) - COALESCE(l.netsuite_received_baseline_qty, l.netsuite_received_qty, 0) - COALESCE(pa.allocated_sales_qty, 0) - COALESCE(spa.split_sales_qty, 0), 0),
          'unit', l.unit,
          'itemWeight', COALESCE(l.item_weight, 0),
          'lineWeight', GREATEST(COALESCE(l.quantity, 0) - COALESCE(l.netsuite_received_baseline_qty, l.netsuite_received_qty, 0) - COALESCE(pa.allocated_sales_qty, 0) - COALESCE(spa.split_sales_qty, 0), 0) * COALESCE(l.item_weight, 0),
          'netsuiteReceivedQty', COALESCE(l.netsuite_received_qty, 0),
          'netsuiteReceivedBaselineQty', COALESCE(l.netsuite_received_baseline_qty, l.netsuite_received_qty, 0),
          'poAllocatedPallets', COALESCE(pa.allocated_pallet_qty, 0),
          'poAllocatedLayers', COALESCE(pa.allocated_layer_qty, 0),
          'poAllocatedSections', COALESCE(pa.allocated_section_qty, 0),
          'poAllocatedPieces', COALESCE(pa.allocated_piece_qty, 0),
          'poAllocatedSalesQty', COALESCE(pa.allocated_sales_qty, 0),
          'scmSplitAllocatedPallets', COALESCE(spa.split_pallet_qty, 0),
          'scmSplitAllocatedLayers', COALESCE(spa.split_layer_qty, 0),
          'scmSplitAllocatedSections', COALESCE(spa.split_section_qty, 0),
          'scmSplitAllocatedPieces', COALESCE(spa.split_piece_qty, 0),
          'scmSplitAllocatedSalesQty', COALESCE(spa.split_sales_qty, 0),
          'toPlt', l.to_plt,
          'toLyr', l.to_lyr,
          'toSec', l.to_sec,
          'toPcs', l.to_pcs
        ) ORDER BY l.line_id NULLS LAST, l.id) FILTER (WHERE l.id IS NOT NULL) AS items
      FROM receiving_order_source o
      LEFT JOIN scm_transport_schedule scm
        ON scm.order_kind = CASE WHEN o.order_type = 'transfer_order' THEN 'TO' ELSE 'PO' END
       AND lower(scm.order_ref) = lower(COALESCE(NULLIF(o.dispatch_ref, ''), o.tranid))
      LEFT JOIN LATERAL (
        SELECT y.address, y.window_start, y.window_end, y.instructions, y.day_label
          FROM dispatch_vendor_yards y
         WHERE y.active = true
           AND lower(y.yard) = lower(COALESCE(NULLIF(scm.pickup_point, ''), NULLIF(o.dispatch_vendor_yard, '')))
         ORDER BY CASE WHEN y.day_label = 'Mon-Fri' THEN 0 ELSE 1 END, y.id
         LIMIT 1
      ) schedule_pickup_yard ON true
      LEFT JOIN receiving_line_source l ON l.order_id = o.netsuite_id AND l.netsuite_active = true
      LEFT JOIN po_alloc pa ON pa.po_line_id = l.id
      LEFT JOIN scm_po_split_alloc spa ON spa.source_line_id = l.id
      WHERE o.netsuite_active = true
        AND (
          $1::boolean
          OR COALESCE(scm.method, 'MBT') = 'MBT'
        )
        AND (
          $1::boolean
          OR COALESCE(scm.status, 'Queued') NOT IN ('Cancelled', 'Hold')
        )
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
                o.dispatch_ref,
                o.destination_location, o.destination_location_id, o.expected_delivery_date, o.dispatch_vendor_yard,
               o.dispatch_address, o.dispatch_pickup_address, o.dispatch_window_start, o.dispatch_window_end,
               o.dispatch_instructions, o.dispatch_parse_source, o.dispatch_plan_date,
               o.dispatch_truck_plate, o.dispatch_load_name, o.dispatch_parking_spot,
               o.status_text, o.netsuite_active, scm.method, scm.status, scm.is_special_order,
               scm.group_ref, scm.packing_slip_ref, scm.pickup_point, scm.dropoff_point,
               scm.eta_date, scm.eta_time, scm.driver, scm.notes,
               schedule_pickup_yard.address, schedule_pickup_yard.window_start, schedule_pickup_yard.window_end,
               schedule_pickup_yard.instructions, schedule_pickup_yard.day_label
      HAVING o.dispatch_plan_date IS NOT NULL
          OR COALESCE(SUM(GREATEST(COALESCE(l.quantity, 0) - COALESCE(l.netsuite_received_baseline_qty, l.netsuite_received_qty, 0) - COALESCE(pa.allocated_sales_qty, 0) - COALESCE(spa.split_sales_qty, 0), 0)), 0) > 0.000001
    ),
    local_co AS (
      SELECT
        co.delivery_order_id AS netsuite_id,
        co.co_ref AS tranid,
        NULL::text AS dispatch_ref,
        'CO' AS dispatch_type,
        'local_co_orders' AS source_table,
        COALESCE(co.details->>'customer', 'Transit Depot') AS party,
        co.dispatch_plan_date AS expected_delivery_date,
        co.from_location AS pickup_location,
        ''::text AS pickup_address_override,
        ${yardAddressSql("co.from_location")} AS source_address,
        co.to_location AS destination_location,
        co.to_location_id AS destination_location_id,
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
        'MBT'::text AS scm_method,
        'Queued'::text AS scm_status,
        false AS scm_is_special_order,
        NULL::text AS scm_group_ref,
        NULL::text AS scm_packing_slip_ref,
        NULL::date AS scm_eta_date,
        NULL::text AS scm_eta_time,
        NULL::text AS scm_driver,
        NULL::text AS scm_notes,
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
          'unit', l.unit,
          'itemWeight', COALESCE(l.item_weight, 0),
          'lineWeight', COALESCE(l.quantity, 0) * COALESCE(l.item_weight, 0)
        ) ORDER BY l.line_id NULLS LAST, l.id) FILTER (WHERE l.id IS NOT NULL) AS items
      FROM co_orders co
      LEFT JOIN co_order_lines l ON l.co_id = co.id
      WHERE co.status IN ('pending_load', 'planned', 'received')
      GROUP BY co.id
    ),
    local_vrma AS (
      SELECT
        -v.id AS netsuite_id,
        v.vrma_ref AS tranid,
        NULL::text AS dispatch_ref,
        'PO' AS dispatch_type,
        'scm_vrma_orders' AS source_table,
        COALESCE(v.local_vendor, v.vendor, 'Vendor Return') AS party,
        scm.eta_date AS expected_delivery_date,
        v.pickup_location AS pickup_location,
        ''::text AS pickup_address_override,
        ${yardAddressSql("v.pickup_location")} AS source_address,
        v.dropoff_location AS destination_location,
        NULL::bigint AS destination_location_id,
        COALESCE(vrma_yard.address, '') AS drop_address,
        COALESCE(vrma_yard.address, '') AS dispatch_address,
        COALESCE(vrma_yard.window_start, '') AS dispatch_window_start,
        COALESCE(vrma_yard.window_end, '') AS dispatch_window_end,
        COALESCE(NULLIF(trim(concat_ws(' | ', NULLIF(v.notes, ''), NULLIF(vrma_yard.instructions, ''))), ''), 'Vendor return') AS dispatch_instructions,
        COALESCE(v.local_vendor, v.vendor, scm.brand) AS dispatch_vendor_yard,
        'scm-vrma'::text AS dispatch_parse_source,
        NULL::text AS transit_co_ref,
        NULL::text AS transit_co_from_yard,
        NULL::text AS transit_co_to_yard,
        '[]'::jsonb AS allocation_pickup_locations,
        NULL::text AS operator_status,
        'Open'::text AS local_yard_order_status,
        false AS dispatch_planned,
        NULL::date AS dispatch_plan_date,
        NULL::text AS dispatch_truck_plate,
        NULL::text AS dispatch_load_name,
        NULL::text AS dispatch_parking_spot,
        NULL::text AS fulfillment_status,
        v.status AS status,
        v.status AS status_text,
        true AS netsuite_active,
        COALESCE(scm.method, v.method, 'MBT') AS scm_method,
        COALESCE(scm.status, v.status, 'Queued') AS scm_status,
        false AS scm_is_special_order,
        scm.group_ref AS scm_group_ref,
        scm.packing_slip_ref AS scm_packing_slip_ref,
        scm.eta_date AS scm_eta_date,
        scm.eta_time AS scm_eta_time,
        scm.driver AS scm_driver,
        scm.notes AS scm_notes,
        COALESCE(SUM(l.pallet_qty), 0) AS total_pallet_qty,
        COALESCE(SUM(l.layer_qty), 0) AS total_layer_qty,
        COALESCE(SUM(l.quantity), 0) AS total_quantity,
        0::numeric AS total_packed_pallet_qty,
        0::numeric AS total_packed_layer_qty,
        0::numeric AS total_packed_section_qty,
        0::numeric AS total_packed_piece_qty,
        COALESCE(SUM(COALESCE(l.weight_lbs, 0)), COALESCE(scm.weight_lbs, 0), 0) AS total_weight_lbs,
        jsonb_agg(jsonb_build_object(
          'lineRowId', l.id,
          'lineId', l.id,
          'itemId', l.item_id,
          'sku', COALESCE(l.sku, l.item_name),
          'itemName', l.item_name,
          'description', COALESCE(l.item_description, ''),
          'pallets', COALESCE(l.pallet_qty, 0),
          'layers', COALESCE(l.layer_qty, 0),
          'sections', COALESCE(l.section_qty, 0),
          'pieces', COALESCE(l.piece_qty, 0),
          'quantity', COALESCE(l.quantity, 0),
          'unit', l.unit,
          'itemWeight', CASE WHEN COALESCE(l.quantity, 0) = 0 THEN 0 ELSE COALESCE(l.weight_lbs, 0) / NULLIF(l.quantity, 0) END,
          'lineWeight', COALESCE(l.weight_lbs, 0),
          'netsuiteReceivedQty', 0,
          'toPlt', COALESCE(l.to_plt, 0),
          'toLyr', COALESCE(l.to_lyr, 0),
          'toSec', COALESCE(l.to_sec, 0),
          'toPcs', COALESCE(l.to_pcs, 0)
        ) ORDER BY l.id) FILTER (WHERE l.id IS NOT NULL) AS items
      FROM scm_vrma_orders v
      LEFT JOIN scm_transport_schedule scm ON scm.order_kind = 'VRMA' AND lower(scm.order_ref) = lower(v.vrma_ref)
      LEFT JOIN LATERAL (
        SELECT y.id, y.address, y.window_start, y.window_end, y.instructions
          FROM dispatch_vendor_yards y
         WHERE y.active = true
           AND LOWER(y.vendor) = LOWER(COALESCE(v.local_vendor, v.vendor, ''))
           AND LOWER(y.yard) = LOWER(COALESCE(v.dropoff_location, ''))
         ORDER BY y.id
         LIMIT 1
      ) vrma_yard ON true
      LEFT JOIN scm_vrma_order_lines l ON l.vrma_order_id = v.id
      WHERE v.pickup_location IN ('3445', '2967', '12441', '150')
        AND vrma_yard.id IS NOT NULL
        AND (
          $1::boolean
          OR COALESCE(scm.method, v.method, 'MBT') = 'MBT'
        )
        AND (
          $1::boolean
          OR COALESCE(scm.status, v.status, 'Queued') NOT IN ('Cancelled', 'Hold')
        )
      GROUP BY v.id, scm.id, vrma_yard.address, vrma_yard.window_start, vrma_yard.window_end, vrma_yard.instructions
    ),
    eligible_orders AS (
      SELECT * FROM delivery
      UNION ALL
      SELECT * FROM receiving
      UNION ALL
      SELECT * FROM local_co
      UNION ALL
      SELECT * FROM local_vrma
    ),
    ranked_orders AS (
      SELECT eligible_orders.*,
             ROW_NUMBER() OVER (
               PARTITION BY dispatch_type
               ORDER BY CASE WHEN $2::boolean AND tranid LIKE 'TSTDEP-SO-%' THEN 0 ELSE 1 END,
                        dispatch_window_start NULLS LAST, tranid DESC
             ) AS dispatch_type_rank
        FROM eligible_orders
       WHERE ($5::text = '' OR dispatch_type = $5)
         AND (
           $3::text = ''
           OR tranid ILIKE '%' || $3 || '%'
           OR COALESCE(dispatch_ref, '') ILIKE '%' || $3 || '%'
           OR COALESCE(party, '') ILIKE '%' || $3 || '%'
           OR COALESCE(drop_address, '') ILIKE '%' || $3 || '%'
           OR COALESCE(pickup_location, '') ILIKE '%' || $3 || '%'
           OR COALESCE(destination_location, '') ILIKE '%' || $3 || '%'
           OR COALESCE(dispatch_instructions, '') ILIKE '%' || $3 || '%'
           OR COALESCE(items, '[]'::jsonb)::text ILIKE '%' || $3 || '%'
         )
    )
    SELECT orders.*,
           COALESCE((
             SELECT jsonb_agg(m.order_ref ORDER BY m.order_ref)
               FROM scm_schedule_groups g
               JOIN scm_schedule_group_members m ON m.group_id = g.id
              WHERE g.status = 'active'
                AND orders.dispatch_type = 'PO'
                AND lower(g.group_ref) = lower(COALESCE(NULLIF(orders.dispatch_ref, ''), orders.tranid))
           ), '[]'::jsonb) AS scm_child_orders
    FROM ranked_orders orders
    WHERE $3::text <> '' OR orders.dispatch_type_rank <= $4
    ORDER BY CASE WHEN $2::boolean AND tranid LIKE 'TSTDEP-SO-%' THEN 0 ELSE 1 END,
             dispatch_window_start NULLS LAST, tranid DESC
    LIMIT CASE WHEN $3::text <> '' THEN 200 ELSE NULL END
    `,
    params
  );
  return result.rows.map(rowToDispatchOrder);
}

export async function searchSalesOrderMethodOverrides({ search = "", limit = 30 } = {}) {
  const term = String(search || "").trim();
  const cleanLimit = Math.min(Math.max(Number(limit) || 30, 1), 100);
  const result = await query(
    `SELECT o.netsuite_id, o.tranid, o.customer, o.status, o.status_text,
            o.delivery_method_id,
            o.sales_order_type AS local_method,
            COALESCE(o.netsuite_sales_order_type, o.sales_order_type) AS netsuite_method,
            o.sales_order_type_override AS override_active,
            o.outbound_location_id, o.outbound_location,
            o.trandate, o.expected_delivery_date, o.synced_at,
            COUNT(l.id) FILTER (WHERE l.netsuite_active = true) AS active_line_count,
            COALESCE(SUM(l.quantity) FILTER (WHERE l.netsuite_active = true), 0) AS total_sales_qty
       FROM sales_orders o
       LEFT JOIN sales_order_lines l ON l.sales_order_id = o.netsuite_id
      WHERE ($1 = ''
             OR lower(o.tranid) LIKE '%' || lower($1) || '%'
             OR lower(COALESCE(o.customer, '')) LIKE '%' || lower($1) || '%')
      GROUP BY o.netsuite_id
      ORDER BY
        CASE WHEN lower(o.tranid) = lower($1) THEN 0 ELSE 1 END,
        o.trandate DESC NULLS LAST,
        o.tranid DESC
      LIMIT $2`,
    [term, cleanLimit]
  );
  return result.rows.map((row) => ({
    netsuiteId: row.netsuite_id,
    tranid: row.tranid,
    customer: row.customer || "",
    status: row.status || "",
    statusText: row.status_text || "",
    deliveryMethodId: row.delivery_method_id,
    localMethod: row.local_method || "",
    netsuiteMethod: row.netsuite_method || "",
    overrideActive: Boolean(row.override_active),
    outboundLocationId: row.outbound_location_id,
    outboundLocation: row.outbound_location || "",
    trandate: row.trandate,
    expectedDeliveryDate: row.expected_delivery_date,
    syncedAt: row.synced_at,
    activeLineCount: Number(row.active_line_count || 0),
    totalSalesQty: Number(row.total_sales_qty || 0),
    dispatchVisible: String(row.local_method || "") !== CUSTOMER_PICKUP_DELIVERY_METHOD
  }));
}

export async function updateSalesOrderLocalMethod(tranid, { method = "", updatedBy = "" } = {}) {
  const orderRef = String(tranid || "").trim();
  if (!orderRef) throw new Error("Sales order number is required.");
  const normalizedMethod = String(method || "").trim();
  const allowed = new Set(["Delivery", CUSTOMER_PICKUP_DELIVERY_METHOD]);
  if (!allowed.has(normalizedMethod)) throw new Error("Local method must be Delivery or Pick-Up.");

  const result = await query(
    `UPDATE sales_orders
        SET netsuite_sales_order_type = COALESCE(netsuite_sales_order_type, sales_order_type),
            sales_order_type = $2,
            sales_order_type_override = (COALESCE(netsuite_sales_order_type, sales_order_type) IS DISTINCT FROM $2),
            sales_order_type_updated_by = $3,
            sales_order_type_updated_at = now(),
            synced_at = now()
      WHERE lower(tranid) = lower($1)
      RETURNING netsuite_id, tranid, customer, status, status_text,
                sales_order_type AS local_method,
                COALESCE(netsuite_sales_order_type, sales_order_type) AS netsuite_method,
                sales_order_type_override AS override_active,
                outbound_location_id, outbound_location, synced_at`,
    [orderRef, normalizedMethod, updatedBy || null]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    netsuiteId: row.netsuite_id,
    tranid: row.tranid,
    customer: row.customer || "",
    status: row.status || "",
    statusText: row.status_text || "",
    localMethod: row.local_method || "",
    netsuiteMethod: row.netsuite_method || "",
    overrideActive: Boolean(row.override_active),
    outboundLocationId: row.outbound_location_id,
    outboundLocation: row.outbound_location || "",
    syncedAt: row.synced_at,
    dispatchVisible: String(row.local_method || "") !== CUSTOMER_PICKUP_DELIVERY_METHOD
  };
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
      `SELECT netsuite_id, 'purchase_order'::text AS order_type, memo, vendor_id::text AS vendor_id, vendor, vendor_address,
               source_location_id, source_location, destination_location_id, destination_location, tranid
          FROM purchase_orders
         WHERE netsuite_active = true
           AND ($1::boolean OR dispatch_note_hash IS NULL OR dispatch_parse_source IS NULL)
        UNION ALL
        SELECT netsuite_id, 'transfer_order'::text AS order_type, memo, NULL::text AS vendor_id, NULL::text AS vendor, NULL::text AS vendor_address,
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
  const pickupAddressProvided = patch.pickupAddress !== undefined
    || patch.pickup_address !== undefined;
  const pickupAddress = String(patch.pickupAddress ?? patch.pickup_address ?? "").trim();
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
              dispatch_pickup_address = CASE WHEN $6::boolean THEN $7 ELSE dispatch_pickup_address END,
              dispatch_parse_source = 'manual-dispatch-details',
              dispatch_parsed_at = now()
        WHERE (tranid = $1 OR netsuite_id::text = $1)
        RETURNING netsuite_id, tranid, dispatch_address, dispatch_window_start,
                  dispatch_window_end, expected_delivery_date, dispatch_pickup_address,
                  '${table}'::text AS source_table`,
      [orderRef, address, windowStart, windowEnd, expectedDate, pickupAddressProvided, pickupAddress]
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

function purchaseOrderReceivedBaseline(row) {
  return positiveQuantity(row?.netsuite_received_baseline_qty ?? row?.netsuite_received_qty);
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
  if (!hasConversion(row) && hasCustomQuantity(row)) return directSales;
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
    positiveQuantity(row.quantity) - purchaseOrderReceivedBaseline(row) - positiveQuantity(row.allocated_sales_qty),
    0
  );
  if (!conversion) return byUnit || (!hasCustomQuantity(row) && unit === "piece" ? remainingSales : byUnit);
  if (!hasCustomQuantity(row)) return Math.floor((remainingSales / conversion) + 0.000001);
  return Math.min(byUnit, Math.floor((remainingSales / conversion) + 0.000001));
}

function availableUnitSelection(row) {
  const remainingSales = Math.max(
    positiveQuantity(row.quantity) - purchaseOrderReceivedBaseline(row) - positiveQuantity(row.allocated_sales_qty),
    0
  );
  if (hasCustomQuantity(row)) {
    return {
      pallets: availableUnitQty(row, "pallet"),
      layers: availableUnitQty(row, "layer"),
      sections: availableUnitQty(row, "section"),
      pieces: availableUnitQty(row, "piece"),
      salesQty: remainingSales
    };
  }
  if (!hasConversion(row)) return { pallets: 0, layers: 0, sections: 0, pieces: 0, salesQty: remainingSales };
  let remainder = remainingSales;
  const result = { pallets: 0, layers: 0, sections: 0, pieces: 0, salesQty: 0 };
  for (const [field, conversionField] of [["pallets", "to_plt"], ["layers", "to_lyr"], ["sections", "to_sec"], ["pieces", "to_pcs"]]) {
    const conversion = positiveQuantity(row[conversionField]);
    if (!conversion || remainder <= 0.000001) continue;
    result[field] = Math.floor((remainder / conversion) + 0.000001);
    remainder = Math.max(0, Number((remainder - (result[field] * conversion)).toFixed(6)));
  }
  return result;
}

function syntheticPurchaseOrderId(value) {
  const hex = crypto.createHash("sha1").update(String(value || "")).digest("hex").slice(0, 12);
  return -Number.parseInt(hex, 16);
}

function syntheticPurchaseOrderIdForGroup(groupRef = "") {
  return syntheticPurchaseOrderId(`scm-schedule-group:${groupRef}`);
}

function repositoryHashText(value = "") {
  return crypto.createHash("sha1").update(String(value || "")).digest("hex");
}

function roundDispatchQuantity(value) {
  return Number(Number(value || 0).toFixed(6));
}

function splitLineQuantityPayload(line = {}) {
  return {
    pallets: positiveQuantity(line.pallets ?? line.pallet_qty),
    layers: positiveQuantity(line.layers ?? line.layer_qty),
    sections: positiveQuantity(line.sections ?? line.section_qty),
    pieces: positiveQuantity(line.pieces ?? line.piece_qty),
    salesQty: positiveQuantity(line.salesQty ?? line.quantity)
  };
}

function hasRequestedSplitQuantity(qtys = {}) {
  return positiveQuantity(qtys.pallets)
    + positiveQuantity(qtys.layers)
    + positiveQuantity(qtys.sections)
    + positiveQuantity(qtys.pieces)
    + positiveQuantity(qtys.salesQty) > 0;
}

function visibleScmSplitItem(item = {}) {
  return positiveQuantity(item.pallets)
    + positiveQuantity(item.layers)
    + positiveQuantity(item.sections)
    + positiveQuantity(item.pieces)
    + positiveQuantity(item.quantity) > 0;
}

function scmPurchaseOrderRefValues(order = {}) {
  return [...new Set([
    order.id,
    order.originalPoRef,
    order.dispatchRef,
    order.sourcePoRef
  ].map((value) => String(value || "").trim()).filter(Boolean))];
}

function scmPurchaseOrderSearchRefs(orders = [], splitRows = []) {
  const refsByLookup = new Map();
  const connectRefs = (values = []) => {
    const refs = [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
    for (const ref of refs) {
      const key = ref.toLowerCase();
      const connected = refsByLookup.get(key) || new Set();
      refs.forEach((value) => connected.add(value));
      refsByLookup.set(key, connected);
    }
  };
  for (const order of orders) connectRefs(scmPurchaseOrderRefValues(order));
  for (const split of splitRows) connectRefs([split.split_po_ref, split.source_po_ref]);

  return new Map((orders || []).map((order) => {
    const refs = new Set(scmPurchaseOrderRefValues(order));
    for (const childRef of order.childOrders || []) {
      const child = String(childRef || "").trim();
      if (!child) continue;
      refs.add(child);
      for (const connected of refsByLookup.get(child.toLowerCase()) || []) refs.add(connected);
    }
    return [String(order.id || ""), [...refs]];
  }));
}

function compareScmPurchaseOrders(left = {}, right = {}) {
  return String(left.id || "").localeCompare(String(right.id || ""), undefined, {
    numeric: true,
    sensitivity: "base"
  });
}

function replaceRefDeep(value, oldRef, newRef) {
  if (typeof value === "string") return value === oldRef ? newRef : value;
  if (Array.isArray(value)) return value.map((item) => replaceRefDeep(item, oldRef, newRef));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceRefDeep(item, oldRef, newRef)]));
  }
  return value;
}

function removeRefFromPlanArrays({ orders = [], trucks = [] } = {}, orderRef = "") {
  const ref = String(orderRef || "");
  const nextOrders = (orders || []).filter((order) => String(order?.id || "") !== ref);
  const nextTrucks = (trucks || []).map((truck) => ({
    ...truck,
    loads: (truck.loads || []).map((load) => ({
      ...load,
      stops: (load.stops || []).filter((stop) => String(stop?.orderId || "") !== ref)
    }))
  }));
  return { orders: nextOrders, trucks: nextTrucks };
}

async function updateDispatchSnapshotsForRef(client, { oldRef = "", newRef = "", remove = false } = {}) {
  const ref = String(oldRef || "").trim();
  if (!ref) return { planIds: [] };
  const snapshots = await client.query(
    `SELECT plan_id, orders, trucks
       FROM dispatch_plan_snapshots
      WHERE orders::text LIKE $1 OR trucks::text LIKE $1`,
    [`%"${ref.replaceAll('"', '\\"')}"%`]
  );
  const changedPlanIds = [];
  for (const row of snapshots.rows) {
    const next = remove
      ? removeRefFromPlanArrays({ orders: row.orders || [], trucks: row.trucks || [] }, ref)
      : {
          orders: replaceRefDeep(row.orders || [], ref, String(newRef || "").trim()),
          trucks: replaceRefDeep(row.trucks || [], ref, String(newRef || "").trim())
        };
    await client.query(
      `UPDATE dispatch_plan_snapshots
          SET orders = $2::jsonb,
              trucks = $3::jsonb,
              saved_at = now()
        WHERE plan_id = $1`,
      [row.plan_id, JSON.stringify(next.orders), JSON.stringify(next.trucks)]
    );
    changedPlanIds.push(row.plan_id);
  }
  if (changedPlanIds.length) {
    await client.query(
      `UPDATE dispatch_plans
          SET revision = COALESCE(revision, 0) + 1,
              updated_at = now()
        WHERE id = ANY($1::bigint[])`,
      [changedPlanIds]
    );
  }
  return { planIds: changedPlanIds };
}

export async function listScmPurchaseOrders({ search = "", dropoff = "", vendor = "", pickupPoint = "" } = {}) {
  const needle = String(search || "").trim().toLowerCase();
  const dropoffFilter = String(dropoff || "").trim().toLowerCase();
  const vendorFilter = String(vendor || "").trim().toLowerCase();
  const pickupFilter = String(pickupPoint || "").trim().toLowerCase();
  let orders = await listDispatchOrders({ type: "PO", includeHiddenScm: true });
  const splitRows = await query(
    `SELECT s.id, s.source_po_ref, s.split_po_ref, s.created_at, s.created_by,
            COUNT(l.id) AS line_count,
            COALESCE(SUM(l.sales_qty), 0) AS sales_qty
       FROM dispatch_scm_po_splits s
       LEFT JOIN dispatch_scm_po_split_lines l ON l.split_id = s.id
      WHERE s.status = 'active'
      GROUP BY s.id
      ORDER BY s.created_at DESC`
  );
  const splitByRef = new Map(splitRows.rows.map((row) => [String(row.split_po_ref || ""), row]));
  orders = orders.map((order) => {
    const split = splitByRef.get(String(order.id || ""));
    if (!split) return order;
    return {
      ...order,
      isScmSplit: true,
      scmSplitId: split.id,
      sourcePoRef: split.source_po_ref || "",
      scmSplitCreatedAt: split.created_at,
      scmSplitCreatedBy: split.created_by || "",
      scmSplitLineCount: Number(split.line_count || 0),
      scmSplitSalesQty: positiveQuantity(split.sales_qty)
    };
  });
  const searchRefsByOrderId = scmPurchaseOrderSearchRefs(orders, splitRows.rows);
  orders = orders.map((order) => ({
    ...order,
    scmSearchRefs: searchRefsByOrderId.get(String(order.id || "")) || scmPurchaseOrderRefValues(order)
  }));
  if (needle) {
    orders = orders.filter((order) => {
      const haystack = [
        order.id,
        order.originalPoRef,
        order.dispatchRef,
        order.customer,
        order.vendorYard,
        order.sourceYard,
        order.address,
        order.sourcePoRef,
        ...(order.scmSearchRefs || []),
        ...(order.childOrders || []),
        ...(order.items || []).flatMap((item) => [item.sku, item.itemName, item.description])
      ].join(" ").toLowerCase();
      return haystack.includes(needle);
    });
  }
  const vendorYardOptionsByRef = await listScmVendorYardOptionsForRefs(orders.flatMap((order) => [
    order.id,
    order.originalPoRef,
    order.dispatchRef,
    order.netsuiteId
  ]));
  return orders
    .map((order) => ({
      ...order,
      vendorYardOptions: vendorYardOptionsByRef.get(String(order.id || "").toLowerCase())
        || vendorYardOptionsByRef.get(String(order.originalPoRef || "").toLowerCase())
        || vendorYardOptionsByRef.get(String(order.dispatchRef || "").toLowerCase())
        || vendorYardOptionsByRef.get(String(order.netsuiteId || "").toLowerCase())
        || [],
      items: (order.items || []).filter(visibleScmSplitItem)
    }))
    .filter((order) => {
      const groupRef = String(order.scm?.groupRef || "").trim();
      if (!groupRef) return true;
      return String(order.id || "").trim().toLowerCase() === groupRef.toLowerCase();
    })
    .filter((order) => String(order.scm?.status || "").trim().toLowerCase() !== "completed")
    .filter((order) => {
      if (!dropoffFilter) return true;
      return [
        order.destinationYard,
        ...(order.dropoffs || []).map((dropoff) => dropoff.destinationYard)
      ].some((yard) => String(yard || "").trim().toLowerCase() === dropoffFilter);
    })
    .filter((order) => {
      if (!vendorFilter) return true;
      const orderVendor = scmOrderVendorLabel(order).toLowerCase();
      return orderVendor === vendorFilter;
    })
    .filter((order) => {
      if (!pickupFilter) return true;
      return scmEffectivePickupPoint(order).toLowerCase() === pickupFilter;
    })
    .filter((order) => (order.items || []).length || needle)
    .sort(compareScmPurchaseOrders);
}

function scmOrderVendorLabel(order = {}) {
  const localVendor = (Array.isArray(order.vendorYardOptions) ? order.vendorYardOptions : [])
    .map((option) => String(option.vendor || "").trim())
    .find(Boolean);
  return String(localVendor || order.customer || order.vendorYard || order.sourceYard || "").trim();
}

function scmEffectivePickupPoint(order = {}) {
  const options = Array.isArray(order.vendorYardOptions) ? order.vendorYardOptions : [];
  const current = String(order.scm?.pickupPoint || order.sourceYard || order.vendorYard || "").trim();
  if (!options.length) return current;
  const matched = options.find((option) => String(option.yard || "").trim().toLowerCase() === current.toLowerCase());
  return String(matched?.yard || options[0]?.yard || current).trim();
}

async function listScmVendorYardOptionsForRefs(refs = [], executor = query) {
  const cleanRefs = [...new Set((Array.isArray(refs) ? refs : [])
    .map((ref) => String(ref || "").trim())
    .filter(Boolean))];
  if (!cleanRefs.length) return new Map();
  const runQuery = typeof executor === "function" ? executor : executor.query.bind(executor);
  const result = await runQuery(
    `WITH requested(ref) AS (
       SELECT unnest($1::text[])
     ),
     matched_po AS (
       SELECT DISTINCT
              r.ref AS requested_ref,
              po.netsuite_id,
              po.tranid,
              po.dispatch_ref,
              po.vendor_id::text AS vendor_id,
              po.vendor
         FROM requested r
         JOIN purchase_orders po
           ON lower(po.tranid) = lower(r.ref)
           OR lower(COALESCE(po.dispatch_ref, '')) = lower(r.ref)
           OR po.netsuite_id::text = r.ref
        WHERE po.netsuite_active = true
     ),
     mapped_po AS (
       SELECT p.*,
              COALESCE(NULLIF(m.local_vendor, ''), '') AS local_vendor
         FROM matched_po p
         LEFT JOIN dispatch_vendor_mappings m
           ON m.active = true
          AND COALESCE(m.local_vendor, '') <> ''
          AND (
            (COALESCE(p.vendor_id, '') <> '' AND m.netsuite_vendor_id::text = p.vendor_id)
            OR lower(m.netsuite_vendor_name) = lower(p.vendor)
          )
     )
     SELECT DISTINCT ON (requested_ref, lower(y.yard))
            requested_ref,
            tranid,
            COALESCE(NULLIF(dispatch_ref, ''), tranid) AS display_ref,
            netsuite_id,
            local_vendor,
            y.id,
            y.vendor,
            y.yard,
            y.day_label,
            y.window_start,
            y.window_end,
            y.instructions,
            y.address
       FROM mapped_po p
       JOIN dispatch_vendor_yards y
         ON y.active = true
        AND lower(y.vendor) = lower(p.local_vendor)
      WHERE p.local_vendor <> ''
        AND p.local_vendor <> $2
      ORDER BY requested_ref, lower(y.yard),
        CASE y.day_label
          WHEN 'Mon-Fri' THEN 0
          WHEN 'Monday' THEN 1
          ELSE 2
        END,
        y.id`,
    [cleanRefs, useNetSuiteAddressMappingValue()]
  );
  const map = new Map();
  const add = (key, option) => {
    const cleanKey = String(key || "").trim().toLowerCase();
    if (!cleanKey) return;
    const list = map.get(cleanKey) || [];
    if (!list.some((existing) => String(existing.yard || "").toLowerCase() === String(option.yard || "").toLowerCase())) {
      list.push(option);
    }
    map.set(cleanKey, list);
  };
  for (const row of result.rows) {
    const option = {
      id: row.id,
      vendor: row.vendor || row.local_vendor || "",
      yard: row.yard || "",
      dayLabel: row.day_label || "",
      windowStart: row.window_start || "",
      windowEnd: row.window_end || "",
      instructions: row.instructions || "",
      address: row.address || ""
    };
    add(row.requested_ref, option);
    add(row.tranid, option);
    add(row.display_ref, option);
    add(row.netsuite_id, option);
  }
  return map;
}

async function resolveScmPurchaseOrderPickupYard(client, source = {}, pickupPoint = "") {
  const requested = String(pickupPoint || "").trim();
  if (!requested) return null;
  const optionsByRef = await listScmVendorYardOptionsForRefs([
    source.tranid,
    source.dispatch_ref,
    source.netsuite_id
  ], client);
  const options = optionsByRef.get(String(source.tranid || "").toLowerCase())
    || optionsByRef.get(String(source.dispatch_ref || "").toLowerCase())
    || optionsByRef.get(String(source.netsuite_id || "").toLowerCase())
    || [];
  const selected = options.find((option) =>
    String(option.yard || "").trim().toLowerCase() === requested.toLowerCase()
    || String(option.id || "") === requested
  );
  if (!selected) {
    throw new Error(`Pickup yard ${requested} is not available for ${source.tranid || source.dispatch_ref || "this PO"} vendor mapping.`);
  }
  return selected;
}

function vendorYardInstructions(yard = {}) {
  return `${yard.dayLabel || ""}${yard.instructions ? ` | ${yard.instructions}` : ""}`.trim();
}

function normalizeScmStatus(value) {
  const allowed = new Set(["Queued", "Planned", "Completed", "Urgent", "Cancelled", "Hold", "Priority", "Surplus Only", "Book Appt"]);
  const text = String(value || "").trim();
  return allowed.has(text) ? text : "Queued";
}

function normalizeManualScmStatus(value) {
  const allowed = new Set(["Queued", "Urgent", "Cancelled", "Hold", "Priority", "Surplus Only", "Book Appt"]);
  const text = String(value || "").trim();
  if (!text) return "Queued";
  if (!allowed.has(text)) {
    throw new Error(`${text} is controlled by dispatch or driver status and cannot be set manually.`);
  }
  return text;
}

function normalizeScmMethod(value) {
  const text = String(value || "").trim();
  if (text === "Vendor" || text === "Customer Pickup") return text;
  return "MBT";
}

function normalizeScmOrderKind(value) {
  const text = String(value || "").trim().toUpperCase();
  if (text === "TO" || text === "VRMA") return text;
  return "PO";
}

function normalizeScmScheduleFilterValues(value, { lowercase = false } = {}) {
  const source = Array.isArray(value) ? value : String(value || "").split(",");
  const values = source.map((item) => String(item || "").trim()).filter(Boolean);
  return [...new Set(values.map((item) => lowercase ? item.toLowerCase() : item))];
}

function scmDisplayRef(row = {}) {
  return row.dispatch_ref || row.display_ref || row.order_ref || row.tranid || row.vrma_ref || "";
}

async function listScmVrmaSchedule({
  search = "",
  status = "",
  method = "",
  yard = "",
  brand = "",
  from = "",
  to = "",
  view = ""
} = {}) {
  const params = [
    String(search || "").trim().toLowerCase(),
    normalizeScmScheduleFilterValues(status),
    String(method || "").trim(),
    String(yard || "").trim(),
    normalizeScmScheduleFilterValues(brand, { lowercase: true }),
    String(from || "").trim() || null,
    String(to || "").trim() || null,
    String(view || "").trim()
  ];
  const result = await query(
    `WITH line_summary AS (
       SELECT l.vrma_order_id,
              string_agg(
                trim(concat_ws(' ',
                  COALESCE(NULLIF(l.sku, ''), NULLIF(l.item_name, ''), 'Item'),
                  CASE
                    WHEN COALESCE(l.pallet_qty, 0) + COALESCE(l.layer_qty, 0) + COALESCE(l.section_qty, 0) + COALESCE(l.piece_qty, 0) > 0
                      THEN trim(concat_ws(' ',
                        CASE WHEN COALESCE(l.pallet_qty, 0) > 0 THEN trim(to_char(l.pallet_qty, 'FM999999999990.##')) || ' PLT' END,
                        CASE WHEN COALESCE(l.layer_qty, 0) > 0 THEN trim(to_char(l.layer_qty, 'FM999999999990.##')) || ' LYR' END,
                        CASE WHEN COALESCE(l.section_qty, 0) > 0 THEN trim(to_char(l.section_qty, 'FM999999999990.##')) || ' SEC' END,
                        CASE WHEN COALESCE(l.piece_qty, 0) > 0 THEN trim(to_char(l.piece_qty, 'FM999999999990.##')) || ' PCS' END
                      ))
                    ELSE trim(concat_ws(' ',
                      trim(to_char(COALESCE(l.quantity, 0), 'FM999999999990.######')),
                      NULLIF(l.unit, '')
                    ))
                  END
                )),
                '; ' ORDER BY l.id
              ) AS content,
              COALESCE(SUM(l.pallet_qty), 0) AS total_pallet_qty,
              COALESCE(SUM(l.weight_lbs), 0) AS weight_lbs
         FROM scm_vrma_order_lines l
        GROUP BY l.vrma_order_id
     ),
     planned AS (
       SELECT DISTINCT ON (LOWER(a.order_ref))
              a.order_ref,
              a.plan_date AS eta_date,
              COALESCE(a.eta_time, '') AS eta_time,
              COALESCE(a.driver, '') AS driver,
              trim(concat_ws(' ', NULLIF(a.truck_plate, ''), NULLIF(a.load_name, ''))) AS notes
         FROM dispatch_vrma_plan_assignments a
         JOIN dispatch_plans p ON p.id = a.plan_id AND p.status <> 'cancelled'
        ORDER BY LOWER(a.order_ref), a.plan_date DESC, a.updated_at DESC
     ),
     vrma_rows AS (
       SELECT
         COALESCE(s.id, 0) AS schedule_id,
         'VRMA'::text AS order_kind,
         'scm_vrma_orders'::text AS source_table,
         v.id AS source_id,
         v.vrma_ref AS source_ref,
         v.vrma_ref AS order_ref,
         ''::text AS dispatch_ref,
         COALESCE(v.local_vendor, v.vendor, 'Vendor Return') AS party,
         COALESCE(NULLIF(s.display_ref, ''), v.vrma_ref) AS display_ref,
         COALESCE(s.is_special_order, false) AS is_special_order,
         'MBT'::text AS method,
         v.pickup_location AS pickup_point,
         v.dropoff_location AS dropoff_point,
         COALESCE(v.local_vendor, v.vendor, '') AS brand,
         COALESCE(NULLIF(s.content, ''), summary.content, '') AS content,
         COALESCE(summary.total_pallet_qty, 0) AS total_pallet_qty,
         COALESCE(NULLIF(s.weight_lbs, 0), summary.weight_lbs, 0) AS weight_lbs,
         COALESCE(NULLIF(s.packing_slip_ref, ''), '') AS packing_slip_ref,
         COALESCE(s.group_ref, '') AS group_ref,
         CASE
           WHEN COALESCE(s.status, '') IN ('Completed', 'Cancelled', 'Hold') THEN s.status
           WHEN planned.order_ref IS NOT NULL THEN 'Planned'
           WHEN COALESCE(s.status, '') = 'Planned' THEN COALESCE(v.status, 'Queued')
           ELSE COALESCE(s.status, v.status, 'Queued')
         END AS status,
         COALESCE(s.created_at, v.created_at) AS queued_at,
         COALESCE(s.eta_date, planned.eta_date) AS eta_date,
         COALESCE(NULLIF(s.eta_time, ''), planned.eta_time, '') AS eta_time,
         COALESCE(NULLIF(s.driver, ''), planned.driver, '') AS driver,
         COALESCE(NULLIF(s.notes, ''), planned.notes, '') AS notes,
         s.updated_at,
         s.updated_by
       FROM scm_vrma_orders v
       LEFT JOIN line_summary summary ON summary.vrma_order_id = v.id
       LEFT JOIN scm_transport_schedule s
         ON s.order_kind = 'VRMA'
        AND LOWER(s.order_ref) = LOWER(v.vrma_ref)
       LEFT JOIN planned ON LOWER(planned.order_ref) = LOWER(v.vrma_ref)
     )
     SELECT *,
            CASE
              WHEN eta_date IS NULL OR queued_at IS NULL THEN NULL
              ELSE eta_date - queued_at::date
            END AS sla_days
       FROM vrma_rows
      WHERE ($1 = '' OR LOWER(CONCAT_WS(' ', order_ref, party, pickup_point, dropoff_point, brand, content, packing_slip_ref, group_ref)) LIKE '%' || $1 || '%')
        AND (cardinality($2::text[]) = 0 OR status = ANY($2::text[]))
        AND ($3 = '' OR method = $3)
        AND ($4 = '' OR dropoff_point = $4)
        AND (cardinality($5::text[]) = 0 OR LOWER(brand) = ANY($5::text[]))
        AND ($6::date IS NULL OR eta_date >= $6::date)
        AND ($7::date IS NULL OR eta_date <= $7::date)
        AND ($8 <> 'dispatch' OR (method = 'MBT' AND status NOT IN ('Cancelled', 'Hold')))
        AND ($8 <> 'completed' OR status = 'Completed')
      ORDER BY
        CASE status
          WHEN 'Urgent' THEN 0
          WHEN 'Priority' THEN 1
          WHEN 'Queued' THEN 2
          WHEN 'Book Appt' THEN 3
          WHEN 'Surplus Only' THEN 4
          WHEN 'Planned' THEN 5
          WHEN 'Completed' THEN 6
          WHEN 'Hold' THEN 7
          ELSE 9
        END,
        eta_date NULLS LAST,
        order_ref
      LIMIT 1000`,
    params
  );
  return result.rows.map((row) => ({
    scheduleId: Number(row.schedule_id || 0),
    orderKind: "VRMA",
    sourceTable: row.source_table,
    sourceId: row.source_id,
    sourceRef: row.source_ref,
    orderRef: row.order_ref,
    dispatchRef: "",
    party: row.party || "",
    displayRef: row.display_ref || row.order_ref,
    isSpecialOrder: row.is_special_order === true,
    method: "MBT",
    pickupPoint: row.pickup_point || "",
    dropoffPoint: row.dropoff_point || "",
    brand: row.brand || "",
    content: row.content || "",
    totalPalletQty: Number(row.total_pallet_qty || 0),
    weightLbs: Number(row.weight_lbs || 0),
    packingSlipRef: row.packing_slip_ref || "",
    groupRef: row.group_ref || "",
    status: row.status || "Queued",
    queuedDate: dateOnly(row.queued_at),
    etaDate: dateOnly(row.eta_date),
    etaTime: row.eta_time || "",
    driver: row.driver || "",
    sla: row.sla_days === null || row.sla_days === undefined ? "" : `${Number(row.sla_days)} day${Number(row.sla_days) === 1 ? "" : "s"}`,
    slaDays: row.sla_days === null || row.sla_days === undefined ? null : Number(row.sla_days),
    notes: row.notes || "",
    updatedAt: row.updated_at,
    updatedBy: row.updated_by || ""
  }));
}

export async function listScmSchedule({
  search = "",
  status = "",
  method = "",
  kind = "",
  yard = "",
  brand = "",
  from = "",
  to = "",
  view = ""
} = {}) {
  const globalSearch = String(search || "").trim().toLowerCase();
  const cleanKind = String(kind || "").trim().toUpperCase();
  if (!globalSearch && cleanKind === "VRMA") {
    return listScmVrmaSchedule({
      search: "",
      status,
      method,
      yard,
      brand,
      from,
      to,
      view
    });
  }
  const params = [
    globalSearch,
    globalSearch ? [] : normalizeScmScheduleFilterValues(status),
    globalSearch ? "" : String(method || "").trim(),
    globalSearch ? "" : cleanKind,
    globalSearch ? "" : String(yard || "").trim(),
    globalSearch ? [] : normalizeScmScheduleFilterValues(brand, { lowercase: true }),
    globalSearch ? null : String(from || "").trim() || null,
    globalSearch ? null : String(to || "").trim() || null,
    globalSearch ? "" : String(view || "").trim()
  ];
  const result = await query(
    `
    WITH base_po AS (
      SELECT
        'PO'::text AS order_kind,
        'purchase_orders'::text AS source_table,
        po.netsuite_id AS source_id,
        COALESCE(active_split.source_po_ref, po.tranid) AS source_ref,
        COALESCE(NULLIF(po.dispatch_ref, ''), po.tranid) AS order_ref,
        po.dispatch_ref,
        po.vendor AS party,
        COALESCE(NULLIF(po.dispatch_vendor_yard, ''), NULLIF(po.source_location, ''), po.vendor) AS pickup_point,
        po.destination_location AS dropoff_point,
        COALESCE(NULLIF(po.dispatch_vendor_yard, ''), po.vendor) AS brand,
        string_agg(
          CASE
            WHEN COALESCE(l.to_plt, 0) <> 0 OR COALESCE(l.to_lyr, 0) <> 0 OR COALESCE(l.to_sec, 0) <> 0 OR COALESCE(l.to_pcs, 0) <> 0 THEN
              trim(concat_ws(' ',
                COALESCE(NULLIF(l.sku, ''), NULLIF(l.item_name, ''), 'Item'),
                NULLIF(trim(concat_ws(' ',
                  CASE WHEN GREATEST(COALESCE(l.pallet_qty, 0) - COALESCE(l.received_pallet_qty, 0), 0) > 0 THEN trim(to_char(GREATEST(COALESCE(l.pallet_qty, 0) - COALESCE(l.received_pallet_qty, 0), 0), 'FM999999999990.##')) || ' PLT' END,
                  CASE WHEN GREATEST(COALESCE(l.layer_qty, 0) - COALESCE(l.received_layer_qty, 0), 0) > 0 THEN trim(to_char(GREATEST(COALESCE(l.layer_qty, 0) - COALESCE(l.received_layer_qty, 0), 0), 'FM999999999990.##')) || ' LYR' END,
                  CASE WHEN GREATEST(COALESCE(l.section_qty, 0) - COALESCE(l.received_section_qty, 0), 0) > 0 THEN trim(to_char(GREATEST(COALESCE(l.section_qty, 0) - COALESCE(l.received_section_qty, 0), 0), 'FM999999999990.##')) || ' SEC' END,
                  CASE WHEN GREATEST(COALESCE(l.piece_qty, 0) - COALESCE(l.received_piece_qty, 0), 0) > 0 THEN trim(to_char(GREATEST(COALESCE(l.piece_qty, 0) - COALESCE(l.received_piece_qty, 0), 0), 'FM999999999990.##')) || ' PCS' END
                )), '')
              ))
            ELSE
              trim(concat_ws(' ',
                COALESCE(NULLIF(l.sku, ''), NULLIF(l.item_name, ''), 'Item'),
                trim(to_char(GREATEST(COALESCE(l.quantity, 0) - COALESCE(l.netsuite_received_baseline_qty, l.netsuite_received_qty, 0), 0), 'FM999999999990.######')),
                NULLIF(l.unit, '')
              ))
          END,
          E'\n' ORDER BY l.line_id NULLS LAST, l.id
        ) FILTER (
          WHERE l.id IS NOT NULL
            AND (
              CASE
                WHEN COALESCE(l.to_plt, 0) <> 0 OR COALESCE(l.to_lyr, 0) <> 0 OR COALESCE(l.to_sec, 0) <> 0 OR COALESCE(l.to_pcs, 0) <> 0 THEN
                  GREATEST(COALESCE(l.pallet_qty, 0) - COALESCE(l.received_pallet_qty, 0), 0)
                  + GREATEST(COALESCE(l.layer_qty, 0) - COALESCE(l.received_layer_qty, 0), 0)
                  + GREATEST(COALESCE(l.section_qty, 0) - COALESCE(l.received_section_qty, 0), 0)
                  + GREATEST(COALESCE(l.piece_qty, 0) - COALESCE(l.received_piece_qty, 0), 0)
                ELSE GREATEST(COALESCE(l.quantity, 0) - COALESCE(l.netsuite_received_baseline_qty, l.netsuite_received_qty, 0), 0)
              END
            ) > 0
        ) AS content,
        po.expected_delivery_date,
        COALESCE(po.synced_at, po.status_updated_at, now()) AS queued_at,
        COALESCE(SUM(GREATEST(COALESCE(l.pallet_qty, 0) - COALESCE(l.received_pallet_qty, 0), 0)), 0) AS total_pallet_qty,
        COALESCE(SUM(GREATEST(COALESCE(l.quantity, 0) - COALESCE(l.netsuite_received_baseline_qty, l.netsuite_received_qty, 0), 0) * COALESCE(l.item_weight, 0)), 0) AS weight_lbs
      FROM purchase_orders po
      LEFT JOIN dispatch_scm_po_splits active_split
        ON active_split.split_po_id = po.netsuite_id
       AND active_split.status = 'active'
      LEFT JOIN scm_transport_schedule member_schedule
        ON member_schedule.order_kind = 'PO'
       AND lower(member_schedule.order_ref) = lower(COALESCE(NULLIF(po.dispatch_ref, ''), po.tranid))
      LEFT JOIN scm_schedule_groups active_group
        ON active_group.status = 'active'
       AND lower(active_group.group_ref) = lower(COALESCE(member_schedule.group_ref, ''))
      LEFT JOIN purchase_order_lines l ON l.purchase_order_id = po.netsuite_id AND l.netsuite_active = true
      WHERE po.netsuite_active = true
        AND (
          active_group.id IS NULL
          OR lower(COALESCE(NULLIF(po.dispatch_ref, ''), po.tranid)) = lower(active_group.group_ref)
        )
      GROUP BY po.netsuite_id, active_split.source_po_ref
    ),
    base_to AS (
      SELECT
        'TO'::text AS order_kind,
        'transfer_orders'::text AS source_table,
        t.netsuite_id AS source_id,
        t.tranid AS source_ref,
        t.tranid AS order_ref,
        NULL::text AS dispatch_ref,
        COALESCE(t.from_location, 'Transfer Order') AS party,
        t.from_location AS pickup_point,
        t.to_location AS dropoff_point,
        'Transfer'::text AS brand,
        string_agg(
          CASE
            WHEN COALESCE(l.to_plt, 0) <> 0 OR COALESCE(l.to_lyr, 0) <> 0 OR COALESCE(l.to_sec, 0) <> 0 OR COALESCE(l.to_pcs, 0) <> 0 THEN
              trim(concat_ws(' ',
                COALESCE(NULLIF(l.sku, ''), NULLIF(l.item_name, ''), 'Item'),
                NULLIF(trim(concat_ws(' ',
                  CASE WHEN GREATEST(COALESCE(l.pallet_qty, 0) - GREATEST(COALESCE(l.fulfilled_pallet_qty, 0), COALESCE(l.received_pallet_qty, 0)), 0) > 0 THEN trim(to_char(GREATEST(COALESCE(l.pallet_qty, 0) - GREATEST(COALESCE(l.fulfilled_pallet_qty, 0), COALESCE(l.received_pallet_qty, 0)), 0), 'FM999999999990.##')) || ' PLT' END,
                  CASE WHEN GREATEST(COALESCE(l.layer_qty, 0) - GREATEST(COALESCE(l.fulfilled_layer_qty, 0), COALESCE(l.received_layer_qty, 0)), 0) > 0 THEN trim(to_char(GREATEST(COALESCE(l.layer_qty, 0) - GREATEST(COALESCE(l.fulfilled_layer_qty, 0), COALESCE(l.received_layer_qty, 0)), 0), 'FM999999999990.##')) || ' LYR' END,
                  CASE WHEN GREATEST(COALESCE(l.section_qty, 0) - GREATEST(COALESCE(l.fulfilled_section_qty, 0), COALESCE(l.received_section_qty, 0)), 0) > 0 THEN trim(to_char(GREATEST(COALESCE(l.section_qty, 0) - GREATEST(COALESCE(l.fulfilled_section_qty, 0), COALESCE(l.received_section_qty, 0)), 0), 'FM999999999990.##')) || ' SEC' END,
                  CASE WHEN GREATEST(COALESCE(l.piece_qty, 0) - GREATEST(COALESCE(l.fulfilled_piece_qty, 0), COALESCE(l.received_piece_qty, 0)), 0) > 0 THEN trim(to_char(GREATEST(COALESCE(l.piece_qty, 0) - GREATEST(COALESCE(l.fulfilled_piece_qty, 0), COALESCE(l.received_piece_qty, 0)), 0), 'FM999999999990.##')) || ' PCS' END
                )), '')
              ))
            ELSE
              trim(concat_ws(' ',
                COALESCE(NULLIF(l.sku, ''), NULLIF(l.item_name, ''), 'Item'),
                trim(to_char(GREATEST(COALESCE(l.quantity, 0) - GREATEST(COALESCE(l.netsuite_received_qty, 0), COALESCE(l.loaded_qty, 0)), 0), 'FM999999999990.######')),
                NULLIF(l.unit, '')
              ))
          END,
          E'\n' ORDER BY l.line_id NULLS LAST, l.id
        ) FILTER (
          WHERE l.id IS NOT NULL
            AND (
              CASE
                WHEN COALESCE(l.to_plt, 0) <> 0 OR COALESCE(l.to_lyr, 0) <> 0 OR COALESCE(l.to_sec, 0) <> 0 OR COALESCE(l.to_pcs, 0) <> 0 THEN
                  GREATEST(COALESCE(l.pallet_qty, 0) - GREATEST(COALESCE(l.fulfilled_pallet_qty, 0), COALESCE(l.received_pallet_qty, 0)), 0)
                  + GREATEST(COALESCE(l.layer_qty, 0) - GREATEST(COALESCE(l.fulfilled_layer_qty, 0), COALESCE(l.received_layer_qty, 0)), 0)
                  + GREATEST(COALESCE(l.section_qty, 0) - GREATEST(COALESCE(l.fulfilled_section_qty, 0), COALESCE(l.received_section_qty, 0)), 0)
                  + GREATEST(COALESCE(l.piece_qty, 0) - GREATEST(COALESCE(l.fulfilled_piece_qty, 0), COALESCE(l.received_piece_qty, 0)), 0)
                ELSE GREATEST(COALESCE(l.quantity, 0) - GREATEST(COALESCE(l.netsuite_received_qty, 0), COALESCE(l.loaded_qty, 0)), 0)
              END
            ) > 0
        ) AS content,
        t.expected_delivery_date,
        COALESCE(t.synced_at, t.status_updated_at, now()) AS queued_at,
        COALESCE(SUM(GREATEST(COALESCE(l.pallet_qty, 0) - GREATEST(COALESCE(l.fulfilled_pallet_qty, 0), COALESCE(l.received_pallet_qty, 0)), 0)), 0) AS total_pallet_qty,
        COALESCE(SUM(GREATEST(COALESCE(l.quantity, 0) - COALESCE(l.netsuite_received_qty, 0), 0) * COALESCE(l.item_weight, 0)), 0) AS weight_lbs
      FROM transfer_orders t
      LEFT JOIN transfer_order_lines l ON l.transfer_order_id = t.netsuite_id AND l.netsuite_active = true
      WHERE t.netsuite_active = true
        AND t.to_location_id IS NOT NULL
      GROUP BY t.netsuite_id
    ),
    base_vrma AS (
      SELECT
        'VRMA'::text AS order_kind,
        'scm_vrma_orders'::text AS source_table,
        v.id AS source_id,
        v.vrma_ref AS source_ref,
        v.vrma_ref AS order_ref,
        NULL::text AS dispatch_ref,
        COALESCE(v.local_vendor, v.vendor, 'Vendor Return') AS party,
        v.pickup_location AS pickup_point,
        v.dropoff_location AS dropoff_point,
        COALESCE(v.local_vendor, v.vendor) AS brand,
        string_agg(
          trim(concat_ws(' ',
            COALESCE(NULLIF(l.sku, ''), NULLIF(l.item_name, ''), 'Item'),
            CASE
              WHEN COALESCE(l.pallet_qty, 0) + COALESCE(l.layer_qty, 0) + COALESCE(l.section_qty, 0) + COALESCE(l.piece_qty, 0) > 0
                THEN trim(concat_ws(' ',
                  CASE WHEN COALESCE(l.pallet_qty, 0) > 0 THEN trim(to_char(l.pallet_qty, 'FM999999999990.##')) || ' PLT' END,
                  CASE WHEN COALESCE(l.layer_qty, 0) > 0 THEN trim(to_char(l.layer_qty, 'FM999999999990.##')) || ' LYR' END,
                  CASE WHEN COALESCE(l.section_qty, 0) > 0 THEN trim(to_char(l.section_qty, 'FM999999999990.##')) || ' SEC' END,
                  CASE WHEN COALESCE(l.piece_qty, 0) > 0 THEN trim(to_char(l.piece_qty, 'FM999999999990.##')) || ' PCS' END
                ))
              ELSE trim(concat_ws(' ',
                trim(to_char(COALESCE(l.quantity, 0), 'FM999999999990.######')),
                NULLIF(l.unit, '')
              ))
            END
          )),
          '; ' ORDER BY l.id
        ) FILTER (WHERE l.id IS NOT NULL) AS content,
        NULL::date AS expected_delivery_date,
        v.created_at AS queued_at,
        COALESCE(SUM(l.pallet_qty), 0) AS total_pallet_qty,
        COALESCE(SUM(l.weight_lbs), 0) AS weight_lbs
      FROM scm_vrma_orders v
      LEFT JOIN scm_vrma_order_lines l ON l.vrma_order_id = v.id
      GROUP BY v.id
    ),
    base AS (
      SELECT * FROM base_po
      UNION ALL SELECT * FROM base_to
      UNION ALL SELECT * FROM base_vrma
    ),
    plan_order_types AS MATERIALIZED (
      SELECT snap.plan_id,
             item.value->>'id' AS order_ref,
             CASE
               WHEN item.value->>'sourceTable' = 'scm_vrma_orders' THEN 'VRMA'
               WHEN item.value->>'type' = 'TO' THEN 'TO'
               ELSE 'PO'
             END AS order_kind
        FROM dispatch_plan_snapshots snap
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(snap.orders, '[]'::jsonb)) item(value)
       WHERE item.value->>'type' IN ('PO', 'TO')
          OR item.value->>'sourceTable' = 'scm_vrma_orders'
    ),
    planned AS (
      SELECT DISTINCT ON (plan_order.order_kind, plan_order.order_ref)
        plan_order.order_kind,
        plan_order.order_ref,
        p.plan_date AS eta_date,
        COALESCE(NULLIF(stop.value->>'arriveTime', ''), NULLIF(stop.value->>'plannedArrive', ''), '') AS eta_time,
        COALESCE(NULLIF(truck.value->>'driverName', ''), NULLIF(truck.value->>'driver', ''), '') AS driver,
        trim(concat_ws(' ', NULLIF(truck.value->>'plate', ''), NULLIF(load.value->>'name', ''))) AS notes
      FROM dispatch_plans p
      JOIN dispatch_plan_snapshots snap ON snap.plan_id = p.id
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(snap.trucks, '[]'::jsonb)) truck(value)
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(truck.value->'loads', '[]'::jsonb)) load(value)
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(load.value->'stops', '[]'::jsonb)) stop(value)
      JOIN plan_order_types plan_order
        ON plan_order.plan_id = snap.plan_id
       AND plan_order.order_ref = stop.value->>'orderId'
      WHERE stop.value->>'type' = 'drop'
        AND COALESCE(stop.value->>'orderId', '') <> ''
        AND COALESCE(load.value->>'returnOnly', 'false') <> 'true'
      ORDER BY plan_order.order_kind, plan_order.order_ref, p.plan_date DESC,
               COALESCE(NULLIF(stop.value->>'arriveTime', ''), NULLIF(stop.value->>'plannedArrive', ''), '') DESC
    )
    SELECT
      COALESCE(s.id, 0) AS schedule_id,
      b.order_kind,
      b.source_table,
      b.source_id,
      b.source_ref,
      b.order_ref,
      b.dispatch_ref,
      b.party,
      COALESCE(NULLIF(s.display_ref, ''), b.order_ref) AS display_ref,
      COALESCE(s.is_special_order, false) AS is_special_order,
      CASE WHEN b.order_kind = 'VRMA' THEN 'MBT' ELSE COALESCE(s.method, 'MBT') END AS method,
      NULLIF(s.pickup_point, '') AS schedule_pickup_point,
      CASE WHEN b.order_kind = 'VRMA'
        THEN COALESCE(b.pickup_point, '')
        ELSE COALESCE(NULLIF(s.pickup_point, ''), b.pickup_point, '') END AS pickup_point,
      CASE WHEN b.order_kind = 'VRMA'
        THEN COALESCE(b.dropoff_point, '')
        ELSE COALESCE(NULLIF(s.dropoff_point, ''), b.dropoff_point, '') END AS dropoff_point,
      CASE WHEN b.order_kind = 'VRMA'
        THEN COALESCE(b.brand, '')
        ELSE COALESCE(NULLIF(s.brand, ''), b.brand, '') END AS brand,
      COALESCE(NULLIF(s.content, ''), b.content, '') AS content,
      COALESCE(b.total_pallet_qty, 0) AS total_pallet_qty,
      COALESCE(NULLIF(s.weight_lbs, 0), b.weight_lbs, 0) AS weight_lbs,
      COALESCE(NULLIF(s.packing_slip_ref, ''), b.dispatch_ref, '') AS packing_slip_ref,
      COALESCE(s.group_ref, '') AS group_ref,
      CASE
        WHEN COALESCE(s.status, '') IN ('Completed', 'Cancelled', 'Hold') THEN s.status
        WHEN planned.order_ref IS NOT NULL THEN 'Planned'
        ELSE COALESCE(s.status, 'Queued')
      END AS status,
      COALESCE(s.created_at, b.queued_at) AS queued_at,
      COALESCE(s.eta_date, planned.eta_date, b.expected_delivery_date) AS eta_date,
      COALESCE(NULLIF(s.eta_time, ''), planned.eta_time, '') AS eta_time,
      COALESCE(NULLIF(s.driver, ''), planned.driver, '') AS driver,
      CASE
        WHEN COALESCE(s.eta_date, planned.eta_date, b.expected_delivery_date) IS NULL OR COALESCE(s.created_at, b.queued_at) IS NULL THEN NULL
        ELSE COALESCE(s.eta_date, planned.eta_date, b.expected_delivery_date) - COALESCE(s.created_at, b.queued_at)::date
      END AS sla_days,
      COALESCE(NULLIF(s.notes, ''), planned.notes, '') AS notes,
      s.updated_at,
      s.updated_by
    FROM base b
    LEFT JOIN scm_transport_schedule s
      ON s.order_kind = b.order_kind
     AND lower(s.order_ref) = lower(b.order_ref)
    LEFT JOIN planned
      ON planned.order_kind = b.order_kind
     AND lower(planned.order_ref) = lower(b.order_ref)
    WHERE ($1 = '' OR lower(concat_ws(' ', b.order_ref, b.source_ref, b.dispatch_ref, b.party, b.pickup_point, b.dropoff_point, b.brand, b.content, s.packing_slip_ref, s.group_ref)) LIKE '%' || $1 || '%')
      AND (cardinality($2::text[]) = 0 OR (
        CASE
          WHEN COALESCE(s.status, '') IN ('Completed', 'Cancelled', 'Hold') THEN s.status
          WHEN planned.order_ref IS NOT NULL THEN 'Planned'
          ELSE COALESCE(s.status, 'Queued')
        END
      ) = ANY($2::text[]))
      AND ($3 = '' OR COALESCE(s.method, 'MBT') = $3)
      AND ($4 = '' OR b.order_kind = $4)
      AND (
        $5 = ''
        OR COALESCE(s.dropoff_point, b.dropoff_point, '') = $5
        OR regexp_split_to_array(regexp_replace(COALESCE(s.dropoff_point, b.dropoff_point, ''), '\\s+', '', 'g'), '\\+') @> ARRAY[$5]
      )
      AND (cardinality($6::text[]) = 0 OR lower(COALESCE(NULLIF(s.brand, ''), b.brand, '')) = ANY($6::text[]))
      AND ($7::date IS NULL OR COALESCE(s.eta_date, planned.eta_date, b.expected_delivery_date) >= $7::date)
      AND ($8::date IS NULL OR COALESCE(s.eta_date, planned.eta_date, b.expected_delivery_date) <= $8::date)
      AND (
        $9 = ''
        OR $9 <> 'dispatch'
        OR (COALESCE(s.method, 'MBT') = 'MBT' AND (
          CASE
            WHEN COALESCE(s.status, '') IN ('Completed', 'Cancelled', 'Hold') THEN s.status
            WHEN planned.order_ref IS NOT NULL THEN 'Planned'
            ELSE COALESCE(s.status, 'Queued')
          END
        ) NOT IN ('Cancelled', 'Hold'))
      )
      AND (
        $9 = ''
        OR $9 <> 'completed'
        OR COALESCE(s.status, 'Queued') = 'Completed'
      )
    ORDER BY
      CASE (
        CASE
          WHEN COALESCE(s.status, '') IN ('Completed', 'Cancelled', 'Hold') THEN s.status
          WHEN planned.order_ref IS NOT NULL THEN 'Planned'
          ELSE COALESCE(s.status, 'Queued')
        END
      )
        WHEN 'Urgent' THEN 0
        WHEN 'Priority' THEN 1
        WHEN 'Queued' THEN 2
        WHEN 'Book Appt' THEN 3
        WHEN 'Surplus Only' THEN 4
        WHEN 'Planned' THEN 5
        WHEN 'Completed' THEN 6
        WHEN 'Hold' THEN 7
        ELSE 9
      END,
      COALESCE(s.eta_date, planned.eta_date, b.expected_delivery_date) NULLS LAST,
      b.order_ref
    LIMIT 1000
    `,
    params
  );
  const poIds = Array.from(new Set(
    result.rows
      .filter((row) => row.order_kind === "PO" && row.source_id)
      .map((row) => String(row.source_id))
  ));
  const [poDetails, schedulePoEnricher] = poIds.length
    ? await Promise.all([
      query(
        `SELECT po.netsuite_id,
                po.tranid,
                po.dispatch_ref,
                po.vendor_id,
                po.vendor,
                po.memo,
                po.vendor_address,
                po.dispatch_vendor_yard,
                vendor_map.local_vendor
           FROM purchase_orders po
           LEFT JOIN dispatch_vendor_mappings vendor_map
             ON vendor_map.active = true
            AND COALESCE(vendor_map.local_vendor, '') <> ''
            AND (
              (COALESCE(po.vendor_id::text, '') <> '' AND vendor_map.netsuite_vendor_id::text = po.vendor_id::text)
              OR lower(vendor_map.netsuite_vendor_name) = lower(po.vendor)
            )
          WHERE po.netsuite_id::text = ANY($1::text[])`,
        [poIds]
      ),
      createPurchaseOrderDispatchEnricher({ allowOllama: false })
    ])
    : [{ rows: [] }, null];
  const poById = new Map(poDetails.rows.map((row) => [String(row.netsuite_id), row]));
  const enrichmentCache = new Map();
  const enrichPoForSchedule = async (po) => {
    const key = [
      po.vendor_id || "",
      po.vendor || "",
      po.memo || "",
      po.tranid || po.dispatch_ref || "",
      po.vendor_address || ""
    ].join("|");
    if (!enrichmentCache.has(key)) {
      enrichmentCache.set(key, schedulePoEnricher(po, { mappedLocalVendor: po.local_vendor || "" }));
    }
    return enrichmentCache.get(key);
  };
  const useNetSuiteAddressValue = useNetSuiteAddressMappingValue();
  const rows = await Promise.all(result.rows.map(async (row) => {
    let pickupPoint = row.pickup_point || "";
    let brand = row.brand || "";
    if (row.order_kind === "PO") {
      const po = poById.get(String(row.source_id));
      if (po) {
        const localVendor = String(po.local_vendor || "").trim();
        if (localVendor && localVendor !== useNetSuiteAddressValue) {
          brand = localVendor;
        } else if (localVendor === useNetSuiteAddressValue) {
          brand = po.vendor || brand;
        }
        if (!row.schedule_pickup_point) {
          const enriched = await enrichPoForSchedule(po);
          pickupPoint = enriched.dispatch_vendor_yard || pickupPoint;
        }
      }
    }
    return {
      scheduleId: Number(row.schedule_id || 0),
      orderKind: row.order_kind,
      sourceTable: row.source_table,
      sourceId: row.source_id,
      sourceRef: row.source_ref,
      orderRef: row.order_ref,
      dispatchRef: row.dispatch_ref || "",
      party: row.party || "",
      displayRef: row.display_ref || row.order_ref,
      isSpecialOrder: row.is_special_order === true,
      method: row.method || "MBT",
      pickupPoint,
      dropoffPoint: row.dropoff_point || "",
      brand,
      content: row.content || "",
      totalPalletQty: Number(row.total_pallet_qty || 0),
      weightLbs: Number(row.weight_lbs || 0),
      packingSlipRef: row.packing_slip_ref || "",
      groupRef: row.group_ref || "",
      status: row.status || "Queued",
      queuedDate: dateOnly(row.queued_at),
      etaDate: dateOnly(row.eta_date),
      etaTime: row.eta_time || "",
      driver: row.driver || "",
      sla: row.sla_days === null || row.sla_days === undefined ? "" : `${Number(row.sla_days)} day${Number(row.sla_days) === 1 ? "" : "s"}`,
      slaDays: row.sla_days === null || row.sla_days === undefined ? null : Number(row.sla_days),
      notes: row.notes || "",
      updatedAt: row.updated_at,
      updatedBy: row.updated_by || ""
    };
  }));
  return rows;
}

export async function updateScmScheduleEntry({
  orderKind = "PO",
  orderRef = "",
  patch = {},
  updatedBy = ""
} = {}) {
  const kind = normalizeScmOrderKind(orderKind);
  const ref = String(orderRef || "").trim();
  if (!ref) throw new Error("SCM order ref is required.");
  const existing = await query(
    `SELECT *
       FROM scm_transport_schedule
      WHERE order_kind = $1 AND lower(order_ref) = lower($2)
      LIMIT 1`,
    [kind, ref]
  );
  const current = existing.rows[0] || {};
  const has = (camel, snake = camel) => Object.prototype.hasOwnProperty.call(patch, camel)
    || Object.prototype.hasOwnProperty.call(patch, snake);
  const pickText = (camel, snake = camel, fallback = "") => {
    if (!has(camel, snake)) return fallback;
    return String(patch[camel] ?? patch[snake] ?? "").trim();
  };
  const next = {
    displayRef: pickText("displayRef", "display_ref", current.display_ref || ""),
    isSpecialOrder: has("isSpecialOrder", "is_special_order")
      ? patch.isSpecialOrder === true || patch.is_special_order === true
      : current.is_special_order === true,
    method: has("method") ? normalizeScmMethod(patch.method) : current.method || "MBT",
    pickupPoint: pickText("pickupPoint", "pickup_point", current.pickup_point || ""),
    dropoffPoint: pickText("dropoffPoint", "dropoff_point", current.dropoff_point || ""),
    brand: pickText("brand", "brand", current.brand || ""),
    content: pickText("content", "content", current.content || ""),
    weightLbs: has("weightLbs", "weight_lbs") ? positiveQuantity(patch.weightLbs ?? patch.weight_lbs) : positiveQuantity(current.weight_lbs),
    packingSlipRef: pickText("packingSlipRef", "packing_slip_ref", current.packing_slip_ref || ""),
    groupRef: pickText("groupRef", "group_ref", current.group_ref || ""),
    status: has("status") ? normalizeManualScmStatus(patch.status) : current.status || "Queued",
    etaDate: pickText("etaDate", "eta_date", dateOnly(current.eta_date)),
    etaTime: pickText("etaTime", "eta_time", current.eta_time || ""),
    driver: pickText("driver", "driver", current.driver || ""),
    sla: pickText("sla", "sla", current.sla || ""),
    notes: pickText("notes", "notes", current.notes || "")
  };
  if (kind === "VRMA") {
    const routeResult = await query(
      `SELECT v.pickup_location, v.dropoff_location, COALESCE(v.local_vendor, v.vendor, '') AS local_vendor
         FROM scm_vrma_orders v
         JOIN dispatch_local_vendors lv
           ON lv.active = true
          AND LOWER(lv.name) = LOWER(COALESCE(v.local_vendor, v.vendor, ''))
         JOIN dispatch_vendor_yards y
           ON y.active = true
          AND LOWER(y.vendor) = LOWER(lv.name)
          AND LOWER(y.yard) = LOWER(v.dropoff_location)
        WHERE LOWER(v.vrma_ref) = LOWER($1)
          AND v.pickup_location IN ('3445', '2967', '12441', '150')
        LIMIT 1`,
      [ref]
    );
    const route = routeResult.rows[0];
    if (!route) throw new Error("VRMA route must be one of our yards to an active local vendor yard.");
    next.method = "MBT";
    next.pickupPoint = route.pickup_location;
    next.dropoffPoint = route.dropoff_location;
    next.brand = route.local_vendor;
  }
  const result = await query(
    `INSERT INTO scm_transport_schedule (
       order_kind, order_ref, display_ref, is_special_order, method,
       pickup_point, dropoff_point, brand, content, weight_lbs,
       packing_slip_ref, group_ref, status, eta_date, eta_time,
       driver, sla, notes, updated_by, created_by
     )
     VALUES (
       $1, $2, NULLIF($3, ''), $4, $5,
       NULLIF($6, ''), NULLIF($7, ''), NULLIF($8, ''), NULLIF($9, ''), COALESCE($10::numeric, 0),
       NULLIF($11, ''), NULLIF($12, ''), $13, $14::date, NULLIF($15, ''),
       NULLIF($16, ''), NULLIF($17, ''), NULLIF($18, ''), $19, $19
     )
     ON CONFLICT (order_kind, order_ref) DO UPDATE SET
       display_ref = EXCLUDED.display_ref,
       is_special_order = EXCLUDED.is_special_order,
       method = EXCLUDED.method,
       pickup_point = EXCLUDED.pickup_point,
       dropoff_point = EXCLUDED.dropoff_point,
       brand = EXCLUDED.brand,
       content = EXCLUDED.content,
       weight_lbs = EXCLUDED.weight_lbs,
       packing_slip_ref = EXCLUDED.packing_slip_ref,
       group_ref = EXCLUDED.group_ref,
       status = EXCLUDED.status,
       eta_date = EXCLUDED.eta_date,
       eta_time = EXCLUDED.eta_time,
       driver = EXCLUDED.driver,
       sla = EXCLUDED.sla,
       notes = EXCLUDED.notes,
       updated_by = EXCLUDED.updated_by,
       updated_at = now()
     RETURNING *`,
    [
      kind,
      ref,
      next.displayRef,
      next.isSpecialOrder,
      next.method,
      next.pickupPoint,
      next.dropoffPoint,
      next.brand,
      next.content,
      next.weightLbs,
      next.packingSlipRef,
      next.groupRef,
      next.status,
      next.etaDate || null,
      next.etaTime,
      next.driver,
      next.sla,
      next.notes,
      updatedBy || null
    ]
  );
  if (kind === "PO" && has("packingSlipRef", "packing_slip_ref")) {
    await updatePurchaseOrderDispatchRef({
      poRef: ref,
      newRef: next.packingSlipRef,
      updatedBy
    });
  }
  return result.rows[0];
}

function buildScmGroupRef(refs = []) {
  const cleaned = [...new Set((refs || []).map((ref) => String(ref || "").trim()).filter(Boolean))];
  if (cleaned.length < 2) throw new Error("Select at least two refs to group.");
  return `PGOB-${cleaned.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })).join("-")}`;
}

export async function createScmScheduleGroup({ refs = [], createdBy = "" } = {}) {
  const groupRef = buildScmGroupRef(refs);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const members = [];
    for (const ref of refs) {
      const row = await client.query(
        `SELECT po.*,
                s.pickup_point AS schedule_pickup_point,
                s.dropoff_point AS schedule_dropoff_point
           FROM purchase_orders po
           LEFT JOIN scm_transport_schedule s
             ON s.order_kind = 'PO'
            AND lower(s.order_ref) = lower(COALESCE(NULLIF(po.dispatch_ref, ''), po.tranid))
          WHERE lower(po.tranid) = lower($1)
             OR lower(COALESCE(po.dispatch_ref, '')) = lower($1)
          ORDER BY CASE WHEN lower(COALESCE(po.dispatch_ref, '')) = lower($1) THEN 0 ELSE 1 END,
                   po.netsuite_active DESC,
                   po.synced_at DESC NULLS LAST
          LIMIT 1`,
        [ref]
      );
      const po = row.rows[0];
      if (!po) throw new Error(`SCM PO ${ref} was not found.`);
      if (!po.netsuite_active) throw new Error(`${ref} is inactive and cannot be grouped.`);
      if (String(po.tranid || "").toLowerCase().startsWith("pgob-")) throw new Error(`${ref} is already a grouped PO.`);
      const existingGroup = await client.query(
        `SELECT group_ref
           FROM scm_transport_schedule
          WHERE order_kind = 'PO'
            AND lower(order_ref) = lower(COALESCE(NULLIF($1, ''), $2))
            AND COALESCE(group_ref, '') <> ''
          LIMIT 1`,
        [po.dispatch_ref || "", po.tranid]
      );
      if (existingGroup.rows[0]?.group_ref && existingGroup.rows[0].group_ref !== groupRef) {
        throw new Error(`${ref} is already grouped under ${existingGroup.rows[0].group_ref}.`);
      }
      const enriched = await enrichPurchaseOrderDispatch(po);
      const schedulePickupPoint = String(po.schedule_pickup_point || "").trim();
      const scheduleDropoffPoint = String(po.schedule_dropoff_point || "").trim();
      const schedulePickupYard = schedulePickupPoint
        ? await client.query(
          `SELECT yard, address, window_start, window_end, instructions, day_label
             FROM dispatch_vendor_yards
            WHERE active = true
              AND lower(yard) = lower($1)
            ORDER BY CASE WHEN day_label = 'Mon-Fri' THEN 0 ELSE 1 END, id
            LIMIT 1`,
          [schedulePickupPoint]
        )
        : { rows: [] };
      const pickupYard = schedulePickupYard.rows[0] || {};
      members.push({
        ...po,
        order_ref: po.dispatch_ref || po.tranid,
        pickup_point: schedulePickupPoint || enriched.dispatch_vendor_yard || po.dispatch_vendor_yard || po.source_location || po.vendor || "",
        dropoff_point: scheduleDropoffPoint || po.destination_location || "",
        dropoff_location_id: normalizeScmDestinationLocationId(scheduleDropoffPoint) || po.destination_location_id || null,
        pickup_address: pickupYard.address || enriched.dispatch_address || po.dispatch_address || "",
        pickup_window_start: pickupYard.window_start || enriched.dispatch_window_start || po.dispatch_window_start || "",
        pickup_window_end: pickupYard.window_end || enriched.dispatch_window_end || po.dispatch_window_end || "",
        pickup_instructions: pickupYard.yard
          ? `${pickupYard.day_label || ""}${pickupYard.instructions ? ` | ${pickupYard.instructions}` : ""}`.trim()
          : enriched.dispatch_instructions || po.dispatch_instructions || ""
      });
    }
    const pickupKeys = [...new Set(members.map((member) => String(member.pickup_point || "").trim().toLowerCase()).filter(Boolean))];
    if (pickupKeys.length !== 1) {
      throw new Error(`Cannot group orders with different pickup points: ${members.map((member) => `${member.order_ref}=${member.pickup_point || "blank"}`).join(", ")}`);
    }
    const pickupPoint = members[0]?.pickup_point || "";
    const pickupAddress = members[0]?.pickup_address || "";
    const pickupWindowStart = members[0]?.pickup_window_start || "";
    const pickupWindowEnd = members[0]?.pickup_window_end || "";
    const pickupInstructions = members[0]?.pickup_instructions || "";
    const memberRefs = members.map((member) => member.order_ref);
    const destinationNames = [...new Set(members.map((member) => member.dropoff_point || "").filter(Boolean))];
    const destinationIds = [...new Set(members.map((member) => String(member.dropoff_location_id || "")).filter(Boolean))];
    const groupOrderId = syntheticPurchaseOrderId(`scm-schedule-group:${groupRef}`);
    const group = await client.query(
      `INSERT INTO scm_schedule_groups (group_ref, created_by, details)
       VALUES ($1, $2, '{}'::jsonb)
       ON CONFLICT (group_ref) DO UPDATE SET status = 'active', cancelled_at = NULL, details = EXCLUDED.details
       RETURNING *`,
      [groupRef, createdBy || null]
    );
    const groupId = group.rows[0].id;
    await client.query(
      `UPDATE scm_schedule_groups
          SET details = $2::jsonb
        WHERE id = $1`,
      [
        groupId,
        JSON.stringify({
          memberRefs,
          pickupPoint,
          dropoffPoints: destinationNames,
          syntheticPurchaseOrderId: groupOrderId
        })
      ]
    );
    await client.query(
      `INSERT INTO purchase_orders (
         netsuite_id, tranid, trandate, vendor_id, vendor, status, status_text, foreign_total,
         destination_location_id, destination_location, memo, dispatch_vendor_yard, dispatch_address,
         dispatch_window_start, dispatch_window_end, dispatch_instructions, receipt_status,
         netsuite_active, synced_at, source_location_id, source_location, expected_delivery_date,
         dispatch_parse_source, dispatch_note_hash, dispatch_parsed_at, netsuite_missing_at,
         last_item_receipt_id, last_item_receipt_tranid, received_at, status_updated_at,
         dispatch_ref, dispatch_ref_updated_at, dispatch_ref_updated_by, vendor_address
       ) VALUES (
         $1, $2, CURRENT_DATE, NULL, $3, 'B', 'Purchase Order : Pending Receipt', 0,
         $4::bigint, $5, $6, $7, $8,
         $9, $10, $11, 'pending',
         true, now(), NULL, $7, NULL,
         'scm-schedule-group', $12, now(), NULL,
         NULL, NULL, NULL, now(),
         $2, now(), $13, NULL
       )
       ON CONFLICT (netsuite_id) DO UPDATE SET
         tranid = EXCLUDED.tranid,
         vendor = EXCLUDED.vendor,
         status_text = EXCLUDED.status_text,
         destination_location_id = EXCLUDED.destination_location_id,
         destination_location = EXCLUDED.destination_location,
         memo = EXCLUDED.memo,
         dispatch_vendor_yard = EXCLUDED.dispatch_vendor_yard,
         dispatch_address = EXCLUDED.dispatch_address,
         dispatch_window_start = EXCLUDED.dispatch_window_start,
         dispatch_window_end = EXCLUDED.dispatch_window_end,
         dispatch_instructions = EXCLUDED.dispatch_instructions,
         netsuite_active = true,
         synced_at = now(),
         source_location = EXCLUDED.source_location,
         dispatch_parse_source = EXCLUDED.dispatch_parse_source,
         dispatch_note_hash = EXCLUDED.dispatch_note_hash,
         dispatch_parsed_at = now(),
         status_updated_at = now(),
         dispatch_ref = EXCLUDED.dispatch_ref,
         dispatch_ref_updated_at = now(),
         dispatch_ref_updated_by = EXCLUDED.dispatch_ref_updated_by`,
      [
        groupOrderId,
        groupRef,
        pickupPoint || "SCM Group",
        destinationIds.length === 1 ? Number(destinationIds[0]) : null,
        destinationNames.join(" + "),
        `SCM grouped PO: ${memberRefs.join(", ")}`,
        pickupPoint,
        pickupAddress,
        pickupWindowStart,
        pickupWindowEnd,
        pickupInstructions,
        repositoryHashText(`${groupRef}|${memberRefs.join("|")}|${pickupPoint}`),
        createdBy || null
      ]
    );
    await client.query(
      `UPDATE purchase_order_lines
          SET netsuite_active = false,
              synced_at = now()
        WHERE purchase_order_id = $1`,
      [groupOrderId]
    );
    const lineRows = await client.query(
      `SELECT l.*, po.tranid, COALESCE(NULLIF(po.dispatch_ref, ''), po.tranid) AS source_ref
         FROM purchase_order_lines l
         JOIN purchase_orders po ON po.netsuite_id = l.purchase_order_id
        WHERE po.netsuite_id = ANY($1::bigint[])
          AND l.netsuite_active = true
          AND GREATEST(COALESCE(l.quantity, 0) - COALESCE(l.netsuite_received_baseline_qty, l.netsuite_received_qty, 0), 0) > 0`,
      [members.map((member) => member.netsuite_id)]
    );
    for (const line of lineRows.rows) {
      const groupLineId = syntheticPurchaseOrderId(`scm-schedule-group-line:${groupRef}:${line.purchase_order_id}:${line.id}`);
      await client.query(
        `INSERT INTO purchase_order_lines (
           id, purchase_order_id, line_id, item_id, item_name, sku, item_description, item_type,
           item_type_text, quantity, unit, location_id, location, pallet_qty, layer_qty,
           section_qty, piece_qty, to_plt, to_lyr, to_sec, to_pcs, received_pallet_qty,
           received_layer_qty, received_section_qty, received_piece_qty, netsuite_received_qty,
           netsuite_active, sync_exception, synced_at, item_weight, sync_exception_at, raw,
           confirmed_at, confirmed_by
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8,
           $9, $10, $11, $12, $13, $14, $15,
           $16, $17, $18, $19, $20, $21, 0,
           0, 0, 0, 0,
           true, null, now(), $22, null, $23::jsonb,
           null, null
         )
         ON CONFLICT (id) DO UPDATE SET
           quantity = EXCLUDED.quantity,
           pallet_qty = EXCLUDED.pallet_qty,
           layer_qty = EXCLUDED.layer_qty,
           section_qty = EXCLUDED.section_qty,
           piece_qty = EXCLUDED.piece_qty,
           netsuite_active = true,
           synced_at = now(),
           raw = EXCLUDED.raw`,
        [
          groupLineId,
          groupOrderId,
          line.line_id,
          line.item_id,
          line.item_name,
          line.sku,
          line.item_description,
          line.item_type,
          line.item_type_text,
          Math.max(positiveQuantity(line.quantity) - purchaseOrderReceivedBaseline(line), 0),
          line.unit,
          line.location_id,
          line.location,
          Math.max(positiveQuantity(line.pallet_qty) - positiveQuantity(line.received_pallet_qty), 0),
          Math.max(positiveQuantity(line.layer_qty) - positiveQuantity(line.received_layer_qty), 0),
          Math.max(positiveQuantity(line.section_qty) - positiveQuantity(line.received_section_qty), 0),
          Math.max(positiveQuantity(line.piece_qty) - positiveQuantity(line.received_piece_qty), 0),
          line.to_plt,
          line.to_lyr,
          line.to_sec,
          line.to_pcs,
          line.item_weight,
          JSON.stringify({
            scmGroup: true,
            groupRef,
            sourcePoRef: line.source_ref,
            sourcePoId: line.purchase_order_id,
            sourceLineId: line.id
          })
        ]
      );
    }
    await client.query(
      `INSERT INTO scm_transport_schedule (
         order_kind, order_ref, display_ref, method, pickup_point, dropoff_point,
         brand, packing_slip_ref, group_ref, status, content, weight_lbs, updated_by, created_by
       ) VALUES (
         'PO', $1, $1, 'MBT', $2, $3,
         $4, $1, $1, 'Queued', $5, $6, $7, $7
       )
       ON CONFLICT (order_kind, order_ref) DO UPDATE SET
         display_ref = EXCLUDED.display_ref,
         method = EXCLUDED.method,
         pickup_point = EXCLUDED.pickup_point,
         dropoff_point = EXCLUDED.dropoff_point,
         brand = EXCLUDED.brand,
         packing_slip_ref = EXCLUDED.packing_slip_ref,
         group_ref = EXCLUDED.group_ref,
         status = CASE WHEN scm_transport_schedule.status IN ('Completed', 'Cancelled', 'Hold') THEN scm_transport_schedule.status ELSE EXCLUDED.status END,
         content = EXCLUDED.content,
         weight_lbs = EXCLUDED.weight_lbs,
         updated_by = EXCLUDED.updated_by,
         updated_at = now()`,
      [
        groupRef,
        pickupPoint,
        destinationNames.join(" + "),
        pickupPoint || "SCM Group",
        "",
        lineRows.rows.reduce((sum, line) => sum + (Math.max(positiveQuantity(line.quantity) - purchaseOrderReceivedBaseline(line), 0) * positiveQuantity(line.item_weight)), 0),
        createdBy || null
      ]
    );
    for (const found of members.map((member) => ({ order_kind: "PO", order_ref: member.order_ref }))) {
      await client.query(
        `INSERT INTO scm_transport_schedule (order_kind, order_ref, group_ref, updated_by, created_by)
         VALUES ($1, $2, $3, $4, $4)
         ON CONFLICT (order_kind, order_ref) DO UPDATE SET group_ref = EXCLUDED.group_ref, updated_by = EXCLUDED.updated_by, updated_at = now()
         RETURNING id`,
        [found.order_kind, found.order_ref, groupRef, createdBy || null]
      );
      await client.query(
        `INSERT INTO scm_schedule_group_members (group_id, order_kind, order_ref)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [groupId, found.order_kind, found.order_ref]
      );
    }
    await client.query("COMMIT");
    return { groupRef, count: refs.length, syntheticPurchaseOrderId: groupOrderId, pickupPoint, memberRefs };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => null);
    throw error;
  } finally {
    client.release();
  }
}

export async function cancelScmScheduleGroup({ groupRef = "", cancelledBy = "" } = {}) {
  const ref = String(groupRef || "").trim();
  if (!ref) throw new Error("Group ref is required.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const groupResult = await client.query(
      `SELECT *
         FROM scm_schedule_groups
        WHERE lower(group_ref) = lower($1)
        LIMIT 1`,
      [ref]
    );
    const group = groupResult.rows[0];
    const syntheticPurchaseOrderId = group?.details?.syntheticPurchaseOrderId || syntheticPurchaseOrderIdForGroup(ref);
    await client.query(
      `UPDATE scm_schedule_groups
          SET status = 'cancelled', cancelled_at = now()
        WHERE lower(group_ref) = lower($1)`,
      [ref]
    );
    await client.query(
      `UPDATE scm_transport_schedule
          SET group_ref = NULL, updated_by = $2, updated_at = now()
        WHERE lower(group_ref) = lower($1)`,
      [ref, cancelledBy || null]
    );
    await client.query(
      `UPDATE purchase_order_lines
          SET netsuite_active = false,
              synced_at = now()
        WHERE purchase_order_id = $1`,
      [syntheticPurchaseOrderId]
    );
    await client.query(
      `UPDATE purchase_orders
          SET netsuite_active = false,
              status_text = COALESCE(status_text, '') || ' (SCM group cancelled)',
              status_updated_at = now(),
              synced_at = now()
        WHERE netsuite_id = $1 OR lower(tranid) = lower($2)`,
      [syntheticPurchaseOrderId, ref]
    );
    await client.query("COMMIT");
    return { groupRef: ref };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => null);
    throw error;
  } finally {
    client.release();
  }
}

export async function listScmViewPresets() {
  const result = await query(
    `SELECT id, name, description, config, active, updated_at
       FROM scm_view_presets
      WHERE active = true
      ORDER BY name`
  );
  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description || "",
    config: row.config || {},
    active: row.active,
    updatedAt: row.updated_at
  }));
}

export async function upsertScmViewPreset({ id = null, name = "", description = "", config = {}, updatedBy = "" } = {}) {
  const cleanName = String(name || "").trim();
  if (!cleanName) throw new Error("View name is required.");
  const result = await query(
    `INSERT INTO scm_view_presets (id, name, description, config, updated_by, created_by)
     VALUES (COALESCE($1::bigint, nextval('scm_view_presets_id_seq')), $2, $3, $4::jsonb, $5, $5)
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       description = EXCLUDED.description,
       config = EXCLUDED.config,
       updated_by = EXCLUDED.updated_by,
       updated_at = now()
     RETURNING id, name, description, config, active, updated_at`,
    [id, cleanName, String(description || "").trim(), JSON.stringify(config || {}), updatedBy || null]
  );
  return result.rows[0];
}

export async function getScmVrmaOptions() {
  const result = await query(
    `SELECT y.id, y.vendor, y.yard, y.address, y.day_label, y.window_start, y.window_end, y.instructions
       FROM dispatch_local_vendors v
       JOIN dispatch_vendor_yards y ON LOWER(y.vendor) = LOWER(v.name)
      WHERE v.active = true
        AND y.active = true
      ORDER BY v.name, y.yard, y.day_label, y.id`
  );
  const byVendor = new Map();
  for (const row of result.rows) {
    const name = String(row.vendor || "").trim();
    if (!name) continue;
    if (!byVendor.has(name)) byVendor.set(name, { name, yards: [] });
    const vendor = byVendor.get(name);
    if (vendor.yards.some((yard) => yard.name.toLowerCase() === String(row.yard || "").trim().toLowerCase())) continue;
    vendor.yards.push({
      id: row.id,
      name: row.yard || "",
      address: row.address || "",
      dayLabel: row.day_label || "",
      windowStart: row.window_start || "",
      windowEnd: row.window_end || "",
      instructions: row.instructions || ""
    });
  }
  return {
    ownYards: SCM_VRMA_OWN_YARDS.map((yard) => ({ ...yard })),
    localVendors: [...byVendor.values()]
  };
}

export async function searchScmVrmaItems({ search = "", limit = 20 } = {}) {
  const term = String(search || "").trim();
  if (term.length < 2) return [];
  const result = await query(
    `SELECT item_id, item_name, display_name, item_description, stock_unit, item_weight,
            to_plt, to_lyr, to_sec, to_pcs
       FROM inventory_items
      WHERE item_name ILIKE $1
         OR COALESCE(display_name, '') ILIKE $1
         OR COALESCE(item_description, '') ILIKE $1
      ORDER BY
        CASE WHEN LOWER(item_name) = LOWER($2) THEN 0
             WHEN LOWER(item_name) LIKE LOWER($2) || '%' THEN 1
             ELSE 2 END,
        item_name
      LIMIT $3`,
    [`%${term}%`, term, Math.min(Math.max(Number(limit) || 20, 1), 40)]
  );
  return result.rows.map((row) => ({
    itemId: row.item_id,
    sku: row.item_name || "",
    itemName: row.display_name || row.item_name || "",
    description: row.item_description || "",
    stockUnit: row.stock_unit || "",
    itemWeight: positiveQuantity(row.item_weight),
    toPlt: positiveQuantity(row.to_plt),
    toLyr: positiveQuantity(row.to_lyr),
    toSec: positiveQuantity(row.to_sec),
    toPcs: positiveQuantity(row.to_pcs)
  }));
}

export async function getScmVrmaOrder(vrmaRef = "") {
  const ref = String(vrmaRef || "").trim();
  if (!ref) return null;
  const headerResult = await query(
    `SELECT id, vrma_ref, vendor, local_vendor, pickup_location, dropoff_location,
            status, method, notes, created_at, updated_at
       FROM scm_vrma_orders
      WHERE LOWER(vrma_ref) = LOWER($1)
      LIMIT 1`,
    [ref]
  );
  const header = headerResult.rows[0];
  if (!header) return null;
  const lineResult = await query(
    `SELECT l.id, l.item_id, l.sku, l.item_name, l.item_description, l.quantity, l.unit,
            l.weight_lbs, l.pallet_qty, l.layer_qty, l.section_qty, l.piece_qty,
            l.to_plt, l.to_lyr, l.to_sec, l.to_pcs,
            i.stock_unit, i.item_weight
       FROM scm_vrma_order_lines l
       LEFT JOIN inventory_items i ON i.item_id = l.item_id
      WHERE l.vrma_order_id = $1
      ORDER BY l.id`,
    [header.id]
  );
  return {
    id: header.id,
    vrmaRef: header.vrma_ref,
    vendor: header.vendor || "",
    localVendor: header.local_vendor || header.vendor || "",
    pickupLocation: header.pickup_location || "",
    dropoffLocation: header.dropoff_location || "",
    status: header.status || "Queued",
    method: header.method || "MBT",
    notes: header.notes || "",
    createdAt: header.created_at,
    updatedAt: header.updated_at,
    lines: lineResult.rows.map((line) => ({
      id: line.id,
      itemId: line.item_id,
      sku: line.sku || "",
      itemName: line.item_name || line.sku || "",
      description: line.item_description || "",
      quantity: positiveQuantity(line.quantity),
      unit: line.unit || "",
      weightLbs: positiveQuantity(line.weight_lbs),
      palletQty: positiveQuantity(line.pallet_qty),
      layerQty: positiveQuantity(line.layer_qty),
      sectionQty: positiveQuantity(line.section_qty),
      pieceQty: positiveQuantity(line.piece_qty),
      toPlt: positiveQuantity(line.to_plt),
      toLyr: positiveQuantity(line.to_lyr),
      toSec: positiveQuantity(line.to_sec),
      toPcs: positiveQuantity(line.to_pcs),
      stockUnit: line.stock_unit || line.unit || "",
      itemWeight: positiveQuantity(line.item_weight)
    }))
  };
}

function vrmaUnit(value) {
  const unit = String(value || "").trim().toUpperCase();
  return SCM_VRMA_FALLBACK_UNITS.has(unit) ? unit : "";
}

function vrmaLineContent(line = {}) {
  const units = [
    ["PLT", line.palletQty],
    ["LYR", line.layerQty],
    ["SEC", line.sectionQty],
    ["PCS", line.pieceQty]
  ].filter(([, quantity]) => positiveQuantity(quantity) > 0)
    .map(([unit, quantity]) => `${positiveQuantity(quantity)} ${unit}`);
  const quantityText = units.length ? units.join(" ") : `${positiveQuantity(line.quantity)} ${line.unit || ""}`.trim();
  return `${line.sku || line.itemName || "Item"} ${quantityText}`.trim();
}

export async function createScmVrmaOrder({
  vrmaRef = "",
  vendor = "",
  localVendor = "",
  pickupLocation = "",
  dropoffLocation = "",
  status = "Queued",
  method = "MBT",
  notes = "",
  lines = [],
  createdBy = ""
} = {}) {
  const ref = String(vrmaRef || "").trim();
  if (!ref) throw new Error("VRMA ref is required.");
  if (!Array.isArray(lines) || !lines.length) throw new Error("At least one VRMA line is required.");
  const pickup = String(pickupLocation || "").trim();
  const selectedVendor = String(localVendor || vendor || "").trim();
  const requestedDropoff = String(dropoffLocation || "").trim();
  if (!SCM_VRMA_OWN_YARD_CODES.has(pickup)) throw new Error("VRMA pickup must be one of our local yards.");
  if (!selectedVendor) throw new Error("Local vendor is required.");
  if (!requestedDropoff) throw new Error("Vendor drop-off yard is required.");
  return withTransaction(async () => {
    const existingActivity = await query(
      `SELECT v.id, v.operator_status, v.preparing_operator_id, v.loaded_at,
              EXISTS (
                SELECT 1
                  FROM scm_vrma_order_lines line
                 WHERE line.vrma_order_id = v.id
                   AND (
                     COALESCE(line.packed_pallet_qty, 0) > 0
                     OR COALESCE(line.packed_layer_qty, 0) > 0
                     OR COALESCE(line.packed_section_qty, 0) > 0
                     OR COALESCE(line.packed_piece_qty, 0) > 0
                     OR COALESCE(line.packed_sales_qty, 0) > 0
                     OR COALESCE(line.loaded_qty, 0) > 0
                   )
              ) AS has_operator_activity
         FROM scm_vrma_orders v
        WHERE LOWER(v.vrma_ref) = LOWER($1)
        LIMIT 1`,
      [ref]
    );
    const activity = existingActivity.rows[0];
    if (activity && (
      activity.operator_status !== "open"
      || activity.preparing_operator_id
      || activity.loaded_at
      || activity.has_operator_activity
    )) {
      const error = new Error("This VRMA can no longer be edited because Operator packing or loading has started.");
      error.status = 409;
      throw error;
    }

    const vendorYardResult = await query(
      `SELECT y.yard, y.address, y.window_start, y.window_end, y.instructions, y.day_label
         FROM dispatch_local_vendors v
         JOIN dispatch_vendor_yards y ON LOWER(y.vendor) = LOWER(v.name)
        WHERE v.active = true
          AND y.active = true
          AND LOWER(v.name) = LOWER($1)
          AND LOWER(y.yard) = LOWER($2)
        ORDER BY y.id
        LIMIT 1`,
      [selectedVendor, requestedDropoff]
    );
    const vendorYard = vendorYardResult.rows[0];
    if (!vendorYard) throw new Error(`${requestedDropoff} is not an active yard for ${selectedVendor}.`);
    const normalizedLines = [];
    for (const [index, line] of lines.entries()) {
      const itemId = Number(line.itemId || line.item_id || 0);
      if (!Number.isFinite(itemId) || itemId <= 0) throw new Error(`Select an inventory item for VRMA line ${index + 1}.`);
      const itemResult = await query(
        `SELECT item_id, item_name, display_name, item_description, stock_unit, item_weight,
                to_plt, to_lyr, to_sec, to_pcs
           FROM inventory_items
          WHERE item_id = $1
          LIMIT 1`,
        [itemId]
      );
      const item = itemResult.rows[0];
      if (!item) throw new Error(`Inventory item ${itemId} is no longer available.`);
      const conversions = {
        toPlt: positiveQuantity(item.to_plt),
        toLyr: positiveQuantity(item.to_lyr),
        toSec: positiveQuantity(item.to_sec),
        toPcs: positiveQuantity(item.to_pcs)
      };
      const componentQuantities = {
        palletQty: conversions.toPlt ? positiveQuantity(line.palletQty ?? line.pallet_qty) : 0,
        layerQty: conversions.toLyr ? positiveQuantity(line.layerQty ?? line.layer_qty) : 0,
        sectionQty: conversions.toSec ? positiveQuantity(line.sectionQty ?? line.section_qty) : 0,
        pieceQty: conversions.toPcs ? positiveQuantity(line.pieceQty ?? line.piece_qty) : 0
      };
      const hasConversions = Object.values(conversions).some((value) => value > 0);
      let quantity = 0;
      let unit = "";
      if (hasConversions) {
        quantity = (componentQuantities.palletQty * conversions.toPlt)
          + (componentQuantities.layerQty * conversions.toLyr)
          + (componentQuantities.sectionQty * conversions.toSec)
          + (componentQuantities.pieceQty * conversions.toPcs);
        unit = String(item.stock_unit || "").trim();
        if (!Object.values(componentQuantities).some((value) => value > 0)) {
          throw new Error(`Enter at least one converted quantity for VRMA line ${index + 1}.`);
        }
      } else {
        quantity = positiveQuantity(line.quantity);
        unit = vrmaUnit(line.unit);
        if (!quantity) throw new Error(`Quantity is required for VRMA line ${index + 1}.`);
        if (!unit) throw new Error(`UOM for VRMA line ${index + 1} must be PLT, SQFT, or PC.`);
        if (unit === "PLT") componentQuantities.palletQty = quantity;
      }
      const itemWeight = positiveQuantity(item.item_weight);
      normalizedLines.push({
        itemId: item.item_id,
        sku: item.item_name || "",
        itemName: item.display_name || item.item_name || "",
        description: item.item_description || "",
        quantity,
        unit,
        weightLbs: quantity * itemWeight,
        ...componentQuantities,
        ...conversions
      });
    }
    if (!normalizedLines.length) throw new Error("At least one VRMA line is required.");

    const header = await query(
      `INSERT INTO scm_vrma_orders (vrma_ref, vendor, local_vendor, pickup_location, dropoff_location, status, method, notes, created_by, updated_by)
       VALUES ($1, NULLIF($2, ''), NULLIF($3, ''), NULLIF($4, ''), NULLIF($5, ''), $6, $7, NULLIF($8, ''), $9, $9)
       ON CONFLICT (vrma_ref) DO UPDATE SET
         vendor = EXCLUDED.vendor,
         local_vendor = EXCLUDED.local_vendor,
         pickup_location = EXCLUDED.pickup_location,
         dropoff_location = EXCLUDED.dropoff_location,
         status = EXCLUDED.status,
         method = EXCLUDED.method,
         notes = EXCLUDED.notes,
         updated_by = EXCLUDED.updated_by,
         updated_at = now()
       RETURNING *`,
      [
        ref,
        selectedVendor,
        selectedVendor,
        pickup,
        vendorYard.yard,
        normalizeManualScmStatus(status),
        "MBT",
        String(notes || "").trim(),
        createdBy || null
      ]
    );
    await query("DELETE FROM scm_vrma_order_lines WHERE vrma_order_id = $1", [header.rows[0].id]);
    for (const line of normalizedLines) {
      await query(
        `INSERT INTO scm_vrma_order_lines (
           vrma_order_id, item_id, sku, item_name, item_description, quantity, unit, weight_lbs,
           pallet_qty, layer_qty, section_qty, piece_qty, to_plt, to_lyr, to_sec, to_pcs
         ) VALUES (
           $1, $2, NULLIF($3, ''), $4, NULLIF($5, ''), $6, NULLIF($7, ''), $8,
           $9, $10, $11, $12, NULLIF($13, 0), NULLIF($14, 0), NULLIF($15, 0), NULLIF($16, 0)
         )`,
        [
          header.rows[0].id,
          line.itemId,
          line.sku,
          line.itemName,
          line.description,
          line.quantity,
          line.unit,
          line.weightLbs,
          line.palletQty,
          line.layerQty,
          line.sectionQty,
          line.pieceQty,
          line.toPlt,
          line.toLyr,
          line.toSec,
          line.toPcs
        ]
      );
    }
    await query(
      `INSERT INTO scm_transport_schedule (
         order_kind, source_table, source_id, order_ref, method, pickup_point, dropoff_point,
         brand, content, weight_lbs, status, notes, created_by, updated_by
       )
       SELECT 'VRMA', 'scm_vrma_orders', $1, $2, $3, NULLIF($4, ''), NULLIF($5, ''),
              NULLIF($6, ''), NULLIF($7, ''), COALESCE(SUM(weight_lbs), 0), $8, NULLIF($9, ''), $10, $10
         FROM scm_vrma_order_lines
        WHERE vrma_order_id = $1
       ON CONFLICT (order_kind, order_ref) DO UPDATE SET
         source_table = EXCLUDED.source_table,
         source_id = EXCLUDED.source_id,
         method = EXCLUDED.method,
         pickup_point = EXCLUDED.pickup_point,
         dropoff_point = EXCLUDED.dropoff_point,
         brand = EXCLUDED.brand,
         content = EXCLUDED.content,
         weight_lbs = EXCLUDED.weight_lbs,
         status = EXCLUDED.status,
         notes = EXCLUDED.notes,
         updated_by = EXCLUDED.updated_by,
         updated_at = now()`,
      [
        header.rows[0].id,
        ref,
        "MBT",
        pickup,
        vendorYard.yard,
        selectedVendor,
        normalizedLines.map(vrmaLineContent).join("; "),
        normalizeManualScmStatus(status),
        String(notes || "").trim(),
        createdBy || null
      ]
    );
    return { vrma: header.rows[0], vendorYard, lines: normalizedLines };
  });
}

export async function syncScmScheduleFromDispatchPlan(plan, { updatedBy = "dispatch-plan" } = {}) {
  if (!plan?.planDate || !Array.isArray(plan.trucks)) return { planned: 0 };
  const plannedRows = [];
  for (const truck of plan.trucks || []) {
    for (const load of truck.loads || []) {
      if (load.returnOnly) continue;
      for (const stop of load.stops || []) {
        if (stop.type !== "drop" || !stop.orderId) continue;
        const order = (plan.orders || []).find((item) => item.id === stop.orderId);
        if (order?.type !== "PO" && order?.type !== "TO" && order?.sourceTable !== "scm_vrma_orders") continue;
        plannedRows.push({
          orderRef: order.id,
          orderKind: order.sourceTable === "scm_vrma_orders" ? "VRMA" : order.type === "TO" ? "TO" : "PO",
          truckPlate: truck.plate || "",
          driver: truck.driverName || truck.driver || "",
          loadName: load.name || "",
          parkingSpot: load.parkingSpot || truck.parkingSpot || "",
          etaDate: plan.planDate,
          etaTime: stop.arriveTime || stop.plannedArrive || ""
        });
      }
    }
  }
  const vrmaAssignments = plannedRows.filter((row) => row.orderKind === "VRMA");
  if (plan.id) {
    await query("DELETE FROM dispatch_vrma_plan_assignments WHERE plan_id = $1", [plan.id]);
    for (const row of vrmaAssignments) {
      await query(
        `INSERT INTO dispatch_vrma_plan_assignments (
           plan_id, order_ref, plan_date, truck_plate, driver, load_name, parking_spot, eta_time, updated_at
         ) VALUES ($1, $2, $3::date, NULLIF($4, ''), NULLIF($5, ''), NULLIF($6, ''), NULLIF($7, ''), NULLIF($8, ''), now())
         ON CONFLICT (plan_id, order_ref) DO UPDATE SET
           plan_date = EXCLUDED.plan_date,
           truck_plate = EXCLUDED.truck_plate,
           driver = EXCLUDED.driver,
           load_name = EXCLUDED.load_name,
           parking_spot = EXCLUDED.parking_spot,
           eta_time = EXCLUDED.eta_time,
           updated_at = now()`,
        [plan.id, row.orderRef, row.etaDate, row.truckPlate, row.driver, row.loadName, row.parkingSpot, row.etaTime]
      );
    }
  }
  for (const row of plannedRows) {
    await query(
      `INSERT INTO scm_transport_schedule (
         order_kind, order_ref, method, status, eta_date, eta_time, driver, notes, updated_by, created_by
       )
       VALUES ($1, $2, 'MBT', 'Planned', $3::date, NULLIF($4, ''), NULLIF($5, ''), NULLIF($6, ''), $7, $7)
       ON CONFLICT (order_kind, order_ref) DO UPDATE SET
         method = CASE WHEN scm_transport_schedule.method IS NULL THEN 'MBT' ELSE scm_transport_schedule.method END,
         status = CASE
           WHEN scm_transport_schedule.status IN ('Completed', 'Cancelled', 'Hold') THEN scm_transport_schedule.status
           ELSE 'Planned'
         END,
         eta_date = EXCLUDED.eta_date,
         eta_time = EXCLUDED.eta_time,
         driver = EXCLUDED.driver,
         notes = COALESCE(NULLIF(scm_transport_schedule.notes, ''), EXCLUDED.notes),
         updated_by = EXCLUDED.updated_by,
         updated_at = now()`,
      [
        row.orderKind,
        row.orderRef,
        row.etaDate,
        row.etaTime,
        row.driver,
        `${row.truckPlate} ${row.loadName}`.trim(),
        updatedBy || null
      ]
    );
  }
  return { planned: plannedRows.length };
}

export async function updateScmPurchaseOrderSplitRef({
  splitPoRef = "",
  newPoRef = "",
  updatedBy = ""
} = {}) {
  const oldRef = String(splitPoRef || "").trim();
  const nextRef = String(newPoRef || "").trim();
  if (!oldRef) throw new Error("Current split PO ref is required.");
  if (!nextRef) throw new Error("New PO ref number is required.");
  if (oldRef.toLowerCase() === nextRef.toLowerCase()) throw new Error("The new PO ref is the same as the current ref.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const splitResult = await client.query(
      `SELECT *
         FROM dispatch_scm_po_splits
        WHERE lower(split_po_ref) = lower($1)
          AND status = 'active'
        LIMIT 1`,
      [oldRef]
    );
    const split = splitResult.rows[0];
    if (!split) throw new Error(`SCM split ${oldRef} was not found.`);
    const existing = await client.query(
      `SELECT tranid FROM purchase_orders
        WHERE lower(tranid) = lower($1)
          AND netsuite_id <> $3
       UNION
       SELECT dispatch_ref AS tranid FROM purchase_orders
        WHERE lower(dispatch_ref) = lower($1)
          AND netsuite_id <> $3
       UNION
       SELECT split_po_ref AS tranid FROM dispatch_scm_po_splits
        WHERE lower(split_po_ref) = lower($1)
          AND id <> $2`,
      [nextRef, split.id, split.split_po_id]
    );
    if (existing.rowCount) throw new Error(`PO ref ${nextRef} already exists.`);
    await client.query(
      `UPDATE purchase_orders
          SET dispatch_ref = $2,
              dispatch_ref_updated_at = now(),
              dispatch_ref_updated_by = $3,
              synced_at = now(),
              status_updated_at = now()
        WHERE netsuite_id = $1`,
      [split.split_po_id, nextRef, updatedBy || null]
    );
    await client.query(
      `UPDATE dispatch_scm_po_splits
          SET split_po_ref = $2,
              details = COALESCE(details, '{}'::jsonb) || $3::jsonb
        WHERE id = $1`,
      [
        split.id,
        nextRef,
        JSON.stringify({
          lastRenamedAt: new Date().toISOString(),
          lastRenamedBy: updatedBy || "",
          previousRefs: [...(Array.isArray(split.details?.previousRefs) ? split.details.previousRefs : []), oldRef]
        })
      ]
    );
    const snapshotUpdate = await updateDispatchSnapshotsForRef(client, { oldRef, newRef: nextRef });
    await client.query("COMMIT");
    return {
      splitId: split.id,
      sourcePoRef: split.source_po_ref,
      oldPoRef: oldRef,
      newPoRef: nextRef,
      updatedPlans: snapshotUpdate.planIds
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => null);
    throw error;
  } finally {
    client.release();
  }
}

export async function updatePurchaseOrderDispatchRef({
  poRef = "",
  newRef = "",
  updatedBy = ""
} = {}) {
  const lookupRef = String(poRef || "").trim();
  const requestedRef = String(newRef || "").trim();
  if (!lookupRef) throw new Error("Purchase order is required.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const poResult = await client.query(
      `SELECT netsuite_id, tranid, dispatch_ref
         FROM purchase_orders
        WHERE lower(tranid) = lower($1)
           OR lower(dispatch_ref) = lower($1)
        ORDER BY CASE WHEN lower(dispatch_ref) = lower($1) THEN 0 ELSE 1 END
        LIMIT 1`,
      [lookupRef]
    );
    const po = poResult.rows[0];
    if (!po) throw new Error(`Purchase order ${lookupRef} was not found.`);
    const oldVisibleRef = String(po.dispatch_ref || po.tranid || "").trim();
    const normalizedRef = requestedRef && requestedRef.toLowerCase() !== String(po.tranid || "").toLowerCase()
      ? requestedRef
      : "";
    const newVisibleRef = normalizedRef || po.tranid;
    if (normalizedRef) {
      const existing = await client.query(
        `SELECT tranid FROM purchase_orders
          WHERE (lower(tranid) = lower($1) OR lower(dispatch_ref) = lower($1))
            AND netsuite_id <> $2
         UNION
         SELECT split_po_ref AS tranid FROM dispatch_scm_po_splits
          WHERE lower(split_po_ref) = lower($1)
            AND split_po_id <> $2
            AND status = 'active'`,
        [normalizedRef, po.netsuite_id]
      );
      if (existing.rowCount) throw new Error(`PO ref ${normalizedRef} already exists.`);
    }
    await client.query(
      `UPDATE purchase_orders
          SET dispatch_ref = NULLIF($2, ''),
              dispatch_ref_updated_at = CASE WHEN COALESCE(dispatch_ref, '') IS DISTINCT FROM $2 THEN now() ELSE dispatch_ref_updated_at END,
              dispatch_ref_updated_by = CASE WHEN COALESCE(dispatch_ref, '') IS DISTINCT FROM $2 THEN $3 ELSE dispatch_ref_updated_by END,
              synced_at = now(),
              status_updated_at = now()
        WHERE netsuite_id = $1`,
      [po.netsuite_id, normalizedRef, updatedBy || null]
    );
    await client.query(
      `UPDATE scm_transport_schedule s
          SET order_ref = $2,
              packing_slip_ref = NULLIF($3, ''),
              updated_by = $4,
              updated_at = now()
        WHERE s.order_kind = 'PO'
          AND lower(s.order_ref) = lower($1)
          AND NOT EXISTS (
            SELECT 1
              FROM scm_transport_schedule duplicate
             WHERE duplicate.order_kind = 'PO'
               AND lower(duplicate.order_ref) = lower($2)
               AND duplicate.id <> s.id
          )`,
      [oldVisibleRef, newVisibleRef, normalizedRef, updatedBy || null]
    );
    const snapshotUpdate = oldVisibleRef !== newVisibleRef
      ? await updateDispatchSnapshotsForRef(client, { oldRef: oldVisibleRef, newRef: newVisibleRef })
      : { planIds: [] };
    await client.query("COMMIT");
    return {
      poId: po.netsuite_id,
      poRef: po.tranid,
      oldDisplayRef: oldVisibleRef,
      dispatchRef: normalizedRef,
      displayRef: newVisibleRef,
      updatedPlans: snapshotUpdate.planIds
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => null);
    throw error;
  } finally {
    client.release();
  }
}

export async function updateScmPurchaseOrderSplitDestination({
  splitPoRef = "",
  destinationLocationId = null,
  updatedBy = ""
} = {}) {
  const ref = String(splitPoRef || "").trim();
  if (!ref) throw new Error("Split PO ref is required.");
  const nextLocationId = normalizeScmDestinationLocationId(destinationLocationId);
  if (!nextLocationId) throw new Error("Destination yard is required.");
  const nextLocationText = locationTextFromId(nextLocationId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const splitResult = await client.query(
      `SELECT s.*, po.destination_location_id, po.destination_location
         FROM dispatch_scm_po_splits s
         INNER JOIN purchase_orders po ON po.netsuite_id = s.split_po_id
        WHERE lower(s.split_po_ref) = lower($1)
          AND s.status = 'active'
        LIMIT 1`,
      [ref]
    );
    const split = splitResult.rows[0];
    if (!split) throw new Error(`SCM split ${ref} was not found.`);
    const activity = await client.query(
      `SELECT COUNT(*)::int AS count
         FROM purchase_order_lines
        WHERE purchase_order_id = $1
          AND (
            COALESCE(received_pallet_qty, 0) > 0
            OR COALESCE(received_layer_qty, 0) > 0
            OR COALESCE(received_section_qty, 0) > 0
            OR COALESCE(received_piece_qty, 0) > 0
            OR COALESCE(netsuite_received_qty, 0) > 0
            OR confirmed_at IS NOT NULL
          )`,
      [split.split_po_id]
    );
    if (Number(activity.rows[0]?.count || 0) > 0) {
      throw new Error(`Cannot change ${ref} destination yard. It already has receiving activity.`);
    }
    await client.query(
      `UPDATE purchase_orders
          SET destination_location_id = $2,
              destination_location = $3,
              synced_at = now(),
              status_updated_at = now()
        WHERE netsuite_id = $1`,
      [split.split_po_id, nextLocationId, nextLocationText]
    );
    await client.query(
      `UPDATE purchase_order_lines
          SET location_id = $2,
              location = $3,
              synced_at = now()
        WHERE purchase_order_id = $1`,
      [split.split_po_id, nextLocationId, nextLocationText]
    );
    await client.query(
      `UPDATE dispatch_scm_po_splits
          SET details = COALESCE(details, '{}'::jsonb) || $2::jsonb
        WHERE id = $1`,
      [
        split.id,
        JSON.stringify({
          destinationLocationId: nextLocationId,
          destinationLocation: nextLocationText,
          lastDestinationUpdatedAt: new Date().toISOString(),
          lastDestinationUpdatedBy: updatedBy || "",
          previousDestinations: [
            ...(Array.isArray(split.details?.previousDestinations) ? split.details.previousDestinations : []),
            {
              destinationLocationId: split.destination_location_id,
              destinationLocation: split.destination_location || ""
            }
          ]
        })
      ]
    );
    await client.query("COMMIT");
    return {
      splitId: split.id,
      sourcePoRef: split.source_po_ref,
      splitPoRef: split.split_po_ref,
      splitPoId: split.split_po_id,
      oldDestinationLocationId: split.destination_location_id,
      oldDestinationLocation: split.destination_location || "",
      destinationLocationId: nextLocationId,
      destinationLocation: nextLocationText
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => null);
    throw error;
  } finally {
    client.release();
  }
}

export async function updateScmPurchaseOrderSplitPickupYard({
  splitPoRef = "",
  pickupPoint = "",
  updatedBy = ""
} = {}) {
  const ref = String(splitPoRef || "").trim();
  const requestedPickup = String(pickupPoint || "").trim();
  if (!ref) throw new Error("Split PO ref is required.");
  if (!requestedPickup) throw new Error("Pickup yard is required.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const splitResult = await client.query(
      `SELECT s.*, split_po.dispatch_vendor_yard, source_po.tranid AS source_tranid,
              source_po.dispatch_ref AS source_dispatch_ref, source_po.netsuite_id AS source_netsuite_id,
              source_po.vendor_id, source_po.vendor
         FROM dispatch_scm_po_splits s
         INNER JOIN purchase_orders split_po ON split_po.netsuite_id = s.split_po_id
         INNER JOIN purchase_orders source_po ON source_po.netsuite_id = s.source_po_id
        WHERE lower(s.split_po_ref) = lower($1)
          AND s.status = 'active'
        LIMIT 1`,
      [ref]
    );
    const split = splitResult.rows[0];
    if (!split) throw new Error(`SCM split ${ref} was not found.`);
    const selected = await resolveScmPurchaseOrderPickupYard(client, {
      tranid: split.source_tranid,
      dispatch_ref: split.source_dispatch_ref,
      netsuite_id: split.source_netsuite_id,
      vendor_id: split.vendor_id,
      vendor: split.vendor
    }, requestedPickup);
    const previousPickup = split.dispatch_vendor_yard || "";
    await client.query(
      `UPDATE purchase_orders
          SET dispatch_vendor_yard = $2,
              dispatch_address = $3,
              dispatch_window_start = $4,
              dispatch_window_end = $5,
              dispatch_instructions = $6,
              dispatch_parse_source = 'manual-scm-po-yard',
              dispatch_parsed_at = now(),
              synced_at = now(),
              status_updated_at = now()
        WHERE netsuite_id = $1`,
      [
        split.split_po_id,
        selected.yard || "",
        selected.address || "",
        selected.windowStart || "",
        selected.windowEnd || "",
        vendorYardInstructions(selected)
      ]
    );
    await client.query(
      `INSERT INTO scm_transport_schedule (
         order_kind, order_ref, pickup_point, brand, updated_by, created_by
       ) VALUES ('PO', $1, $2, NULLIF($3, ''), $4, $4)
       ON CONFLICT (order_kind, order_ref) DO UPDATE SET
         pickup_point = EXCLUDED.pickup_point,
         brand = COALESCE(scm_transport_schedule.brand, EXCLUDED.brand),
         updated_by = EXCLUDED.updated_by,
         updated_at = now()`,
      [split.split_po_ref, selected.yard || "", selected.vendor || "", updatedBy || null]
    );
    await client.query(
      `UPDATE dispatch_scm_po_splits
          SET details = COALESCE(details, '{}'::jsonb) || $2::jsonb
        WHERE id = $1`,
      [
        split.id,
        JSON.stringify({
          pickupPoint: selected.yard || "",
          pickupAddress: selected.address || "",
          lastPickupUpdatedAt: new Date().toISOString(),
          lastPickupUpdatedBy: updatedBy || "",
          previousPickups: [
            ...(Array.isArray(split.details?.previousPickups) ? split.details.previousPickups : []),
            previousPickup
          ].filter(Boolean)
        })
      ]
    );
    await client.query("COMMIT");
    return {
      splitId: split.id,
      sourcePoRef: split.source_po_ref,
      splitPoRef: split.split_po_ref,
      splitPoId: split.split_po_id,
      oldPickupPoint: previousPickup,
      pickupPoint: selected.yard || "",
      pickupAddress: selected.address || ""
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => null);
    throw error;
  } finally {
    client.release();
  }
}

export async function cancelScmPurchaseOrderSplit({
  splitPoRef = "",
  cancelledBy = ""
} = {}) {
  const ref = String(splitPoRef || "").trim();
  if (!ref) throw new Error("Split PO ref is required.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const splitResult = await client.query(
      `SELECT *
         FROM dispatch_scm_po_splits
        WHERE lower(split_po_ref) = lower($1)
          AND status = 'active'
        LIMIT 1`,
      [ref]
    );
    const split = splitResult.rows[0];
    if (!split) throw new Error(`SCM split ${ref} was not found.`);
    const activity = await client.query(
      `SELECT COUNT(*)::int AS count
         FROM purchase_order_lines
        WHERE purchase_order_id = $1
          AND (
            COALESCE(received_pallet_qty, 0) > 0
            OR COALESCE(received_layer_qty, 0) > 0
            OR COALESCE(received_section_qty, 0) > 0
            OR COALESCE(received_piece_qty, 0) > 0
            OR COALESCE(netsuite_received_qty, 0) > 0
            OR confirmed_at IS NOT NULL
          )`,
      [split.split_po_id]
    );
    if (Number(activity.rows[0]?.count || 0) > 0) {
      throw new Error(`Cannot unsplit ${ref}. It already has receiving activity.`);
    }
    const poLinks = await client.query(
      `SELECT COUNT(*)::int AS count
         FROM dispatch_so_po_allocations
        WHERE po_order_id = $1
          AND status = 'active'`,
      [split.split_po_id]
    );
    if (Number(poLinks.rows[0]?.count || 0) > 0) {
      throw new Error(`Cannot unsplit ${ref}. It is linked to sales order shortage allocation.`);
    }
    const snapshotUpdate = await updateDispatchSnapshotsForRef(client, { oldRef: split.split_po_ref, remove: true });
    await client.query(
      `UPDATE purchase_order_lines
          SET netsuite_active = false,
              synced_at = now()
        WHERE purchase_order_id = $1`,
      [split.split_po_id]
    );
    await client.query(
      `UPDATE purchase_orders
          SET netsuite_active = false,
              status_text = COALESCE(status_text, '') || ' (SCM unsplit)',
              synced_at = now(),
              status_updated_at = now()
        WHERE netsuite_id = $1`,
      [split.split_po_id]
    );
    await client.query(
      `UPDATE dispatch_scm_po_splits
          SET status = 'cancelled',
              cancelled_at = now(),
              details = COALESCE(details, '{}'::jsonb) || $2::jsonb
        WHERE id = $1`,
      [
        split.id,
        JSON.stringify({
          cancelledBy: cancelledBy || "",
          cancelledAt: new Date().toISOString()
        })
      ]
    );
    await client.query("COMMIT");
    return {
      splitId: split.id,
      sourcePoRef: split.source_po_ref,
      splitPoRef: split.split_po_ref,
      splitPoId: split.split_po_id,
      updatedPlans: snapshotUpdate.planIds
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => null);
    throw error;
  } finally {
    client.release();
  }
}

export async function createScmPurchaseOrderSplit({
  sourcePoRef = "",
  newPoRef = "",
  pickupPoint = "",
  destinationLocationId = null,
  lines = [],
  createdBy = "",
  details = {}
} = {}) {
  const sourceRef = String(sourcePoRef || "").trim();
  const splitRef = String(newPoRef || "").trim();
  if (!sourceRef) throw new Error("Blanket PO is required.");
  if (!splitRef) throw new Error("New PO ref number is required.");
  if (sourceRef.toLowerCase() === splitRef.toLowerCase()) throw new Error("New PO ref must be different from the blanket PO.");
  const requestedLines = (Array.isArray(lines) ? lines : [])
    .map((line) => ({
      ...line,
      lineRowId: Number(line.lineRowId || line.id || 0),
      quantities: splitLineQuantityPayload(line)
    }))
    .filter((line) => line.lineRowId && hasRequestedSplitQuantity(line.quantities));
  if (!requestedLines.length) throw new Error("Select at least one PO line quantity to split.");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const sourceOrder = await client.query(
      `SELECT *
         FROM purchase_orders
        WHERE tranid = $1 OR dispatch_ref = $1 OR netsuite_id::text = $1
        ORDER BY CASE WHEN dispatch_ref = $1 THEN 0 ELSE 1 END, netsuite_active DESC, synced_at DESC NULLS LAST
        LIMIT 1`,
      [sourceRef]
    );
    const source = sourceOrder.rows[0];
    if (!source) throw new Error(`Blanket PO ${sourceRef} was not found.`);
    const splitDestinationLocationId = normalizeScmDestinationLocationId(destinationLocationId)
      || normalizeScmDestinationLocationId(source.destination_location_id)
      || normalizeScmDestinationLocationId(source.destination_location);
    if (!splitDestinationLocationId) throw new Error("Destination yard is required for the split PO.");
    const splitDestinationLocation = locationTextFromId(splitDestinationLocationId);
    const selectedPickupYard = String(pickupPoint || "").trim()
      ? await resolveScmPurchaseOrderPickupYard(client, source, pickupPoint)
      : null;
    const splitPickupPoint = selectedPickupYard?.yard || source.dispatch_vendor_yard || source.source_location || source.vendor || "";
    const splitPickupAddress = selectedPickupYard?.address || source.dispatch_address || "";
    const splitPickupWindowStart = selectedPickupYard?.windowStart || source.dispatch_window_start || "";
    const splitPickupWindowEnd = selectedPickupYard?.windowEnd || source.dispatch_window_end || "";
    const splitPickupInstructions = selectedPickupYard ? vendorYardInstructions(selectedPickupYard) : source.dispatch_instructions || "";
    const splitPickupParseSource = selectedPickupYard ? "manual-scm-po-yard" : source.dispatch_parse_source || "scm-split";
    const existing = await client.query(
      `SELECT tranid FROM purchase_orders WHERE lower(tranid) = lower($1)
       UNION
       SELECT dispatch_ref AS tranid FROM purchase_orders WHERE lower(dispatch_ref) = lower($1)
       UNION
       SELECT split_po_ref AS tranid FROM dispatch_scm_po_splits WHERE lower(split_po_ref) = lower($1)`,
      [splitRef]
    );
    if (existing.rowCount) throw new Error(`PO ref ${splitRef} already exists.`);

    const lineIds = requestedLines.map((line) => line.lineRowId);
    const sourceLines = await client.query(
      `WITH po_alloc AS (
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
       scm_alloc AS (
         SELECT sl.source_line_id,
                SUM(sl.pallet_qty) AS split_pallet_qty,
                SUM(sl.layer_qty) AS split_layer_qty,
                SUM(sl.section_qty) AS split_section_qty,
                SUM(sl.piece_qty) AS split_piece_qty,
                SUM(sl.sales_qty) AS split_sales_qty
           FROM dispatch_scm_po_split_lines sl
           JOIN dispatch_scm_po_splits s ON s.id = sl.split_id
          WHERE s.status = 'active'
          GROUP BY sl.source_line_id
       )
       SELECT l.*,
              COALESCE(pa.allocated_pallet_qty, 0) + COALESCE(sa.split_pallet_qty, 0) AS allocated_pallet_qty,
              COALESCE(pa.allocated_layer_qty, 0) + COALESCE(sa.split_layer_qty, 0) AS allocated_layer_qty,
              COALESCE(pa.allocated_section_qty, 0) + COALESCE(sa.split_section_qty, 0) AS allocated_section_qty,
              COALESCE(pa.allocated_piece_qty, 0) + COALESCE(sa.split_piece_qty, 0) AS allocated_piece_qty,
              COALESCE(pa.allocated_sales_qty, 0) + COALESCE(sa.split_sales_qty, 0) AS allocated_sales_qty
         FROM purchase_order_lines l
         LEFT JOIN po_alloc pa ON pa.po_line_id = l.id
         LEFT JOIN scm_alloc sa ON sa.source_line_id = l.id
        WHERE l.purchase_order_id = $1
          AND l.id = ANY($2::bigint[])
          AND l.netsuite_active = true`,
      [source.netsuite_id, lineIds]
    );
    const sourceLineById = new Map(sourceLines.rows.map((row) => [Number(row.id), row]));
    const selected = [];
    for (const request of requestedLines) {
      const sourceLine = sourceLineById.get(request.lineRowId);
      if (!sourceLine) throw new Error(`Selected PO line ${request.lineRowId} was not found on ${source.tranid}.`);
      const qtys = request.quantities;
      const salesQty = roundDispatchQuantity(lineSalesQty(sourceLine, qtys));
      const label = sourceLine.sku || sourceLine.item_name || `line ${sourceLine.line_id || sourceLine.id}`;
      if (hasConversion(sourceLine)) {
        const unitChecks = [
          ["pallet", qtys.pallets, "PLT"],
          ["layer", qtys.layers, "LYR"],
          ["section", qtys.sections, "SEC"],
          ["piece", qtys.pieces, "PCS"]
        ];
        for (const [unit, value, unitLabel] of unitChecks) {
          if (!value) continue;
          const available = availableUnitQty(sourceLine, unit);
          if (value > available + 0.000001) {
            throw new Error(`${label}: blanket PO only has ${available} ${unitLabel} remaining.`);
          }
        }
      }
      const salesRemaining = Math.max(
        positiveQuantity(sourceLine.quantity) - purchaseOrderReceivedBaseline(sourceLine) - positiveQuantity(sourceLine.allocated_sales_qty),
        0
      );
      if (salesQty <= 0) throw new Error(`${label}: selected quantity is zero.`);
      if (salesQty > salesRemaining + 0.000001) {
        throw new Error(`${label}: blanket PO only has ${salesRemaining} ${sourceLine.unit || "UOM"} remaining.`);
      }
      selected.push({ sourceLine, qtys, salesQty });
    }

    const splitOrderId = syntheticPurchaseOrderId(`scm-po:${source.netsuite_id}:${splitRef}`);
    await client.query(
      `INSERT INTO purchase_orders (
         netsuite_id, tranid, trandate, vendor_id, vendor, status, status_text, foreign_total,
         destination_location_id, destination_location, memo, dispatch_vendor_yard, dispatch_address,
         dispatch_window_start, dispatch_window_end, dispatch_instructions, receipt_status,
         netsuite_active, synced_at, source_location_id, source_location, expected_delivery_date,
         dispatch_parse_source, dispatch_note_hash, dispatch_parsed_at, netsuite_missing_at,
         last_item_receipt_id, last_item_receipt_tranid, received_at, status_updated_at,
         dispatch_ref, dispatch_ref_updated_at, dispatch_ref_updated_by
       )
       SELECT
         $1, $2, trandate, vendor_id, vendor, status, status_text, foreign_total,
          $5::bigint, $6::text,
          CONCAT(COALESCE(memo, ''), CASE WHEN COALESCE(memo, '') = '' THEN '' ELSE E'\n' END, 'SCM split from ', tranid),
          $7::text, $8::text,
         $9::text, $10::text, $11::text, receipt_status,
         true, now(), source_location_id, source_location, expected_delivery_date,
         $12::text, dispatch_note_hash, now(), null,
         null, null, null, now(),
          $2, now(), $4
         FROM purchase_orders
        WHERE netsuite_id = $3`,
      [
        splitOrderId,
        splitRef,
        source.netsuite_id,
        createdBy || null,
        splitDestinationLocationId,
        splitDestinationLocation,
        splitPickupPoint,
        splitPickupAddress,
        splitPickupWindowStart,
        splitPickupWindowEnd,
        splitPickupInstructions,
        splitPickupParseSource
      ]
    );

    const splitHeader = await client.query(
      `INSERT INTO dispatch_scm_po_splits (
         source_po_id, source_po_ref, split_po_id, split_po_ref, created_by, details
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       RETURNING *`,
      [
        source.netsuite_id,
        source.tranid,
        splitOrderId,
        splitRef,
        createdBy,
        JSON.stringify({
          ...(details || {}),
          pickupPoint: splitPickupPoint,
          pickupAddress: splitPickupAddress,
          destinationLocationId: splitDestinationLocationId,
          destinationLocation: splitDestinationLocation
        })
      ]
    );
    const split = splitHeader.rows[0];
    if (splitPickupPoint) {
      await client.query(
        `INSERT INTO scm_transport_schedule (
           order_kind, order_ref, pickup_point, brand, updated_by, created_by
         ) VALUES ('PO', $1, $2, NULLIF($3, ''), $4, $4)
         ON CONFLICT (order_kind, order_ref) DO UPDATE SET
           pickup_point = EXCLUDED.pickup_point,
           brand = COALESCE(scm_transport_schedule.brand, EXCLUDED.brand),
           updated_by = EXCLUDED.updated_by,
           updated_at = now()`,
        [splitRef, splitPickupPoint, selectedPickupYard?.vendor || "", createdBy || null]
      );
    }
    const createdLines = [];
    for (const selection of selected) {
      const sourceLine = selection.sourceLine;
      const qtys = selection.qtys;
      const splitLineId = syntheticPurchaseOrderId(`scm-po-line:${splitRef}:${sourceLine.id}`);
      const inserted = await client.query(
        `INSERT INTO purchase_order_lines (
           id, purchase_order_id, line_id, item_id, item_name, sku, item_description, item_type,
           item_type_text, quantity, unit, location_id, location, pallet_qty, layer_qty,
           section_qty, piece_qty, to_plt, to_lyr, to_sec, to_pcs, received_pallet_qty,
           received_layer_qty, received_section_qty, received_piece_qty, netsuite_received_qty,
           netsuite_active, sync_exception, synced_at, item_weight, sync_exception_at, raw,
           confirmed_at, confirmed_by
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8,
           $9, $10, $11, $12, $13, $14, $15,
           $16, $17, $18, $19, $20, $21, 0,
           0, 0, 0, 0,
           true, null, now(), $22, null, $23::jsonb,
           null, null
         )
         RETURNING *`,
        [
          splitLineId,
          splitOrderId,
          sourceLine.line_id,
          sourceLine.item_id,
          sourceLine.item_name,
          sourceLine.sku,
          sourceLine.item_description,
          sourceLine.item_type,
          sourceLine.item_type_text,
          selection.salesQty,
          sourceLine.unit,
          splitDestinationLocationId,
          splitDestinationLocation,
          hasConversion(sourceLine) ? qtys.pallets : 0,
          hasConversion(sourceLine) ? qtys.layers : 0,
          hasConversion(sourceLine) ? qtys.sections : 0,
          hasConversion(sourceLine) ? qtys.pieces : 0,
          sourceLine.to_plt,
          sourceLine.to_lyr,
          sourceLine.to_sec,
          sourceLine.to_pcs,
          sourceLine.item_weight,
          JSON.stringify({
            scmSplit: true,
            sourcePoRef: source.tranid,
            sourcePoId: source.netsuite_id,
            sourceLineId: sourceLine.id,
            destinationLocationId: splitDestinationLocationId,
            destinationLocation: splitDestinationLocation,
            selected: qtys
          })
        ]
      );
      const splitLine = inserted.rows[0];
      createdLines.push(splitLine);
      await client.query(
        `INSERT INTO dispatch_scm_po_split_lines (
           split_id, source_line_id, split_line_id, item_id, sku, item_name,
           pallet_qty, layer_qty, section_qty, piece_qty, sales_qty, unit,
           requested_pallet_qty, requested_layer_qty, requested_section_qty,
           requested_piece_qty, requested_sales_qty
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
           $7, $8, $9, $10, $11
         )`,
        [
          split.id,
          sourceLine.id,
          splitLine.id,
          sourceLine.item_id,
          sourceLine.sku,
          sourceLine.item_name,
          hasConversion(sourceLine) ? qtys.pallets : 0,
          hasConversion(sourceLine) ? qtys.layers : 0,
          hasConversion(sourceLine) ? qtys.sections : 0,
          hasConversion(sourceLine) ? qtys.pieces : 0,
          selection.salesQty,
          sourceLine.unit
        ]
      );
    }
    await client.query("COMMIT");
    return {
      split: {
        id: split.id,
        sourcePoRef: source.tranid,
        sourcePoId: source.netsuite_id,
        splitPoRef: splitRef,
        splitPoId: splitOrderId,
        destinationLocationId: splitDestinationLocationId,
        destinationLocation: splitDestinationLocation,
        pickupPoint: splitPickupPoint,
        pickupAddress: splitPickupAddress,
        createdAt: split.created_at
      },
      lines: createdLines.map((line) => ({
        id: line.id,
        lineId: line.line_id,
        itemId: line.item_id,
        sku: line.sku || line.item_name,
        itemName: line.item_name,
        quantity: positiveQuantity(line.quantity),
        unit: line.unit || "",
        pallets: positiveQuantity(line.pallet_qty),
        layers: positiveQuantity(line.layer_qty),
        sections: positiveQuantity(line.section_qty),
        pieces: positiveQuantity(line.piece_qty)
      }))
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => null);
    throw error;
  } finally {
    client.release();
  }
}

const MBBS_SPECIAL_ITEM_ID = 2055;

function isMbbsSpecialLine(line = {}) {
  return Number(line.item_id ?? line.itemId) === MBBS_SPECIAL_ITEM_ID;
}

function normalizedSpecialDescription(value, itemName = "") {
  const normalize = (text) => String(text || "").normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
  const itemLabel = normalize(itemName);
  const parts = String(value || "").normalize("NFKC").split(/\r?\n/).map(normalize).filter(Boolean);
  while (parts.length && [itemLabel, "mbbs-special", "mbbs special"].filter(Boolean).includes(parts[0])) parts.shift();
  return normalize(parts.join(" "))
    .replace(/^mbbs[\s-]*special(?:\s+order)?\s*[:\-–—]?\s*/, "")
    .trim();
}

function normalizedSpecialUnit(value) {
  return String(value || "").normalize("NFKC").trim().toUpperCase().replace(/\s+/g, " ");
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
    dispatchTargetRef: row.dispatch_target_ref || row.sales_order_ref,
    dispatchTargetKind: row.dispatch_target_kind || "normal",
    targetLineKey: row.dispatch_target_line_key || "",
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

function dispatchItemLineIdentities(item = {}) {
  return [...new Set([
    item.lineRowId,
    item.sourceLineId,
    item.lineId,
    item.line_id,
    item.id
  ].map((value) => String(value || "").trim()).filter(Boolean))];
}

function allocationMatchesDispatchItem(allocation = {}, item = {}, sourceRefs = []) {
  const key = String(allocation.dispatch_target_line_key || "");
  const identities = dispatchItemLineIdentities(item);
  if (!identities.some((identity) => key.endsWith(`::${identity}`))) return false;
  const sources = sourceRefs.map((value) => String(value || "").trim()).filter(Boolean);
  return !sources.length || sources.some((source) => key.includes(`::${source}::`));
}

function applyTargetPoAllocationsToOrder(order = {}, allocations = []) {
  const applyItems = (candidate) => {
    const sources = [candidate.id, candidate.originalOrderId];
    const childOrderDetails = (candidate.childOrderDetails || []).map(applyItems);
    const items = childOrderDetails.length
      ? childOrderDetails.flatMap((child) => child.items || [])
      : (candidate.items || []).map((item) => {
          const matches = allocations.filter((allocation) => allocationMatchesDispatchItem(allocation, item, sources));
          if (!matches.length) return item;
          return {
            ...item,
            poAllocatedPallets: matches.reduce((sum, row) => sum + positiveQuantity(row.allocated_pallet_qty), 0),
            poAllocatedLayers: matches.reduce((sum, row) => sum + positiveQuantity(row.allocated_layer_qty), 0),
            poAllocatedSections: matches.reduce((sum, row) => sum + positiveQuantity(row.allocated_section_qty), 0),
            poAllocatedPieces: matches.reduce((sum, row) => sum + positiveQuantity(row.allocated_piece_qty), 0),
            poAllocatedSalesQty: matches.reduce((sum, row) => sum + positiveQuantity(row.allocated_sales_qty), 0)
          };
        });
    return { ...candidate, childOrderDetails, items };
  };
  const enriched = applyItems(order);
  const manifestByLocation = new Map();
  for (const allocation of allocations) {
    const location = allocation.po_vendor_yard || allocation.po_vendor || "";
    if (!location) continue;
    const key = `${allocation.po_order_ref || ""}|${location}`;
    const entry = manifestByLocation.get(key) || {
      poOrderRef: allocation.po_order_ref || "",
      location,
      address: allocation.po_address || "",
      items: []
    };
    entry.items.push({
      itemId: allocation.item_id,
      itemName: allocation.item_name,
      sku: allocation.sku,
      unit: allocation.unit || "",
      pallets: positiveQuantity(allocation.allocated_pallet_qty),
      layers: positiveQuantity(allocation.allocated_layer_qty),
      sections: positiveQuantity(allocation.allocated_section_qty),
      pieces: positiveQuantity(allocation.allocated_piece_qty),
      quantity: positiveQuantity(allocation.allocated_sales_qty)
    });
    manifestByLocation.set(key, entry);
  }
  const poPickupManifest = [...manifestByLocation.values()];
  return {
    ...enriched,
    pickupLocations: [...new Set([
      ...(enriched.pickupLocations || []),
      ...poPickupManifest.map((entry) => entry.location).filter(Boolean)
    ])],
    poPickupManifest
  };
}

export async function enrichDispatchOrdersWithPoTargetAllocations(orders = []) {
  if (!orders.length) return orders;
  const refs = [...new Set(orders.map((order) => String(order?.id || "").trim()).filter(Boolean))];
  const result = await query(
    `SELECT allocation.*, po.vendor AS po_vendor, po.dispatch_vendor_yard AS po_vendor_yard,
            po.dispatch_address AS po_address, po_line.unit
       FROM dispatch_so_po_allocations allocation
       LEFT JOIN purchase_orders po ON po.netsuite_id = allocation.po_order_id
       LEFT JOIN purchase_order_lines po_line ON po_line.id = allocation.po_line_id
      WHERE allocation.status = 'active'
        AND allocation.dispatch_target_ref = ANY($1::text[])
      ORDER BY allocation.dispatch_target_ref, allocation.po_order_ref, allocation.id`,
    [refs]
  );
  const byTarget = new Map();
  for (const allocation of result.rows) {
    const ref = String(allocation.dispatch_target_ref || allocation.sales_order_ref || "");
    if (!byTarget.has(ref)) byTarget.set(ref, []);
    byTarget.get(ref).push(allocation);
  }
  return orders.map((order) => {
    const allocations = byTarget.get(String(order?.id || "")) || [];
    return allocations.length ? applyTargetPoAllocationsToOrder(order, allocations) : order;
  });
}

function targetLineAsAllocationRow(line = {}) {
  return {
    id: line.salesLineId,
    line_id: line.lineId,
    item_id: line.itemId,
    sku: line.sku,
    item_name: line.itemName,
    item_description: line.description,
    unit: line.unit,
    quantity: line.quantity,
    pallet_qty: line.pallets,
    layer_qty: line.layers,
    section_qty: line.sections,
    piece_qty: line.pieces,
    to_plt: line.toPlt,
    to_lyr: line.toLyr,
    to_sec: line.toSec,
    to_pcs: line.toPcs,
    netsuite_received_qty: 0,
    allocated_pallet_qty: line.poAllocatedPallets,
    allocated_layer_qty: line.poAllocatedLayers,
    allocated_section_qty: line.poAllocatedSections,
    allocated_piece_qty: line.poAllocatedPieces,
    allocated_sales_qty: line.poAllocatedSalesQty
  };
}

export async function getSalesOrderPoAllocationOptions(orderRef, { planDate = "" } = {}) {
  const resolved = await resolveDispatchSalesTarget({ dispatchTargetRef: orderRef, planDate });
  const salesLines = resolved.lines.map(targetLineAsAllocationRow);
  const itemIds = [...new Set(salesLines.map((line) => line.item_id).filter(Boolean))];
  const itemNames = [...new Set(salesLines.map((line) => String(line.sku || line.item_name || "").trim()).filter(Boolean))];
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
      WHERE a.dispatch_target_ref = $1
        AND a.status = 'active'
      ORDER BY a.created_at DESC, a.id DESC`,
    [resolved.target.ref]
  );

  return {
    order: {
      id: resolved.target.ref,
      kind: resolved.target.kind,
      memberRefs: resolved.target.memberRefs,
      customer: resolved.target.customer || "",
      outboundLocation: resolved.target.outboundLocation || "",
      targetSignature: resolved.signature
    },
    salesLines: resolved.lines.map((targetLine) => {
      const line = targetLineAsAllocationRow(targetLine);
      const special = isMbbsSpecialLine(line);
      const normalizedDescription = normalizedSpecialDescription(line.item_description, line.item_name || line.sku);
      const lineCandidates = poLines.rows.filter((poLine) => lineMatches(line, poLine)).map((poLine) => ({
        poLineId: poLine.id,
        poRef: poLine.po_ref,
        descriptionMatch: Boolean(normalizedDescription) && normalizedDescription === normalizedSpecialDescription(poLine.item_description, poLine.item_name || poLine.sku),
        unitMatch: normalizedSpecialUnit(line.unit) === normalizedSpecialUnit(poLine.unit),
        exactMatch: !special || (Boolean(normalizedDescription) && normalizedDescription === normalizedSpecialDescription(poLine.item_description, poLine.item_name || poLine.sku) && normalizedSpecialUnit(line.unit) === normalizedSpecialUnit(poLine.unit))
      }));
      return {
      id: line.id,
      targetLineKey: targetLine.targetLineKey,
      sourceOrderRef: targetLine.sourceOrderRef,
      lineId: line.line_id,
      itemId: line.item_id,
      sku: line.sku || line.item_name,
      itemName: line.item_name,
      description: line.item_description || "",
      isSpecial: special,
      independentSalesQty: !hasConversion(line) && hasCustomQuantity(line),
      poCandidates: lineCandidates,
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
      available: availableUnitSelection(line),
      conversions: {
        pallets: positiveQuantity(line.to_plt),
        layers: positiveQuantity(line.to_lyr),
        sections: positiveQuantity(line.to_sec),
        pieces: positiveQuantity(line.to_pcs)
      }
    }; }),
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
      available: availableUnitSelection(line)
    })),
    allocations: allocations.rows.map(normalizeAllocationRow)
  };
}

async function createSalesOrderPoAllocationWithExecutor(executor, {
  dispatchTargetRef = "", salesOrderRef, targetLineKey = "", salesLineId, poLineId, poRef = "",
  planDate = "", targetSignature = "", quantities = {}, createdBy = ""
} = {}) {
  const resolved = await resolveDispatchSalesTarget({
    dispatchTargetRef: dispatchTargetRef || salesOrderRef,
    planDate
  });
  if (targetSignature && targetSignature !== resolved.signature) {
    const error = new Error(`${resolved.target.ref} changed while the link window was open. Refresh before linking the PO.`);
    error.status = 409;
    error.code = "DISPATCH_TARGET_CHANGED";
    throw error;
  }
  const targetLine = resolved.lines.find((line) => line.targetLineKey === String(targetLineKey || ""))
    || resolved.lines.find((line) => Number(line.salesLineId) === Number(salesLineId));
  const salesLine = targetLine ? {
    ...targetLineAsAllocationRow(targetLine),
    sales_order_id: targetLine.sourceOrderId,
    sales_order_ref: targetLine.sourceOrderRef
  } : null;
  if (isMbbsSpecialLine(salesLine) && !poLineId) {
    throw new Error("Select the exact PO line for MBBS-Special before connecting quantity.");
  }
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
  const requestedPoRef = String(poRef || "").trim().toLowerCase();
  if (requestedPoRef && requestedPoRef !== String(poLine.po_order_ref || "").trim().toLowerCase()
    && requestedPoRef !== String(poLine.purchase_order_id || "").trim().toLowerCase()) {
    throw new Error("Selected PO line is not part of the entered purchase order.");
  }
  if (!lineMatches(salesLine, poLine)) throw new Error("Selected PO line item does not match the SO line item.");

  const pallets = positiveQuantity(quantities.pallets);
  const layers = positiveQuantity(quantities.layers);
  const sections = positiveQuantity(quantities.sections);
  const pieces = positiveQuantity(quantities.pieces);
  const independentSalesQty = !hasConversion(salesLine) && hasCustomQuantity(salesLine);
  const conversionLine = independentSalesQty || isMbbsSpecialLine(salesLine) ? salesLine : hasConversion(salesLine) ? salesLine : poLine;
  let salesQty = lineSalesQty(conversionLine, { ...quantities, pallets, layers, sections, pieces });
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
  const poRemaining = Math.max(positiveQuantity(poLine.quantity) - purchaseOrderReceivedBaseline(poLine) - positiveQuantity(poLine.allocated_sales_qty), 0);
  const selectedPhysical = pallets + layers + sections + pieces > 0;
  const fullPhysical = selectedPhysical && checks.every(([unit, value]) => {
    const available = availableUnitQty(salesLine, unit);
    return available <= 0.000001 || value + 0.000001 >= available;
  });
  if (independentSalesQty && selectedPhysical && salesQty <= 0) {
    if (!fullPhysical) throw new Error(`${itemLabel}: enter the sales-unit quantity for a partial manual PLT/LYR/SEC/PCS allocation.`);
    salesQty = salesRemaining;
  }
  if (salesQty > salesRemaining) throw new Error(`${itemLabel}: SO open sales quantity is only ${salesRemaining}.`);
  if (salesQty > poRemaining) throw new Error(`${itemLabel}: PO ${poLine.po_order_ref} only has ${poRemaining} sales quantity available.`);

  const inserted = await executor.query(
    `INSERT INTO dispatch_so_po_allocations (
       sales_order_id, sales_order_ref, sales_line_id, po_order_id, po_order_ref, po_line_id,
       item_id, item_name, sku, allocated_pallet_qty, allocated_layer_qty, allocated_section_qty,
       allocated_piece_qty, allocated_sales_qty, created_by, details,
       dispatch_target_ref, dispatch_target_kind, dispatch_target_line_key
     ) VALUES (
       $1, $2, $3, $4, $5, $6,
       $7, $8, $9, $10, $11, $12,
       $13, $14, $15, $16::jsonb, $17, $18, $19
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
      }),
      resolved.target.ref,
      resolved.target.kind,
      targetLine.targetLineKey
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

export async function createSalesOrderPoAllocations({
  dispatchTargetRef = "", salesOrderRef, poRef = "", planDate = "", targetSignature = "", lines = [], createdBy = ""
} = {}) {
  const cleaned = (Array.isArray(lines) ? lines : [])
    .map((line) => ({
      salesLineId: line.salesLineId,
      targetLineKey: line.targetLineKey,
      poLineId: line.poLineId,
      quantities: line.quantities || line
    }))
    .filter((line) => {
      const q = line.quantities || {};
      return positiveQuantity(q.pallets) + positiveQuantity(q.layers) + positiveQuantity(q.sections) + positiveQuantity(q.pieces) + positiveQuantity(q.salesQty) > 0;
    });
  if (!cleaned.length) throw new Error("At least one SO item quantity is required.");
  if (!String(poRef || "").trim()) throw new Error("Purchase order number is required.");

  return withTransaction(async () => {
    const executor = { query };
    const created = [];
    for (const line of cleaned) {
      created.push(await createSalesOrderPoAllocationWithExecutor(executor, {
        dispatchTargetRef: dispatchTargetRef || salesOrderRef,
        salesOrderRef,
        salesLineId: line.salesLineId,
        targetLineKey: line.targetLineKey,
        poLineId: line.poLineId,
        poRef,
        planDate,
        targetSignature,
        quantities: line.quantities,
        createdBy
      }));
    }
    return created;
  });
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

function localCoChildSourceYards(child = {}) {
  const raw = child.raw && typeof child.raw === "object" ? child.raw : {};
  const normalized = (values) => [...new Set(values.map(locationTextFromId).filter(Boolean))];
  const rawYards = normalized([
    raw.pickup_location,
    raw.outbound_location,
    raw.source_location
  ]);
  if (rawYards.length) return rawYards;
  const originalYards = normalized([
    ...(Array.isArray(child.transitOriginalPickupLocations) ? child.transitOriginalPickupLocations : []),
    child.transitOriginalSourceYard
  ]);
  if (originalYards.length) return originalYards;
  return normalized([
    ...(Array.isArray(child.pickupLocations) ? child.pickupLocations : []),
    child.sourceYard
  ]);
}

function isLocalCoTransportItem(item = {}) {
  const itemName = String(item.sku || item.itemName || item.item_name || "").trim().toUpperCase();
  if (itemName.startsWith("DELIVERY CHARGE") || itemName.startsWith("SALES CREDIT")) return false;
  return positiveQuantity(item.quantity || item.salesQty)
    + positiveQuantity(item.pallets || item.pallet_qty)
    + positiveQuantity(item.layers || item.layer_qty)
    + positiveQuantity(item.sections || item.section_qty)
    + positiveQuantity(item.pieces || item.piece_qty) > 0;
}

function localCoSourceItems(order = {}, fromYard = "") {
  const children = Array.isArray(order.childOrderDetails) ? order.childOrderDetails : [];
  if (!children.length) return (Array.isArray(order.items) ? order.items : []).filter(isLocalCoTransportItem);
  const fromText = locationTextFromId(fromYard);
  const selectedChildren = children.filter((child) => {
    const yards = localCoChildSourceYards(child);
    return !yards.length || yards.includes(fromText);
  });
  const childItems = selectedChildren.flatMap((child) => (
    Array.isArray(child.items) && child.items.length
      ? child.items
      : Array.isArray(child.raw?.items) ? child.raw.items : []
  )).filter(isLocalCoTransportItem);
  if (!childItems.length) return (Array.isArray(order.items) ? order.items : []).filter(isLocalCoTransportItem);
  const unique = new Map();
  childItems.forEach((item, index) => {
    const key = String(item.lineRowId || item.line_row_id || item.lineId || item.line_id || `${item.itemId || item.item_id || item.sku || "item"}:${index}`);
    if (!unique.has(key)) unique.set(key, item);
  });
  return [...unique.values()];
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

  const items = localCoSourceItems(order, fromText);
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
