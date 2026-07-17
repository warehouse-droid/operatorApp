import { query } from "./db.js";
import { writeAudit } from "./auth-repository.js";

function normalizeNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  return Number(String(value).replaceAll(",", ""));
}

function normalizeQuantity(value) {
  const number = normalizeNumber(value);
  return number === null ? null : Math.abs(number);
}

function positiveQuantity(value) {
  const number = normalizeNumber(value);
  return number === null ? 0 : Math.max(number, 0);
}

function netsuiteReceivedBaseline(line) {
  return positiveQuantity(line?.netsuite_received_baseline_qty ?? line?.netsuite_received_qty);
}

function isPhotoReference(value) {
  const text = String(value || "");
  return text.startsWith("data:image/") || text.startsWith("r2://");
}

function roundQuantity(value) {
  return Math.round((Number(value) || 0) * 1000000) / 1000000;
}

function hasConversion(line) {
  return positiveQuantity(line.to_plt) > 0
    || positiveQuantity(line.to_lyr) > 0
    || positiveQuantity(line.to_sec) > 0
    || positiveQuantity(line.to_pcs) > 0;
}

function hasRequiredCustomQuantity(line) {
  return positiveQuantity(line.pallet_qty) > 0
    || positiveQuantity(line.layer_qty) > 0
    || positiveQuantity(line.section_qty) > 0
    || positiveQuantity(line.piece_qty) > 0;
}

function unitConversion(line, unit) {
  if (unit === "pallets") return positiveQuantity(line.to_plt);
  if (unit === "layers") return positiveQuantity(line.to_lyr);
  if (unit === "sections") return positiveQuantity(line.to_sec);
  if (unit === "pieces") return positiveQuantity(line.to_pcs);
  return 0;
}

function explicitUnitQuantity(line, unit) {
  if (unit === "pallets") return positiveQuantity(line.pallet_qty);
  if (unit === "layers") return positiveQuantity(line.layer_qty);
  if (unit === "sections") return positiveQuantity(line.section_qty);
  if (unit === "pieces") return positiveQuantity(line.piece_qty);
  return 0;
}

function receivedSalesQuantity(line) {
  if (!hasConversion(line)) {
    if (hasRequiredCustomQuantity(line)) {
      return positiveQuantity(line.received_sales_qty);
    }
    return positiveQuantity(line.received_piece_qty)
      || positiveQuantity(line.received_section_qty)
      || positiveQuantity(line.received_layer_qty)
      || positiveQuantity(line.received_pallet_qty);
  }
  return (positiveQuantity(line.received_pallet_qty) * positiveQuantity(line.to_plt))
    + (positiveQuantity(line.received_layer_qty) * positiveQuantity(line.to_lyr))
    + (positiveQuantity(line.received_section_qty) * positiveQuantity(line.to_sec))
    + (positiveQuantity(line.received_piece_qty) * positiveQuantity(line.to_pcs));
}

function receivingUnitAvailability(line) {
  const salesAvailable = remainingSalesQuantity(line);
  if (!hasConversion(line)) {
    if (hasRequiredCustomQuantity(line)) {
      return {
        pallets: positiveQuantity(line.pallet_qty),
        layers: positiveQuantity(line.layer_qty),
        sections: positiveQuantity(line.section_qty),
        pieces: positiveQuantity(line.piece_qty)
      };
    }
    return { pallets: 0, layers: 0, sections: 0, pieces: salesAvailable };
  }
  const deriveFromSales = !hasRequiredCustomQuantity(line);
  const unitAvailable = (unit) => {
    const conversion = unitConversion(line, unit);
    if (!conversion) return 0;
    const explicit = explicitUnitQuantity(line, unit);
    if (explicit > 0) return explicit;
    return deriveFromSales ? Math.floor((salesAvailable / conversion) + 0.000001) : 0;
  };
  return {
    pallets: unitAvailable("pallets"),
    layers: unitAvailable("layers"),
    sections: unitAvailable("sections"),
    pieces: unitAvailable("pieces")
  };
}

function resolveIndependentReceivedSalesQuantity(line, received, requestedSalesQty) {
  if (hasConversion(line) || !hasRequiredCustomQuantity(line)) return 0;
  const explicitSalesQty = positiveQuantity(requestedSalesQty);
  const selectedPhysical = positiveQuantity(received.pallets)
    + positiveQuantity(received.layers)
    + positiveQuantity(received.sections)
    + positiveQuantity(received.pieces) > 0;
  const fullPhysical = [
    ["pallets", "pallet_qty"],
    ["layers", "layer_qty"],
    ["sections", "section_qty"],
    ["pieces", "piece_qty"]
  ].every(([unit, field]) => {
    const required = positiveQuantity(line[field]);
    return required <= 0.000001 || positiveQuantity(received[unit]) + 0.000001 >= required;
  });
  let salesQty = explicitSalesQty;
  if (selectedPhysical && salesQty <= 0) {
    if (!fullPhysical) throw new Error("Enter the sales-unit quantity when partially receiving a manual PLT/LYR/SEC/PCS line.");
    salesQty = remainingSalesQuantity(line);
  }
  const available = remainingSalesQuantity(line);
  if (salesQty > available + 0.000001) {
    throw new Error("Received sales quantity cannot exceed " + roundQuantity(available) + " " + (line.unit || "sales units") + ".");
  }
  return roundQuantity(salesQty);
}

function remainingLineQuantities(line) {
  const baselineReceived = netsuiteReceivedBaseline(line);
  const quantity = Math.max(positiveQuantity(line.quantity) - baselineReceived, 0);
  if (baselineReceived <= 0) {
    return {
      pallet_qty: positiveQuantity(line.pallet_qty),
      layer_qty: positiveQuantity(line.layer_qty),
      section_qty: positiveQuantity(line.section_qty),
      piece_qty: positiveQuantity(line.piece_qty),
      quantity: positiveQuantity(line.quantity)
    };
  }
  if (!hasConversion(line)) {
    return {
      pallet_qty: 0,
      layer_qty: 0,
      section_qty: 0,
      piece_qty: 0,
      quantity
    };
  }
  let remaining = quantity;
  const next = {
    pallet_qty: 0,
    layer_qty: 0,
    section_qty: 0,
    piece_qty: 0,
    quantity
  };
  const conversions = [
    ["pallet_qty", "to_plt"],
    ["layer_qty", "to_lyr"],
    ["section_qty", "to_sec"],
    ["piece_qty", "to_pcs"]
  ];
  for (const [qtyField, conversionField] of conversions) {
    const conversion = positiveQuantity(line[conversionField]);
    if (!conversion || remaining <= 0) continue;
    const units = Math.floor((remaining / conversion) + 0.000001);
    next[qtyField] = units;
    remaining = roundQuantity(remaining - (units * conversion));
  }
  return next;
}

function applyPoAllocationFields(line) {
  const allocatedPallets = positiveQuantity(line.so_allocated_pallet_qty);
  const allocatedLayers = positiveQuantity(line.so_allocated_layer_qty);
  const allocatedSections = positiveQuantity(line.so_allocated_section_qty);
  const allocatedPieces = positiveQuantity(line.so_allocated_piece_qty);
  const allocatedSalesQty = positiveQuantity(line.so_allocated_sales_qty);
  const remaining = remainingLineQuantities(line);
  return {
    ...line,
    original_pallet_qty: line.pallet_qty,
    original_layer_qty: line.layer_qty,
    original_section_qty: line.section_qty,
    original_piece_qty: line.piece_qty,
    original_quantity: line.quantity,
    so_allocated_pallet_qty: allocatedPallets,
    so_allocated_layer_qty: allocatedLayers,
    so_allocated_section_qty: allocatedSections,
    so_allocated_piece_qty: allocatedPieces,
    so_allocated_sales_qty: allocatedSalesQty,
    pallet_qty: Math.max(remaining.pallet_qty - allocatedPallets, 0),
    layer_qty: Math.max(remaining.layer_qty - allocatedLayers, 0),
    section_qty: Math.max(remaining.section_qty - allocatedSections, 0),
    piece_qty: Math.max(remaining.piece_qty - allocatedPieces, 0),
    quantity: Math.max(remaining.quantity - allocatedSalesQty, 0)
  };
}

function hasReceivingDisplayQuantity(line) {
  return positiveQuantity(line.pallet_qty) > 0
    || positiveQuantity(line.layer_qty) > 0
    || positiveQuantity(line.section_qty) > 0
    || positiveQuantity(line.piece_qty) > 0
    || positiveQuantity(line.quantity) > 0
    || positiveQuantity(line.received_pallet_qty) > 0
    || positiveQuantity(line.received_layer_qty) > 0
    || positiveQuantity(line.received_section_qty) > 0
    || positiveQuantity(line.received_piece_qty) > 0
    || positiveQuantity(line.received_sales_qty) > 0
    || Boolean(line.sync_exception);
}

export async function listReceivingVendors({ destinationLocationId = null } = {}) {
  const params = [];
  let destinationClause = "";
  if (destinationLocationId) {
    params.push(destinationLocationId);
    destinationClause = `AND destination_location_id = $${params.length}`;
  }
  const result = await query(
    `SELECT vendor_id, vendor, COUNT(*)::int AS order_count
     FROM purchase_orders
     WHERE netsuite_active = true
       AND (status_text ILIKE '%Pending Receipt%' OR status_text ILIKE '%Partially Received%')
       ${destinationClause}
     GROUP BY vendor_id, vendor
     ORDER BY vendor`,
    params
  );
  return result.rows;
}

export async function listReceivingSources({ destinationLocationId = null } = {}) {
  const params = [];
  let destinationClause = "";
  if (destinationLocationId) {
    params.push(destinationLocationId);
    destinationClause = `AND destination_location_id = $${params.length}
       AND source_location_id <> $${params.length}`;
  }
  const result = await query(
    `SELECT source_location_id, source_location, COUNT(*)::int AS order_count
     FROM (
       SELECT from_location_id AS source_location_id,
              from_location AS source_location,
              to_location_id AS destination_location_id,
              status_text,
              netsuite_active
       FROM transfer_orders t
       WHERE t.to_location_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM order_dependencies d
            WHERE d.transfer_order_id = t.netsuite_id
              AND d.dependency_mode = 'direct_to_customer'
              AND d.status <> 'cancelled'
         )
     ) transfer_receiving_source
     WHERE netsuite_active = true
       AND (status_text ILIKE '%Pending Receipt%' OR status_text ILIKE '%Partially Received%')
       ${destinationClause}
     GROUP BY source_location_id, source_location
     ORDER BY source_location`,
    params
  );
  return result.rows;
}

export async function listReceivingOrders({ orderType, vendor = null, sourceLocationId = null, destinationLocationId = null, search = null, itemSearch = null } = {}) {
  const params = [orderType];
  const clauses = ["ro.order_type = $1", "ro.netsuite_active = true", "(ro.status_text ILIKE '%Pending Receipt%' OR ro.status_text ILIKE '%Partially Received%')"];
  if (vendor) {
    params.push(vendor);
    clauses.push(`ro.vendor = $${params.length}`);
  }
  if (sourceLocationId) {
    params.push(sourceLocationId);
    clauses.push(`ro.source_location_id = $${params.length}`);
  }
  if (destinationLocationId) {
    params.push(destinationLocationId);
    clauses.push(`ro.destination_location_id = $${params.length}`);
  }
  if (search) {
    params.push(`%${String(search).trim()}%`);
    clauses.push(`(ro.tranid ILIKE $${params.length} OR ro.original_tranid ILIKE $${params.length})`);
  }
  if (itemSearch) {
    params.push(`%${String(itemSearch).trim()}%`);
    clauses.push(`EXISTS (
      SELECT 1 FROM receiving_line_source rol
      WHERE rol.order_id = ro.netsuite_id
        AND rol.netsuite_active = true
        AND (rol.item_name ILIKE $${params.length} OR rol.item_description ILIKE $${params.length})
    )`);
  }
  const result = await query(
    `WITH receiving_order_source AS (
       SELECT netsuite_id, 'purchase_order'::text AS order_type,
              COALESCE(NULLIF(dispatch_ref, ''), tranid) AS tranid,
              tranid AS original_tranid,
              dispatch_ref,
              trandate,
              vendor_id, vendor, status, status_text, foreign_total,
              source_location_id, source_location, destination_location_id, destination_location,
              netsuite_active, synced_at, receipt_status, memo, expected_delivery_date,
              dispatch_vendor_yard, dispatch_address, dispatch_window_start,
              dispatch_window_end, dispatch_instructions
       FROM purchase_orders
       UNION ALL
       SELECT netsuite_id, 'transfer_order'::text AS order_type,
              tranid,
              tranid AS original_tranid,
              NULL::text AS dispatch_ref,
              trandate,
              NULL::bigint AS vendor_id, NULL::text AS vendor, status, status_text, NULL::numeric AS foreign_total,
              from_location_id AS source_location_id, from_location AS source_location,
              to_location_id AS destination_location_id, to_location AS destination_location,
              netsuite_active, synced_at, receiving_status AS receipt_status, memo, expected_delivery_date,
              NULL::text AS dispatch_vendor_yard, dispatch_address, dispatch_window_start,
              dispatch_window_end, dispatch_instructions
       FROM transfer_orders t
       WHERE t.to_location_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM order_dependencies d
            WHERE d.transfer_order_id = t.netsuite_id
              AND d.dependency_mode = 'direct_to_customer'
              AND d.status <> 'cancelled'
         )
     ),
     receiving_line_source AS (
       SELECT purchase_order_id AS order_id, item_name, item_description, netsuite_active
       FROM purchase_order_lines
       UNION ALL
       SELECT transfer_order_id AS order_id, item_name, item_description, netsuite_active
       FROM transfer_order_lines
       WHERE line_stage = 'receiving'
     )
     SELECT ro.*,
            (SELECT COUNT(*)::int FROM receiving_line_source rol WHERE rol.order_id = ro.netsuite_id AND rol.netsuite_active = true) AS line_count
     FROM receiving_order_source ro
     WHERE ${clauses.join(" AND ")}
     ORDER BY ro.trandate DESC, ro.tranid DESC
     LIMIT 200`,
    params
  );
  return result.rows;
}

export async function getReceivingOrder(orderId) {
  const order = await query(
    `WITH receiving_order_source AS (
       SELECT netsuite_id, 'purchase_order'::text AS order_type,
              COALESCE(NULLIF(dispatch_ref, ''), tranid) AS tranid,
              tranid AS original_tranid,
              dispatch_ref,
              trandate,
              vendor_id, vendor, status, status_text, foreign_total,
              source_location_id, source_location, destination_location_id, destination_location,
              netsuite_active, synced_at, receipt_status, memo, expected_delivery_date,
              dispatch_vendor_yard, dispatch_address, dispatch_window_start,
              dispatch_window_end, dispatch_instructions
       FROM purchase_orders
       UNION ALL
       SELECT netsuite_id, 'transfer_order'::text AS order_type,
              tranid,
              tranid AS original_tranid,
              NULL::text AS dispatch_ref,
              trandate,
              NULL::bigint AS vendor_id, NULL::text AS vendor, status, status_text, NULL::numeric AS foreign_total,
              from_location_id AS source_location_id, from_location AS source_location,
              to_location_id AS destination_location_id, to_location AS destination_location,
              netsuite_active, synced_at, receiving_status AS receipt_status, memo, expected_delivery_date,
              NULL::text AS dispatch_vendor_yard, dispatch_address, dispatch_window_start,
              dispatch_window_end, dispatch_instructions
       FROM transfer_orders t
       WHERE t.to_location_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM order_dependencies d
            WHERE d.transfer_order_id = t.netsuite_id
              AND d.dependency_mode = 'direct_to_customer'
              AND d.status <> 'cancelled'
         )
     )
     SELECT *
     FROM receiving_order_source
     WHERE netsuite_id = $1`,
    [orderId]
  );
  if (!order.rowCount) return null;
  const lines = await query(
    `WITH alloc AS (
       SELECT po_line_id,
              SUM(allocated_pallet_qty) AS so_allocated_pallet_qty,
              SUM(allocated_layer_qty) AS so_allocated_layer_qty,
              SUM(allocated_section_qty) AS so_allocated_section_qty,
              SUM(allocated_piece_qty) AS so_allocated_piece_qty,
              SUM(allocated_sales_qty) AS so_allocated_sales_qty
         FROM dispatch_so_po_allocations
        WHERE status = 'active'
        GROUP BY po_line_id
     ),
     receiving_line_source AS (
       SELECT purchase_order_id AS order_id, id, line_id, item_id, item_name, item_type,
              item_type_text, item_description, sku, quantity, unit, location_id, location,
              pallet_qty, layer_qty, piece_qty, section_qty, to_plt, to_lyr, to_sec, to_pcs,
              netsuite_active, sync_exception, synced_at, received_pallet_qty,
              received_layer_qty, received_piece_qty, received_section_qty, NULL::timestamptz AS confirmed_at,
              NULL::text AS confirmed_by, netsuite_received_qty, netsuite_received_baseline_qty, pack_quantity_source, received_sales_qty
       FROM purchase_order_lines
       UNION ALL
       SELECT transfer_order_id AS order_id, id, line_id, item_id, item_name, item_type,
              item_type_text, item_description, sku, quantity, unit, location_id, location,
              pallet_qty, layer_qty, piece_qty, section_qty, to_plt, to_lyr, to_sec, to_pcs,
              netsuite_active, sync_exception, synced_at, received_pallet_qty,
              received_layer_qty, received_piece_qty, received_section_qty, NULL::timestamptz AS confirmed_at,
              NULL::text AS confirmed_by, netsuite_received_qty,
              netsuite_received_qty AS netsuite_received_baseline_qty, pack_quantity_source, received_sales_qty
       FROM transfer_order_lines
       WHERE line_stage = 'receiving'
     )
     SELECT receiving_line_source.*,
            COALESCE(alloc.so_allocated_pallet_qty, 0) AS so_allocated_pallet_qty,
            COALESCE(alloc.so_allocated_layer_qty, 0) AS so_allocated_layer_qty,
            COALESCE(alloc.so_allocated_section_qty, 0) AS so_allocated_section_qty,
            COALESCE(alloc.so_allocated_piece_qty, 0) AS so_allocated_piece_qty,
            COALESCE(alloc.so_allocated_sales_qty, 0) AS so_allocated_sales_qty
     FROM receiving_line_source
     LEFT JOIN alloc ON alloc.po_line_id = receiving_line_source.id
     WHERE order_id = $1
       AND (netsuite_active = true OR sync_exception IS NOT NULL)
     ORDER BY line_id NULLS LAST, id`,
    [orderId]
  );
  return { ...order.rows[0], lines: lines.rows.map(applyPoAllocationFields).filter(hasReceivingDisplayQuantity) };
}

export async function confirmReceivingLine(orderId, lineRowId, values, operatorId) {
  const line = await query(
    `WITH alloc AS (
       SELECT po_line_id,
              SUM(allocated_pallet_qty) AS so_allocated_pallet_qty,
              SUM(allocated_layer_qty) AS so_allocated_layer_qty,
              SUM(allocated_section_qty) AS so_allocated_section_qty,
              SUM(allocated_piece_qty) AS so_allocated_piece_qty,
              SUM(allocated_sales_qty) AS so_allocated_sales_qty
         FROM dispatch_so_po_allocations
        WHERE status = 'active'
        GROUP BY po_line_id
     ),
     receiving_line_source AS (
       SELECT 'purchase_order'::text AS order_type, purchase_order_id AS order_id, id, line_id, item_id, item_name, item_type,
              item_type_text, item_description, sku, quantity, unit, location_id, location,
              pallet_qty, layer_qty, piece_qty, section_qty, to_plt, to_lyr, to_sec, to_pcs,
              netsuite_active, sync_exception, synced_at, received_pallet_qty,
              received_layer_qty, received_piece_qty, received_section_qty, netsuite_received_qty,
              netsuite_received_baseline_qty, pack_quantity_source, received_sales_qty
       FROM purchase_order_lines
       UNION ALL
       SELECT 'transfer_order'::text AS order_type, transfer_order_id AS order_id, id, line_id, item_id, item_name, item_type,
              item_type_text, item_description, sku, quantity, unit, location_id, location,
              pallet_qty, layer_qty, piece_qty, section_qty, to_plt, to_lyr, to_sec, to_pcs,
              netsuite_active, sync_exception, synced_at, received_pallet_qty,
              received_layer_qty, received_piece_qty, received_section_qty, netsuite_received_qty,
              netsuite_received_qty AS netsuite_received_baseline_qty, pack_quantity_source, received_sales_qty
       FROM transfer_order_lines
       WHERE line_stage = 'receiving'
     )
     SELECT receiving_line_source.*,
            COALESCE(alloc.so_allocated_pallet_qty, 0) AS so_allocated_pallet_qty,
            COALESCE(alloc.so_allocated_layer_qty, 0) AS so_allocated_layer_qty,
            COALESCE(alloc.so_allocated_section_qty, 0) AS so_allocated_section_qty,
            COALESCE(alloc.so_allocated_piece_qty, 0) AS so_allocated_piece_qty,
            COALESCE(alloc.so_allocated_sales_qty, 0) AS so_allocated_sales_qty
     FROM receiving_line_source
     LEFT JOIN alloc ON alloc.po_line_id = receiving_line_source.id
     WHERE id = $1
       AND order_id = $2
       AND netsuite_active = true`,
    [lineRowId, orderId]
  );
  if (!line.rowCount) throw new Error("Receiving line not found.");
  const current = applyPoAllocationFields(line.rows[0]);
  const available = receivingUnitAvailability(current);
  const pallets = Math.min(positiveQuantity(values.pallets), available.pallets);
  const layers = Math.min(positiveQuantity(values.layers), available.layers);
  const sections = Math.min(positiveQuantity(values.sections), available.sections);
  const pieces = Math.min(positiveQuantity(values.pieces), available.pieces);
  const received = { pallets, layers, sections, pieces };
  const receivedSalesQty = resolveIndependentReceivedSalesQuantity(current, received, values.salesQty);
  if (current.order_type === "transfer_order") {
    await query(
      `UPDATE transfer_order_lines
       SET received_pallet_qty = $3,
           received_layer_qty = $4,
           received_section_qty = $5,
           received_piece_qty = $6,
           received_sales_qty = $8,
           confirmed_at = now(),
           confirmed_by = $7
       WHERE id = $1
         AND transfer_order_id = $2
         AND line_stage = 'receiving'`,
      [lineRowId, orderId, pallets, layers, sections, pieces, operatorId || null, receivedSalesQty]
    );
  } else {
    await query(
      `UPDATE purchase_order_lines
       SET received_pallet_qty = $3,
           received_layer_qty = $4,
           received_section_qty = $5,
           received_piece_qty = $6,
           received_sales_qty = $8,
           confirmed_at = now(),
           confirmed_by = $7
       WHERE id = $1
         AND purchase_order_id = $2`,
      [lineRowId, orderId, pallets, layers, sections, pieces, operatorId || null, receivedSalesQty]
    );
  }
  await writeAudit({
    actorOperatorId: operatorId,
    source: "receiving",
    action: "receiving.line.confirm",
    lineId: current.line_id,
    details: { receivingOrderId: orderId, pallets, layers, sections, pieces, salesQty: receivedSalesQty }
  });
  return getReceivingOrder(orderId);
}

export async function unconfirmReceivingLine(orderId, lineRowId, operatorId) {
  const line = await query(
    `WITH receiving_line_source AS (
       SELECT purchase_order_id AS order_id,
              'purchase_order'::text AS order_type,
              id,
              line_id,
              received_pallet_qty,
              received_layer_qty,
              received_section_qty,
              received_piece_qty
         FROM purchase_order_lines
        UNION ALL
       SELECT transfer_order_id AS order_id,
              'transfer_order'::text AS order_type,
              id,
              line_id,
              received_pallet_qty,
              received_layer_qty,
              received_section_qty,
              received_piece_qty
         FROM transfer_order_lines
        WHERE line_stage = 'receiving'
     )
     SELECT *
       FROM receiving_line_source
      WHERE id = $1
        AND order_id = $2`,
    [lineRowId, orderId]
  );
  if (!line.rowCount) throw new Error("Receiving line not found.");
  const current = line.rows[0];
  if (current.order_type === "transfer_order") {
    await query(
      `UPDATE transfer_order_lines
          SET received_pallet_qty = 0,
              received_layer_qty = 0,
              received_section_qty = 0,
              received_piece_qty = 0,
              received_sales_qty = 0,
              confirmed_at = null,
              confirmed_by = null
        WHERE id = $1
          AND transfer_order_id = $2
          AND line_stage = 'receiving'`,
      [lineRowId, orderId]
    );
  } else {
    await query(
      `UPDATE purchase_order_lines
          SET received_pallet_qty = 0,
              received_layer_qty = 0,
              received_section_qty = 0,
              received_piece_qty = 0,
              received_sales_qty = 0,
              confirmed_at = null,
              confirmed_by = null
        WHERE id = $1
          AND purchase_order_id = $2`,
      [lineRowId, orderId]
    );
  }
  await writeAudit({
    actorOperatorId: operatorId,
    source: "receiving",
    action: "receiving.line.unconfirm",
    lineId: current.line_id,
    details: {
      receivingOrderId: orderId,
      pallets: current.received_pallet_qty,
      layers: current.received_layer_qty,
      sections: current.received_section_qty,
      pieces: current.received_piece_qty
    }
  });
  return getReceivingOrder(orderId);
}

export async function getReceivableReceivingOrder(orderId) {
  const order = await getReceivingOrder(orderId);
  if (!order) throw new Error("Receiving order not found.");
  const receivableLines = (order.lines || []).filter((line) => {
    if (remainingSalesQuantity(line) <= 0) return false;
    const total = positiveQuantity(line.received_pallet_qty)
      + positiveQuantity(line.received_layer_qty)
      + positiveQuantity(line.received_section_qty)
      + positiveQuantity(line.received_piece_qty);
    return line.netsuite_active && !line.sync_exception && ["InvtPart", "NonInvtPart"].includes(line.item_type || "") && total > 0;
  });
  if (!receivableLines.length) throw new Error("No confirmed lines to receive.");
  return { ...order, receivableLines };
}

export function buildItemReceiptPayload(order, lines) {
  const isTransferOrder = order.order_type === "transfer_order";
  const items = lines.map((line) => {
    const item = {
      orderLine: Number(line.line_id),
      quantity: receiptLineQuantity(line),
      itemReceive: true
    };
    if (!isTransferOrder) {
      item.location = Number(line.location_id || order.destination_location_id);
    }
    return item;
  });

  const receivedLineIds = new Set(lines.map((line) => Number(line.line_id)));
  for (const line of order.lines || []) {
    if (!line.netsuite_active || !["InvtPart", "NonInvtPart"].includes(line.item_type || "")) continue;
    if (remainingSalesQuantity(line) <= 0) continue;
    if (receivedLineIds.has(Number(line.line_id))) continue;
    const item = {
      orderLine: Number(line.line_id),
      itemReceive: false
    };
    if (!isTransferOrder) item.location = Number(line.location_id || order.destination_location_id);
    items.push(item);
  }

  return { item: { items } };
}

function receiptLineQuantity(line) {
  const baseQuantity = positiveQuantity(line.received_piece_qty)
    || positiveQuantity(line.received_section_qty)
    || positiveQuantity(line.received_layer_qty)
    || positiveQuantity(line.received_pallet_qty);
  const remaining = remainingSalesQuantity(line);
  if (!hasConversion(line)) {
    const quantity = hasRequiredCustomQuantity(line) ? positiveQuantity(line.received_sales_qty) : baseQuantity;
    return roundQuantity(Math.min(quantity, remaining || quantity));
  }
  const convertedQuantity = (positiveQuantity(line.received_pallet_qty) * positiveQuantity(line.to_plt))
    + (positiveQuantity(line.received_layer_qty) * positiveQuantity(line.to_lyr))
    + (positiveQuantity(line.received_section_qty) * positiveQuantity(line.to_sec))
    + (positiveQuantity(line.received_piece_qty) * positiveQuantity(line.to_pcs));
  const quantity = convertedQuantity || baseQuantity;
  return roundQuantity(Math.min(quantity, remaining || quantity));
}

function remainingSalesQuantity(line) {
  if (Object.hasOwn(line || {}, "original_quantity")) return positiveQuantity(line.quantity);
  return Math.max(positiveQuantity(line.quantity) - netsuiteReceivedBaseline(line), 0);
}

function locationTextFromId(value) {
  const text = String(value || "").trim();
  if (text === "1") return "3445";
  if (text === "13" || text === "28") return "2967";
  if (text === "15") return "12441";
  return text;
}

export async function listLocalCoSources({ destinationLocationId = null } = {}) {
  const params = [];
  const clauses = ["status = 'planned'"];
  if (destinationLocationId) {
    params.push(destinationLocationId);
    clauses.push(`to_location_id = $${params.length}`);
  }
  const result = await query(
    `SELECT from_location_id AS source_location_id,
            from_location AS source_location,
            COUNT(*)::int AS order_count
       FROM co_orders
      WHERE ${clauses.join(" AND ")}
      GROUP BY from_location_id, from_location
      ORDER BY from_location`,
    params
  );
  return result.rows;
}

export async function listLocalCoReceivingOrders({ sourceLocationId = null, destinationLocationId = null, search = null, itemSearch = null } = {}) {
  const params = [];
  const clauses = ["co.status = 'planned'"];
  if (sourceLocationId) {
    params.push(sourceLocationId);
    clauses.push(`co.from_location_id = $${params.length}`);
  }
  if (destinationLocationId) {
    params.push(destinationLocationId);
    clauses.push(`co.to_location_id = $${params.length}`);
  }
  if (search) {
    params.push(`%${String(search).trim()}%`);
    clauses.push(`(co.co_ref ILIKE $${params.length} OR co.source_order_ref ILIKE $${params.length})`);
  }
  if (itemSearch) {
    params.push(`%${String(itemSearch).trim()}%`);
    clauses.push(`EXISTS (
      SELECT 1 FROM co_order_lines line
      WHERE line.co_id = co.id
        AND (line.item_name ILIKE $${params.length} OR line.item_description ILIKE $${params.length})
    )`);
  }
  const result = await query(
    `SELECT co.delivery_order_id AS netsuite_id,
            co.co_ref AS tranid,
            'co_order' AS order_type,
            co.created_at::date AS trandate,
            co.source_order_ref,
            co.from_location_id AS source_location_id,
            co.from_location AS source_location,
            co.to_location_id AS destination_location_id,
            co.to_location AS destination_location,
            co.status,
            co.dispatch_plan_date,
            co.dispatch_truck_plate,
            co.dispatch_load_name,
            co.dispatch_parking_spot,
            'Local CO - Pending Receive' AS status_text,
            co.details,
            (SELECT COUNT(*)::int FROM co_order_lines line WHERE line.co_id = co.id) AS line_count
       FROM co_orders co
      WHERE ${clauses.join(" AND ")}
      ORDER BY co.created_at DESC, co.co_ref DESC
      LIMIT 200`,
    params
  );
  return result.rows;
}

export async function searchLocalCoItems({ sourceLocationId = null, destinationLocationId = null, search = "" } = {}) {
  const term = String(search || "").trim();
  if (term.length < 2) return [];
  const params = [`%${term}%`];
  const clauses = [
    "co.status = 'planned'",
    "(line.item_name ILIKE $1 OR line.item_description ILIKE $1)"
  ];
  if (sourceLocationId) {
    params.push(sourceLocationId);
    clauses.push(`co.from_location_id = $${params.length}`);
  }
  if (destinationLocationId) {
    params.push(destinationLocationId);
    clauses.push(`co.to_location_id = $${params.length}`);
  }
  const result = await query(
    `SELECT line.item_id,
            line.item_name,
            MIN(line.item_description) AS item_description,
            COUNT(DISTINCT co.id)::int AS order_count
       FROM co_order_lines line
       INNER JOIN co_orders co ON co.id = line.co_id
      WHERE ${clauses.join(" AND ")}
      GROUP BY line.item_id, line.item_name
      ORDER BY order_count DESC, line.item_name
      LIMIT 12`,
    params
  );
  return result.rows;
}

export async function getLocalCoReceivingOrder(coRefOrId) {
  const order = await query(
    `SELECT co.delivery_order_id AS netsuite_id,
            co.co_ref AS tranid,
            'co_order' AS order_type,
            co.created_at::date AS trandate,
            co.source_order_ref,
            co.from_location_id AS source_location_id,
            co.from_location AS source_location,
            co.to_location_id AS destination_location_id,
            co.to_location AS destination_location,
            co.status,
            'Local CO - Pending Receive' AS status_text,
            co.details
       FROM co_orders co
      WHERE co.co_ref = $1 OR co.delivery_order_id::text = $1 OR co.id::text = $1`,
    [String(coRefOrId)]
  );
  if (!order.rowCount) return null;
  const lines = await query(
    `SELECT line.*,
            line.co_id AS order_id,
            true AS netsuite_active,
            null::text AS sync_exception,
            0::numeric AS netsuite_received_qty
       FROM co_order_lines line
       INNER JOIN co_orders co ON co.id = line.co_id
      WHERE co.co_ref = $1 OR co.delivery_order_id::text = $1 OR co.id::text = $1
      ORDER BY line.line_id, line.id`,
    [String(coRefOrId)]
  );
  return { ...order.rows[0], lines: lines.rows };
}

export async function confirmLocalCoReceivingLine(coRefOrId, lineRowId, values, operatorId) {
  const line = await query(
    `SELECT line.*
       FROM co_order_lines line
       INNER JOIN co_orders co ON co.id = line.co_id
      WHERE line.id = $1
        AND (co.co_ref = $2 OR co.delivery_order_id::text = $2 OR co.id::text = $2)
        AND co.status = 'planned'`,
    [lineRowId, String(coRefOrId)]
  );
  if (!line.rowCount) throw new Error("CO receiving line not found.");
  const current = line.rows[0];
  const available = receivingUnitAvailability(current);
  const pallets = Math.min(positiveQuantity(values.pallets), available.pallets);
  const layers = Math.min(positiveQuantity(values.layers), available.layers);
  const sections = Math.min(positiveQuantity(values.sections), available.sections);
  const pieces = Math.min(positiveQuantity(values.pieces), available.pieces);
  await query(
    `UPDATE co_order_lines
        SET received_pallet_qty = $2,
            received_layer_qty = $3,
            received_section_qty = $4,
            received_piece_qty = $5,
            confirmed_at = now(),
            confirmed_by = $6
      WHERE id = $1`,
    [lineRowId, pallets, layers, sections, pieces, operatorId || null]
  );
  await writeAudit({
    actorOperatorId: operatorId,
    source: "receiving",
    action: "local_co.line.confirm",
    details: { coRefOrId, lineRowId, pallets, layers, sections, pieces }
  });
  return getLocalCoReceivingOrder(coRefOrId);
}

export async function unconfirmLocalCoReceivingLine(coRefOrId, lineRowId, operatorId) {
  const line = await query(
    `SELECT line.*
       FROM co_order_lines line
       INNER JOIN co_orders co ON co.id = line.co_id
      WHERE line.id = $1
        AND (co.co_ref = $2 OR co.delivery_order_id::text = $2 OR co.id::text = $2)
        AND co.status = 'planned'`,
    [lineRowId, String(coRefOrId)]
  );
  if (!line.rowCount) throw new Error("CO receiving line not found.");
  const current = line.rows[0];
  await query(
    `UPDATE co_order_lines
        SET received_pallet_qty = 0,
            received_layer_qty = 0,
            received_section_qty = 0,
            received_piece_qty = 0,
            confirmed_at = null,
            confirmed_by = null
      WHERE id = $1`,
    [lineRowId]
  );
  await writeAudit({
    actorOperatorId: operatorId,
    source: "receiving",
    action: "local_co.line.unconfirm",
    details: {
      coRefOrId,
      lineRowId,
      pallets: current.received_pallet_qty,
      layers: current.received_layer_qty,
      sections: current.received_section_qty,
      pieces: current.received_piece_qty
    }
  });
  return getLocalCoReceivingOrder(coRefOrId);
}

export async function receiveLocalCoOrder(coRefOrId, operatorId, { photoDataUrls = [] } = {}) {
  const photos = Array.isArray(photoDataUrls) ? photoDataUrls.filter(isPhotoReference) : [];
  if (photos.length < 2) throw new Error("Two receiving photos are required.");
  const co = await getLocalCoReceivingOrder(coRefOrId);
  if (!co) throw new Error("Local CO not found.");
  if (co.status !== "planned") throw new Error("This CO is not ready for receiving.");
  const confirmedLines = (co.lines || []).filter((line) => {
    return positiveQuantity(line.received_pallet_qty)
      + positiveQuantity(line.received_layer_qty)
      + positiveQuantity(line.received_section_qty)
      + positiveQuantity(line.received_piece_qty) > 0;
  });
  if (!confirmedLines.length) throw new Error("No confirmed CO lines to receive.");
  const sourceDelivery = await query(
    `SELECT *
       FROM sales_orders
      WHERE tranid = $1
      LIMIT 1`,
    [co.source_order_ref]
  );
  const sourceTransfer = await query(
    `SELECT *
       FROM transfer_orders
      WHERE tranid = $1
      LIMIT 1`,
    [co.source_order_ref]
  );
  const sourceOrder = sourceDelivery.rows[0] || null;
  const sourceTransferOrder = sourceTransfer.rows[0] || null;
  const receiveAsSourceSo = Boolean(sourceOrder);
  const receiveAsSourceTransfer = !receiveAsSourceSo && Boolean(sourceTransferOrder);
  const deliveryOrderId = receiveAsSourceSo
    ? Number(sourceOrder.netsuite_id)
    : receiveAsSourceTransfer
      ? Number(sourceTransferOrder.netsuite_id)
      : Number(co.netsuite_id);
  const coRemark = `${co.tranid}: received transit stock from ${co.source_location} for ${co.source_order_ref}.`;
  const sourceForMemo = sourceOrder || sourceTransferOrder || {};
  const receiveAsSourceOrder = receiveAsSourceSo || receiveAsSourceTransfer;
  const existingMemo = receiveAsSourceOrder ? String(sourceForMemo.memo || "").trim() : "";
  const existingInstructions = receiveAsSourceOrder ? String(sourceForMemo.dispatch_instructions || "").trim() : "";
  const deliveryMemo = receiveAsSourceOrder
    ? (existingMemo.includes(co.tranid) ? existingMemo : `${coRemark}${existingMemo ? ` ${existingMemo}` : ""}`)
    : `Local CO received for ${co.source_order_ref}`;
  const deliveryInstructions = receiveAsSourceOrder
    ? (existingInstructions.includes(co.tranid) ? existingInstructions : `${coRemark}${existingInstructions ? ` ${existingInstructions}` : ""}`)
    : `Local CO ${co.tranid} received from ${co.source_location}.`;
  const today = new Date().toISOString().slice(0, 10);
  if (receiveAsSourceSo) {
    await query(
      `UPDATE sales_orders
          SET outbound_location_id = $2,
              outbound_location = $3,
              memo = $4,
              dispatch_address = $5,
              dispatch_instructions = $6,
              netsuite_active = true,
              operator_status = 'packed',
              status_updated_at = now(),
              local_yard_order_status = 'Open',
              dispatch_planned = true,
              dispatch_plan_date = $7::date,
              dispatch_truck_plate = $8,
              dispatch_load_name = $9,
              dispatch_parking_spot = $10,
              dispatch_planned_at = now()
        WHERE netsuite_id = $1`,
      [
        deliveryOrderId,
        co.destination_location_id,
        co.destination_location,
        deliveryMemo,
        `${locationTextFromId(co.destination_location_id)} yard`,
        deliveryInstructions,
        co.dispatch_plan_date || null,
        co.dispatch_truck_plate || "",
        co.dispatch_load_name || "",
        co.dispatch_parking_spot || ""
      ]
    );
  } else if (receiveAsSourceTransfer) {
    await query(
      `UPDATE transfer_orders
          SET from_location_id = $2,
              from_location = $3,
              memo = $4,
              dispatch_address = $5,
              dispatch_instructions = $6,
              netsuite_active = true,
              outbound_operator_status = 'packed',
              status_updated_at = now(),
              local_yard_order_status = 'Open',
              dispatch_planned = true,
              dispatch_plan_date = $7::date,
              dispatch_truck_plate = $8,
              dispatch_load_name = $9,
              dispatch_parking_spot = $10,
              dispatch_planned_at = now()
        WHERE netsuite_id = $1`,
      [
        deliveryOrderId,
        co.destination_location_id,
        co.destination_location,
        deliveryMemo,
        `${locationTextFromId(co.destination_location_id)} yard`,
        deliveryInstructions,
        co.dispatch_plan_date || null,
        co.dispatch_truck_plate || "",
        co.dispatch_load_name || "",
        co.dispatch_parking_spot || ""
      ]
    );
  } else {
    await query(
      `INSERT INTO transfer_orders (
         netsuite_id, tranid, trandate, status, status_text,
         from_location_id, from_location, to_location_id, to_location,
         outbound_operator_status, local_yard_order_status, memo,
         dispatch_address, dispatch_instructions, netsuite_active,
         dispatch_planned, dispatch_plan_date, dispatch_truck_plate,
         dispatch_load_name, dispatch_parking_spot, dispatch_planned_at,
         status_updated_at
       ) VALUES (
         $1, $2, $3::date, 'B', 'Pending Fulfillment - Local CO',
         $4, $5, $6, $7,
         'packed', 'Open', $8,
         $9, $10, true,
         true, $11::date, $12, $13, $14, now(), now()
       )
       ON CONFLICT (netsuite_id) DO UPDATE SET
         status = EXCLUDED.status,
         status_text = EXCLUDED.status_text,
         from_location_id = EXCLUDED.from_location_id,
         from_location = EXCLUDED.from_location,
         to_location_id = EXCLUDED.to_location_id,
         to_location = EXCLUDED.to_location,
         outbound_operator_status = 'packed',
         local_yard_order_status = 'Open',
         memo = EXCLUDED.memo,
         dispatch_address = EXCLUDED.dispatch_address,
         dispatch_instructions = EXCLUDED.dispatch_instructions,
         netsuite_active = true,
         dispatch_planned = true,
         dispatch_plan_date = EXCLUDED.dispatch_plan_date,
         dispatch_truck_plate = EXCLUDED.dispatch_truck_plate,
         dispatch_load_name = EXCLUDED.dispatch_load_name,
         dispatch_parking_spot = EXCLUDED.dispatch_parking_spot,
         dispatch_planned_at = now(),
         status_updated_at = now()`,
      [
        deliveryOrderId,
        co.tranid,
        today,
        co.source_location_id,
        co.source_location,
        co.destination_location_id,
        co.destination_location,
        deliveryMemo,
        `${locationTextFromId(co.destination_location_id)} yard`,
        deliveryInstructions,
        co.dispatch_plan_date || null,
        co.dispatch_truck_plate || "",
        co.dispatch_load_name || "",
        co.dispatch_parking_spot || ""
      ]
    );
  }

  if (receiveAsSourceSo) {
    await query("DELETE FROM sales_order_lines WHERE sales_order_id = $1", [deliveryOrderId]);
  } else {
    await query("DELETE FROM transfer_order_lines WHERE transfer_order_id = $1 AND line_stage = 'outbound'", [deliveryOrderId]);
  }
  for (const line of confirmedLines) {
    const values = [
      deliveryOrderId,
      line.line_id,
      line.item_id,
      line.item_name,
      line.item_type || "InvtPart",
      line.item_type_text || "Inventory Item",
      line.item_description,
      line.sku,
      line.quantity,
      line.unit,
      co.destination_location_id,
      co.destination_location,
      line.received_pallet_qty,
      line.received_layer_qty,
      line.received_piece_qty,
      line.received_section_qty,
      line.to_plt,
      line.to_lyr,
      line.to_sec,
      line.to_pcs,
      line.received_pallet_qty,
      line.received_layer_qty,
      line.received_piece_qty,
      line.received_section_qty
    ];
    if (receiveAsSourceSo) {
      await query(
        `INSERT INTO sales_order_lines (
          sales_order_id, line_id, item_id, item_name, item_type, item_type_text,
          item_description, sku, quantity, unit, location_id, location,
          pallet_qty, layer_qty, piece_qty, section_qty, to_plt, to_lyr, to_sec, to_pcs,
          packed_pallet_qty, packed_layer_qty, packed_piece_qty, packed_section_qty,
          confirmed, confirmed_at, synced_at, netsuite_active
        ) VALUES (
          $1, $2, $3, $4, COALESCE($5, 'InvtPart'), $6,
          $7, $8, $9, $10, $11, $12,
          $13, $14, $15, $16, $17, $18, $19, $20,
          $21, $22, $23, $24,
          true, now(), now(), true
        )`,
        values
      );
    } else {
      await query(
        `INSERT INTO transfer_order_lines (
          line_stage, transfer_order_id, line_id, item_id, item_name, item_type, item_type_text,
          item_description, sku, quantity, unit, location_id, location,
          pallet_qty, layer_qty, piece_qty, section_qty, to_plt, to_lyr, to_sec, to_pcs,
          packed_pallet_qty, packed_layer_qty, packed_piece_qty, packed_section_qty,
          confirmed, confirmed_at, raw, synced_at, netsuite_active
        ) VALUES (
          'outbound', $1, $2, $3, $4, COALESCE($5, 'InvtPart'), $6,
          $7, $8, $9, $10, $11, $12,
          $13, $14, $15, $16, $17, $18, $19, $20,
          $21, $22, $23, $24,
          true, now(), $25::jsonb, now(), true
        )`,
        [...values, JSON.stringify(line.raw || {})]
      );
    }
  }
  await query(
    `UPDATE co_orders
        SET status = 'received',
            received_by = $2,
            received_at = now(),
            updated_at = now()
      WHERE co_ref = $1 OR delivery_order_id::text = $1 OR id::text = $1`,
    [String(coRefOrId), operatorId || null]
  );
  await query(
    `INSERT INTO local_co_receipt_records (
       co_id, operator_id, photo_data_urls, created_delivery_order_id, response
     )
     SELECT id, $2, $3::jsonb, $4, $5::jsonb
       FROM co_orders
      WHERE co_ref = $1 OR delivery_order_id::text = $1 OR id::text = $1`,
    [
      String(coRefOrId),
      operatorId || null,
      JSON.stringify(photos),
      deliveryOrderId,
      JSON.stringify({ deliveryOrderId, localYardOrderStatus: "Packed" })
    ]
  );
  await writeAudit({
    actorOperatorId: operatorId,
    source: "receiving",
    action: "local_co.order.receive",
    orderId: deliveryOrderId,
    details: {
      coRef: co.tranid,
      sourceOrderRef: co.source_order_ref,
      deliveryOrderId,
      revivedSourceSalesOrder: receiveAsSourceSo,
      revivedSourceTransferOrder: receiveAsSourceTransfer,
      lines: confirmedLines.length
    }
  });
  return {
    receiptStatus: "local_co_received",
    itemReceiptTranid: co.tranid,
    deliveryOrderId,
    localYardOrderStatus: "Packed"
  };
}

export async function recordReceivingReceipt(orderId, operatorId, { photoDataUrls, payload, response, itemReceiptId, itemReceiptTranid }) {
  const photos = Array.isArray(photoDataUrls) ? photoDataUrls.filter(isPhotoReference) : [];
  if (photos.length < 2) throw new Error("Two receiving photos are required.");
  const order = await getReceivingOrder(orderId);
  if (!order) throw new Error("Receiving order not found.");
  const receivedIds = (payload?.item?.items || [])
    .filter((item) => item.itemReceive !== false && positiveQuantity(item.quantity) > 0)
    .map((item) => Number(item.orderLine))
    .filter((id) => Number.isInteger(id));

  const remainingLines = (order.lines || []).filter((line) => {
    if (!line.netsuite_active || !["InvtPart", "NonInvtPart"].includes(line.item_type || "")) return false;
    if (!receivedIds.includes(Number(line.line_id))) return true;
    if (receivedSalesQuantity(line) + 0.000001 < remainingSalesQuantity(line)) return true;
    return false;
  });
  const receiptStatus = remainingLines.length ? "partial_received" : "received";

  await query(
    `INSERT INTO receiving_receipt_records (
       order_id, operator_id, item_receipt_id, item_receipt_tranid,
       receipt_status, photo_data_urls, payload, response
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      orderId,
      operatorId || null,
      itemReceiptId || null,
      itemReceiptTranid || null,
      receiptStatus,
      JSON.stringify(photos),
      JSON.stringify(payload || {}),
      JSON.stringify(response || {})
    ]
  );

  if (order.order_type === "transfer_order") {
    await query(
      `UPDATE transfer_orders
       SET receiving_status = $2,
           last_item_receipt_id = $3,
           last_item_receipt_tranid = $4,
           received_at = now()
       WHERE netsuite_id = $1`,
      [orderId, receiptStatus, itemReceiptId || null, itemReceiptTranid || null]
    );
  } else {
    await query(
      `UPDATE purchase_orders
       SET receipt_status = $2,
           last_item_receipt_id = $3,
           last_item_receipt_tranid = $4,
           received_at = now()
       WHERE netsuite_id = $1`,
      [orderId, receiptStatus, itemReceiptId || null, itemReceiptTranid || null]
    );
  }

  await writeAudit({
    actorOperatorId: operatorId,
    source: "receiving",
    action: "receiving.order.receive",
    details: { receivingOrderId: orderId, receiptStatus, itemReceiptId, itemReceiptTranid, payload, response }
  });
  return { receiptStatus, itemReceiptId, itemReceiptTranid };
}

export async function recordReceivingReceiptFailure(orderId, operatorId, { photoDataUrls, payload, error, stage }) {
  const message = error?.message || String(error || "Unknown receiving error");
  try {
    await query(
      `INSERT INTO receiving_receipt_records (
         order_id, operator_id, receipt_status, photo_data_urls, payload, response
       ) VALUES ($1, $2, 'failed', $3, $4, $5)`,
      [
        orderId,
        operatorId || null,
        JSON.stringify(Array.isArray(photoDataUrls) ? photoDataUrls : []),
        JSON.stringify(payload || {}),
        JSON.stringify({ error: message, stage: stage || null })
      ]
    );
    await writeAudit({
      actorOperatorId: operatorId,
      source: "receiving",
      action: "receiving.order.receive_failed",
      details: { receivingOrderId: orderId, error: message, stage, payload }
    });
  } catch (recordError) {
    console.error("Receiving receipt failure record failed:", recordError.message);
  }
}

export async function listReceivingReceipts({ limit = 100, operatorId = null } = {}) {
  const params = [];
  const clauses = [];
  if (operatorId) {
    params.push(operatorId);
    clauses.push(`r.operator_id = $${params.length}`);
  }
  params.push(Math.min(Math.max(Number(limit) || 100, 1), 500));
  const result = await query(
    `WITH receiving_order_source AS (
       SELECT netsuite_id, COALESCE(NULLIF(dispatch_ref, ''), tranid) AS tranid, 'purchase_order'::text AS order_type FROM purchase_orders
       UNION ALL
       SELECT netsuite_id, tranid, 'transfer_order'::text AS order_type FROM transfer_orders
     )
     SELECT r.id,
            r.order_id,
            o.tranid,
            o.order_type,
            r.item_receipt_id,
            r.item_receipt_tranid,
            r.receipt_status,
            r.created_at,
            op.display_name AS operator_name,
            r.payload,
            r.response
     FROM receiving_receipt_records r
     LEFT JOIN receiving_order_source o ON o.netsuite_id = r.order_id
     LEFT JOIN operators op ON op.id = r.operator_id
     ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
     ORDER BY r.created_at DESC
     LIMIT $${params.length}`,
    params
  );
  return result.rows;
}

export async function searchReceivingItems({ orderType, vendor = null, sourceLocationId = null, destinationLocationId = null, search = "" } = {}) {
  const term = String(search || "").trim();
  if (term.length < 2) return [];
  const params = [orderType, `%${term}%`];
  const clauses = [
    "ro.order_type = $1",
    "ro.netsuite_active = true",
    "(ro.status_text ILIKE '%Pending Receipt%' OR ro.status_text ILIKE '%Partially Received%')",
    "rol.netsuite_active = true",
    "(rol.item_name ILIKE $2 OR rol.item_description ILIKE $2)"
  ];
  if (vendor) {
    params.push(vendor);
    clauses.push(`ro.vendor = $${params.length}`);
  }
  if (sourceLocationId) {
    params.push(sourceLocationId);
    clauses.push(`ro.source_location_id = $${params.length}`);
  }
  if (destinationLocationId) {
    params.push(destinationLocationId);
    clauses.push(`ro.destination_location_id = $${params.length}`);
  }
  const result = await query(
    `WITH receiving_order_source AS (
       SELECT netsuite_id, 'purchase_order'::text AS order_type, vendor,
              NULL::bigint AS source_location_id, destination_location_id,
              status_text, netsuite_active
       FROM purchase_orders
       UNION ALL
       SELECT netsuite_id, 'transfer_order'::text AS order_type, NULL::text AS vendor,
              from_location_id AS source_location_id, to_location_id AS destination_location_id,
              status_text, netsuite_active
       FROM transfer_orders t
       WHERE t.to_location_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM order_dependencies d
            WHERE d.transfer_order_id = t.netsuite_id
              AND d.dependency_mode = 'direct_to_customer'
              AND d.status <> 'cancelled'
         )
     ),
     receiving_line_source AS (
       SELECT purchase_order_id AS order_id, item_id, item_name, item_description, netsuite_active
       FROM purchase_order_lines
       UNION ALL
       SELECT transfer_order_id AS order_id, item_id, item_name, item_description, netsuite_active
       FROM transfer_order_lines
       WHERE line_stage = 'receiving'
     )
     SELECT rol.item_id,
            rol.item_name,
            MIN(rol.item_description) AS item_description,
            COUNT(DISTINCT ro.netsuite_id)::int AS order_count
     FROM receiving_line_source rol
     INNER JOIN receiving_order_source ro ON ro.netsuite_id = rol.order_id
     WHERE ${clauses.join(" AND ")}
     GROUP BY rol.item_id, rol.item_name
     ORDER BY order_count DESC, rol.item_name
     LIMIT 12`,
    params
  );
  return result.rows;
}
