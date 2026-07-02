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
  return Math.max(0, normalizeQuantity(value) || 0);
}

function isPhotoReference(value) {
  const text = String(value || "");
  return text.startsWith("data:image/") || text.startsWith("r2://");
}

function roundQuantity(value) {
  return Number(Number(value || 0).toFixed(6));
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

function lineUnitsToSalesQuantity(line, quantities) {
  const pallets = positiveQuantity(quantities?.pallets);
  const layers = positiveQuantity(quantities?.layers);
  const sections = positiveQuantity(quantities?.sections);
  const pieces = positiveQuantity(quantities?.pieces);
  if (!hasConversion(line)) return pieces || sections || layers || pallets;
  return (pallets * positiveQuantity(line.to_plt))
    + (layers * positiveQuantity(line.to_lyr))
    + (sections * positiveQuantity(line.to_sec))
    + (pieces * positiveQuantity(line.to_pcs));
}

function lineRequiredSalesQuantity(line) {
  return positiveQuantity(line.quantity) || lineUnitsToSalesQuantity(line, {
    pallets: line.pallet_qty,
    layers: line.layer_qty,
    sections: line.section_qty,
    pieces: line.piece_qty
  });
}

function linePackedSalesQuantity(line) {
  return lineUnitsToSalesQuantity(line, {
    pallets: line.packed_pallet_qty,
    layers: line.packed_layer_qty,
    sections: line.packed_section_qty,
    pieces: line.packed_piece_qty
  });
}

function lineLoadedSalesQuantity(line) {
  return positiveQuantity(line.loaded_qty);
}

function orderFamily(order) {
  if (order?.order_type === "transfer_order") return "transfer_order";
  return "sales_order";
}

function operatorLoadLineSnapshot(lines = []) {
  return lines
    .filter((line) => positiveQuantity(line.loaded_qty) > 0 || positiveQuantity(line.packed_pallet_qty) > 0 || positiveQuantity(line.packed_layer_qty) > 0 || positiveQuantity(line.packed_section_qty) > 0 || positiveQuantity(line.packed_piece_qty) > 0)
    .map((line) => ({
      lineId: line.line_id,
      itemId: line.item_id,
      itemName: line.item_name,
      description: line.item_description || "",
      quantity: line.quantity,
      unit: line.unit,
      packedPallets: positiveQuantity(line.packed_pallet_qty),
      packedLayers: positiveQuantity(line.packed_layer_qty),
      packedSections: positiveQuantity(line.packed_section_qty),
      packedPieces: positiveQuantity(line.packed_piece_qty),
      loadedQty: positiveQuantity(line.loaded_qty),
      loadedUom: line.loaded_uom || line.unit || ""
    }));
}

async function insertOperatorLoadRecord({
  loadType,
  order,
  operatorId,
  photoDataUrl,
  loadedQty = null,
  loadedUom = null,
  sourceTable = null,
  sourceRecordId = null,
  lineSnapshot = [],
  response = {}
}) {
  const result = await query(
    `INSERT INTO operator_load_records (
       load_type, order_family, order_id, order_ref, source_table, source_record_id,
       operator_id, photo_data_url, loaded_qty, loaded_uom, line_snapshot, response
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb)
     ON CONFLICT (source_table, source_record_id) DO UPDATE SET
       load_type = EXCLUDED.load_type,
       order_family = EXCLUDED.order_family,
       order_id = EXCLUDED.order_id,
       order_ref = EXCLUDED.order_ref,
       operator_id = EXCLUDED.operator_id,
       photo_data_url = EXCLUDED.photo_data_url,
       loaded_qty = EXCLUDED.loaded_qty,
       loaded_uom = EXCLUDED.loaded_uom,
       line_snapshot = EXCLUDED.line_snapshot,
       response = EXCLUDED.response
     RETURNING id`,
    [
      loadType,
      orderFamily(order),
      order?.netsuite_id || null,
      order?.tranid || "",
      sourceTable,
      sourceRecordId,
      operatorId || null,
      photoDataUrl || "",
      loadedQty,
      loadedUom,
      JSON.stringify(lineSnapshot || []),
      JSON.stringify(response || {})
    ]
  );
  return result.rows[0] || null;
}

function loadedUnitConsumption(line) {
  let remainingLoadedSales = lineLoadedSalesQuantity(line);
  const units = [
    { key: "pallet", required: positiveQuantity(line.pallet_qty), conversion: positiveQuantity(line.to_plt) },
    { key: "layer", required: positiveQuantity(line.layer_qty), conversion: positiveQuantity(line.to_lyr) },
    { key: "section", required: positiveQuantity(line.section_qty), conversion: positiveQuantity(line.to_sec) },
    { key: "piece", required: positiveQuantity(line.piece_qty), conversion: positiveQuantity(line.to_pcs) }
  ];
  return units.reduce((result, unit) => {
    if (!unit.required || !unit.conversion || remainingLoadedSales <= 0) {
      result[unit.key] = 0;
      return result;
    }
    const consumed = Math.min(unit.required, Math.floor((remainingLoadedSales / unit.conversion) + 0.000001));
    result[unit.key] = consumed;
    remainingLoadedSales = Math.max(0, remainingLoadedSales - (consumed * unit.conversion));
    return result;
  }, {});
}

function remainingPackAvailability(line) {
  const salesAvailable = Math.max(0, lineRequiredSalesQuantity(line) - lineLoadedSalesQuantity(line));
  if (!hasConversion(line)) {
    return { pallets: 0, layers: 0, sections: 0, pieces: salesAvailable };
  }
  const consumed = loadedUnitConsumption(line);
  const deriveFromSales = !hasRequiredCustomQuantity(line);
  const unitAvailable = (unit, consumedValue) => {
    const conversion = unitConversion(line, unit);
    if (!conversion) return 0;
    const explicit = explicitUnitQuantity(line, unit);
    if (explicit > 0) return Math.max(0, explicit - positiveQuantity(consumedValue));
    return deriveFromSales ? Math.floor((salesAvailable / conversion) + 0.000001) : 0;
  };
  return {
    pallets: unitAvailable("pallets", consumed.pallet),
    layers: unitAvailable("layers", consumed.layer),
    pieces: unitAvailable("pieces", consumed.piece),
    sections: unitAvailable("sections", consumed.section)
  };
}

const packedQtySql = `
  COALESCE(packed_pallet_qty, 0)
  + COALESCE(packed_section_qty, 0)
  + COALESCE(packed_layer_qty, 0)
  + COALESCE(packed_piece_qty, 0)
`;

function applyDeliveryAllocationFields(line) {
  const allocatedPallets = positiveQuantity(line.po_allocated_pallet_qty);
  const allocatedLayers = positiveQuantity(line.po_allocated_layer_qty);
  const allocatedSections = positiveQuantity(line.po_allocated_section_qty);
  const allocatedPieces = positiveQuantity(line.po_allocated_piece_qty);
  const allocatedSalesQty = positiveQuantity(line.po_allocated_sales_qty);
  return {
    ...line,
    original_pallet_qty: line.pallet_qty,
    original_layer_qty: line.layer_qty,
    original_section_qty: line.section_qty,
    original_piece_qty: line.piece_qty,
    original_quantity: line.quantity,
    po_allocated_pallet_qty: allocatedPallets,
    po_allocated_layer_qty: allocatedLayers,
    po_allocated_section_qty: allocatedSections,
    po_allocated_piece_qty: allocatedPieces,
    po_allocated_sales_qty: allocatedSalesQty,
    pallet_qty: Math.max(positiveQuantity(line.pallet_qty) - allocatedPallets, 0),
    layer_qty: Math.max(positiveQuantity(line.layer_qty) - allocatedLayers, 0),
    section_qty: Math.max(positiveQuantity(line.section_qty) - allocatedSections, 0),
    piece_qty: Math.max(positiveQuantity(line.piece_qty) - allocatedPieces, 0),
    quantity: Math.max(positiveQuantity(line.quantity) - allocatedSalesQty, 0)
  };
}

function hasDeliveryDisplayQuantity(line) {
  return positiveQuantity(line.pallet_qty) > 0
    || positiveQuantity(line.layer_qty) > 0
    || positiveQuantity(line.section_qty) > 0
    || positiveQuantity(line.piece_qty) > 0
    || positiveQuantity(line.quantity) > 0
    || positiveQuantity(line.packed_pallet_qty) > 0
    || positiveQuantity(line.packed_layer_qty) > 0
    || positiveQuantity(line.packed_section_qty) > 0
    || positiveQuantity(line.packed_piece_qty) > 0
    || Boolean(line.sync_exception);
}

function loadLineUnits(line) {
  if (hasConversion(line)) {
    const available = remainingPackAvailability(line);
    const customUnits = [
      { key: "pallet", label: "PLT", required: available.pallets, packed: positiveQuantity(line.packed_pallet_qty) },
      { key: "layer", label: "LYR", required: available.layers, packed: positiveQuantity(line.packed_layer_qty) },
      { key: "section", label: "SEC", required: available.sections, packed: positiveQuantity(line.packed_section_qty) },
      { key: "piece", label: "PCS", required: available.pieces, packed: positiveQuantity(line.packed_piece_qty) }
    ].filter((unit) => unit.required > 0 || unit.packed > 0);
    if (customUnits.length) return customUnits;
  }
  return [{
    key: "sales",
    label: line.unit || "Qty",
    required: Math.max(0, lineRequiredSalesQuantity(line) - lineLoadedSalesQuantity(line)),
    packed: linePackedSalesQuantity(line)
  }];
}

function formatLoadUnits(units, field) {
  const visible = units.filter((unit) => positiveQuantity(unit[field]) > 0);
  if (!visible.length) return "0";
  return visible.map((unit) => `${roundQuantity(unit[field])} ${unit.label}`).join(" / ");
}

function buildDeliveryLoadValidation(order) {
  const issues = [];
  for (const line of order.lines || []) {
    const lineDeleted = !line.netsuite_active || line.sync_exception === "line_deleted";
    const units = loadLineUnits(line).map((unit) => lineDeleted ? { ...unit, required: 0 } : unit);
    const packedSalesQty = linePackedSalesQuantity(line);
    if (packedSalesQty <= 0) continue;
    const remainingSalesQty = lineDeleted
      ? 0
      : Math.max(0, lineRequiredSalesQuantity(line) - lineLoadedSalesQuantity(line));
    const itemLabel = line.sku || line.item_name || `Line ${line.line_id}`;
    const issue = {
      lineId: line.id,
      netsuiteLineId: line.line_id,
      itemName: itemLabel,
      itemDescription: line.item_description || "",
      syncException: line.sync_exception || null,
      requiredText: formatLoadUnits(units, "required"),
      packedText: formatLoadUnits(units, "packed"),
      requiredSalesQty: roundQuantity(remainingSalesQty),
      packedSalesQty: roundQuantity(packedSalesQty),
      salesUom: line.unit || "",
      units
    };

    if (lineDeleted) {
      issues.push({
        ...issue,
        code: "line_deleted",
        message: `${itemLabel} was removed from NetSuite. Unpack the whole line before loading.`
      });
      continue;
    }

    if (packedSalesQty > remainingSalesQty + 0.000001) {
      issues.push({
        ...issue,
        code: line.sync_exception || "overpacked",
        message: `${itemLabel} packed sales quantity is higher than the latest remaining required quantity. Update packed qty to ${formatLoadUnits(units, "required")} or unpack the line and repack.`
      });
    }
  }
  return {
    ok: issues.length === 0,
    issues
  };
}

export const CUSTOMER_PICKUP_DELIVERY_METHOD = "Pick-Up";

export function isPickupDeliveryMethod(value) {
  return String(value || "").trim() === CUSTOMER_PICKUP_DELIVERY_METHOD;
}

function isPickupOrder(order) {
  return order?.order_type === "sales_order" && isPickupDeliveryMethod(order.delivery_method);
}

export function isPendingApprovalStatus(status, statusText) {
  return String(status || "").trim().toUpperCase() === "A"
    || String(statusText || "").toLowerCase().includes("pending approval");
}

function deliveryMethodClause(alias = "delivery_order_source") {
  return `(
    ${alias}.order_type <> 'sales_order'
    OR COALESCE(${alias}.delivery_method, '') <> '${CUSTOMER_PICKUP_DELIVERY_METHOD.replaceAll("'", "''")}'
  )`;
}

function activePoAllocationSql(unit, lineAlias = "delivery_line_source") {
  const column = unit === "pallet" ? "allocated_pallet_qty"
    : unit === "layer" ? "allocated_layer_qty"
      : unit === "section" ? "allocated_section_qty"
        : unit === "piece" ? "allocated_piece_qty"
          : "allocated_sales_qty";
  return `COALESCE((SELECT SUM(${column}) FROM dispatch_so_po_allocations a WHERE a.status = 'active' AND a.sales_line_id = ${lineAlias}.id), 0)`;
}

function isTransferDeliveryOrder(order) {
  return order?.order_type === "transfer_order";
}

function canonicalOrderTarget(order) {
  return isTransferDeliveryOrder(order)
    ? { table: "transfer_orders", statusColumn: "outbound_operator_status" }
    : { table: "sales_orders", statusColumn: "operator_status" };
}

function canonicalLineTarget(order) {
  return isTransferDeliveryOrder(order)
    ? { table: "transfer_order_lines", orderColumn: "transfer_order_id", extraWhere: "AND line_stage = 'outbound'", allocationAlias: null }
    : { table: "sales_order_lines", orderColumn: "sales_order_id", extraWhere: "", allocationAlias: "sales_order_lines" };
}

function activeDeliveryAllocationSql(order, unit, lineAlias) {
  return isTransferDeliveryOrder(order) ? "0" : activePoAllocationSql(unit, lineAlias);
}

function lineRequiredSalesSql(alias) {
  const customSales = `
    (COALESCE(${alias}.pallet_qty, 0) * COALESCE(${alias}.to_plt, 0))
    + (COALESCE(${alias}.layer_qty, 0) * COALESCE(${alias}.to_lyr, 0))
    + (COALESCE(${alias}.section_qty, 0) * COALESCE(${alias}.to_sec, 0))
    + (COALESCE(${alias}.piece_qty, 0) * COALESCE(${alias}.to_pcs, 0))
  `;
  return `CASE WHEN COALESCE(${alias}.quantity, 0) > 0 THEN COALESCE(${alias}.quantity, 0) ELSE (${customSales}) END`;
}

function linePackedSalesSql(alias) {
  const converted = `
    (COALESCE(${alias}.packed_pallet_qty, 0) * COALESCE(${alias}.to_plt, 0))
    + (COALESCE(${alias}.packed_layer_qty, 0) * COALESCE(${alias}.to_lyr, 0))
    + (COALESCE(${alias}.packed_section_qty, 0) * COALESCE(${alias}.to_sec, 0))
    + (COALESCE(${alias}.packed_piece_qty, 0) * COALESCE(${alias}.to_pcs, 0))
  `;
  const rawUnits = `
    COALESCE(${alias}.packed_pallet_qty, 0)
    + COALESCE(${alias}.packed_layer_qty, 0)
    + COALESCE(${alias}.packed_section_qty, 0)
    + COALESCE(${alias}.packed_piece_qty, 0)
  `;
  return `CASE
    WHEN (
      COALESCE(${alias}.to_plt, 0)
      + COALESCE(${alias}.to_lyr, 0)
      + COALESCE(${alias}.to_sec, 0)
      + COALESCE(${alias}.to_pcs, 0)
    ) > 0 THEN (${converted})
    ELSE (${rawUnits})
  END`;
}

function lineOpenSalesSql(alias) {
  return `GREATEST((${lineRequiredSalesSql(alias)}) - COALESCE(${alias}.loaded_qty, 0) - (${linePackedSalesSql(alias)}), 0)`;
}

async function updateCanonicalDeliveryOrder(order, setClauses, params) {
  const target = canonicalOrderTarget(order);
  await query(
    `UPDATE ${target.table}
        SET ${setClauses.join(", ")}
      WHERE netsuite_id = $1`,
    [order.netsuite_id, ...params]
  );
}

async function setCanonicalDeliveryStatus(order, status, { clearPreparing = false, localYardOrderStatus = undefined } = {}) {
  const target = canonicalOrderTarget(order);
  const setClauses = [
    `${target.statusColumn} = $2`,
    "status_updated_at = now()"
  ];
  const params = [status];
  if (clearPreparing) {
    setClauses.push("preparing_operator_id = null", "preparing_started_at = null");
  }
  if (localYardOrderStatus !== undefined) {
    params.push(localYardOrderStatus);
    setClauses.push(`local_yard_order_status = $${params.length + 1}`);
  }
  await updateCanonicalDeliveryOrder(order, setClauses, params);
}

async function refreshDeliveryProgressStatus(orderId, { clearPreparing = false } = {}) {
  const order = await getDeliveryOrder(orderId);
  if (!order) throw new Error("Delivery order not found.");
  const pickableLines = (order.lines || []).filter((line) => {
    return line.netsuite_active && ["InvtPart", "NonInvtPart"].includes(line.item_type || "");
  });
  const hasPacked = pickableLines.some((line) => linePackedSalesQuantity(line) > 0);
  const hasLoaded = pickableLines.some((line) => lineLoadedSalesQuantity(line) > 0);
  const hasOpen = pickableLines.some((line) => {
    return lineRequiredSalesQuantity(line) > lineLoadedSalesQuantity(line) + linePackedSalesQuantity(line) + 0.000001;
  });

  let status = "open";
  let localYardOrderStatus = "Open";
  if (hasPacked) {
    status = "packed";
  } else if (hasLoaded && hasOpen) {
    status = "partial_loaded";
    localYardOrderStatus = "Partial Loaded";
  } else if (hasLoaded && !hasOpen) {
    status = "loaded";
    localYardOrderStatus = "Loaded";
  }

  await setCanonicalDeliveryStatus(order, status, { clearPreparing, localYardOrderStatus });
  return getDeliveryOrder(orderId);
}

export async function resetDeliveryFulfillmentState(orderId, operatorId, reason = "netsuite_if_missing") {
  const order = await getDeliveryOrder(orderId);
  if (!order) throw new Error("Delivery order not found.");
  const lineTarget = canonicalLineTarget(order);
  const orderTarget = canonicalOrderTarget(order);
  await query(
    `UPDATE ${lineTarget.table}
     SET fulfilled_pallet_qty = 0,
         fulfilled_layer_qty = 0,
         fulfilled_piece_qty = 0,
         fulfilled_section_qty = 0
     WHERE ${lineTarget.orderColumn} = $1
       ${lineTarget.extraWhere}`,
    [orderId]
  );
  await query(
    `UPDATE ${orderTarget.table}
     SET fulfillment_status = 'not_fulfilled',
         last_item_fulfillment_id = null,
         last_item_fulfillment_tranid = null,
         fulfilled_at = null,
         ${orderTarget.statusColumn} = CASE WHEN ${orderTarget.statusColumn} = 'fulfilled' THEN 'packed' ELSE ${orderTarget.statusColumn} END,
         status_updated_at = now()
     WHERE netsuite_id = $1`,
    [orderId]
  );
  await writeAudit({
    actorOperatorId: operatorId,
    action: "delivery.fulfillment.reset",
    orderId,
    details: { reason }
  });
}

function parseStatusFilter(status) {
  if (!status || status === "active") return ["open", "preparing"];
  if (status === "packed") return ["packed"];
  return String(status).split(",").map((item) => item.trim()).filter(Boolean);
}

export async function listDeliveryOrders({ locationId = null, status = "active", orderType = "sales_order" } = {}) {
  const statuses = parseStatusFilter(status);
  const params = [];
  let locationClause = "";
  if (locationId) {
    params.push(locationId);
    locationClause = `AND outbound_location_id = $${params.length}`;
  }
  const pickable = "COALESCE(l.item_type, '') IN ('InvtPart', 'NonInvtPart')";
  const hasPackedQty = `
    EXISTS (
      SELECT 1 FROM delivery_line_source l
      WHERE l.order_id = delivery_order_source.netsuite_id
        AND (${pickable} OR l.sync_exception IS NOT NULL)
        AND (
          COALESCE(l.packed_pallet_qty, 0) > 0
          OR COALESCE(l.packed_section_qty, 0) > 0
          OR COALESCE(l.packed_layer_qty, 0) > 0
          OR COALESCE(l.packed_piece_qty, 0) > 0
        )
    )
  `;
  const hasRemainingQty = `
    EXISTS (
      SELECT 1 FROM delivery_line_source l
      WHERE l.order_id = delivery_order_source.netsuite_id
        AND ${pickable}
        AND l.netsuite_active = true
        AND ${lineOpenSalesSql("l")} > 0
    )
  `;
  const hasProgressQty = `
    EXISTS (
      SELECT 1 FROM delivery_line_source progress_line
      WHERE progress_line.order_id = delivery_order_source.netsuite_id
        AND COALESCE(progress_line.item_type, '') IN ('InvtPart', 'NonInvtPart')
        AND progress_line.netsuite_active = true
        AND (
          COALESCE(progress_line.loaded_qty, 0) > 0
          OR COALESCE(progress_line.packed_pallet_qty, 0) > 0
          OR COALESCE(progress_line.packed_section_qty, 0) > 0
          OR COALESCE(progress_line.packed_layer_qty, 0) > 0
          OR COALESCE(progress_line.packed_piece_qty, 0) > 0
        )
    )
  `;
  const underpackCountSql = `
    SELECT COUNT(*)::int
    FROM delivery_line_source underpack_line
    WHERE underpack_line.order_id = delivery_order_source.netsuite_id
      AND COALESCE(underpack_line.item_type, '') IN ('InvtPart', 'NonInvtPart')
      AND underpack_line.netsuite_active = true
      AND ${hasProgressQty}
      AND ${lineOpenSalesSql("underpack_line")} > 0
  `;
  const statusClause = status === "packed"
    ? `operator_status = 'packed'`
    : `(
        operator_status = ANY($${params.length + 1}) AND operator_status <> 'packed'
        OR (operator_status IN ('packed', 'loaded', 'partial_loaded') AND (${underpackCountSql}) > 0)
      )`;
  if (status !== "packed") params.push(statuses);
  params.push(orderType || "sales_order");

  const result = await query(
    `WITH delivery_order_source AS (
       SELECT netsuite_id, tranid, trandate, customer_id, customer, status, status_text,
              foreign_total, order_location_id, order_location, outbound_location_id,
              outbound_location, delivery_method_id, sales_order_type AS delivery_method,
              operator_status, local_yard_order_status, preparing_operator_id,
              preparing_started_at, status_updated_at, netsuite_active, synced_at,
              fulfillment_status, dispatch_planned, dispatch_plan_date, dispatch_planned_at, dispatch_truck_plate,
              dispatch_load_name, dispatch_parking_spot, expected_delivery_date,
              dispatch_address, dispatch_window_start, dispatch_window_end,
              dispatch_instructions, 'sales_order'::text AS order_type,
              NULL::bigint AS source_location_id, NULL::text AS source_location,
              NULL::bigint AS destination_location_id, NULL::text AS destination_location
       FROM sales_orders
       WHERE sales_order_type <> '${CUSTOMER_PICKUP_DELIVERY_METHOD.replaceAll("'", "''")}'
       UNION ALL
       SELECT netsuite_id, tranid, trandate, NULL::bigint AS customer_id, NULL::text AS customer,
              status, status_text, NULL::numeric AS foreign_total, NULL::bigint AS order_location_id,
              NULL::text AS order_location, from_location_id AS outbound_location_id,
              from_location AS outbound_location, NULL::bigint AS delivery_method_id,
              NULL::text AS delivery_method, outbound_operator_status AS operator_status,
              local_yard_order_status, preparing_operator_id, preparing_started_at,
              status_updated_at, netsuite_active, synced_at, fulfillment_status,
              dispatch_planned, dispatch_plan_date, dispatch_planned_at, dispatch_truck_plate,
              dispatch_load_name, dispatch_parking_spot, expected_delivery_date,
              dispatch_address, dispatch_window_start, dispatch_window_end,
              dispatch_instructions, 'transfer_order'::text AS order_type,
              from_location_id AS source_location_id, from_location AS source_location,
              to_location_id AS destination_location_id, to_location AS destination_location
       FROM transfer_orders
       WHERE from_location_id IS NOT NULL
     ),
     delivery_line_source AS (
       SELECT sales_order_id AS order_id, id, line_id, item_id, item_name, sku,
              item_description, item_type, item_type_text, quantity, unit,
              pallet_qty, layer_qty, section_qty, piece_qty,
              packed_pallet_qty, packed_layer_qty, packed_section_qty, packed_piece_qty,
              to_plt, to_lyr, to_sec, to_pcs, loaded_qty, loaded_uom,
              netsuite_active, sync_exception, synced_at
       FROM sales_order_lines
       UNION ALL
       SELECT transfer_order_id AS order_id, id, line_id, item_id, item_name, sku,
              item_description, item_type, item_type_text, quantity, unit,
              pallet_qty, layer_qty, section_qty, piece_qty,
              packed_pallet_qty, packed_layer_qty, packed_section_qty, packed_piece_qty,
              to_plt, to_lyr, to_sec, to_pcs, loaded_qty, loaded_uom,
              netsuite_active, sync_exception, synced_at
       FROM transfer_order_lines
       WHERE line_stage = 'outbound'
     )
     SELECT delivery_order_source.*,
            (
              SELECT COUNT(*)::int
              FROM delivery_line_source warning_line
              WHERE warning_line.order_id = delivery_order_source.netsuite_id
                AND warning_line.sync_exception IS NOT NULL
                AND (
                  COALESCE(warning_line.packed_pallet_qty, 0) > 0
                  OR COALESCE(warning_line.packed_section_qty, 0) > 0
                  OR COALESCE(warning_line.packed_layer_qty, 0) > 0
                  OR COALESCE(warning_line.packed_piece_qty, 0) > 0
                )
            ) AS warning_count
            , (${underpackCountSql}) AS underpack_count
     FROM delivery_order_source
     WHERE ${statusClause}
       ${locationClause}
        AND order_type = $${params.length}
        AND ${deliveryMethodClause("delivery_order_source")}
        AND (COALESCE(local_yard_order_status, 'Open') <> 'Loaded' OR (${underpackCountSql}) > 0)
        AND netsuite_active = true
        AND (
          (order_type = 'sales_order' AND (status = 'B' OR status_text ILIKE '%Pending Fulfillment%' OR status_text ILIKE '%Partially Fulfilled%' OR fulfillment_status = 'partial_fulfilled'))
          OR (order_type = 'transfer_order' AND (status_text ILIKE '%Pending Fulfillment%' OR status_text ILIKE '%Partially Fulfilled%' OR fulfillment_status = 'partial_fulfilled'))
        )
        AND fulfillment_status <> 'fulfilled'
     ORDER BY dispatch_planned DESC, warning_count DESC, underpack_count DESC, trandate DESC, tranid DESC`
    ,
    params
  );
  return result.rows;
}

function todayKey() {
  const date = new Date();
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

function addDaysKey(days) {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + days);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

function minutesFromTimeText(value) {
  const text = String(value || "").replace(/[^0-9]/g, "");
  if (!text) return null;
  const padded = text.length <= 2 ? `${text}00` : text.padStart(4, "0").slice(0, 4);
  const hours = Number(padded.slice(0, 2));
  const minutes = Number(padded.slice(2, 4));
  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || hours > 23 || minutes > 59) return null;
  return (hours * 60) + minutes;
}

function dateKey(value) {
  if (!value) return "";
  if (typeof value === "string") {
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

function hasBeforeNoonWindow(order) {
  const start = minutesFromTimeText(order?.dispatch_window_start);
  const end = minutesFromTimeText(order?.dispatch_window_end);
  if (end !== null) return end <= 720;
  if (start !== null) return start < 720;
  return false;
}

function hasAnyDeliveryWindow(order) {
  return minutesFromTimeText(order?.dispatch_window_start) !== null
    || minutesFromTimeText(order?.dispatch_window_end) !== null;
}

function isBatchA(order) {
  if (order?.dispatch_planned) return false;
  const expected = dateKey(order?.expected_delivery_date);
  if (!expected) return false;
  const today = todayKey();
  const tomorrow = addDaysKey(1);
  return expected <= today || (expected === tomorrow && (hasBeforeNoonWindow(order) || !hasAnyDeliveryWindow(order)));
}

export async function getDeliveryPrepNotifications({ locationId = null } = {}) {
  if (!locationId) return { locationId: null, total: 0, salesOrder: { dueToday: 0 }, transferOrder: { dueToday: 0 }, items: [] };
  const [salesActive, transferActive] = await Promise.all([
    listDeliveryOrders({ locationId, status: "active", orderType: "sales_order" }),
    listDeliveryOrders({ locationId, status: "active", orderType: "transfer_order" })
  ]);
  const today = todayKey();
  const uniqueById = (rows) => [...new Map(rows.map((row) => [String(row.netsuite_id), row])).values()];
  const hasOpenOperatorStatus = (order) => {
    const operatorStatus = String(order?.operator_status || "open").toLowerCase();
    const yardStatus = String(order?.local_yard_order_status || "open").toLowerCase();
    return operatorStatus === "open" && !["loaded", "shipped"].includes(yardStatus);
  };
  const shouldNotifyDeliveryPrep = (order) => {
    if (order?.dispatch_planned) return true;
    const expected = dateKey(order?.expected_delivery_date);
    const planned = dateKey(order?.dispatch_plan_date);
    return expected === today || planned === today;
  };
  const toNoticeItem = (order, type) => ({
    orderId: order.netsuite_id,
    type,
    bucket: order.dispatch_planned ? "planned" : "due_today",
    tranid: order.tranid,
    customer: order.customer || "",
    expectedDeliveryDate: dateKey(order.expected_delivery_date),
    dispatchPlanDate: dateKey(order.dispatch_plan_date),
    dispatchPlannedAt: order.dispatch_planned_at || "",
    dispatchPlanned: Boolean(order.dispatch_planned),
    windowStart: order.dispatch_window_start || "",
    windowEnd: order.dispatch_window_end || "",
    truck: order.dispatch_truck_plate || "",
    load: order.dispatch_load_name || "",
    parkingSpot: order.dispatch_parking_spot || "",
    locationId: order.outbound_location_id,
    location: order.outbound_location
  });
  const salesItems = uniqueById(salesActive)
    .filter((order) => hasOpenOperatorStatus(order) && shouldNotifyDeliveryPrep(order))
    .map((order) => toNoticeItem(order, "sales_order"));
  const transferItems = uniqueById(transferActive)
    .filter((order) => hasOpenOperatorStatus(order) && shouldNotifyDeliveryPrep(order))
    .map((order) => toNoticeItem(order, "transfer_order"));
  const items = [...salesItems, ...transferItems]
    .sort((a, b) => String(a.expectedDeliveryDate || a.dispatchPlanDate || "").localeCompare(String(b.expectedDeliveryDate || b.dispatchPlanDate || "")) || String(a.tranid || "").localeCompare(String(b.tranid || "")));
  return {
    locationId: Number(locationId),
    total: items.length,
    salesOrder: {
      dueToday: salesItems.length
    },
    transferOrder: {
      dueToday: transferItems.length
    },
    items
  };
}

export async function getDeliveryOrder(id) {
  const order = await query(
    `WITH delivery_order_source AS (
       SELECT netsuite_id, tranid, trandate, customer_id, customer, status, status_text,
              foreign_total, order_location_id, order_location, outbound_location_id,
              outbound_location, delivery_method_id, sales_order_type AS delivery_method,
              operator_status, local_yard_order_status, preparing_operator_id,
              preparing_started_at, status_updated_at, netsuite_active, synced_at,
              fulfillment_status, dispatch_planned, dispatch_plan_date, dispatch_planned_at, dispatch_truck_plate,
              dispatch_load_name, dispatch_parking_spot, expected_delivery_date,
              dispatch_address, dispatch_window_start, dispatch_window_end,
              dispatch_instructions, 'sales_order'::text AS order_type,
              NULL::bigint AS source_location_id, NULL::text AS source_location,
              NULL::bigint AS destination_location_id, NULL::text AS destination_location
       FROM sales_orders
       UNION ALL
       SELECT netsuite_id, tranid, trandate, NULL::bigint AS customer_id, NULL::text AS customer,
              status, status_text, NULL::numeric AS foreign_total, NULL::bigint AS order_location_id,
              NULL::text AS order_location, from_location_id AS outbound_location_id,
              from_location AS outbound_location, NULL::bigint AS delivery_method_id,
              NULL::text AS delivery_method, outbound_operator_status AS operator_status,
              local_yard_order_status, preparing_operator_id, preparing_started_at,
              status_updated_at, netsuite_active, synced_at, fulfillment_status,
              dispatch_planned, dispatch_plan_date, dispatch_planned_at, dispatch_truck_plate,
              dispatch_load_name, dispatch_parking_spot, expected_delivery_date,
              dispatch_address, dispatch_window_start, dispatch_window_end,
              dispatch_instructions, 'transfer_order'::text AS order_type,
              from_location_id AS source_location_id, from_location AS source_location,
              to_location_id AS destination_location_id, to_location AS destination_location
       FROM transfer_orders
       WHERE from_location_id IS NOT NULL
     ),
     delivery_line_source AS (
       SELECT sales_order_id AS order_id, id, line_id, item_id, item_name, sku,
              item_description, item_type, item_type_text, quantity, unit,
              item_weight, location_id, location, pallet_qty, layer_qty, section_qty, piece_qty,
              packed_pallet_qty, packed_layer_qty, packed_section_qty, packed_piece_qty,
              fulfilled_pallet_qty, fulfilled_layer_qty, fulfilled_piece_qty, fulfilled_section_qty,
              to_plt, to_lyr, to_sec, to_pcs, loaded_qty, loaded_uom,
              netsuite_active, sync_exception, synced_at
       FROM sales_order_lines
       UNION ALL
       SELECT transfer_order_id AS order_id, id, line_id, item_id, item_name, sku,
              item_description, item_type, item_type_text, quantity, unit,
              item_weight, location_id, location, pallet_qty, layer_qty, section_qty, piece_qty,
              packed_pallet_qty, packed_layer_qty, packed_section_qty, packed_piece_qty,
              fulfilled_pallet_qty, fulfilled_layer_qty, fulfilled_piece_qty, fulfilled_section_qty,
              to_plt, to_lyr, to_sec, to_pcs, loaded_qty, loaded_uom,
              netsuite_active, sync_exception, synced_at
       FROM transfer_order_lines
       WHERE line_stage = 'outbound'
     )
     SELECT delivery_order_source.*,
            (
              SELECT COUNT(*)::int
              FROM delivery_line_source warning_line
              WHERE warning_line.order_id = delivery_order_source.netsuite_id
                AND warning_line.sync_exception IS NOT NULL
                AND (
                  COALESCE(warning_line.packed_pallet_qty, 0) > 0
                  OR COALESCE(warning_line.packed_section_qty, 0) > 0
                  OR COALESCE(warning_line.packed_layer_qty, 0) > 0
                  OR COALESCE(warning_line.packed_piece_qty, 0) > 0
                )
            ) AS warning_count
            , (
              SELECT COUNT(*)::int
              FROM delivery_line_source underpack_line
              WHERE underpack_line.order_id = delivery_order_source.netsuite_id
                AND COALESCE(underpack_line.item_type, '') IN ('InvtPart', 'NonInvtPart')
                AND underpack_line.netsuite_active = true
                AND EXISTS (
                  SELECT 1 FROM delivery_line_source progress_line
                  WHERE progress_line.order_id = delivery_order_source.netsuite_id
                    AND COALESCE(progress_line.item_type, '') IN ('InvtPart', 'NonInvtPart')
                    AND progress_line.netsuite_active = true
                    AND (
                      COALESCE(progress_line.loaded_qty, 0) > 0
                      OR COALESCE(progress_line.packed_pallet_qty, 0) > 0
                      OR COALESCE(progress_line.packed_section_qty, 0) > 0
                      OR COALESCE(progress_line.packed_layer_qty, 0) > 0
                      OR COALESCE(progress_line.packed_piece_qty, 0) > 0
                    )
                )
                AND ${lineOpenSalesSql("underpack_line")} > 0
            ) AS underpack_count
     FROM delivery_order_source
     WHERE netsuite_id = $1`,
    [id]
  );
  if (!order.rowCount) return null;

  const lines = await query(
    `WITH alloc AS (
       SELECT sales_line_id,
              SUM(allocated_pallet_qty) AS po_allocated_pallet_qty,
              SUM(allocated_layer_qty) AS po_allocated_layer_qty,
              SUM(allocated_section_qty) AS po_allocated_section_qty,
              SUM(allocated_piece_qty) AS po_allocated_piece_qty,
              SUM(allocated_sales_qty) AS po_allocated_sales_qty
         FROM dispatch_so_po_allocations
        WHERE status = 'active'
        GROUP BY sales_line_id
     ),
     delivery_line_source AS (
       SELECT sales_order_id AS order_id, id, line_id, item_id, item_name, sku,
              item_description, item_type, item_type_text, quantity, unit,
              item_weight, location_id, location, pallet_qty, layer_qty, section_qty, piece_qty,
              packed_pallet_qty, packed_layer_qty, packed_section_qty, packed_piece_qty,
              fulfilled_pallet_qty, fulfilled_layer_qty, fulfilled_piece_qty, fulfilled_section_qty,
              to_plt, to_lyr, to_sec, to_pcs, loaded_qty, loaded_uom,
              netsuite_active, sync_exception, synced_at
       FROM sales_order_lines
       UNION ALL
       SELECT transfer_order_id AS order_id, id, line_id, item_id, item_name, sku,
              item_description, item_type, item_type_text, quantity, unit,
              item_weight, location_id, location, pallet_qty, layer_qty, section_qty, piece_qty,
              packed_pallet_qty, packed_layer_qty, packed_section_qty, packed_piece_qty,
              fulfilled_pallet_qty, fulfilled_layer_qty, fulfilled_piece_qty, fulfilled_section_qty,
              to_plt, to_lyr, to_sec, to_pcs, loaded_qty, loaded_uom,
              netsuite_active, sync_exception, synced_at
       FROM transfer_order_lines
       WHERE line_stage = 'outbound'
     )
     SELECT delivery_line_source.*,
            COALESCE(alloc.po_allocated_pallet_qty, 0) AS po_allocated_pallet_qty,
            COALESCE(alloc.po_allocated_layer_qty, 0) AS po_allocated_layer_qty,
            COALESCE(alloc.po_allocated_section_qty, 0) AS po_allocated_section_qty,
            COALESCE(alloc.po_allocated_piece_qty, 0) AS po_allocated_piece_qty,
            COALESCE(alloc.po_allocated_sales_qty, 0) AS po_allocated_sales_qty
     FROM delivery_line_source
     LEFT JOIN alloc ON alloc.sales_line_id = delivery_line_source.id
     WHERE order_id = $1
       AND (
         netsuite_active = true
         OR sync_exception IS NOT NULL
         OR (${packedQtySql}) > 0
       )
     ORDER BY line_id NULLS LAST, id`,
    [id]
  );

  return { ...order.rows[0], lines: lines.rows.map(applyDeliveryAllocationFields).filter(hasDeliveryDisplayQuantity) };
}

export async function findCustomerPickupOrder(code, { locationId = null } = {}) {
  const text = String(code || "").trim();
  if (!text) return null;
  const params = [text.toUpperCase()];
  let locationClause = "";
  if (locationId) {
    params.push(locationId);
    locationClause = `AND outbound_location_id = $${params.length}`;
  }
  const result = await query(
    `SELECT netsuite_id
       FROM sales_orders
      WHERE (UPPER(tranid) = $1 OR netsuite_id::text = $1)
        ${locationClause}
        AND sales_order_type = $${params.length + 1}
        AND NOT (status = 'A' OR status_text ILIKE '%Pending Approval%')
        AND LOWER(COALESCE(local_yard_order_status, 'Open')) IN ('open', 'partial_loaded', 'partially loaded', 'loaded')
        AND netsuite_active = true
      LIMIT 1`,
    [...params, CUSTOMER_PICKUP_DELIVERY_METHOD]
  );
  return result.rows[0]?.netsuite_id || null;
}

export async function applyConfirmedDispatchPlanToDelivery(plan, { forceOrderRefs = [] } = {}) {
  if (!plan?.planDate || !Array.isArray(plan.trucks)) return { planned: 0 };
  const forceRefs = new Set((forceOrderRefs || []).map((ref) => String(ref || "").trim()).filter(Boolean));
  const plannedRows = [];
  for (const truck of plan.trucks || []) {
    for (const load of truck.loads || []) {
      if (load.returnOnly) continue;
      for (const stop of load.stops || []) {
        if (stop.type !== "drop" || !stop.orderId) continue;
        const order = (plan.orders || []).find((item) => item.id === stop.orderId);
        if (!["SO", "TO"].includes(order?.type)) continue;
        plannedRows.push({
          tranid: order.id,
          orderType: order.type,
          truckPlate: truck.plate || "",
          loadName: load.name || "",
          parkingSpot: truck.parkingSpot || "",
          planDate: plan.planDate,
          forcePlannedAt: forceRefs.has(String(order.id || ""))
        });
      }
    }
  }
  const salesRefs = plannedRows.filter((row) => row.orderType === "SO").map((row) => row.tranid);
  const transferRefs = plannedRows.filter((row) => row.orderType === "TO").map((row) => row.tranid);
  await query(
    `UPDATE sales_orders
        SET dispatch_planned = false,
            dispatch_plan_date = null,
            dispatch_truck_plate = null,
            dispatch_load_name = null,
            dispatch_parking_spot = null,
            dispatch_planned_at = null
      WHERE dispatch_plan_date = $1::date
        AND NOT (tranid = ANY($2::text[]))`,
    [plan.planDate, salesRefs]
  );
  await query(
    `UPDATE transfer_orders
        SET dispatch_planned = false,
            dispatch_plan_date = null,
            dispatch_truck_plate = null,
            dispatch_load_name = null,
            dispatch_parking_spot = null,
            dispatch_planned_at = null
      WHERE dispatch_plan_date = $1::date
        AND NOT (tranid = ANY($2::text[]))`,
    [plan.planDate, transferRefs]
  );

  for (const row of plannedRows) {
    const targetTable = row.orderType === "TO" ? "transfer_orders" : "sales_orders";
    await query(
      `UPDATE ${targetTable}
          SET dispatch_planned = true,
              dispatch_plan_date = $2::date,
              dispatch_truck_plate = $3,
              dispatch_load_name = $4,
              dispatch_parking_spot = $5,
              dispatch_planned_at = CASE
                WHEN $6::boolean
                  OR dispatch_planned IS DISTINCT FROM true
                  OR COALESCE(dispatch_plan_date::text, '') <> $2::date::text
                  OR COALESCE(dispatch_truck_plate, '') <> $3
                  OR COALESCE(dispatch_load_name, '') <> $4
                  OR COALESCE(dispatch_parking_spot, '') <> $5
                  OR dispatch_planned_at IS NULL
                THEN now()
                ELSE dispatch_planned_at
              END
        WHERE tranid = $1
          AND COALESCE(local_yard_order_status, 'Open') <> 'Loaded'`,
      [row.tranid, row.planDate, row.truckPlate, row.loadName, row.parkingSpot, row.forcePlannedAt]
    );
  }

  await writeAudit({
    actorType: "system",
    source: "dispatch",
    action: "dispatch.plan.operator_flags_applied",
    details: { planDate: plan.planDate, plannedCount: plannedRows.length, forcedCount: forceRefs.size }
  });
  return { planned: plannedRows.length };
}

export async function getFulfillableDeliveryOrder(orderId) {
  const order = await getDeliveryOrder(orderId);
  if (!order) throw new Error("Delivery order not found.");
  const lines = order.lines.filter((line) => {
    const delta = Math.max(positiveQuantity(line.packed_pallet_qty) - positiveQuantity(line.fulfilled_pallet_qty), 0)
      + Math.max(positiveQuantity(line.packed_layer_qty) - positiveQuantity(line.fulfilled_layer_qty), 0)
      + Math.max(positiveQuantity(line.packed_section_qty) - positiveQuantity(line.fulfilled_section_qty), 0)
      + Math.max(positiveQuantity(line.packed_piece_qty) - positiveQuantity(line.fulfilled_piece_qty), 0);
    return line.netsuite_active && !line.sync_exception && ["InvtPart", "NonInvtPart"].includes(line.item_type || "") && delta > 0;
  });
  if (!lines.length) throw new Error("No packed lines to fulfill.");
  return { ...order, fulfillableLines: lines };
}

export function buildItemFulfillmentPayload(order, lines) {
  const isTransferOrder = order.order_type === "transfer_order";
  const items = lines.map((line) => {
    const packedQuantity = fulfillmentLineQuantity(line);
    const item = {
      orderLine: Number(line.line_id),
      quantity: packedQuantity,
      itemReceive: true
    };
    if (isTransferOrder) {
      item.orderLine += 1;
    } else {
      item.location = Number(line.location_id || order.outbound_location_id);
    }
    return item;
  });

  const fulfilledLineIds = new Set(lines.map((line) => Number(line.line_id)));
  for (const line of order.lines || []) {
    if (!line.netsuite_active || !["InvtPart", "NonInvtPart"].includes(line.item_type || "")) continue;
    if (fulfilledLineIds.has(Number(line.line_id))) continue;
    const item = {
      orderLine: Number(line.line_id),
      itemReceive: false
    };
    if (isTransferOrder) {
      item.orderLine += 1;
    } else {
      item.location = Number(line.location_id || order.outbound_location_id);
    }
    items.push(item);
  }

  return {
    item: { items }
  };
}

function fulfilledPayloadLineId(order, item) {
  const orderLine = Number(item.orderLine);
  if (!Number.isInteger(orderLine)) return null;
  return order.order_type === "transfer_order" ? orderLine - 1 : orderLine;
}

function payloadItemReceive(item) {
  return item.itemReceive !== false && item.itemreceive !== false;
}

function fulfillmentLineQuantity(line) {
  const salesQuantity = Math.max(positiveQuantity(line.packed_piece_qty) - positiveQuantity(line.fulfilled_piece_qty), 0)
    || Math.max(positiveQuantity(line.packed_section_qty) - positiveQuantity(line.fulfilled_section_qty), 0)
    || Math.max(positiveQuantity(line.packed_layer_qty) - positiveQuantity(line.fulfilled_layer_qty), 0)
    || Math.max(positiveQuantity(line.packed_pallet_qty) - positiveQuantity(line.fulfilled_pallet_qty), 0);
  if (!hasConversion(line)) {
    if (hasRequiredCustomQuantity(line)) {
      return roundQuantity(positiveQuantity(line.quantity) || salesQuantity);
    }
    return roundQuantity(salesQuantity);
  }
  const convertedQuantity = (Math.max(positiveQuantity(line.packed_pallet_qty) - positiveQuantity(line.fulfilled_pallet_qty), 0) * positiveQuantity(line.to_plt))
    + (Math.max(positiveQuantity(line.packed_layer_qty) - positiveQuantity(line.fulfilled_layer_qty), 0) * positiveQuantity(line.to_lyr))
    + (Math.max(positiveQuantity(line.packed_section_qty) - positiveQuantity(line.fulfilled_section_qty), 0) * positiveQuantity(line.to_sec))
    + (Math.max(positiveQuantity(line.packed_piece_qty) - positiveQuantity(line.fulfilled_piece_qty), 0) * positiveQuantity(line.to_pcs));
  if (convertedQuantity > 0) return roundQuantity(convertedQuantity);
  return roundQuantity(salesQuantity);
}

export async function recordDeliveryFulfillment(orderId, operatorId, { photoDataUrl, payload, response, itemFulfillmentId, itemFulfillmentTranid }) {
  if (!isPhotoReference(photoDataUrl)) {
    throw new Error("Photo proof is required.");
  }
  const order = await getDeliveryOrder(orderId);
  if (!order) throw new Error("Delivery order not found.");
  const lineTarget = canonicalLineTarget(order);
  const orderTarget = canonicalOrderTarget(order);
  await query(
    `UPDATE ${lineTarget.table}
     SET fulfilled_pallet_qty = GREATEST(
           COALESCE(fulfilled_pallet_qty, 0),
           CASE
             WHEN COALESCE(to_plt, 0) = 0 AND COALESCE(to_lyr, 0) = 0 AND COALESCE(to_sec, 0) = 0 AND COALESCE(to_pcs, 0) = 0
              AND (COALESCE(pallet_qty, 0) + COALESCE(layer_qty, 0) + COALESCE(section_qty, 0) + COALESCE(piece_qty, 0)) > 0
             THEN COALESCE(pallet_qty, 0)
             ELSE COALESCE(packed_pallet_qty, 0)
           END
         ),
         fulfilled_layer_qty = GREATEST(
           COALESCE(fulfilled_layer_qty, 0),
           CASE
             WHEN COALESCE(to_plt, 0) = 0 AND COALESCE(to_lyr, 0) = 0 AND COALESCE(to_sec, 0) = 0 AND COALESCE(to_pcs, 0) = 0
              AND (COALESCE(pallet_qty, 0) + COALESCE(layer_qty, 0) + COALESCE(section_qty, 0) + COALESCE(piece_qty, 0)) > 0
             THEN COALESCE(layer_qty, 0)
             ELSE COALESCE(packed_layer_qty, 0)
           END
         ),
         fulfilled_piece_qty = GREATEST(
           COALESCE(fulfilled_piece_qty, 0),
           CASE
             WHEN COALESCE(to_plt, 0) = 0 AND COALESCE(to_lyr, 0) = 0 AND COALESCE(to_sec, 0) = 0 AND COALESCE(to_pcs, 0) = 0
              AND (COALESCE(pallet_qty, 0) + COALESCE(layer_qty, 0) + COALESCE(section_qty, 0) + COALESCE(piece_qty, 0)) > 0
             THEN COALESCE(piece_qty, 0)
             ELSE COALESCE(packed_piece_qty, 0)
           END
         ),
         fulfilled_section_qty = GREATEST(
           COALESCE(fulfilled_section_qty, 0),
           CASE
             WHEN COALESCE(to_plt, 0) = 0 AND COALESCE(to_lyr, 0) = 0 AND COALESCE(to_sec, 0) = 0 AND COALESCE(to_pcs, 0) = 0
              AND (COALESCE(pallet_qty, 0) + COALESCE(layer_qty, 0) + COALESCE(section_qty, 0) + COALESCE(piece_qty, 0)) > 0
             THEN COALESCE(section_qty, 0)
             ELSE COALESCE(packed_section_qty, 0)
           END
         )
     WHERE ${lineTarget.orderColumn} = $1
       AND line_id = ANY($2::bigint[])
       ${lineTarget.extraWhere}`,
    [
      orderId,
      (payload?.item?.items || [])
        .filter((item) => payloadItemReceive(item) && positiveQuantity(item.quantity) > 0)
        .map((item) => fulfilledPayloadLineId(order, item))
        .filter((id) => Number.isInteger(id))
    ]
  );
  const refreshedOrder = await getDeliveryOrder(orderId);
  const remainingLines = (order.lines || []).filter((line) => {
    if (!line.netsuite_active || !["InvtPart", "NonInvtPart"].includes(line.item_type || "")) return false;
    const latest = (refreshedOrder.lines || []).find((item) => String(item.id) === String(line.id)) || line;
    return positiveQuantity(latest.pallet_qty) > positiveQuantity(latest.fulfilled_pallet_qty)
      || positiveQuantity(latest.layer_qty) > positiveQuantity(latest.fulfilled_layer_qty)
      || positiveQuantity(latest.section_qty) > positiveQuantity(latest.fulfilled_section_qty)
      || positiveQuantity(latest.piece_qty || latest.quantity) > positiveQuantity(latest.fulfilled_piece_qty);
  });
  const fulfillmentStatus = remainingLines.length ? "partial_fulfilled" : "fulfilled";

  await query(
    `INSERT INTO delivery_fulfillment_records (
       order_id, operator_id, item_fulfillment_id, item_fulfillment_tranid,
       fulfillment_status, photo_data_url, payload, response
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      orderId,
      operatorId || null,
      itemFulfillmentId || null,
      itemFulfillmentTranid || null,
      fulfillmentStatus,
      photoDataUrl,
      JSON.stringify(payload || {}),
      JSON.stringify(response || {})
    ]
  );

  await query(
    `UPDATE ${orderTarget.table}
     SET fulfillment_status = $2,
         last_item_fulfillment_id = $3,
         last_item_fulfillment_tranid = $4,
         fulfilled_at = now(),
         ${orderTarget.statusColumn} = CASE WHEN $2 = 'fulfilled' THEN 'fulfilled' ELSE 'packed' END,
         status_updated_at = now()
     WHERE netsuite_id = $1`,
    [orderId, fulfillmentStatus, itemFulfillmentId || null, itemFulfillmentTranid || null]
  );

  await writeAudit({
    actorOperatorId: operatorId,
    action: "delivery.order.fulfill",
    orderId,
    details: { fulfillmentStatus, itemFulfillmentId, itemFulfillmentTranid, payload, response }
  });

  return { fulfillmentStatus, itemFulfillmentId, itemFulfillmentTranid };
}

export async function recordDeliveryLoad(orderId, operatorId, { photoDataUrl }) {
  if (!isPhotoReference(photoDataUrl)) {
    throw new Error("Photo proof is required.");
  }
  const order = await getDeliveryOrder(orderId);
  if (!order) throw new Error("Delivery order not found.");
  if (!["packed", "loaded"].includes(order.operator_status)) {
    throw new Error("Order must be packed before loading.");
  }
  const validation = buildDeliveryLoadValidation(order);
  if (!validation.ok) {
    const error = new Error("Packed quantity must be corrected before loading.");
    error.code = "DELIVERY_LOAD_VALIDATION_FAILED";
    error.status = 409;
    error.validation = validation;
    throw error;
  }

  for (const line of order.lines || []) {
    const packedSalesQty = linePackedSalesQuantity(line);
    if (packedSalesQty <= 0) continue;
    const lineTarget = canonicalLineTarget(order);
    await query(
      `UPDATE ${lineTarget.table}
          SET loaded_qty = LEAST($3, COALESCE(loaded_qty, 0) + $4),
              loaded_uom = COALESCE(NULLIF(unit, ''), loaded_uom),
              packed_pallet_qty = 0,
              packed_layer_qty = 0,
              packed_piece_qty = 0,
              packed_section_qty = 0,
              confirmed = false,
              confirmed_at = null
        WHERE ${lineTarget.orderColumn} = $1
          AND id = $2
          ${lineTarget.extraWhere}`,
      [orderId, line.id, lineRequiredSalesQuantity(line), packedSalesQty]
    );
  }

  const loadedSnapshotOrder = await getDeliveryOrder(orderId);
  const remainingLines = (loadedSnapshotOrder.lines || []).filter((line) => {
    if (!line.netsuite_active || !["InvtPart", "NonInvtPart"].includes(line.item_type || "")) return false;
    return lineRequiredSalesQuantity(line) > lineLoadedSalesQuantity(line) + linePackedSalesQuantity(line) + 0.000001;
  });
  const nextStatus = remainingLines.length ? "partial_loaded" : "loaded";
  const loadRecord = await insertOperatorLoadRecord({
    loadType: order.order_type === "transfer_order" ? "transfer_order_load" : "sales_order_delivery_load",
    order,
    operatorId,
    photoDataUrl,
    sourceTable: null,
    sourceRecordId: null,
    lineSnapshot: operatorLoadLineSnapshot(loadedSnapshotOrder.lines || order.lines || []),
    response: {
      localYardOrderStatus: nextStatus === "loaded" ? "Loaded" : "Partial Loaded",
      dispatchPlanDate: order.dispatch_plan_date,
      dispatchTruckPlate: order.dispatch_truck_plate,
      dispatchLoadName: order.dispatch_load_name,
      dispatchParkingSpot: order.dispatch_parking_spot,
      remainingLines: remainingLines.length
    }
  });

  await setCanonicalDeliveryStatus(order, nextStatus, {
    clearPreparing: true,
    localYardOrderStatus: nextStatus === "loaded" ? "Loaded" : "Partial Loaded"
  });

  let activatedCo = { rows: [] };
  if (nextStatus === "loaded") {
    await query(
      `UPDATE local_co_orders
          SET status = 'loaded',
              loaded_at = now(),
              updated_at = now()
        WHERE delivery_order_id = $1`,
      [orderId]
    );
    activatedCo = await query(
      `UPDATE local_co_orders
          SET status = 'planned',
              loaded_at = COALESCE(loaded_at, now()),
              details = details || $2::jsonb,
              updated_at = now()
        WHERE source_order_ref = $1
          AND status = 'pending_load'
        RETURNING co_ref, from_location, to_location`,
      [
        order.tranid,
        JSON.stringify({
          sourceLoaded: true,
          sourceLoadedAt: new Date().toISOString(),
          sourceDeliveryOrderId: orderId
        })
      ]
    );
  }

  await writeAudit({
    actorOperatorId: operatorId,
    action: "delivery.order.load",
    orderId,
    details: {
      localYardOrderStatus: nextStatus === "loaded" ? "Loaded" : "Partial Loaded",
      dispatchPlanDate: order.dispatch_plan_date,
      dispatchTruckPlate: order.dispatch_truck_plate,
      dispatchLoadName: order.dispatch_load_name,
      dispatchParkingSpot: order.dispatch_parking_spot
      ,
      activatedCo: activatedCo.rows,
      remainingLines: remainingLines.length
    }
  });

  return {
    id: loadRecord?.id || null,
    localYardOrderStatus: nextStatus === "loaded" ? "Loaded" : "Partial Loaded",
    dispatchPlanDate: order.dispatch_plan_date,
    dispatchTruckPlate: order.dispatch_truck_plate,
    dispatchLoadName: order.dispatch_load_name,
    dispatchParkingSpot: order.dispatch_parking_spot,
    activatedCo: activatedCo.rows,
    remainingLines: remainingLines.length
  };
}

export async function recordCustomerPickupLoad(orderId, operatorId, { photoDataUrl }) {
  if (!isPhotoReference(photoDataUrl)) {
    throw new Error("Photo proof is required.");
  }
  const order = await getDeliveryOrder(orderId);
  if (!order || !isPickupOrder(order)) throw new Error("Customer pickup sales order not found.");
  const confirmedLines = (order.lines || []).filter((line) => {
    return positiveQuantity(line.packed_pallet_qty)
      + positiveQuantity(line.packed_layer_qty)
      + positiveQuantity(line.packed_piece_qty)
      + positiveQuantity(line.packed_section_qty) > 0;
  });
  if (!confirmedLines.length) throw new Error("Confirm at least one pickup line before loading.");
  const validation = buildDeliveryLoadValidation(order);
  if (!validation.ok) {
    const error = new Error("Packed quantity must be corrected before loading.");
    error.code = "DELIVERY_LOAD_VALIDATION_FAILED";
    error.status = 409;
    error.validation = validation;
    throw error;
  }

  const totals = confirmedLines.reduce((sum, line) => ({
    pallets: sum.pallets + positiveQuantity(line.packed_pallet_qty),
    layers: sum.layers + positiveQuantity(line.packed_layer_qty),
    pieces: sum.pieces + positiveQuantity(line.packed_piece_qty),
    sections: sum.sections + positiveQuantity(line.packed_section_qty),
    salesQuantity: sum.salesQuantity + linePackedSalesQuantity(line)
  }), { pallets: 0, layers: 0, pieces: 0, sections: 0, salesQuantity: 0 });
  const loadedUoms = [...new Set(confirmedLines.map((line) => String(line.unit || "").trim()).filter(Boolean))];
  const loadedUom = loadedUoms.length === 1 ? loadedUoms[0] : loadedUoms.length > 1 ? "MIXED" : "";
  const aggregateLoadedQty = loadedUom === "MIXED" ? null : totals.salesQuantity;

  for (const line of confirmedLines) {
    await query(
      `UPDATE sales_order_lines
          SET loaded_qty = LEAST($3, COALESCE(loaded_qty, 0) + $4),
              loaded_uom = COALESCE(NULLIF(unit, ''), loaded_uom),
              packed_pallet_qty = 0,
              packed_layer_qty = 0,
              packed_piece_qty = 0,
              packed_section_qty = 0,
              confirmed = false,
              confirmed_at = null
        WHERE sales_order_id = $1
          AND id = $2`,
      [
        orderId,
        line.id,
        lineRequiredSalesQuantity(line),
        linePackedSalesQuantity(line)
      ]
    );
  }

  await query(
    `UPDATE sales_order_lines
        SET packed_pallet_qty = 0,
            packed_layer_qty = 0,
            packed_piece_qty = 0,
            packed_section_qty = 0,
            confirmed = false,
            confirmed_at = null
      WHERE sales_order_id = $1
        AND (
          COALESCE(packed_pallet_qty, 0) > 0
          OR COALESCE(packed_layer_qty, 0) > 0
          OR COALESCE(packed_piece_qty, 0) > 0
          OR COALESCE(packed_section_qty, 0) > 0
        )`,
    [orderId]
  );

  const refreshed = await getDeliveryOrder(orderId);
  const remainingLines = (refreshed.lines || []).filter((line) => {
    return lineRequiredSalesQuantity(line) > lineLoadedSalesQuantity(line);
  });
  const pickupStatus = remainingLines.length ? "partial_loaded" : "loaded";

  await query(
    `UPDATE sales_orders
        SET local_yard_order_status = $2,
            operator_status = $2,
            status_updated_at = now()
      WHERE netsuite_id = $1`,
    [orderId, pickupStatus]
  );

  const loadRecord = await insertOperatorLoadRecord({
    loadType: "customer_pickup_load",
    order,
    operatorId,
    photoDataUrl,
    loadedQty: aggregateLoadedQty,
    loadedUom,
    sourceTable: null,
    sourceRecordId: null,
    lineSnapshot: operatorLoadLineSnapshot(refreshed.lines || []),
    response: { pickupStatus, tranid: order.tranid, loadedQty: aggregateLoadedQty, loadedUom }
  });

  await writeAudit({
    actorOperatorId: operatorId,
    action: "customer_pickup.order.load",
    orderId,
    details: { pickupStatus, totals, loadedQty: aggregateLoadedQty, loadedUom, remainingLines: remainingLines.length }
  });

  return {
    id: loadRecord?.id || null,
    pickupStatus,
    localYardOrderStatus: pickupStatus,
    loaded: { ...totals, salesQuantity: aggregateLoadedQty, uom: loadedUom },
    remainingLines: remainingLines.length
  };
}

export async function recordDeliveryFulfillmentFailure(orderId, operatorId, { photoDataUrl, payload, error, stage }) {
  const message = error?.message || String(error || "Unknown fulfillment error");
  try {
    await query(
      `INSERT INTO delivery_fulfillment_records (
         order_id, operator_id, fulfillment_status, photo_data_url, payload, response
       ) VALUES ($1, $2, 'failed', $3, $4, $5)`,
      [
        orderId,
        operatorId || null,
        isPhotoReference(photoDataUrl) ? photoDataUrl : "",
        JSON.stringify(payload || {}),
        JSON.stringify({ error: message, stage: stage || null })
      ]
    );

    await writeAudit({
      actorOperatorId: operatorId,
      action: "delivery.order.fulfill_failed",
      orderId,
      details: { error: message, stage, payload }
    });
  } catch (recordError) {
    console.error("Delivery fulfillment failure record failed:", recordError.message);
  }
}

export async function listDeliveryFulfillments({ limit = 100 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const result = await query(
    `SELECT l.id,
            l.order_id,
            l.order_ref AS tranid,
            null::bigint AS item_fulfillment_id,
            null::text AS item_fulfillment_tranid,
            l.load_type AS fulfillment_status,
            l.created_at,
            op.display_name AS operator_name,
            jsonb_build_object(
              'orderFamily', l.order_family,
              'loadedQty', l.loaded_qty,
              'loadedUom', l.loaded_uom,
              'lines', l.line_snapshot
            ) AS payload,
            l.response,
            left(l.photo_data_url, 80) AS photo_preview
     FROM operator_load_records l
     LEFT JOIN operators op ON op.id = l.operator_id
     ORDER BY l.created_at DESC
     LIMIT ${safeLimit}`
  );
  return result.rows;
}

function normalizeControlDate(value, fallback = new Date()) {
  const text = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  return [
    fallback.getFullYear(),
    String(fallback.getMonth() + 1).padStart(2, "0"),
    String(fallback.getDate()).padStart(2, "0")
  ].join("-");
}

function loadedOrderFilterParams({ from = "", to = "", yard = "all", search = "" } = {}) {
  const fromDate = normalizeControlDate(from);
  const toDate = normalizeControlDate(to || fromDate);
  const params = [fromDate, toDate];
  const clauses = [
    "l.load_type IN ('sales_order_delivery_load', 'transfer_order_load')",
    "l.created_at >= $1::date",
    "l.created_at < ($2::date + interval '1 day')"
  ];
  if (yard && yard !== "all") {
    params.push(String(yard));
    clauses.push("source.outbound_location_id::text = $" + params.length);
  }
  if (String(search || "").trim()) {
    params.push(`%${String(search).trim()}%`);
    clauses.push(`(
      source.tranid ILIKE $${params.length}
      OR source.customer ILIKE $${params.length}
      OR source.order_id::text ILIKE $${params.length}
    )`);
  }
  return { params, where: clauses.join("\n        AND ") };
}

function loadedOrderSourceCte() {
  return `
    WITH source AS (
      SELECT 'sales_order'::text AS order_type,
             o.netsuite_id AS order_id,
             o.tranid,
             o.customer,
             o.outbound_location_id,
             o.outbound_location,
             o.local_yard_order_status,
             o.operator_status AS operator_status
        FROM sales_orders o
      UNION ALL
      SELECT 'transfer_order'::text AS order_type,
             o.netsuite_id AS order_id,
             o.tranid,
             NULL::text AS customer,
             o.from_location_id AS outbound_location_id,
             o.from_location AS outbound_location,
             o.local_yard_order_status,
             o.outbound_operator_status AS operator_status
        FROM transfer_orders o
    )
  `;
}

export async function listControlLoadedOrders(filters = {}) {
  const { params, where } = loadedOrderFilterParams(filters);
  const result = await query(
    `${loadedOrderSourceCte()}
     SELECT source.order_type,
            source.order_id,
            source.tranid,
            source.customer,
            source.outbound_location_id,
            source.outbound_location,
            source.local_yard_order_status,
            source.operator_status,
            MIN(l.created_at) AS first_loaded_at,
            MAX(l.created_at) AS last_loaded_at,
            COUNT(DISTINCT l.id)::int AS load_count,
            COUNT(*) FILTER (WHERE COALESCE(l.photo_data_url, '') <> '')::int AS photo_count
       FROM operator_load_records l
       JOIN source ON source.order_id = l.order_id
                  AND source.order_type = l.order_family
      WHERE ${where}
      GROUP BY source.order_type, source.order_id, source.tranid, source.customer,
               source.outbound_location_id, source.outbound_location,
               source.local_yard_order_status, source.operator_status
      ORDER BY MAX(l.created_at) DESC, source.tranid`
    ,
    params
  );
  return result.rows;
}

export async function getControlLoadedOrderDetail({ orderType, orderId, from = "", to = "" } = {}) {
  const family = orderType === "transfer_order" ? "transfer_order" : "sales_order";
  const fromDate = normalizeControlDate(from);
  const toDate = normalizeControlDate(to || fromDate);
  const isTransfer = family === "transfer_order";
  const orderResult = await query(
    isTransfer
      ? `SELECT 'transfer_order'::text AS order_type, netsuite_id AS order_id, tranid, NULL::text AS customer,
                from_location_id AS outbound_location_id, from_location AS outbound_location,
                local_yard_order_status, outbound_operator_status AS operator_status
           FROM transfer_orders
          WHERE netsuite_id = $1`
      : `SELECT 'sales_order'::text AS order_type, netsuite_id AS order_id, tranid, customer,
                outbound_location_id, outbound_location, local_yard_order_status,
                operator_status
           FROM sales_orders
          WHERE netsuite_id = $1`,
    [orderId]
  );
  if (!orderResult.rowCount) return null;

  const lineResult = await query(
    isTransfer
      ? `SELECT id, line_id, item_id, item_name, sku, item_description,
                loaded_qty, COALESCE(NULLIF(loaded_uom, ''), unit) AS loaded_uom,
                location_id, location
           FROM transfer_order_lines
          WHERE transfer_order_id = $1
            AND line_stage = 'outbound'
            AND COALESCE(loaded_qty, 0) > 0
          ORDER BY line_id NULLS LAST, id`
      : `SELECT id, line_id, item_id, item_name, sku, item_description,
                loaded_qty, COALESCE(NULLIF(loaded_uom, ''), unit) AS loaded_uom,
                location_id, location
           FROM sales_order_lines
          WHERE sales_order_id = $1
            AND COALESCE(loaded_qty, 0) > 0
          ORDER BY line_id NULLS LAST, id`,
    [orderId]
  );
  const photoResult = await query(
    `SELECT id, created_at, photo_data_url, response
       FROM operator_load_records
      WHERE order_family = $1
        AND order_id = $2
        AND load_type IN ('sales_order_delivery_load', 'transfer_order_load')
        AND created_at >= $3::date
        AND created_at < ($4::date + interval '1 day')
      ORDER BY created_at DESC`,
    [family, orderId, fromDate, toDate]
  );
  return {
    order: orderResult.rows[0],
    lines: lineResult.rows,
    photos: photoResult.rows
  };
}

export async function listControlLoadedOrderCsvRows(filters = {}) {
  const orders = await listControlLoadedOrders(filters);
  const rows = [];
  for (const order of orders) {
    const isTransfer = order.order_type === "transfer_order";
    const lineResult = await query(
      isTransfer
        ? `SELECT $2::text AS order_ref, item_name, loaded_qty, COALESCE(NULLIF(loaded_uom, ''), unit) AS loaded_uom, location
             FROM transfer_order_lines
            WHERE transfer_order_id = $1
              AND line_stage = 'outbound'
              AND COALESCE(loaded_qty, 0) > 0
            ORDER BY line_id NULLS LAST, id`
        : `SELECT $2::text AS order_ref, item_name, loaded_qty, COALESCE(NULLIF(loaded_uom, ''), unit) AS loaded_uom, location
             FROM sales_order_lines
            WHERE sales_order_id = $1
              AND COALESCE(loaded_qty, 0) > 0
            ORDER BY line_id NULLS LAST, id`,
      [order.order_id, order.tranid]
    );
    rows.push(...lineResult.rows);
  }
  return rows;
}

async function assertOrderEditable(orderId, operatorId) {
  const order = await getDeliveryOrder(orderId);
  if (!order) throw new Error("Delivery order not found.");
  if (order.operator_status === "preparing" && order.preparing_operator_id && String(order.preparing_operator_id) !== String(operatorId)) {
    throw new Error("This order is preparing on another tablet.");
  }
  if (!["packed", "loaded", "fulfilled"].includes(order.operator_status || "") && order.preparing_operator_id && String(order.preparing_operator_id) !== String(operatorId)) {
    const hasDraftPackedQty = (order.lines || []).some((line) => {
      return ["InvtPart", "NonInvtPart"].includes(line.item_type || "")
        && (
          positiveQuantity(line.packed_pallet_qty) > 0
          || positiveQuantity(line.packed_layer_qty) > 0
          || positiveQuantity(line.packed_section_qty) > 0
          || positiveQuantity(line.packed_piece_qty) > 0
        );
    });
    if (hasDraftPackedQty) throw new Error("This order is preparing on another tablet.");
  }
  return order;
}

function orderHasPackedQuantity(order) {
  return (order?.lines || []).some((line) => {
    return ["InvtPart", "NonInvtPart"].includes(line.item_type || "")
      && linePackedSalesQuantity(line) > 0;
  });
}

async function findActiveDraftOrder(operatorId, orderId) {
  const result = await query(
    `SELECT netsuite_id
       FROM (
         SELECT o.netsuite_id
           FROM sales_orders o
          WHERE o.netsuite_id <> $2
            AND (
              (o.operator_status = 'preparing' AND o.preparing_operator_id::text = $1)
              OR (
                o.operator_status <> 'packed'
                AND o.preparing_operator_id::text = $1
                AND EXISTS (
                  SELECT 1
                    FROM sales_order_lines l
                   WHERE l.sales_order_id = o.netsuite_id
                     AND COALESCE(l.item_type, '') IN ('InvtPart', 'NonInvtPart')
                     AND (${packedQtySql}) > 0
                )
              )
            )
         UNION ALL
         SELECT o.netsuite_id
           FROM transfer_orders o
          WHERE o.netsuite_id <> $2
            AND (
              (o.outbound_operator_status = 'preparing' AND o.preparing_operator_id::text = $1)
              OR (
                o.outbound_operator_status <> 'packed'
                AND o.preparing_operator_id::text = $1
                AND EXISTS (
                  SELECT 1
                    FROM transfer_order_lines l
                   WHERE l.transfer_order_id = o.netsuite_id
                     AND l.line_stage = 'outbound'
                     AND COALESCE(l.item_type, '') IN ('InvtPart', 'NonInvtPart')
                     AND (${packedQtySql}) > 0
                )
              )
            )
       ) active_draft
      LIMIT 1`,
    [operatorId, orderId]
  );
  return result.rows[0]?.netsuite_id || null;
}

async function claimPreparingOrder(orderId, operatorId) {
  const order = await assertOrderEditable(orderId, operatorId);

  const existing = await findActiveDraftOrder(operatorId, orderId);
  if (existing) {
    throw new Error("Pack your current preparing order before moving on.");
  }

  const target = canonicalOrderTarget(order);
  await query(
    `UPDATE ${target.table}
        SET ${target.statusColumn} = CASE WHEN ${target.statusColumn} = 'open' THEN 'preparing' ELSE ${target.statusColumn} END,
            preparing_operator_id = CASE WHEN ${target.statusColumn} <> 'packed' THEN $2 ELSE preparing_operator_id END,
            preparing_started_at = CASE WHEN ${target.statusColumn} <> 'packed' THEN COALESCE(preparing_started_at, now()) ELSE preparing_started_at END,
            status_updated_at = now()
      WHERE netsuite_id = $1`,
    [orderId, operatorId]
  );
  return getDeliveryOrder(orderId);
}

export async function confirmDeliveryLine(orderId, lineId, values, operatorId) {
  if (!operatorId) throw new Error("Operator ID is required.");
  const order = await claimPreparingOrder(orderId, operatorId);
  const line = (order.lines || []).find((item) => String(item.id) === String(lineId));
  if (!line || line.sync_exception) throw new Error("Delivery line not found.");

  const pallets = normalizeQuantity(values?.pallets) || 0;
  const layers = normalizeQuantity(values?.layers) || 0;
  const pieces = normalizeQuantity(values?.pieces) || 0;
  const sections = normalizeQuantity(values?.sections) || 0;
  const lineTarget = canonicalLineTarget(order);
  const available = remainingPackAvailability(line);
  const next = {
    pallets: Math.min(available.pallets, positiveQuantity(line.packed_pallet_qty) + pallets),
    layers: Math.min(available.layers, positiveQuantity(line.packed_layer_qty) + layers),
    pieces: Math.min(available.pieces, positiveQuantity(line.packed_piece_qty) + pieces),
    sections: Math.min(available.sections, positiveQuantity(line.packed_section_qty) + sections)
  };

  await query(
    `UPDATE ${lineTarget.table}
     SET packed_pallet_qty = $3,
         packed_layer_qty = $4,
         packed_piece_qty = $5,
         packed_section_qty = $6,
         confirmed = ($3::numeric + $4::numeric + $5::numeric + $6::numeric) > 0,
         confirmed_at = CASE WHEN ($3::numeric + $4::numeric + $5::numeric + $6::numeric) > 0 THEN now() ELSE null END
     WHERE ${lineTarget.orderColumn} = $1
       AND sync_exception IS NULL
       AND id = $2
       ${lineTarget.extraWhere}`,
    [orderId, lineId, next.pallets, next.layers, next.pieces, next.sections]
  );

  await writeAudit({
    actorOperatorId: operatorId,
    action: "delivery.line.confirm",
    orderId,
    lineId,
    details: { pallets: next.pallets, layers: next.layers, pieces: next.pieces, sections: next.sections }
  });
}

export async function confirmCustomerPickupLine(orderId, lineId, values, operatorId) {
  if (!operatorId) throw new Error("Operator ID is required.");
  const order = await getDeliveryOrder(orderId);
  if (!order || !isPickupOrder(order)) throw new Error("Customer pickup sales order not found.");
  const line = (order.lines || []).find((item) => String(item.id) === String(lineId));
  if (!line || line.sync_exception) throw new Error("Customer pickup line not found.");

  const pallets = normalizeQuantity(values?.pallets) || 0;
  const layers = normalizeQuantity(values?.layers) || 0;
  const pieces = normalizeQuantity(values?.pieces) || 0;
  const sections = normalizeQuantity(values?.sections) || 0;
  const available = remainingPackAvailability(line);
  const next = {
    pallets: Math.min(available.pallets, positiveQuantity(line.packed_pallet_qty) + pallets),
    layers: Math.min(available.layers, positiveQuantity(line.packed_layer_qty) + layers),
    pieces: Math.min(available.pieces, positiveQuantity(line.packed_piece_qty) + pieces),
    sections: Math.min(available.sections, positiveQuantity(line.packed_section_qty) + sections)
  };
  if ((next.pallets + next.layers + next.pieces + next.sections) <= 0) {
    throw new Error("This pickup line has no remaining quantity to load.");
  }

  await query(
    `UPDATE sales_order_lines
     SET packed_pallet_qty = $3,
         packed_layer_qty = $4,
         packed_piece_qty = $5,
         packed_section_qty = $6,
         confirmed = true,
         confirmed_at = now()
     WHERE sales_order_id = $1
       AND sync_exception IS NULL
       AND id = $2`,
    [orderId, lineId, next.pallets, next.layers, next.pieces, next.sections]
  );

  await writeAudit({
    actorOperatorId: operatorId,
    action: "customer_pickup.line.confirm",
    orderId,
    lineId,
    details: { pallets: next.pallets, layers: next.layers, pieces: next.pieces, sections: next.sections }
  });
}

export async function clearCustomerPickupDraft(orderId, operatorId) {
  const order = await getDeliveryOrder(orderId);
  if (!order || !isPickupOrder(order)) throw new Error("Customer pickup sales order not found.");
  await query(
    `UPDATE sales_order_lines
        SET packed_pallet_qty = 0,
            packed_layer_qty = 0,
            packed_piece_qty = 0,
            packed_section_qty = 0,
            confirmed = false,
            confirmed_at = null
      WHERE sales_order_id = $1
        AND (
          COALESCE(packed_pallet_qty, 0) > 0
          OR COALESCE(packed_layer_qty, 0) > 0
          OR COALESCE(packed_piece_qty, 0) > 0
          OR COALESCE(packed_section_qty, 0) > 0
        )`,
    [orderId]
  );
  await writeAudit({
    actorOperatorId: operatorId,
    action: "customer_pickup.draft.clear",
    orderId
  });
  return getDeliveryOrder(orderId);
}

export async function setDeliveryLinePackedQuantity(orderId, lineId, values, operatorId) {
  if (!operatorId) throw new Error("Operator ID is required.");
  const order = await assertOrderEditable(orderId, operatorId);

  const pallets = normalizeQuantity(values?.pallets) || 0;
  const layers = normalizeQuantity(values?.layers) || 0;
  const pieces = normalizeQuantity(values?.pieces) || 0;
  const sections = normalizeQuantity(values?.sections) || 0;
  const lineTarget = canonicalLineTarget(order);
  const line = (order.lines || []).find((item) => String(item.id) === String(lineId));
  if (!line || line.sync_exception) throw new Error("Delivery line not found.");
  const available = remainingPackAvailability(line);
  const next = {
    pallets: Math.min(available.pallets, pallets),
    layers: Math.min(available.layers, layers),
    pieces: Math.min(available.pieces, pieces),
    sections: Math.min(available.sections, sections)
  };

  await query(
    `UPDATE ${lineTarget.table}
     SET packed_pallet_qty = $3,
         packed_layer_qty = $4,
         packed_piece_qty = $5,
         packed_section_qty = $6,
         confirmed = ($3::numeric + $4::numeric + $5::numeric + $6::numeric) > 0,
         confirmed_at = CASE WHEN ($3::numeric + $4::numeric + $5::numeric + $6::numeric) > 0 THEN COALESCE(confirmed_at, now()) ELSE null END
     WHERE ${lineTarget.orderColumn} = $1
       AND sync_exception IS NULL
       AND id = $2
       ${lineTarget.extraWhere}`,
    [orderId, lineId, next.pallets, next.layers, next.pieces, next.sections]
  );

  await writeAudit({
    actorOperatorId: operatorId,
    action: "delivery.line.update_packed_quantity",
    orderId,
    lineId,
    details: { pallets: next.pallets, layers: next.layers, pieces: next.pieces, sections: next.sections }
  });
}

export async function unpackDeliveryLine(orderId, lineId, values, operatorId) {
  if (!operatorId) throw new Error("Operator ID is required.");
  const order = await assertOrderEditable(orderId, operatorId);

  const lineTarget = canonicalLineTarget(order);
  const line = (order.lines || []).find((item) => String(item.id) === String(lineId));
  if (!line) throw new Error("Delivery line not found.");
  const pallets = positiveQuantity(line.packed_pallet_qty);
  const layers = positiveQuantity(line.packed_layer_qty);
  const pieces = positiveQuantity(line.packed_piece_qty);
  const sections = positiveQuantity(line.packed_section_qty);

  await query(
    `UPDATE ${lineTarget.table}
     SET packed_pallet_qty = 0,
         packed_layer_qty = 0,
         packed_piece_qty = 0,
         packed_section_qty = 0,
         confirmed = false,
         confirmed_at = null,
         sync_exception = null,
         sync_exception_at = null
     WHERE ${lineTarget.orderColumn} = $1
       AND id = $2
       ${lineTarget.extraWhere}`,
    [orderId, lineId]
  );

  await refreshDeliveryProgressStatus(orderId, { clearPreparing: true });

  await query(
    `UPDATE dispatch_operator_requests
        SET status = 'resolved',
            resolved_by = $2,
            resolved_at = now()
      WHERE status = 'open'
        AND (order_ref = $1 OR order_ref IN (
          SELECT tranid FROM sales_orders WHERE netsuite_id::text = $1
          UNION ALL
          SELECT tranid FROM transfer_orders WHERE netsuite_id::text = $1
        ))`,
    [String(orderId), operatorId || null]
  );

  await writeAudit({
    actorOperatorId: operatorId,
    action: "delivery.line.unpack",
    orderId,
    lineId,
    details: { pallets, layers, pieces, sections }
  });
}

export async function unpackDeliveryOrder(orderId, operatorId) {
  if (!operatorId) throw new Error("Operator ID is required.");
  const order = await assertOrderEditable(orderId, operatorId);
  const lineTarget = canonicalLineTarget(order);

  await query(
    `UPDATE ${lineTarget.table}
     SET packed_pallet_qty = 0,
         packed_layer_qty = 0,
         packed_piece_qty = 0,
         packed_section_qty = 0,
         confirmed = false,
         confirmed_at = null,
         sync_exception = null,
         sync_exception_at = null
     WHERE ${lineTarget.orderColumn} = $1
       ${lineTarget.extraWhere}`,
    [orderId]
  );

  await refreshDeliveryProgressStatus(orderId, { clearPreparing: true });

  await query(
    `UPDATE dispatch_operator_requests
        SET status = 'resolved',
            resolved_by = $2,
            resolved_at = now()
      WHERE status = 'open'
        AND (order_ref = $1 OR order_ref IN (
          SELECT tranid FROM sales_orders WHERE netsuite_id::text = $1
          UNION ALL
          SELECT tranid FROM transfer_orders WHERE netsuite_id::text = $1
        ))`,
    [String(orderId), operatorId || null]
  );

  await writeAudit({
    actorOperatorId: operatorId,
    action: "delivery.order.unpack",
    orderId
  });
}

export async function updateDeliveryStatus(id, status, operatorId) {
  if (!operatorId) throw new Error("Operator ID is required.");
  const allowed = new Set(["open", "preparing", "packed"]);
  if (!allowed.has(status)) throw new Error("Invalid delivery status.");

  if (status === "preparing") {
    await claimPreparingOrder(id, operatorId);
    await writeAudit({
      actorOperatorId: operatorId,
      action: "delivery.order.status",
      orderId: id,
      details: { status }
    });
    return;
  }

  const order = await assertOrderEditable(id, operatorId);

  if (status === "packed") {
    if (!orderHasPackedQuantity(order)) {
      const error = new Error("Cannot mark this order as packed because no order line has confirmed packed quantity.");
      error.status = 409;
      throw error;
    }
    const existing = await findActiveDraftOrder(operatorId, id);
    if (existing) {
      throw new Error("Pack your current preparing order before moving on.");
    }
  }

  await setCanonicalDeliveryStatus(order, status, { clearPreparing: status === "packed" || status === "open" });

  await writeAudit({
    actorOperatorId: operatorId,
    action: "delivery.order.status",
    orderId: id,
    details: { status }
  });
}

export async function markDeliveryPrepared(id, { operatorName, photoPath, notes }) {
  const order = await getDeliveryOrder(id);
  if (!order) throw new Error("Delivery order not found.");
  await setCanonicalDeliveryStatus(order, "packed", { clearPreparing: true });

  await query(
    `INSERT INTO delivery_preparation_records (order_id, operator_name, photo_path, notes)
     VALUES ($1, $2, $3, $4)`,
    [id, operatorName || null, photoPath || null, notes || null]
  );
}
