import { query } from "./db.js";
import { enrichPurchaseOrderDispatch, enrichSalesOrderDispatch, enrichTransferDispatch } from "./dispatch-enrichment.js";

function toNumber(value) {
  return Number(value || 0) || 0;
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
  const pickupLocations = row.transit_co_to_yard
    ? [row.transit_co_to_yard]
    : row.pickup_location ? [row.pickup_location] : [];
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
    weight: Math.max(1, Math.round((totalPallets || fallbackQty / 100 || 1) * 1000) / 1000),
    items: row.items || [],
    raw: row,
    operatorStatus: row.operator_status || "",
    localYardOrderStatus: row.local_yard_order_status || "Open",
    dispatchPlanned: Boolean(row.dispatch_planned)
  };
}

function locationIdFromText(value) {
  const text = String(value || "").trim();
  if (text === "3445") return 1;
  if (text === "2967") return 13;
  if (text === "12441") return 15;
  return null;
}

function locationTextFromId(value) {
  const text = String(value || "").trim();
  if (text === "1") return "3445";
  if (text === "13") return "2967";
  if (text === "15") return "12441";
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
    WITH delivery AS (
      SELECT
        o.netsuite_id,
        o.tranid,
        CASE WHEN o.order_type = 'transfer_order' THEN 'TO' ELSE 'SO' END AS dispatch_type,
        'delivery_orders' AS source_table,
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
        o.operator_status,
        o.local_yard_order_status,
        o.dispatch_planned,
        COALESCE(SUM(l.pallet_qty), 0) AS total_pallet_qty,
        COALESCE(SUM(l.layer_qty), 0) AS total_layer_qty,
        COALESCE(SUM(l.quantity), 0) AS total_quantity,
        COALESCE(SUM(l.packed_pallet_qty), 0) AS total_packed_pallet_qty,
        COALESCE(SUM(l.packed_layer_qty), 0) AS total_packed_layer_qty,
        COALESCE(SUM(l.packed_section_qty), 0) AS total_packed_section_qty,
        COALESCE(SUM(l.packed_piece_qty), 0) AS total_packed_piece_qty,
        jsonb_agg(jsonb_build_object(
          'sku', COALESCE(l.sku, l.item_name),
          'itemName', l.item_name,
          'description', l.item_description,
          'pallets', COALESCE(l.pallet_qty, 0),
          'layers', COALESCE(l.layer_qty, 0),
          'sections', COALESCE(l.section_qty, 0),
          'pieces', COALESCE(l.piece_qty, 0),
          'quantity', COALESCE(l.quantity, 0)
        ) ORDER BY l.line_id NULLS LAST, l.id) FILTER (WHERE l.id IS NOT NULL) AS items
      FROM delivery_orders o
      LEFT JOIN delivery_order_lines l ON l.order_id = o.netsuite_id AND l.netsuite_active = true
      LEFT JOIN LATERAL (
        SELECT co_ref, from_location, to_location
          FROM local_co_orders
         WHERE source_order_ref = o.tranid
           AND status <> 'cancelled'
         ORDER BY updated_at DESC, id DESC
         LIMIT 1
      ) co ON true
      WHERE (o.netsuite_active = true OR co.co_ref IS NOT NULL)
        AND COALESCE(o.local_yard_order_status, 'Open') <> 'Loaded'
        AND o.fulfillment_status <> 'fulfilled'
        AND (
          (o.order_type = 'sales_order' AND (o.status = 'B' OR o.status_text ILIKE '%Pending Fulfillment%'))
          OR (o.order_type = 'transfer_order' AND o.status_text ILIKE '%Pending Fulfillment%')
        )
      GROUP BY o.netsuite_id, co.co_ref, co.from_location, co.to_location
    ),
    receiving AS (
      SELECT
        o.netsuite_id,
        o.tranid,
        CASE WHEN o.order_type = 'transfer_order' THEN 'TO' ELSE 'PO' END AS dispatch_type,
        'receiving_orders' AS source_table,
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
        NULL::text AS operator_status,
        'Open'::text AS local_yard_order_status,
        false AS dispatch_planned,
        COALESCE(SUM(l.pallet_qty), 0) AS total_pallet_qty,
        COALESCE(SUM(l.layer_qty), 0) AS total_layer_qty,
        COALESCE(SUM(l.quantity), 0) AS total_quantity,
        0::numeric AS total_packed_pallet_qty,
        0::numeric AS total_packed_layer_qty,
        0::numeric AS total_packed_section_qty,
        0::numeric AS total_packed_piece_qty,
        jsonb_agg(jsonb_build_object(
          'sku', COALESCE(l.sku, l.item_name),
          'itemName', l.item_name,
          'description', l.item_description,
          'pallets', COALESCE(l.pallet_qty, 0),
          'layers', COALESCE(l.layer_qty, 0),
          'sections', COALESCE(l.section_qty, 0),
          'pieces', COALESCE(l.piece_qty, 0),
          'quantity', COALESCE(l.quantity, 0)
        ) ORDER BY l.line_id NULLS LAST, l.id) FILTER (WHERE l.id IS NOT NULL) AS items
      FROM receiving_orders o
      LEFT JOIN receiving_order_lines l ON l.order_id = o.netsuite_id AND l.netsuite_active = true
      WHERE o.netsuite_active = true
        AND o.status_text ILIKE '%Pending Receipt%'
        AND NOT EXISTS (
          SELECT 1
          FROM delivery_orders d
          WHERE d.netsuite_id = o.netsuite_id
            AND d.netsuite_active = true
            AND d.fulfillment_status <> 'fulfilled'
        )
      GROUP BY o.netsuite_id
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
        NULL::text AS operator_status,
        COALESCE(co.status, 'planned') AS local_yard_order_status,
        true AS dispatch_planned,
        COALESCE(SUM(l.pallet_qty), 0) AS total_pallet_qty,
        COALESCE(SUM(l.layer_qty), 0) AS total_layer_qty,
        COALESCE(SUM(l.quantity), 0) AS total_quantity,
        0::numeric AS total_packed_pallet_qty,
        0::numeric AS total_packed_layer_qty,
        0::numeric AS total_packed_section_qty,
        0::numeric AS total_packed_piece_qty,
        jsonb_agg(jsonb_build_object(
          'sku', COALESCE(l.sku, l.item_name),
          'itemName', l.item_name,
          'description', l.item_description,
          'pallets', COALESCE(l.pallet_qty, 0),
          'layers', COALESCE(l.layer_qty, 0),
          'sections', COALESCE(l.section_qty, 0),
          'pieces', COALESCE(l.piece_qty, 0),
          'quantity', COALESCE(l.quantity, 0)
        ) ORDER BY l.line_id NULLS LAST, l.id) FILTER (WHERE l.id IS NOT NULL) AS items
      FROM local_co_orders co
      LEFT JOIN local_co_order_lines l ON l.co_id = co.id
      WHERE co.status IN ('planned', 'received')
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
      `SELECT netsuite_id, order_type, memo, outbound_location_id, outbound_location,
              destination_location_id, destination_location, source_location_id, source_location
         FROM delivery_orders
        WHERE netsuite_active = true
          AND ($1::boolean OR dispatch_note_hash IS NULL OR dispatch_parse_source IS NULL)`,
      [force]
    );
    for (const row of delivery.rows) {
      const dispatch = row.order_type === "transfer_order"
        ? enrichTransferDispatch(row)
        : await enrichSalesOrderDispatch(row);
      await query(
        `UPDATE delivery_orders
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
      deliveryCount += 1;
    }
  }

  let receivingCount = 0;
  if (includeReceiving) {
    const receiving = await query(
      `SELECT netsuite_id, order_type, memo, vendor, source_location_id, source_location,
              destination_location_id, destination_location, tranid
         FROM receiving_orders
        WHERE netsuite_active = true
          AND ($1::boolean OR dispatch_note_hash IS NULL OR dispatch_parse_source IS NULL)`,
      [force]
    );
    for (const row of receiving.rows) {
      const dispatch = row.order_type === "transfer_order"
        ? enrichTransferDispatch(row)
        : await enrichPurchaseOrderDispatch(row);
      await query(
        `UPDATE receiving_orders
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
      receivingCount += 1;
    }
  }
  return { delivery: deliveryCount, receiving: receivingCount };
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
    `UPDATE receiving_orders
        SET dispatch_address = $2,
            dispatch_window_start = $3,
            dispatch_window_end = $4,
            dispatch_instructions = $5,
            dispatch_vendor_yard = $6,
            dispatch_parse_source = 'manual-po-yard',
            dispatch_parsed_at = now()
      WHERE order_type = 'purchase_order'
        AND (tranid = $1 OR netsuite_id::text = $1)
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
  const preferReceiving = sourceTable === "receiving_orders" || type === "PO";
  const preferDelivery = sourceTable === "delivery_orders" || type === "SO";
  const attempts = preferReceiving
    ? ["receiving_orders", "delivery_orders"]
    : preferDelivery
      ? ["delivery_orders", "receiving_orders"]
      : ["delivery_orders", "receiving_orders"];

  for (const table of attempts) {
    const result = await query(
      `UPDATE ${table}
          SET dispatch_address = $2,
              dispatch_window_start = $3,
              dispatch_window_end = $4,
              expected_delivery_date = $5::date,
              dispatch_parse_source = 'manual-dispatch-details',
              dispatch_parsed_at = now()
        WHERE (tranid = $1 OR netsuite_id::text = $1)
        RETURNING netsuite_id, tranid, order_type, dispatch_address, dispatch_window_start,
                  dispatch_window_end, expected_delivery_date, '${table}'::text AS source_table`,
      [orderRef, address, windowStart, windowEnd, expectedDate]
    );
    if (result.rows[0]) return result.rows[0];
  }

  throw new Error("Dispatch order not found.");
}

export async function upsertLocalCoOrder({ sourceOrderRef, fromYard, toYard, order = {}, plan = {}, requestedBy = "" } = {}) {
  const sourceRef = String(sourceOrderRef || order.id || "").trim();
  const fromText = locationTextFromId(fromYard || order.sourceYard || order.pickupLocations?.[0]);
  const toText = locationTextFromId(toYard || "12441");
  if (!sourceRef) throw new Error("Source sales order is required for CO.");
  if (!fromText || !toText || fromText === toText) throw new Error("CO source and destination yard must be different.");
  const coRef = String(order.transitCo?.id || `CO-${sourceRef}`).trim();
  const details = {
    customer: order.customer || "",
    notes: order.notes || `Local transit depot order for ${sourceRef}.`,
    sourceOrderId: sourceRef,
    weight: order.weight || 0,
    salesQty: order.salesQty || 0
  };
  const inserted = await query(
    `INSERT INTO local_co_orders (
       co_ref, source_order_ref, from_location_id, from_location, to_location_id, to_location,
       status, dispatch_plan_id, dispatch_plan_date, dispatch_truck_plate, dispatch_load_name,
       dispatch_parking_spot, created_by, details
     ) VALUES (
       $1, $2, $3, $4, $5, $6,
       'planned', $7, $8::date, $9, $10,
       $11, $12, $13::jsonb
     )
     ON CONFLICT (co_ref) DO UPDATE SET
       source_order_ref = EXCLUDED.source_order_ref,
       from_location_id = EXCLUDED.from_location_id,
       from_location = EXCLUDED.from_location,
       to_location_id = EXCLUDED.to_location_id,
       to_location = EXCLUDED.to_location,
       status = CASE WHEN local_co_orders.status = 'cancelled' THEN 'planned' ELSE local_co_orders.status END,
       dispatch_plan_id = EXCLUDED.dispatch_plan_id,
       dispatch_plan_date = EXCLUDED.dispatch_plan_date,
       dispatch_truck_plate = EXCLUDED.dispatch_truck_plate,
       dispatch_load_name = EXCLUDED.dispatch_load_name,
       dispatch_parking_spot = EXCLUDED.dispatch_parking_spot,
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
      plan.id || null,
      plan.planDate || null,
      plan.truckPlate || "",
      plan.loadName || "",
      plan.parkingSpot || "",
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
         quantity, unit, pallet_qty, layer_qty, piece_qty, section_qty, to_plt, to_lyr, to_sec, to_pcs, raw
       ) VALUES (
         $1, $2, $3, $4, COALESCE($5, 'InvtPart'), $6, $7, $8,
         $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19::jsonb
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
    `UPDATE dispatch_operator_requests r
        SET status = 'resolved',
            resolved_at = now(),
            details = r.details || '{"autoResolved":"order_not_packed"}'::jsonb
       FROM delivery_orders d
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
    `SELECT r.*,
            d.netsuite_id,
            d.tranid,
            d.operator_status,
            d.outbound_location_id,
            d.outbound_location
       FROM dispatch_operator_requests r
       LEFT JOIN delivery_orders d
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
    `UPDATE dispatch_operator_requests
        SET status = 'resolved',
            resolved_by = $2,
            resolved_at = now()
      WHERE status = 'open'
        AND (order_ref = $1 OR order_ref IN (
          SELECT tranid FROM delivery_orders WHERE netsuite_id::text = $1
        ))
      RETURNING *`,
    [String(orderRef), operatorId || null]
  );
  return result.rows;
}
