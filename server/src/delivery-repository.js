import crypto from "node:crypto";
import { query, withTransaction } from "./db.js";
import { dispatchLoadAssignment } from "./dispatch-load-assignment.js";
import { isNetSuiteSandboxEnvironment } from "./config.js";
import { writeAudit } from "./auth-repository.js";
import { getDispatchDeliveryGroup, listDispatchDeliveryGroups } from "./dispatch-delivery-group-repository.js";
import { remapDispatchLinksToMaterializedSplit } from "./dispatch-order-target-repository.js";

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

function photoReferences(values = []) {
  return Array.isArray(values) ? values.filter(isPhotoReference) : [];
}

function requirePhotoReferences(values = [], minimum = 2) {
  const photos = photoReferences(values);
  if (photos.length < minimum) throw new Error(`At least ${minimum} photos are required.`);
  return photos;
}

function roundQuantity(value) {
  return Number(Number(value || 0).toFixed(6));
}

const LOAD_SALES_QTY_TOLERANCE = 0.1;

function syntheticOrderId(value) {
  const hex = crypto.createHash("sha1").update(String(value || "")).digest("hex").slice(0, 12);
  return -Number.parseInt(hex, 16);
}

function dateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function itemNumber(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function splitLineSalesQuantity(item = {}) {
  const pallets = itemNumber(item.pallets);
  const layers = itemNumber(item.layers);
  const sections = itemNumber(item.sections);
  const pieces = itemNumber(item.pieces);
  const toPlt = itemNumber(item.toPlt ?? item.to_plt);
  const toLyr = itemNumber(item.toLyr ?? item.to_lyr);
  const toSec = itemNumber(item.toSec ?? item.to_sec);
  const toPcs = itemNumber(item.toPcs ?? item.to_pcs);
  const converted = (pallets * toPlt) + (layers * toLyr) + (sections * toSec) + (pieces * toPcs);
  if (converted > 0) return roundQuantity(converted);
  return roundQuantity(pieces || sections || layers || pallets || itemNumber(item.splitQty) || itemNumber(item.quantity));
}

function splitParentOrderId(order = {}) {
  const explicitParent = String(order.originalOrderId || "").trim();
  if (explicitParent) return explicitParent;
  const orderId = String(order.id || "").trim();
  return /-S\d+$/i.test(orderId) ? orderId.replace(/-S\d+$/i, "") : "";
}

function isSplitOrder(order = {}) {
  return Boolean(splitParentOrderId(order)) && /-S\d+$/i.test(String(order.id || ""));
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
  if (!hasConversion(line)) {
    const packedSalesQty = positiveQuantity(line.packed_sales_qty);
    if (packedSalesQty > 0) return packedSalesQty;
    if (!isLegacySalesQuantityOnlyLine(line)) return 0;
  }
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

function isPalletSalesItem(line) {
  return String(line?.sku || line?.item_name || "").trim().toUpperCase() === "PALLET";
}

function isLegacySalesQuantityOnlyLine(line) {
  return !hasConversion(line) && (isPalletSalesItem(line) || !hasRequiredCustomQuantity(line));
}

function isSalesQuantityOnlyLine(line) {
  return !hasConversion(line) && positiveQuantity(line.quantity) > 0;
}

function resolveSalesOnlyPackedQuantity(line, values = {}, { absolute = false } = {}) {
  const salesAvailable = Math.max(0, lineRequiredSalesQuantity(line) - lineLoadedSalesQuantity(line));
  const requested = positiveQuantity(values?.salesQty)
    || positiveQuantity(values?.pieces)
    || positiveQuantity(values?.sections)
    || positiveQuantity(values?.layers)
    || positiveQuantity(values?.pallets);
  return roundQuantity(Math.min(
    salesAvailable,
    absolute ? requested : positiveQuantity(line.packed_sales_qty) + requested
  ));
}

function lineLoadSalesQuantity(line) {
  const packedSalesQty = roundQuantity(linePackedSalesQuantity(line));
  if (packedSalesQty <= 0) return 0;
  const remainingSalesQty = roundQuantity(Math.max(0, lineRequiredSalesQuantity(line) - lineLoadedSalesQuantity(line)));
  if (remainingSalesQty > 0 && Math.abs(remainingSalesQty - packedSalesQty) <= LOAD_SALES_QTY_TOLERANCE) {
    return remainingSalesQty;
  }
  return packedSalesQty;
}

function wholeUnitsFromSalesQuantity(salesQuantity, conversion) {
  const sales = positiveQuantity(salesQuantity);
  const unitSize = positiveQuantity(conversion);
  if (!sales || !unitSize) return 0;
  const rawUnits = sales / unitSize;
  const floorUnits = Math.floor(rawUnits + 0.000001);
  const ceilUnits = Math.ceil(rawUnits - 0.000001);
  if (ceilUnits > floorUnits && Math.abs((ceilUnits * unitSize) - sales) <= LOAD_SALES_QTY_TOLERANCE) {
    return ceilUnits;
  }
  return floorUnits;
}

function orderFamily(order) {
  if (order?.order_type === "transfer_order") return "transfer_order";
  if (order?.order_type === "vrma_order") return "vrma_order";
  if (order?.order_type === "co_order") return "co_order";
  return "sales_order";
}

function operatorLoadLineSnapshot(lines = []) {
  return lines
    .filter((line) => positiveQuantity(line.loaded_qty) > 0 || positiveQuantity(line.packed_pallet_qty) > 0 || positiveQuantity(line.packed_layer_qty) > 0 || positiveQuantity(line.packed_section_qty) > 0 || positiveQuantity(line.packed_piece_qty) > 0 || positiveQuantity(line.packed_sales_qty) > 0)
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
      packedSalesQty: positiveQuantity(line.packed_sales_qty),
      packedPieces: positiveQuantity(line.packed_piece_qty),
      loadedQty: positiveQuantity(line.loaded_qty),
      loadedUom: line.loaded_uom || line.unit || ""
    }));
}

async function insertOperatorLoadRecord({
  loadType,
  order,
  operatorId,
  photoDataUrls = [],
  loadedQty = null,
  loadedUom = null,
  sourceTable = null,
  sourceRecordId = null,
  lineSnapshot = [],
  response = {}
}) {
  const photos = photoReferences(photoDataUrls);
  const result = await query(
    `INSERT INTO operator_load_records (
       load_type, order_family, order_id, order_ref, source_table, source_record_id,
       operator_id, photo_data_url, photo_data_urls, loaded_qty, loaded_uom, line_snapshot, response
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12::jsonb, $13::jsonb)
     ON CONFLICT (source_table, source_record_id) DO UPDATE SET
       load_type = EXCLUDED.load_type,
       order_family = EXCLUDED.order_family,
       order_id = EXCLUDED.order_id,
       order_ref = EXCLUDED.order_ref,
       operator_id = EXCLUDED.operator_id,
       photo_data_url = EXCLUDED.photo_data_url,
       photo_data_urls = EXCLUDED.photo_data_urls,
       loaded_qty = EXCLUDED.loaded_qty,
       loaded_uom = EXCLUDED.loaded_uom,
       line_snapshot = EXCLUDED.line_snapshot,
       response = EXCLUDED.response
     RETURNING id`,
    [
      loadType,
      orderFamily(order),
      isVrmaDeliveryOrder(order) ? order.vrma_order_id : (order?.netsuite_id || null),
      order?.tranid || "",
      sourceTable,
      sourceRecordId,
      operatorId || null,
      photos[0] || "",
      JSON.stringify(photos),
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
    if (isSalesQuantityOnlyLine(line)) {
      return { pallets: 0, layers: 0, sections: 0, pieces: 0 };
    }
    if (hasRequiredCustomQuantity(line)) {
      return {
        pallets: Math.max(positiveQuantity(line.pallet_qty) - positiveQuantity(line.fulfilled_pallet_qty), 0),
        layers: Math.max(positiveQuantity(line.layer_qty) - positiveQuantity(line.fulfilled_layer_qty), 0),
        sections: Math.max(positiveQuantity(line.section_qty) - positiveQuantity(line.fulfilled_section_qty), 0),
        pieces: Math.max(positiveQuantity(line.piece_qty) - positiveQuantity(line.fulfilled_piece_qty), 0)
      };
    }
    return { pallets: 0, layers: 0, sections: 0, pieces: salesAvailable };
  }
  const consumed = loadedUnitConsumption(line);
  const deriveFromSales = !hasRequiredCustomQuantity(line);
  const unitAvailable = (unit, consumedValue) => {
    const conversion = unitConversion(line, unit);
    if (!conversion) return 0;
    const explicit = explicitUnitQuantity(line, unit);
    const explicitRemaining = explicit > 0 ? Math.max(0, explicit - positiveQuantity(consumedValue)) : 0;
    if (explicitRemaining > 0) return explicitRemaining;
    if (explicit > 0 && salesAvailable > 0) return wholeUnitsFromSalesQuantity(salesAvailable, conversion);
    return deriveFromSales ? wholeUnitsFromSalesQuantity(salesAvailable, conversion) : 0;
  };
  return {
    pallets: unitAvailable("pallets", consumed.pallet),
    layers: unitAvailable("layers", consumed.layer),
    pieces: unitAvailable("pieces", consumed.piece),
    sections: unitAvailable("sections", consumed.section)
  };
}
function resolveIndependentPackedSalesQuantity(line, next, requestedSalesQty, { absolute = false, physicalChanged = false } = {}) {
  if (hasConversion(line) || !hasRequiredCustomQuantity(line)) return 0;
  const salesAvailable = Math.max(0, lineRequiredSalesQuantity(line) - lineLoadedSalesQuantity(line));
  const explicitSalesQty = positiveQuantity(requestedSalesQty);
  let nextSalesQty = absolute
    ? explicitSalesQty
    : positiveQuantity(line.packed_sales_qty) + explicitSalesQty;
  const fullPhysical = [
    ["pallets", "pallet_qty"],
    ["layers", "layer_qty"],
    ["sections", "section_qty"],
    ["pieces", "piece_qty"]
  ].every(([unit, field]) => {
    const required = positiveQuantity(line[field]);
    return required <= 0.000001 || positiveQuantity(next[unit]) + 0.000001 >= required;
  });
  if (physicalChanged && explicitSalesQty <= 0) {
    if (!fullPhysical) {
      throw new Error("Enter the sales-unit quantity when partially packing a manual PLT/LYR/SEC/PCS line.");
    }
    nextSalesQty = salesAvailable;
  }
  if (nextSalesQty > salesAvailable + 0.000001) {
    throw new Error(`Packed sales quantity cannot exceed ${roundQuantity(salesAvailable)} ${line.unit || "sales units"}.`);
  }
  return roundQuantity(nextSalesQty);
}

const packedQtySql = `
  COALESCE(packed_pallet_qty, 0)
  + COALESCE(packed_section_qty, 0)
  + COALESCE(packed_layer_qty, 0)
  + COALESCE(packed_piece_qty, 0)
  + COALESCE(packed_sales_qty, 0)
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

function isExcludedDeliveryServiceLine(line = {}) {
  const itemName = String(line.sku || line.item_name || "").trim().toUpperCase();
  return itemName.startsWith("DELIVERY CHARGE") || itemName.startsWith("SALES CREDIT");
}

function isDeliveryPickableLine(line = {}) {
  return ["InvtPart", "NonInvtPart"].includes(line.item_type || "")
    && !isExcludedDeliveryServiceLine(line);
}

function deliveryPickableSql(alias) {
  const itemName = `UPPER(COALESCE(NULLIF(${alias}.sku, ''), ${alias}.item_name, ''))`;
  return `COALESCE(${alias}.item_type, '') IN ('InvtPart', 'NonInvtPart')
    AND ${itemName} NOT LIKE 'DELIVERY CHARGE%'
    AND ${itemName} NOT LIKE 'SALES CREDIT%'`;
}

function hasDeliveryDisplayQuantity(line) {
  if (isExcludedDeliveryServiceLine(line)) return false;
  return positiveQuantity(line.pallet_qty) > 0
    || positiveQuantity(line.layer_qty) > 0
    || positiveQuantity(line.section_qty) > 0
    || positiveQuantity(line.piece_qty) > 0
    || positiveQuantity(line.quantity) > 0
    || positiveQuantity(line.packed_pallet_qty) > 0
    || positiveQuantity(line.packed_layer_qty) > 0
    || positiveQuantity(line.packed_section_qty) > 0
    || positiveQuantity(line.packed_piece_qty) > 0
    || positiveQuantity(line.packed_sales_qty) > 0
    || Boolean(line.sync_exception);
}

function loadLineUnits(line) {
  if (!isSalesQuantityOnlyLine(line) && (hasConversion(line) || hasRequiredCustomQuantity(line))) {
    const available = remainingPackAvailability(line);
    const customUnits = [
      { key: "pallet", label: "PLT", required: available.pallets, packed: positiveQuantity(line.packed_pallet_qty) },
      { key: "layer", label: "LYR", required: available.layers, packed: positiveQuantity(line.packed_layer_qty) },
      { key: "section", label: "SEC", required: available.sections, packed: positiveQuantity(line.packed_section_qty) },
      { key: "piece", label: "PCS", required: available.pieces, packed: positiveQuantity(line.packed_piece_qty) }
    ].filter((unit) => unit.required > 0 || unit.packed > 0);
    if (!hasConversion(line) && hasRequiredCustomQuantity(line)) {
      customUnits.push({
        key: "sales",
        label: line.unit || "Sales Qty",
        required: Math.max(0, lineRequiredSalesQuantity(line) - lineLoadedSalesQuantity(line)),
        packed: positiveQuantity(line.packed_sales_qty)
      });
    }
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

    if (packedSalesQty > remainingSalesQty + LOAD_SALES_QTY_TOLERANCE) {
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
  const dependencyColumn = unit === "pallet" ? "pallet_qty"
    : unit === "layer" ? "layer_qty"
      : unit === "section" ? "section_qty"
        : unit === "piece" ? "piece_qty"
          : "allocated_quantity";
  return `(
    COALESCE((SELECT SUM(${column}) FROM dispatch_so_po_allocations a WHERE a.status = 'active' AND a.sales_line_id = ${lineAlias}.id), 0)
    + COALESCE((
      SELECT SUM(dl.${dependencyColumn})
        FROM order_dependency_lines dl
        JOIN order_dependencies d ON d.id = dl.dependency_id
       WHERE dl.sales_line_id = ${lineAlias}.id
         AND d.dependency_mode = 'direct_to_customer'
         AND d.status <> 'cancelled'
    ), 0)
  )`;
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
    COALESCE(NULLIF(${alias}.packed_piece_qty, 0),
      NULLIF(${alias}.packed_section_qty, 0),
      NULLIF(${alias}.packed_layer_qty, 0),
      NULLIF(${alias}.packed_pallet_qty, 0), 0)
  `;
  const legacySalesOnly = `
    UPPER(COALESCE(NULLIF(${alias}.sku, ''), ${alias}.item_name, '')) = 'PALLET'
    OR (
      COALESCE(${alias}.pallet_qty, 0) = 0
      AND COALESCE(${alias}.layer_qty, 0) = 0
      AND COALESCE(${alias}.section_qty, 0) = 0
      AND COALESCE(${alias}.piece_qty, 0) = 0
    )
  `;
  return `CASE
    WHEN (
      COALESCE(${alias}.to_plt, 0)
      + COALESCE(${alias}.to_lyr, 0)
      + COALESCE(${alias}.to_sec, 0)
      + COALESCE(${alias}.to_pcs, 0)
    ) > 0 THEN (${converted})
    ELSE COALESCE(NULLIF(${alias}.packed_sales_qty, 0), CASE WHEN ${legacySalesOnly} THEN (${rawUnits}) ELSE 0 END)
  END`;
}

function lineOpenSalesSql(alias) {
  const remaining = `((${lineRequiredSalesSql(alias)}) - COALESCE(${alias}.loaded_qty, 0) - (${linePackedSalesSql(alias)}))`;
  return `CASE WHEN ${remaining} <= 0.000001 THEN 0 ELSE ${remaining} END`;
}

function isDispatchGroupOrderId(value) {
  const text = String(value || "").trim();
  return /^(?:GRP|G[A-Z]+)-/i.test(text) || /^GROUP:(?:GRP|G[A-Z]+)-/i.test(text);
}

function isLocalCoRef(value) {
  return /^CO-/i.test(String(value || "").trim());
}

function normalizeDispatchGroupId(value) {
  return String(value || "").trim().replace(/^GROUP:/i, "");
}

function lineHasPackedQuantity(line) {
  return positiveQuantity(line.packed_pallet_qty) > 0
    || positiveQuantity(line.packed_layer_qty) > 0
    || positiveQuantity(line.packed_section_qty) > 0
    || positiveQuantity(line.packed_piece_qty) > 0
    || positiveQuantity(line.packed_sales_qty) > 0;
}

function lineHasOpenQuantity(line) {
  return isDeliveryPickableLine(line)
    && lineRequiredSalesQuantity(line) > lineLoadedSalesQuantity(line) + linePackedSalesQuantity(line) + 0.000001;
}

function groupLineKey(line) {
  return [
    line.item_id || "",
    line.sku || line.item_name || "",
    line.unit || "",
    line.location_id || "",
    line.location || "",
    positiveQuantity(line.to_plt),
    positiveQuantity(line.to_lyr),
    positiveQuantity(line.to_sec),
    positiveQuantity(line.to_pcs),
    Number(line.item_id) === 2055 ? String(line.id || line.line_id || "") : "",
    Number(line.item_id) === 2055 ? String(line.item_description || "") : ""
  ].join("|");
}

function groupLineId(groupId, key) {
  const hex = crypto.createHash("sha1").update(`${groupId}:${key}`).digest("hex").slice(0, 14);
  return `GRPLINE-${hex}`;
}

function groupLineSource(line, order) {
  return {
    orderId: order.netsuite_id,
    orderRef: order.tranid,
    orderType: order.order_type,
    lineId: line.id,
    lineKey: groupLineKey(line)
  };
}

function addNumericFields(target, source, fields) {
  for (const field of fields) target[field] = roundQuantity(positiveQuantity(target[field]) + positiveQuantity(source[field]));
}

function aggregateGroupLines(groupId, childOrders = []) {
  const linesByKey = new Map();
  for (const order of childOrders) {
    for (const line of order.lines || []) {
      if (isExcludedDeliveryServiceLine(line)) continue;
      if (!isDeliveryPickableLine(line) && !line.sync_exception && !lineHasPackedQuantity(line)) continue;
      const key = groupLineKey(line);
      const existing = linesByKey.get(key);
      if (!existing) {
        linesByKey.set(key, {
          ...line,
          id: groupLineId(groupId, key),
          group_line_key: key,
          source_lines: [groupLineSource(line, order)],
          source_order_refs: [order.tranid],
          quantity: positiveQuantity(line.quantity),
          pallet_qty: positiveQuantity(line.pallet_qty),
          layer_qty: positiveQuantity(line.layer_qty),
          section_qty: positiveQuantity(line.section_qty),
          piece_qty: positiveQuantity(line.piece_qty),
          packed_pallet_qty: positiveQuantity(line.packed_pallet_qty),
          packed_layer_qty: positiveQuantity(line.packed_layer_qty),
          packed_section_qty: positiveQuantity(line.packed_section_qty),
          packed_piece_qty: positiveQuantity(line.packed_piece_qty),
          packed_sales_qty: positiveQuantity(line.packed_sales_qty),
          loaded_qty: positiveQuantity(line.loaded_qty)
        });
        continue;
      }
      addNumericFields(existing, line, [
        "quantity",
        "pallet_qty",
        "layer_qty",
        "section_qty",
        "piece_qty",
        "packed_pallet_qty",
        "packed_layer_qty",
        "packed_section_qty",
        "packed_piece_qty",
        "packed_sales_qty",
        "loaded_qty"
      ]);
      existing.source_lines.push(groupLineSource(line, order));
      if (!existing.source_order_refs.includes(order.tranid)) existing.source_order_refs.push(order.tranid);
      existing.confirmed = Boolean(existing.confirmed || line.confirmed);
      if (line.sync_exception && !existing.sync_exception) existing.sync_exception = line.sync_exception;
      if (line.sync_exception_at && !existing.sync_exception_at) existing.sync_exception_at = line.sync_exception_at;
    }
  }
  return [...linesByKey.values()].sort((a, b) => String(a.sku || a.item_name || "").localeCompare(String(b.sku || b.item_name || "")));
}

async function loadDispatchGroupChildOrders(groups = []) {
  const childRefs = [...new Set(groups.flatMap((group) => group.childRefs || []))];
  if (!childRefs.length || !groups.length) return new Map();
  const isTransfer = groups[0].orderType === "transfer_order";
  const sandboxFixtures = isNetSuiteSandboxEnvironment();
  const sandboxSql = sandboxFixtures ? "true" : "false";
  const orderResult = await query(
    isTransfer
      ? `SELECT o.*,
                o.from_location_id AS outbound_location_id,
                o.from_location AS outbound_location,
                o.outbound_operator_status AS operator_status,
                'transfer_order'::text AS order_type,
                o.from_location_id AS source_location_id,
                o.from_location AS source_location,
                o.to_location_id AS destination_location_id,
                o.to_location AS destination_location,
                NULL::bigint AS customer_id,
                NULL::text AS customer,
                NULL::numeric AS foreign_total,
                NULL::bigint AS delivery_method_id,
                NULL::text AS delivery_method
           FROM transfer_orders o
          WHERE o.tranid = ANY($1::text[])
          ORDER BY o.tranid`
      : `SELECT o.*,
                CASE WHEN ${sandboxSql} AND COALESCE(o.is_test_fixture, false) THEN true ELSE o.netsuite_active END AS netsuite_active,
                o.sales_order_type AS delivery_method,
                'sales_order'::text AS order_type,
                NULL::bigint AS source_location_id,
                NULL::text AS source_location,
                NULL::bigint AS destination_location_id,
                NULL::text AS destination_location
           FROM sales_orders o
           WHERE o.tranid = ANY($1::text[])
             AND (COALESCE(o.is_test_fixture, false) = false OR ${sandboxSql})
           ORDER BY o.tranid`,
    [childRefs]
  );
  const childIds = orderResult.rows.map((order) => order.netsuite_id);
  if (!childIds.length) return new Map(groups.map((group) => [group.id, []]));
  const lineResult = await query(
    isTransfer
      ? `SELECT l.*,
                0::numeric AS po_allocated_pallet_qty,
                0::numeric AS po_allocated_layer_qty,
                0::numeric AS po_allocated_section_qty,
                0::numeric AS po_allocated_piece_qty,
                0::numeric AS po_allocated_sales_qty
           FROM transfer_order_lines l
          WHERE l.transfer_order_id = ANY($1::bigint[])
            AND l.line_stage = 'outbound'
            AND (l.netsuite_active = true OR l.sync_exception IS NOT NULL OR (${packedQtySql}) > 0)
          ORDER BY l.transfer_order_id, l.line_id NULLS LAST, l.id`
      : `WITH alloc AS (
           SELECT sales_line_id,
                  SUM(allocated_pallet_qty) AS po_allocated_pallet_qty,
                  SUM(allocated_layer_qty) AS po_allocated_layer_qty,
                  SUM(allocated_section_qty) AS po_allocated_section_qty,
                  SUM(allocated_piece_qty) AS po_allocated_piece_qty,
                  SUM(allocated_sales_qty) AS po_allocated_sales_qty
             FROM dispatch_so_po_allocations
            WHERE status = 'active'
            GROUP BY sales_line_id
         )
         SELECT l.*,
                COALESCE(alloc.po_allocated_pallet_qty, 0) + ${activePoAllocationSql("pallet", "l")} - COALESCE(alloc.po_allocated_pallet_qty, 0) AS po_allocated_pallet_qty,
                COALESCE(alloc.po_allocated_layer_qty, 0) + ${activePoAllocationSql("layer", "l")} - COALESCE(alloc.po_allocated_layer_qty, 0) AS po_allocated_layer_qty,
                COALESCE(alloc.po_allocated_section_qty, 0) + ${activePoAllocationSql("section", "l")} - COALESCE(alloc.po_allocated_section_qty, 0) AS po_allocated_section_qty,
                COALESCE(alloc.po_allocated_piece_qty, 0) + ${activePoAllocationSql("piece", "l")} - COALESCE(alloc.po_allocated_piece_qty, 0) AS po_allocated_piece_qty,
                COALESCE(alloc.po_allocated_sales_qty, 0) + ${activePoAllocationSql("sales", "l")} - COALESCE(alloc.po_allocated_sales_qty, 0) AS po_allocated_sales_qty
           FROM sales_order_lines l
           JOIN sales_orders o ON o.netsuite_id = l.sales_order_id
           LEFT JOIN alloc ON alloc.sales_line_id = l.id
          WHERE l.sales_order_id = ANY($1::bigint[])
            AND (l.netsuite_active = true
              OR (${sandboxSql} AND COALESCE(o.is_test_fixture, false))
              OR l.sync_exception IS NOT NULL
              OR (${packedQtySql}) > 0)
          ORDER BY l.sales_order_id, l.line_id NULLS LAST, l.id`,
    [childIds]
  );
  const orderColumn = isTransfer ? "transfer_order_id" : "sales_order_id";
  const linesByOrder = new Map();
  for (const line of lineResult.rows.map(applyDeliveryAllocationFields)) {
    const key = String(line[orderColumn]);
    if (!linesByOrder.has(key)) linesByOrder.set(key, []);
    linesByOrder.get(key).push(line);
  }
  const ordersByRef = new Map(orderResult.rows.map((order) => [String(order.tranid), {
    ...order,
    lines: (linesByOrder.get(String(order.netsuite_id)) || []).filter(hasDeliveryDisplayQuantity)
  }]));
  return new Map(groups.map((group) => [
    group.id,
    (group.childRefs || []).map((ref) => ordersByRef.get(String(ref))).filter(Boolean)
  ]));
}

function buildDispatchGroupDeliveryOrder(group, childOrders = []) {
  if (!childOrders.length) return null;
  const lines = aggregateGroupLines(group.id, childOrders).filter(hasDeliveryDisplayQuantity);
  const childRefText = childOrders.map((order) => order.tranid).join("+");
  const hasPacked = childOrders.some((order) => (order.lines || []).some(lineHasPackedQuantity));
  const hasLoaded = childOrders.some((order) => (order.lines || []).some((line) => lineLoadedSalesQuantity(line) > 0));
  const hasOpen = childOrders.some((order) => (order.lines || []).some(lineHasOpenQuantity));
  const hasPreparing = childOrders.some((order) => order.operator_status === "preparing");
  const allLoaded = childOrders.every((order) => String(order.local_yard_order_status || "").toLowerCase() === "loaded");
  const operatorStatus = hasPreparing ? "preparing" : hasPacked ? "packed" : hasLoaded && hasOpen ? "partial_loaded" : "open";
  const base = childOrders[0];
  return {
    ...base,
    netsuite_id: group.id,
    tranid: childRefText || group.id,
    dispatch_group_id: group.id,
    is_dispatch_group: true,
    child_orders: childOrders,
    child_order_refs: childOrders.map((order) => order.tranid),
    child_order_ids: childOrders.map((order) => order.netsuite_id),
    customer: [...new Set(childOrders.map((order) => order.customer).filter(Boolean))].join(" + "),
    operator_status: operatorStatus,
    local_yard_order_status: allLoaded ? "Loaded" : (hasOpen && (hasPacked || hasLoaded) ? "Partial Loaded" : "Open"),
    dispatch_planned: true,
    dispatch_plan_date: group.planDate,
    dispatch_truck_plate: group.truckPlate,
    dispatch_load_name: group.loadName,
    dispatch_parking_spot: group.parkingSpot,
    warning_count: childOrders.reduce((sum, order) => sum + positiveQuantity(order.warning_count), 0),
    underpack_count: hasOpen && (hasPacked || hasLoaded) ? 1 : 0,
    lines
  };
}

function buildDispatchGroupDeliveryListOrder(group, orders = []) {
  if (!orders.length) return null;
  const childIds = orders.map((order) => order.netsuite_id);
  const lines = orders.flatMap((order) => order.lines || []);
  const pickable = lines.filter(isDeliveryPickableLine);
  const hasPacked = pickable.some(lineHasPackedQuantity);
  const hasLoaded = pickable.some((line) => lineLoadedSalesQuantity(line) > 0);
  const hasOpen = pickable.some(lineHasOpenQuantity);
  const allLoaded = orders.every((order) => String(order.local_yard_order_status || "").toLowerCase() === "loaded");
  const hasPreparing = orders.some((order) => order.operator_status === "preparing");
  const base = orders[0];
  return {
    ...base,
    netsuite_id: group.id,
    tranid: group.childRefs.join("+") || orders.map((order) => order.tranid).join("+") || group.id,
    dispatch_group_id: group.id,
    is_dispatch_group: true,
    child_order_refs: group.childRefs,
    child_order_ids: childIds,
    customer: [...new Set(orders.map((order) => order.customer).filter(Boolean))].join(" + "),
    operator_status: hasPreparing ? "preparing" : hasPacked ? "packed" : hasLoaded && hasOpen ? "partial_loaded" : "open",
    local_yard_order_status: allLoaded ? "Loaded" : (hasOpen && (hasPacked || hasLoaded) ? "Partial Loaded" : "Open"),
    dispatch_planned: true,
    dispatch_plan_date: group.planDate,
    dispatch_truck_plate: group.truckPlate,
    dispatch_load_name: group.loadName,
    dispatch_parking_spot: group.parkingSpot,
    warning_count: lines.filter((line) => line.sync_exception && lineHasPackedQuantity(line)).length,
    underpack_count: hasOpen && (hasPacked || hasLoaded) ? 1 : 0,
    has_open_qty: hasOpen,
    has_packed_qty: hasPacked,
    has_loaded_qty: hasLoaded,
    lines: []
  };
}

async function listDispatchGroupDeliveryOrders({ locationId = null, status = "active", orderType = "sales_order", planDate = null, truckPlate = null } = {}) {
  const definitions = await listDispatchDeliveryGroups({ orderType });
  const childOrdersByGroup = await loadDispatchGroupChildOrders(definitions);
  const rows = [];
  for (const group of definitions) {
    const order = buildDispatchGroupDeliveryListOrder(group, childOrdersByGroup.get(group.id) || []);
    if (!order) continue;
    if (locationId && String(order.outbound_location_id || "") !== String(locationId)) continue;
    if (planDate && String(order.dispatch_plan_date || "").slice(0, 10) !== String(dateOnly(planDate) || "")) continue;
    if (truckPlate && String(order.dispatch_truck_plate || "") !== String(truckPlate)) continue;
    const hasPacked = Boolean(order.has_packed_qty);
    const hasOpen = Boolean(order.has_open_qty);
    const allLoaded = String(order.local_yard_order_status || "").toLowerCase() === "loaded";
    const operatorStatus = String(order.operator_status || "").toLowerCase();
    if (allLoaded) continue;
    if (status === "packed" && !(hasPacked && ["packed", "loaded", "partial_loaded"].includes(operatorStatus))) continue;
    if (status !== "packed" && !hasOpen && operatorStatus !== "preparing") continue;
    rows.push(order);
  }
  return rows;
}

async function getDispatchGroupDeliveryOrder(groupId) {
  const group = await getDispatchDeliveryGroup(normalizeDispatchGroupId(groupId));
  if (!group) return null;
  const childOrdersByGroup = await loadDispatchGroupChildOrders([group]);
  return buildDispatchGroupDeliveryOrder(group, childOrdersByGroup.get(group.id) || []);
}

export async function getDeliveryOrdersBatch(ids = []) {
  const keys = [...new Set((ids || []).map((id) => String(id || "").trim()).filter(Boolean))];
  if (!keys.length) return [];
  const groupKeys = keys.filter(isDispatchGroupOrderId).map(normalizeDispatchGroupId);
  const regularIds = keys
    .filter((key) => /^-?\d+$/.test(key))
    .map(Number)
    .filter(Number.isSafeInteger);
  const ordersByKey = new Map();
  const sandboxFixtures = isNetSuiteSandboxEnvironment();
  const sandboxSql = sandboxFixtures ? "true" : "false";

  if (regularIds.length) {
    const orderResult = await query(
        `SELECT o.*,
                CASE WHEN ${sandboxSql} AND COALESCE(o.is_test_fixture, false) THEN true ELSE o.netsuite_active END AS netsuite_active,
                o.sales_order_type AS delivery_method,
                'sales_order'::text AS order_type,
                NULL::bigint AS source_location_id,
                NULL::text AS source_location,
                NULL::bigint AS destination_location_id,
                NULL::text AS destination_location
           FROM sales_orders o
          WHERE o.netsuite_id = ANY($1::bigint[])
            AND (COALESCE(o.is_test_fixture, false) = false OR ${sandboxSql})`,
        [regularIds]
      );
    const lineResult = await query(
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
         )
          SELECT l.*,
                 CASE WHEN ${sandboxSql} AND COALESCE(o.is_test_fixture, false) THEN true ELSE l.netsuite_active END AS netsuite_active,
                COALESCE(alloc.po_allocated_pallet_qty, 0) + ${activePoAllocationSql("pallet", "l")} - COALESCE(alloc.po_allocated_pallet_qty, 0) AS po_allocated_pallet_qty,
                COALESCE(alloc.po_allocated_layer_qty, 0) + ${activePoAllocationSql("layer", "l")} - COALESCE(alloc.po_allocated_layer_qty, 0) AS po_allocated_layer_qty,
                COALESCE(alloc.po_allocated_section_qty, 0) + ${activePoAllocationSql("section", "l")} - COALESCE(alloc.po_allocated_section_qty, 0) AS po_allocated_section_qty,
                COALESCE(alloc.po_allocated_piece_qty, 0) + ${activePoAllocationSql("piece", "l")} - COALESCE(alloc.po_allocated_piece_qty, 0) AS po_allocated_piece_qty,
                COALESCE(alloc.po_allocated_sales_qty, 0) + ${activePoAllocationSql("sales", "l")} - COALESCE(alloc.po_allocated_sales_qty, 0) AS po_allocated_sales_qty
            FROM sales_order_lines l
            JOIN sales_orders o ON o.netsuite_id = l.sales_order_id
           LEFT JOIN alloc ON alloc.sales_line_id = l.id
          WHERE l.sales_order_id = ANY($1::bigint[])
             AND (l.netsuite_active = true
               OR (${sandboxSql} AND COALESCE(o.is_test_fixture, false))
               OR l.sync_exception IS NOT NULL
               OR (${packedQtySql}) > 0)
          ORDER BY l.sales_order_id, l.line_id NULLS LAST, l.id`,
        [regularIds]
      );
    const linesByOrder = new Map();
    for (const line of lineResult.rows.map(applyDeliveryAllocationFields)) {
      const key = String(line.sales_order_id);
      if (!linesByOrder.has(key)) linesByOrder.set(key, []);
      linesByOrder.get(key).push(line);
    }
    for (const order of orderResult.rows) {
      ordersByKey.set(String(order.netsuite_id), {
        ...order,
        testFixture: sandboxFixtures && order.is_test_fixture === true,
        lines: (linesByOrder.get(String(order.netsuite_id)) || []).filter(hasDeliveryDisplayQuantity)
      });
    }
  }

  if (groupKeys.length) {
    const definitions = (await listDispatchDeliveryGroups({ orderType: "sales_order", includePast: true }))
      .filter((group) => groupKeys.includes(normalizeDispatchGroupId(group.id)));
    const childOrdersByGroup = await loadDispatchGroupChildOrders(definitions);
    for (const group of definitions) {
      const order = buildDispatchGroupDeliveryOrder(group, childOrdersByGroup.get(group.id) || []);
      if (order) ordersByKey.set(normalizeDispatchGroupId(group.id), order);
    }
  }

  return keys.map((key) => ordersByKey.get(normalizeDispatchGroupId(key))).filter(Boolean);
}

function savedOrderType(order) {
  if (order?.is_dispatch_group || isDispatchGroupOrderId(order?.netsuite_id)) return "group_order";
  return order?.order_type === "transfer_order" ? "transfer_order" : "sales_order";
}

function isFullyLoadedDeliveryOrder(order = {}) {
  const lines = Array.isArray(order.lines) ? order.lines : [];
  const hasOpen = lines.some(lineHasOpenQuantity);
  const status = String(order.local_yard_order_status || order.operator_status || "").trim().toLowerCase();
  return !hasOpen && (status === "loaded" || status === "shipped" || status === "fulfilled");
}

function groupChildOrderIds(order) {
  return (order?.child_order_ids || []).map((id) => String(id));
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
    return line.netsuite_active && isDeliveryPickableLine(line);
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

function mapLocalCoLineForDelivery(line = {}) {
  const packedSalesQty = isLegacySalesQuantityOnlyLine(line)
    ? positiveQuantity(line.packed_sales_qty)
      || positiveQuantity(line.packed_pallet_qty)
      || positiveQuantity(line.packed_layer_qty)
      || positiveQuantity(line.packed_section_qty)
      || positiveQuantity(line.packed_piece_qty)
    : positiveQuantity(line.packed_sales_qty);
  return {
    ...line,
    order_id: line.delivery_order_id || line.order_id,
    item_description: line.item_description || "",
    item_type: line.item_type || "InvtPart",
    item_type_text: line.item_type_text || "Inventory Item",
    packed_pallet_qty: positiveQuantity(line.packed_pallet_qty),
    packed_layer_qty: positiveQuantity(line.packed_layer_qty),
    packed_section_qty: positiveQuantity(line.packed_section_qty),
    packed_piece_qty: positiveQuantity(line.packed_piece_qty),
    packed_sales_qty: packedSalesQty,
    fulfilled_pallet_qty: 0,
    fulfilled_layer_qty: 0,
    fulfilled_piece_qty: 0,
    fulfilled_section_qty: 0,
    loaded_qty: 0,
    loaded_uom: line.unit || "",
    netsuite_active: true,
    sync_exception: null
  };
}

function mapLocalCoOrderForDelivery(co = {}, lines = []) {
  const details = co.details && typeof co.details === "object" ? co.details : {};
  const status = String(co.status || "pending_load");
  const operatorStatus = status === "packed" ? "packed" : status === "preparing" ? "preparing" : "open";
  return {
    local_co_id: co.id,
    netsuite_id: co.delivery_order_id || -Number(co.id),
    tranid: co.co_ref,
    trandate: co.created_at,
    customer_id: null,
    customer: details.customer || "Transit Depot",
    status: co.status,
    status_text: co.status === "pending_load" ? "Local CO - Pending Load" : "Local CO",
    foreign_total: null,
    order_location_id: null,
    order_location: "",
    outbound_location_id: co.from_location_id,
    outbound_location: co.from_location,
    delivery_method_id: null,
    delivery_method: "Transit CO",
    operator_status: operatorStatus,
    local_yard_order_status: "Open",
    preparing_operator_id: co.preparing_operator_id || null,
    preparing_started_at: co.preparing_started_at || null,
    status_updated_at: co.updated_at || co.created_at,
    netsuite_active: true,
    synced_at: co.updated_at || co.created_at,
    fulfillment_status: "not_fulfilled",
    dispatch_planned: Boolean(co.dispatch_plan_id || co.dispatch_plan_date || co.dispatch_truck_plate || co.dispatch_load_name),
    dispatch_plan_date: co.dispatch_plan_date,
    dispatch_planned_at: co.updated_at || co.created_at,
    dispatch_truck_plate: co.dispatch_truck_plate || "",
    dispatch_load_name: co.dispatch_load_name || "",
    dispatch_parking_spot: co.dispatch_parking_spot || "",
    expected_delivery_date: co.dispatch_plan_date,
    dispatch_address: "",
    dispatch_window_start: "",
    dispatch_window_end: "",
    dispatch_instructions: details.notes || `Local transit depot order for ${co.source_order_ref}.`,
    memo: details.notes || `Local transit depot order for ${co.source_order_ref}.`,
    order_type: "co_order",
    source_order_ref: co.source_order_ref,
    source_location_id: co.from_location_id,
    source_location: co.from_location,
    destination_location_id: co.to_location_id,
    destination_location: co.to_location,
    warning_count: 0,
    underpack_count: 0,
    lines: lines.map(mapLocalCoLineForDelivery).filter(hasDeliveryDisplayQuantity)
  };
}

async function getLocalCoDeliveryOrder(coRefOrId) {
  const text = String(coRefOrId || "").trim();
  if (!text) return null;
  const order = await query(
    `SELECT *
       FROM local_co_orders
      WHERE co_ref = $1
         OR delivery_order_id::text = $1
         OR id::text = $1`,
    [text]
  );
  if (!order.rowCount) return null;
  const co = order.rows[0];
  const lines = await query(
    `SELECT line.*,
            co.delivery_order_id AS delivery_order_id,
            co.delivery_order_id AS order_id
       FROM local_co_order_lines line
       INNER JOIN local_co_orders co ON co.id = line.co_id
      WHERE co.id = $1
      ORDER BY line.line_id NULLS LAST, line.id`,
    [co.id]
  );
  return mapLocalCoOrderForDelivery(co, lines.rows);
}

async function listLocalCoDeliveryOrders({ locationId = null, status = "active", planDate = null, truckPlate = null } = {}) {
  const params = [];
  const clauses = [
    status === "packed"
      ? "co.status = 'packed'"
      : "co.status IN ('pending_load', 'preparing')"
  ];
  if (locationId) {
    params.push(Number(locationId));
    clauses.push(`co.from_location_id = $${params.length}`);
  }
  if (planDate) {
    params.push(dateOnly(planDate));
    clauses.push(`co.dispatch_plan_date = $${params.length}`);
  }
  if (truckPlate) {
    params.push(String(truckPlate));
    clauses.push(`co.dispatch_truck_plate = $${params.length}`);
  }
  const result = await query(
    `SELECT co.*,
            COUNT(line.id)::int AS line_count
       FROM local_co_orders co
       LEFT JOIN local_co_order_lines line ON line.co_id = co.id
      WHERE ${clauses.join(" AND ")}
      GROUP BY co.id
      ORDER BY co.dispatch_plan_date NULLS LAST,
               co.dispatch_load_name NULLS LAST,
               co.co_ref`,
    params
  );
  return result.rows.map((row) => mapLocalCoOrderForDelivery(row, []));
}

const VRMA_OPERATOR_YARD_BY_LOCATION = new Map([
  ["1", "3445"],
  ["28", "2967"],
  ["15", "12441"],
  ["26", "150"]
]);

function isVrmaDeliveryRef(value) {
  return /^VRMA:/i.test(String(value || "").trim());
}

function normalizeVrmaDeliveryRef(value) {
  return String(value || "").trim().replace(/^VRMA:/i, "");
}

function vrmaOperatorLocationId(yard) {
  const entry = [...VRMA_OPERATOR_YARD_BY_LOCATION.entries()].find(([, code]) => code === String(yard || ""));
  return entry ? Number(entry[0]) : null;
}

function mapVrmaLineForDelivery(line = {}, order = {}) {
  const hasItemConversion = positiveQuantity(line.to_plt) > 0
    || positiveQuantity(line.to_lyr) > 0
    || positiveQuantity(line.to_sec) > 0
    || positiveQuantity(line.to_pcs) > 0;
  return {
    id: `VRMALINE:${line.id}`,
    line_id: line.id,
    order_id: order.netsuite_id,
    item_id: line.item_id,
    item_name: line.item_name,
    sku: line.sku || line.item_name,
    item_description: line.item_description || "",
    item_type: line.master_item_type || line.item_type || "InvtPart",
    item_type_text: line.master_item_type_text || line.item_type_text || "Inventory Item",
    quantity: positiveQuantity(line.quantity),
    unit: line.unit || "",
    item_weight: positiveQuantity(line.quantity) > 0
      ? positiveQuantity(line.weight_lbs) / positiveQuantity(line.quantity)
      : 0,
    location_id: order.outbound_location_id,
    location: order.outbound_location,
    pallet_qty: hasItemConversion ? positiveQuantity(line.pallet_qty) : 0,
    layer_qty: hasItemConversion ? positiveQuantity(line.layer_qty) : 0,
    section_qty: hasItemConversion ? positiveQuantity(line.section_qty) : 0,
    piece_qty: hasItemConversion ? positiveQuantity(line.piece_qty) : 0,
    packed_pallet_qty: positiveQuantity(line.packed_pallet_qty),
    packed_layer_qty: positiveQuantity(line.packed_layer_qty),
    packed_section_qty: positiveQuantity(line.packed_section_qty),
    packed_piece_qty: positiveQuantity(line.packed_piece_qty),
    packed_sales_qty: positiveQuantity(line.packed_sales_qty),
    pack_quantity_source: "vrma_local",
    fulfilled_pallet_qty: 0,
    fulfilled_layer_qty: 0,
    fulfilled_section_qty: 0,
    fulfilled_piece_qty: 0,
    to_plt: positiveQuantity(line.to_plt),
    to_lyr: positiveQuantity(line.to_lyr),
    to_sec: positiveQuantity(line.to_sec),
    to_pcs: positiveQuantity(line.to_pcs),
    loaded_qty: positiveQuantity(line.loaded_qty),
    loaded_uom: line.loaded_uom || line.unit || "",
    confirmed: Boolean(line.confirmed),
    confirmed_at: line.confirmed_at || null,
    netsuite_active: true,
    sync_exception: null,
    vrma_reference_only: false,
    vrma_local_only: true
  };
}

function mapVrmaOrderForDelivery(row = {}, lines = []) {
  const planned = Boolean(row.plan_id);
  const locationId = vrmaOperatorLocationId(row.pickup_location);
  const order = {
    vrma_order_id: row.id,
    netsuite_id: `VRMA:${row.vrma_ref}`,
    tranid: row.vrma_ref,
    trandate: row.created_at,
    customer_id: null,
    customer: row.local_vendor || row.vendor || "Local Vendor",
    status: row.status,
    status_text: `Local VRMA - ${row.operator_status || (planned ? "Planned" : "Open")}`,
    foreign_total: null,
    order_location_id: locationId,
    order_location: row.pickup_location,
    outbound_location_id: locationId,
    outbound_location: row.pickup_location,
    delivery_method_id: null,
    delivery_method: "Local VRMA",
    operator_status: row.operator_status || "open",
    local_yard_order_status: row.local_yard_order_status || "Open",
    preparing_operator_id: row.preparing_operator_id || null,
    preparing_started_at: row.preparing_started_at || null,
    status_updated_at: row.status_updated_at || row.updated_at || row.created_at,
    netsuite_active: true,
    synced_at: row.updated_at || row.created_at,
    fulfillment_status: "local_only",
    dispatch_planned: planned,
    dispatch_plan_date: row.plan_date,
    dispatch_planned_at: row.plan_updated_at,
    dispatch_truck_plate: row.truck_plate || "",
    dispatch_load_name: row.load_name || "",
    dispatch_parking_spot: row.parking_spot || "",
    expected_delivery_date: row.plan_date,
    dispatch_address: row.vendor_address || "",
    dispatch_window_start: row.window_start || "",
    dispatch_window_end: row.window_end || "",
    dispatch_instructions: [row.notes, row.vendor_instructions].filter(Boolean).join(" | "),
    memo: row.notes || "",
    order_type: "vrma_order",
    source_location_id: locationId,
    source_location: row.pickup_location,
    destination_location_id: null,
    destination_location: row.dropoff_location,
    warning_count: 0,
    underpack_count: 0,
    line_count: Number(row.line_count || lines.length || 0),
    vrma_reference_only: false,
    vrma_local_only: true
  };
  return { ...order, lines: lines.map((line) => mapVrmaLineForDelivery(line, order)) };
}

export async function listVrmaDeliveryPrepOrders({ locationId = null, ref = "", status = "active" } = {}) {
  const normalizedStatus = String(status || "").trim().toLowerCase();
  const params = [];
  const clauses = [
    "v.pickup_location IN ('3445', '2967', '12441', '150')",
    "v.status NOT IN ('Cancelled', 'Hold', 'Completed')"
  ];
  if (normalizedStatus === "packed") {
    clauses.push("v.operator_status = 'packed'");
  } else if (normalizedStatus === "active") {
    clauses.push("v.operator_status IN ('open', 'preparing', 'partial_loaded')");
  } else if (normalizedStatus === "loaded") {
    clauses.push("v.operator_status = 'loaded'");
  }
  if (locationId) {
    const yard = VRMA_OPERATOR_YARD_BY_LOCATION.get(String(locationId));
    if (!yard) return [];
    params.push(yard);
    clauses.push(`v.pickup_location = $${params.length}`);
  }
  if (ref) {
    params.push(normalizeVrmaDeliveryRef(ref));
    clauses.push(`LOWER(v.vrma_ref) = LOWER($${params.length})`);
  }
  const result = await query(
    `SELECT v.*,
            vendor_yard.address AS vendor_address,
            vendor_yard.window_start,
            vendor_yard.window_end,
            vendor_yard.instructions AS vendor_instructions,
            planned.plan_id,
            planned.plan_date,
            planned.plan_updated_at,
            planned.truck_plate,
            planned.load_name,
            planned.parking_spot,
            (SELECT COUNT(*)::int FROM scm_vrma_order_lines line WHERE line.vrma_order_id = v.id) AS line_count
       FROM scm_vrma_orders v
       JOIN LATERAL (
         SELECT y.address, y.window_start, y.window_end, y.instructions
           FROM dispatch_local_vendors local_vendor
           JOIN dispatch_vendor_yards y ON LOWER(y.vendor) = LOWER(local_vendor.name)
          WHERE local_vendor.active = true
            AND y.active = true
            AND LOWER(local_vendor.name) = LOWER(COALESCE(v.local_vendor, v.vendor, ''))
            AND LOWER(y.yard) = LOWER(v.dropoff_location)
          ORDER BY y.id
          LIMIT 1
       ) vendor_yard ON true
      LEFT JOIN LATERAL (
         SELECT assignment.plan_id,
                assignment.plan_date,
                assignment.updated_at AS plan_updated_at,
                COALESCE(assignment.truck_plate, '') AS truck_plate,
                COALESCE(assignment.load_name, '') AS load_name,
                COALESCE(assignment.parking_spot, '') AS parking_spot
           FROM dispatch_vrma_plan_assignments assignment
           JOIN dispatch_plans p ON p.id = assignment.plan_id AND p.status <> 'cancelled'
          WHERE LOWER(assignment.order_ref) = LOWER(v.vrma_ref)
          ORDER BY assignment.plan_date DESC, assignment.updated_at DESC
          LIMIT 1
       ) planned ON true
      WHERE ${clauses.join(" AND ")}
      ORDER BY planned.plan_id NULLS FIRST, v.updated_at DESC, v.vrma_ref`,
    params
  );
  return result.rows.map((row) => mapVrmaOrderForDelivery(row, []));
}

async function getVrmaDeliveryPrepOrder(ref) {
  const orders = await listVrmaDeliveryPrepOrders({ ref, status: "" });
  const order = orders[0];
  if (!order) return null;
  const lines = await query(
    `SELECT line.*,
            item.item_type AS master_item_type,
            item.item_type_text AS master_item_type_text
       FROM scm_vrma_order_lines line
       LEFT JOIN inventory_items item ON item.item_id::text = line.item_id::text
      WHERE line.vrma_order_id = $1
      ORDER BY line.id`,
    [order.vrma_order_id]
  );
  return mapVrmaOrderForDelivery({
    ...order,
    id: order.vrma_order_id,
    vrma_ref: order.tranid,
    local_vendor: order.customer,
    pickup_location: order.outbound_location,
    dropoff_location: order.destination_location,
    vendor_address: order.dispatch_address,
    window_start: order.dispatch_window_start,
    window_end: order.dispatch_window_end,
    vendor_instructions: order.dispatch_instructions,
    plan_id: order.dispatch_planned ? 1 : null,
    plan_date: order.dispatch_plan_date,
    plan_updated_at: order.dispatch_planned_at,
    truck_plate: order.dispatch_truck_plate,
    load_name: order.dispatch_load_name,
    parking_spot: order.dispatch_parking_spot,
    line_count: lines.rowCount
  }, lines.rows);
}

export async function listDeliveryOrders({ locationId = null, status = "active", orderType = "sales_order", planDate = null, truckPlate = null } = {}) {
  const sandboxFixtures = isNetSuiteSandboxEnvironment();
  const sandboxSql = sandboxFixtures ? "true" : "false";
  const statuses = parseStatusFilter(status);
  const params = [];
  let locationClause = "";
  if (locationId) {
    params.push(locationId);
    locationClause = `AND outbound_location_id = $${params.length}`;
  }
  const pickable = deliveryPickableSql("l");
  const packedQuantity = `(
    COALESCE(l.packed_pallet_qty, 0) > 0
    OR COALESCE(l.packed_section_qty, 0) > 0
    OR COALESCE(l.packed_layer_qty, 0) > 0
    OR COALESCE(l.packed_piece_qty, 0) > 0
    OR COALESCE(l.packed_sales_qty, 0) > 0
  )`;
  const progressQuantity = `(
    COALESCE(l.loaded_qty, 0) > 0
    OR ${packedQuantity}
  )`;
  const openSalesQuantity = lineOpenSalesSql("l");
  const underpackCount = "COALESCE(line_summary.underpack_count, 0)";
  const hasRemainingQty = "COALESCE(line_summary.has_remaining_qty, false)";
  const hasPackedQty = "COALESCE(line_summary.has_packed_qty, false)";
  const hasProgressQty = "COALESCE(line_summary.has_progress_qty, false)";
  const hasDirectDependency = "direct_dependency.sales_order_id IS NOT NULL";
  const statusClause = status === "packed"
    ? `operator_status = 'packed'`
    : `(
        operator_status = ANY($${params.length + 1}) AND operator_status <> 'packed'
        OR (operator_status IN ('packed', 'loaded', 'partial_loaded') AND ${underpackCount} > 0)
      )`;
  if (status !== "packed") params.push(statuses);
  params.push(orderType || "sales_order");
  const orderTypeParam = params.length;
  let planClause = "";
  if (planDate) {
    params.push(dateOnly(planDate));
    planClause += ` AND dispatch_plan_date = $${params.length}`;
  }
  if (truckPlate) {
    params.push(String(truckPlate));
    planClause += ` AND dispatch_truck_plate = $${params.length}`;
  }

  const result = await query(
    `WITH delivery_order_source AS (
       SELECT netsuite_id, tranid, trandate, customer_id, customer, status, status_text,
              foreign_total, order_location_id, order_location, outbound_location_id,
              outbound_location, delivery_method_id, sales_order_type AS delivery_method,
               operator_status, local_yard_order_status, preparing_operator_id,
               preparing_started_at, status_updated_at,
               CASE WHEN ${sandboxSql} AND COALESCE(is_test_fixture, false) THEN true ELSE netsuite_active END AS netsuite_active,
               is_test_fixture, synced_at,
              fulfillment_status, dispatch_planned, dispatch_plan_date, dispatch_planned_at, dispatch_truck_plate,
              dispatch_load_name, dispatch_parking_spot, expected_delivery_date,
              dispatch_address, dispatch_window_start, dispatch_window_end,
              dispatch_instructions, memo, 'sales_order'::text AS order_type,
              NULL::bigint AS source_location_id, NULL::text AS source_location,
              NULL::bigint AS destination_location_id, NULL::text AS destination_location
       FROM sales_orders
       WHERE sales_order_type <> '${CUSTOMER_PICKUP_DELIVERY_METHOD.replaceAll("'", "''")}'
         AND (COALESCE(is_test_fixture, false) = false OR ${sandboxSql})
       UNION ALL
       SELECT netsuite_id, tranid, trandate, NULL::bigint AS customer_id, NULL::text AS customer,
              status, status_text, NULL::numeric AS foreign_total, NULL::bigint AS order_location_id,
              NULL::text AS order_location, from_location_id AS outbound_location_id,
              from_location AS outbound_location, NULL::bigint AS delivery_method_id,
              NULL::text AS delivery_method, outbound_operator_status AS operator_status,
              local_yard_order_status, preparing_operator_id, preparing_started_at,
               status_updated_at, netsuite_active, false AS is_test_fixture, synced_at, fulfillment_status,
              dispatch_planned, dispatch_plan_date, dispatch_planned_at, dispatch_truck_plate,
              dispatch_load_name, dispatch_parking_spot, expected_delivery_date,
              dispatch_address, dispatch_window_start, dispatch_window_end,
              dispatch_instructions, memo, 'transfer_order'::text AS order_type,
              from_location_id AS source_location_id, from_location AS source_location,
              to_location_id AS destination_location_id, to_location AS destination_location
       FROM transfer_orders
       WHERE from_location_id IS NOT NULL
     ),
     active_sales_line_allocations AS (
       SELECT allocation.sales_line_id,
              SUM(allocation.sales_qty) AS sales_qty,
              SUM(allocation.pallet_qty) AS pallet_qty,
              SUM(allocation.layer_qty) AS layer_qty,
              SUM(allocation.section_qty) AS section_qty,
              SUM(allocation.piece_qty) AS piece_qty
         FROM (
           SELECT sales_line_id,
                  allocated_sales_qty AS sales_qty,
                  allocated_pallet_qty AS pallet_qty,
                  allocated_layer_qty AS layer_qty,
                  allocated_section_qty AS section_qty,
                  allocated_piece_qty AS piece_qty
             FROM dispatch_so_po_allocations
            WHERE status = 'active'
           UNION ALL
           SELECT dependency_line.sales_line_id,
                  dependency_line.allocated_quantity AS sales_qty,
                  dependency_line.pallet_qty,
                  dependency_line.layer_qty,
                  dependency_line.section_qty,
                  dependency_line.piece_qty
             FROM order_dependency_lines dependency_line
             JOIN order_dependencies dependency ON dependency.id = dependency_line.dependency_id
            WHERE dependency_line.sales_line_id IS NOT NULL
              AND dependency.dependency_mode = 'direct_to_customer'
              AND dependency.status <> 'cancelled'
         ) allocation
        GROUP BY allocation.sales_line_id
     ),
     delivery_line_source AS (
       SELECT sales_order_id AS order_id, id, line_id, item_id, item_name, sku,
              item_description, item_type, item_type_text,
               GREATEST(COALESCE(l.quantity, 0) - COALESCE(line_allocation.sales_qty, 0), 0) AS quantity, unit,
               GREATEST(COALESCE(l.pallet_qty, 0) - COALESCE(line_allocation.pallet_qty, 0), 0) AS pallet_qty,
               GREATEST(COALESCE(l.layer_qty, 0) - COALESCE(line_allocation.layer_qty, 0), 0) AS layer_qty,
               GREATEST(COALESCE(l.section_qty, 0) - COALESCE(line_allocation.section_qty, 0), 0) AS section_qty,
               GREATEST(COALESCE(l.piece_qty, 0) - COALESCE(line_allocation.piece_qty, 0), 0) AS piece_qty,
              packed_pallet_qty, packed_layer_qty, packed_section_qty, packed_piece_qty, packed_sales_qty, pack_quantity_source,
              to_plt, to_lyr, to_sec, to_pcs, loaded_qty, loaded_uom,
               CASE WHEN ${sandboxSql} AND COALESCE(o.is_test_fixture, false) THEN true ELSE l.netsuite_active END AS netsuite_active,
               sync_exception, l.synced_at
        FROM sales_order_lines l
        JOIN sales_orders o ON o.netsuite_id = l.sales_order_id
        LEFT JOIN active_sales_line_allocations line_allocation ON line_allocation.sales_line_id = l.id
       UNION ALL
       SELECT transfer_order_id AS order_id, id, line_id, item_id, item_name, sku,
              item_description, item_type, item_type_text, quantity, unit,
              pallet_qty, layer_qty, section_qty, piece_qty,
              packed_pallet_qty, packed_layer_qty, packed_section_qty, packed_piece_qty, packed_sales_qty, pack_quantity_source,
              to_plt, to_lyr, to_sec, to_pcs, loaded_qty, loaded_uom,
               netsuite_active, sync_exception, synced_at
       FROM transfer_order_lines
       WHERE line_stage = 'outbound'
     ),
     delivery_line_rollup AS (
       SELECT l.order_id,
              COUNT(*) FILTER (
                WHERE l.sync_exception IS NOT NULL AND ${packedQuantity}
              )::int AS warning_count,
              COUNT(*) FILTER (
                WHERE ${pickable}
                  AND l.netsuite_active = true
                  AND ${openSalesQuantity} > 0
              )::int AS open_line_count,
              BOOL_OR((${pickable} OR l.sync_exception IS NOT NULL) AND ${packedQuantity}) AS has_packed_qty,
              BOOL_OR(${pickable} AND l.netsuite_active = true AND ${progressQuantity}) AS has_progress_qty
         FROM delivery_line_source l
        GROUP BY l.order_id
     ),
     delivery_line_summary AS (
       SELECT line_rollup.*,
              line_rollup.open_line_count > 0 AS has_remaining_qty,
              CASE WHEN line_rollup.has_progress_qty THEN line_rollup.open_line_count ELSE 0 END AS underpack_count
         FROM delivery_line_rollup line_rollup
     ),
     direct_dependency_orders AS (
       SELECT DISTINCT sales_order_id
         FROM order_dependencies
        WHERE dependency_mode = 'direct_to_customer'
          AND status <> 'cancelled'
     )
     SELECT delivery_order_source.*,
            ${hasDirectDependency} AS direct_pickup_only,
            COALESCE(line_summary.warning_count, 0) AS warning_count,
            ${underpackCount} AS underpack_count
     FROM delivery_order_source
     LEFT JOIN delivery_line_summary line_summary ON line_summary.order_id = delivery_order_source.netsuite_id
     LEFT JOIN direct_dependency_orders direct_dependency ON direct_dependency.sales_order_id = delivery_order_source.netsuite_id
     WHERE ${statusClause}
       ${locationClause}
        AND order_type = $${orderTypeParam}
        ${planClause}
        AND ${deliveryMethodClause("delivery_order_source")}
        AND NOT (
          delivery_order_source.tranid NOT LIKE '%-S%'
          AND (
            (
              delivery_order_source.order_type = 'sales_order'
              AND EXISTS (
                SELECT 1
                FROM sales_orders split_child
                WHERE split_child.tranid LIKE delivery_order_source.tranid || '-S%'
                  AND split_child.netsuite_active = true
                  AND COALESCE(split_child.local_yard_order_status, 'Open') <> 'Loaded'
              )
            )
            OR (
              delivery_order_source.order_type = 'transfer_order'
              AND EXISTS (
                SELECT 1
                FROM transfer_orders split_child
                WHERE split_child.tranid LIKE delivery_order_source.tranid || '-S%'
                  AND split_child.netsuite_active = true
                  AND COALESCE(split_child.local_yard_order_status, 'Open') <> 'Loaded'
              )
            )
          )
        )
        AND (COALESCE(local_yard_order_status, 'Open') <> 'Loaded' OR ${underpackCount} > 0)
        AND NOT EXISTS (
          SELECT 1
            FROM local_co_orders source_co
           WHERE source_co.source_order_ref = delivery_order_source.tranid
             AND source_co.status IN ('pending_load', 'preparing', 'packed', 'planned')
             AND (
               source_co.from_location_id IS NULL
               OR delivery_order_source.outbound_location_id IS NULL
               OR source_co.from_location_id = delivery_order_source.outbound_location_id
             )
        )
        AND netsuite_active = true
        AND (
          (order_type = 'sales_order' AND (status = 'B' OR status_text ILIKE '%Pending Fulfillment%' OR status_text ILIKE '%Partially Fulfilled%' OR fulfillment_status = 'partial_fulfilled'))
          OR (order_type = 'transfer_order' AND (status_text ILIKE '%Pending Fulfillment%' OR status_text ILIKE '%Partially Fulfilled%' OR fulfillment_status = 'partial_fulfilled'))
        )
        AND fulfillment_status <> 'fulfilled'
        AND (${hasRemainingQty} OR ${hasPackedQty} OR ${hasProgressQty} OR ${hasDirectDependency})
     ORDER BY dispatch_planned DESC, warning_count DESC, underpack_count DESC, trandate DESC, tranid DESC`
    ,
    params
  );
  const groupRows = await listDispatchGroupDeliveryOrders({ locationId, status, orderType, planDate, truckPlate });
  const localCoRows = orderType === "sales_order"
    ? await listLocalCoDeliveryOrders({ locationId, status, planDate, truckPlate })
    : [];
  const markFixture = (order) => ({
    ...order,
    testFixture: sandboxFixtures && (/^TSTDEP-SO-/i.test(String(order.tranid || "")) || order.is_test_fixture === true)
  });
  if (!groupRows.length) return [...localCoRows, ...result.rows].map(markFixture);
  const groupedChildRefs = new Set(groupRows.flatMap((order) => order.child_order_refs || []));
  return [
    ...localCoRows,
    ...groupRows,
    ...result.rows.filter((row) => !groupedChildRefs.has(String(row.tranid || "")))
  ].map(markFixture);
}

export async function listDeliveryLoadTrucks({ locationId = null, planDate = null } = {}) {
  const date = dateOnly(planDate);
  if (!date) return [];
  const params = [date];
  const sandboxSql = isNetSuiteSandboxEnvironment() ? "true" : "false";
  const locationClause = locationId ? `AND outbound_location_id = $${params.push(Number(locationId))}` : "";
  const result = await query(
    `WITH planned_delivery_orders AS (
       SELECT dispatch_truck_plate, dispatch_load_name, outbound_location_id, operator_status,
              local_yard_order_status, 'sales_order'::text AS order_type
         FROM sales_orders
         WHERE dispatch_plan_date = $1
           AND COALESCE(dispatch_truck_plate, '') <> ''
           AND sales_order_type <> '${CUSTOMER_PICKUP_DELIVERY_METHOD.replaceAll("'", "''")}'
            AND (COALESCE(is_test_fixture, false) = false OR ${sandboxSql})
           AND (netsuite_active = true OR (${sandboxSql} AND COALESCE(is_test_fixture, false)))
       UNION ALL
       SELECT dispatch_truck_plate, dispatch_load_name, from_location_id AS outbound_location_id,
              outbound_operator_status AS operator_status, local_yard_order_status,
              'transfer_order'::text AS order_type
         FROM transfer_orders
        WHERE dispatch_plan_date = $1
          AND COALESCE(dispatch_truck_plate, '') <> ''
          AND from_location_id IS NOT NULL
          AND netsuite_active = true
     )
     SELECT dispatch_truck_plate AS truck_plate,
            COUNT(DISTINCT dispatch_load_name) AS load_count,
            COUNT(*) AS order_count,
            MIN(dispatch_load_name) AS first_load_name
       FROM planned_delivery_orders
      WHERE COALESCE(local_yard_order_status, 'Open') <> 'Loaded'
        ${locationClause}
      GROUP BY dispatch_truck_plate
      ORDER BY dispatch_truck_plate`,
    params
  );
  return result.rows;
}

export async function listDeliveryLoadOrders({ locationId = null, status = "active", planDate = null, truckPlate = null } = {}) {
  if (!dateOnly(planDate)) return [];
  const [salesOrders, transferOrders] = await Promise.all([
    listDeliveryOrders({ locationId, status, orderType: "sales_order", planDate, truckPlate }),
    listDeliveryOrders({ locationId, status, orderType: "transfer_order", planDate, truckPlate })
  ]);
  return [...salesOrders, ...transferOrders].sort((a, b) =>
    String(a.dispatch_load_name || "").localeCompare(String(b.dispatch_load_name || ""), undefined, { numeric: true, sensitivity: "base" })
    || String(a.tranid || "").localeCompare(String(b.tranid || ""), undefined, { numeric: true, sensitivity: "base" })
  );
}

export async function saveDeliveryOrderForOperator(operatorId, { locationId, orderId } = {}) {
  if (!operatorId) throw new Error("Operator login is required.");
  if (!locationId) throw new Error("Location is required.");
  if (!orderId) throw new Error("Order is required.");
  const order = await getDeliveryOrder(orderId);
  if (!order) throw new Error("Delivery order not found.");
  await query(
    `INSERT INTO operator_saved_delivery_orders (operator_id, location_id, order_key, order_ref, order_type)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (operator_id, location_id, order_key)
     DO UPDATE SET order_ref = EXCLUDED.order_ref,
                   order_type = EXCLUDED.order_type,
                   created_at = now()`,
    [operatorId, locationId, String(order.netsuite_id), String(order.tranid || order.netsuite_id), savedOrderType(order)]
  );
  await writeAudit({
    actorOperatorId: operatorId,
    action: "delivery.saved_order.saved",
    orderId: /^\d+$/.test(String(order.netsuite_id || "")) ? order.netsuite_id : null,
    details: { locationId, orderId: order.netsuite_id, tranid: order.tranid, orderType: savedOrderType(order) }
  });
  return { saved: true, order };
}

export async function removeSavedDeliveryOrderForOperator(operatorId, { locationId, orderId } = {}) {
  if (!operatorId) throw new Error("Operator login is required.");
  if (!locationId) throw new Error("Location is required.");
  if (!orderId) throw new Error("Order is required.");
  const result = await query(
    `DELETE FROM operator_saved_delivery_orders
      WHERE operator_id = $1
        AND location_id = $2
        AND order_key = $3
      RETURNING order_key, order_ref`,
    [operatorId, locationId, String(orderId)]
  );
  await writeAudit({
    actorOperatorId: operatorId,
    action: "delivery.saved_order.removed",
    orderId: /^\d+$/.test(String(orderId || "")) ? orderId : null,
    details: { locationId, removed: result.rowCount }
  });
  return { removed: result.rowCount };
}

export async function listSavedDeliveryOrdersForOperator(operatorId, { locationId } = {}) {
  if (!operatorId || !locationId) return [];
  const saved = await query(
    `SELECT order_key, order_ref, order_type, created_at
       FROM operator_saved_delivery_orders
      WHERE operator_id = $1
        AND location_id = $2
      ORDER BY created_at DESC, order_ref`,
    [operatorId, locationId]
  );
  const orders = await getDeliveryOrdersBatch(saved.rows.map((item) => item.order_key));
  const orderByKey = new Map(orders.map((order) => [String(order.netsuite_id), order]));
  const rows = [];
  for (const item of saved.rows) {
    const order = orderByKey.get(String(item.order_key));
    if (!order) continue;
    if (isFullyLoadedDeliveryOrder(order)) continue;
    rows.push({
      ...order,
      saved_order: true,
      saved_at: item.created_at,
      saved_order_type: item.order_type
    });
  }
  return rows;
}

export async function listSavedDeliveryOrderKeysForOperator(operatorId, { locationId } = {}) {
  if (!operatorId || !locationId) return [];
  const result = await query(
    `SELECT order_key
       FROM operator_saved_delivery_orders
      WHERE operator_id = $1
        AND location_id = $2
      ORDER BY created_at DESC`,
    [operatorId, locationId]
  );
  return result.rows.map((row) => String(row.order_key));
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

function buildDeliveryPrepNotifications({ locationId = null, salesActive = [], transferActive = [] } = {}) {
  if (!locationId) return { locationId: null, total: 0, salesOrder: { dueToday: 0 }, transferOrder: { dueToday: 0 }, items: [] };
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
  if (isVrmaDeliveryRef(id)) return getVrmaDeliveryPrepOrder(id);
  if (isLocalCoRef(id)) return getLocalCoDeliveryOrder(id);
  if (isDispatchGroupOrderId(id)) return getDispatchGroupDeliveryOrder(id);
  const sandboxFixtures = isNetSuiteSandboxEnvironment();
  const sandboxSql = sandboxFixtures ? "true" : "false";
  const order = await query(
    `WITH delivery_order_source AS (
       SELECT netsuite_id, tranid, trandate, customer_id, customer, status, status_text,
              foreign_total, order_location_id, order_location, outbound_location_id,
              outbound_location, delivery_method_id, sales_order_type AS delivery_method,
              operator_status, local_yard_order_status, preparing_operator_id,
               preparing_started_at, status_updated_at,
               CASE WHEN ${sandboxSql} AND COALESCE(is_test_fixture, false) THEN true ELSE netsuite_active END AS netsuite_active,
               is_test_fixture, synced_at,
              fulfillment_status, dispatch_planned, dispatch_plan_date, dispatch_planned_at, dispatch_truck_plate,
              dispatch_load_name, dispatch_parking_spot, expected_delivery_date,
              dispatch_address, dispatch_window_start, dispatch_window_end,
              dispatch_instructions, memo, 'sales_order'::text AS order_type,
              NULL::bigint AS source_location_id, NULL::text AS source_location,
              NULL::bigint AS destination_location_id, NULL::text AS destination_location
       FROM sales_orders
       WHERE COALESCE(is_test_fixture, false) = false OR ${sandboxSql}
       UNION ALL
       SELECT netsuite_id, tranid, trandate, NULL::bigint AS customer_id, NULL::text AS customer,
              status, status_text, NULL::numeric AS foreign_total, NULL::bigint AS order_location_id,
              NULL::text AS order_location, from_location_id AS outbound_location_id,
              from_location AS outbound_location, NULL::bigint AS delivery_method_id,
              NULL::text AS delivery_method, outbound_operator_status AS operator_status,
              local_yard_order_status, preparing_operator_id, preparing_started_at,
               status_updated_at, netsuite_active, false AS is_test_fixture, synced_at, fulfillment_status,
              dispatch_planned, dispatch_plan_date, dispatch_planned_at, dispatch_truck_plate,
              dispatch_load_name, dispatch_parking_spot, expected_delivery_date,
              dispatch_address, dispatch_window_start, dispatch_window_end,
              dispatch_instructions, memo, 'transfer_order'::text AS order_type,
              from_location_id AS source_location_id, from_location AS source_location,
              to_location_id AS destination_location_id, to_location AS destination_location
       FROM transfer_orders
       WHERE from_location_id IS NOT NULL
     ),
     delivery_line_source AS (
       SELECT sales_order_id AS order_id, id, line_id, item_id, item_name, sku,
              item_description, item_type, item_type_text, quantity, unit,
              item_weight, location_id, location, pallet_qty, layer_qty, section_qty, piece_qty,
              packed_pallet_qty, packed_layer_qty, packed_section_qty, packed_piece_qty, packed_sales_qty, pack_quantity_source,
              fulfilled_pallet_qty, fulfilled_layer_qty, fulfilled_piece_qty, fulfilled_section_qty,
              to_plt, to_lyr, to_sec, to_pcs, loaded_qty, loaded_uom,
               CASE WHEN ${sandboxSql} AND COALESCE(o.is_test_fixture, false) THEN true ELSE l.netsuite_active END AS netsuite_active,
               sync_exception, l.synced_at
        FROM sales_order_lines l
        JOIN sales_orders o ON o.netsuite_id = l.sales_order_id
       UNION ALL
       SELECT transfer_order_id AS order_id, id, line_id, item_id, item_name, sku,
              item_description, item_type, item_type_text, quantity, unit,
              item_weight, location_id, location, pallet_qty, layer_qty, section_qty, piece_qty,
              packed_pallet_qty, packed_layer_qty, packed_section_qty, packed_piece_qty, packed_sales_qty, pack_quantity_source,
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
                  OR COALESCE(warning_line.packed_sales_qty, 0) > 0
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
                      OR COALESCE(progress_line.packed_sales_qty, 0) > 0
                    )
                )
                AND ${lineOpenSalesSql("underpack_line")} > 0
            ) AS underpack_count
     FROM delivery_order_source
     WHERE netsuite_id = $1`,
    [id]
  );
  if (!order.rowCount) return Number(id) < 0 ? getLocalCoDeliveryOrder(id) : null;

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
              packed_pallet_qty, packed_layer_qty, packed_section_qty, packed_piece_qty, packed_sales_qty, pack_quantity_source,
              fulfilled_pallet_qty, fulfilled_layer_qty, fulfilled_piece_qty, fulfilled_section_qty,
              to_plt, to_lyr, to_sec, to_pcs, loaded_qty, loaded_uom,
               CASE WHEN ${sandboxSql} AND COALESCE(o.is_test_fixture, false) THEN true ELSE l.netsuite_active END AS netsuite_active,
               sync_exception, l.synced_at
        FROM sales_order_lines l
        JOIN sales_orders o ON o.netsuite_id = l.sales_order_id
       UNION ALL
       SELECT transfer_order_id AS order_id, id, line_id, item_id, item_name, sku,
              item_description, item_type, item_type_text, quantity, unit,
              item_weight, location_id, location, pallet_qty, layer_qty, section_qty, piece_qty,
              packed_pallet_qty, packed_layer_qty, packed_section_qty, packed_piece_qty, packed_sales_qty, pack_quantity_source,
              fulfilled_pallet_qty, fulfilled_layer_qty, fulfilled_piece_qty, fulfilled_section_qty,
              to_plt, to_lyr, to_sec, to_pcs, loaded_qty, loaded_uom,
              netsuite_active, sync_exception, synced_at
       FROM transfer_order_lines
       WHERE line_stage = 'outbound'
     )
     SELECT delivery_line_source.*,
            ${activePoAllocationSql("pallet", "delivery_line_source")} AS po_allocated_pallet_qty,
            ${activePoAllocationSql("layer", "delivery_line_source")} AS po_allocated_layer_qty,
            ${activePoAllocationSql("section", "delivery_line_source")} AS po_allocated_section_qty,
            ${activePoAllocationSql("piece", "delivery_line_source")} AS po_allocated_piece_qty,
            ${activePoAllocationSql("sales", "delivery_line_source")} AS po_allocated_sales_qty
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

  return {
    ...order.rows[0],
    testFixture: sandboxFixtures && order.rows[0].is_test_fixture === true,
    lines: lines.rows
      .map(applyDeliveryAllocationFields)
      .filter(hasDeliveryDisplayQuantity)
  };
}

export async function getDeliveryPrepNotifications({ locationId = null } = {}) {
  if (!locationId) return buildDeliveryPrepNotifications({ locationId });
  const [salesActive, transferActive] = await Promise.all([
    listDeliveryOrders({ locationId, status: "active", orderType: "sales_order" }),
    listDeliveryOrders({ locationId, status: "active", orderType: "transfer_order" })
  ]);
  return buildDeliveryPrepNotifications({ locationId, salesActive, transferActive });
}

export async function getDeliveryBootstrap({ operatorId = null, locationId = null } = {}) {
  const [salesOrder, transferOrder, vrmaOrder, savedOrderKeys, activeDraft] = await Promise.all([
    listDeliveryOrders({ locationId, status: "active", orderType: "sales_order" }),
    listDeliveryOrders({ locationId, status: "active", orderType: "transfer_order" }),
    listVrmaDeliveryPrepOrders({ locationId }),
    listSavedDeliveryOrderKeysForOperator(operatorId, { locationId }),
    getCurrentOperatorDeliveryDraft(operatorId, { locationId })
  ]);
  return {
    orders: { salesOrder, transferOrder, vrmaOrder },
    savedOrderKeys,
    activeDraft,
    notifications: buildDeliveryPrepNotifications({ locationId, salesActive: salesOrder, transferActive: transferOrder })
  };
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
         AND COALESCE(is_test_fixture, false) = false
      LIMIT 1`,
    [...params, CUSTOMER_PICKUP_DELIVERY_METHOD]
  );
  return result.rows[0]?.netsuite_id || null;
}

async function materializeSalesSplitOrder(order, parent) {
  const splitId = syntheticOrderId(`sales:${order.id}`);
  const splitItems = Array.isArray(order.items) ? order.items.filter(Boolean) : [];
  await query(
    `INSERT INTO sales_orders (
       netsuite_id, tranid, trandate, customer_id, customer, status, status_text,
       foreign_total, order_location_id, order_location, outbound_location_id,
       outbound_location, delivery_method_id, sales_order_type, memo,
       expected_delivery_date, dispatch_address, dispatch_window_start,
       dispatch_window_end, dispatch_instructions, operator_status,
       local_yard_order_status, netsuite_active, synced_at, dispatch_parse_source,
       dispatch_note_hash, dispatch_parsed_at, fulfillment_status
     )
     SELECT $1, $2, trandate, customer_id, customer, status, status_text,
            foreign_total, order_location_id, order_location, outbound_location_id,
            outbound_location, delivery_method_id, sales_order_type, $3,
            COALESCE($4::date, expected_delivery_date), dispatch_address, dispatch_window_start,
            dispatch_window_end, dispatch_instructions, 'open',
            'Open', true, now(), 'dispatch-split',
            dispatch_note_hash, now(), 'not_fulfilled'
       FROM sales_orders
      WHERE netsuite_id = $5
     ON CONFLICT (netsuite_id) DO UPDATE
       SET tranid = EXCLUDED.tranid,
           memo = EXCLUDED.memo,
           expected_delivery_date = EXCLUDED.expected_delivery_date,
           dispatch_address = EXCLUDED.dispatch_address,
           dispatch_window_start = EXCLUDED.dispatch_window_start,
           dispatch_window_end = EXCLUDED.dispatch_window_end,
           dispatch_instructions = EXCLUDED.dispatch_instructions,
           netsuite_active = true,
           synced_at = now()`,
    [splitId, order.id, order.notes || `Split from ${order.originalOrderId}`, dateOnly(order.expectedDeliveryDate || order.expected_delivery_date), parent.netsuite_id]
  );
  if (!splitItems.length) return splitId;
  await query("DELETE FROM sales_order_lines WHERE sales_order_id = $1 AND COALESCE(loaded_qty, 0) = 0 AND COALESCE(packed_pallet_qty, 0) = 0 AND COALESCE(packed_layer_qty, 0) = 0 AND COALESCE(packed_section_qty, 0) = 0 AND COALESCE(packed_piece_qty, 0) = 0", [splitId]);
  for (const item of splitItems) {
    const rawLineId = item.lineId ?? item.line_id;
    const lineId = rawLineId == null || String(rawLineId).trim() === "" ? null : rawLineId;
    const fallbackIdentity = [item.lineRowId, item.id, item.itemId, item.item_id, item.sku]
      .find((value) => value != null && String(value).trim() !== "");
    const lineIdentity = lineId ?? fallbackIdentity ?? "line";
    const conflictTarget = lineId == null ? "(id)" : "(sales_order_id, line_id)";
    await query(
      `INSERT INTO sales_order_lines (
         sales_order_id, id, line_id, item_id, item_name, sku, item_description,
         item_type, item_type_text, quantity, unit, pallet_qty, layer_qty,
         section_qty, piece_qty, to_plt, to_lyr, to_sec, to_pcs,
         netsuite_active, synced_at, location_id, location, item_weight,
         fulfilled_pallet_qty, fulfilled_layer_qty, fulfilled_piece_qty, fulfilled_section_qty
       )
       SELECT $1, $2, $3, item_id, item_name, sku, item_description,
              item_type, item_type_text, $4, unit, $5, $6,
              $7, $8, to_plt, to_lyr, to_sec, to_pcs,
              true, now(), location_id, location, item_weight,
              0, 0, 0, 0
         FROM sales_order_lines
        WHERE sales_order_id = $10
          AND (
            id = $9
            OR ($13::text IS NOT NULL AND line_id::text = $13::text)
            OR ($11::text <> '' AND sku = $11::text)
            OR ($12::text <> '' AND item_id::text = $12::text)
          )
        ORDER BY CASE
          WHEN id = $9 THEN 0
          WHEN $13::text IS NOT NULL AND line_id::text = $13::text THEN 1
          WHEN $11::text <> '' AND sku = $11::text THEN 2
          WHEN $12::text <> '' AND item_id::text = $12::text THEN 3
          ELSE 4
        END
        LIMIT 1
       ON CONFLICT ${conflictTarget} DO UPDATE
         SET quantity = EXCLUDED.quantity,
             pallet_qty = EXCLUDED.pallet_qty,
             layer_qty = EXCLUDED.layer_qty,
             section_qty = EXCLUDED.section_qty,
             piece_qty = EXCLUDED.piece_qty,
             netsuite_active = true,
             synced_at = now()`,
      [
        splitId,
        syntheticOrderId(`sales-line:${order.id}:${lineIdentity}`),
        lineId,
        splitLineSalesQuantity(item),
        itemNumber(item.pallets),
        itemNumber(item.layers),
        itemNumber(item.sections),
        itemNumber(item.pieces),
        item.lineRowId || item.id,
        parent.netsuite_id,
        item.sku || item.itemName || "",
        item.itemId || item.item_id || "",
        lineId
      ]
    );
  }
  await remapDispatchLinksToMaterializedSplit(order, splitId);
  return splitId;
}

async function materializeTransferSplitOrder(order, parent) {
  const splitId = syntheticOrderId(`transfer:${order.id}`);
  const splitItems = Array.isArray(order.items) ? order.items.filter(Boolean) : [];
  await query(
    `INSERT INTO transfer_orders (
       netsuite_id, tranid, trandate, status, status_text, from_location_id,
       from_location, to_location_id, to_location, outbound_operator_status,
       receiving_status, netsuite_active, synced_at, memo, expected_delivery_date,
       dispatch_address, dispatch_window_start, dispatch_window_end,
       dispatch_instructions, dispatch_parse_source, dispatch_note_hash,
       dispatch_parsed_at, local_yard_order_status, fulfillment_status
     )
     SELECT $1, $2, trandate, status, status_text, from_location_id,
            from_location, to_location_id, to_location, 'open',
            receiving_status, true, now(), $3, COALESCE($4::date, expected_delivery_date),
            dispatch_address, dispatch_window_start, dispatch_window_end,
            dispatch_instructions, 'dispatch-split', dispatch_note_hash,
            now(), 'Open', 'not_fulfilled'
       FROM transfer_orders
      WHERE netsuite_id = $5
     ON CONFLICT (netsuite_id) DO UPDATE
       SET tranid = EXCLUDED.tranid,
           memo = EXCLUDED.memo,
           expected_delivery_date = EXCLUDED.expected_delivery_date,
           dispatch_address = EXCLUDED.dispatch_address,
           dispatch_window_start = EXCLUDED.dispatch_window_start,
           dispatch_window_end = EXCLUDED.dispatch_window_end,
           dispatch_instructions = EXCLUDED.dispatch_instructions,
           netsuite_active = true,
           synced_at = now()`,
    [splitId, order.id, order.notes || `Split from ${order.originalOrderId}`, dateOnly(order.expectedDeliveryDate || order.expected_delivery_date), parent.netsuite_id]
  );
  if (!splitItems.length) return splitId;
  await query("DELETE FROM transfer_order_lines WHERE transfer_order_id = $1 AND COALESCE(loaded_qty, 0) = 0 AND COALESCE(packed_pallet_qty, 0) = 0 AND COALESCE(packed_layer_qty, 0) = 0 AND COALESCE(packed_section_qty, 0) = 0 AND COALESCE(packed_piece_qty, 0) = 0", [splitId]);
  for (const item of splitItems) {
    await query(
      `INSERT INTO transfer_order_lines (
         line_stage, transfer_order_id, id, line_id, item_id, item_name, sku,
         item_description, quantity, unit, pallet_qty, layer_qty, section_qty,
         piece_qty, loaded_qty, loaded_uom, netsuite_active, synced_at,
         item_type, item_type_text, location_id, location, to_plt, to_lyr,
         to_sec, to_pcs, item_weight, confirmed, fulfilled_pallet_qty,
         fulfilled_layer_qty, fulfilled_piece_qty, fulfilled_section_qty
       )
       SELECT 'outbound', $1, $2, $3, item_id, item_name, sku,
              item_description, $4, unit, $5, $6, $7,
              $8, 0, unit, true, now(),
              item_type, item_type_text, location_id, location, to_plt, to_lyr,
              to_sec, to_pcs, item_weight, false, 0,
              0, 0, 0
         FROM transfer_order_lines
        WHERE transfer_order_id = $10
          AND line_stage = 'outbound'
          AND (
            id = $9
            OR ($13::text IS NOT NULL AND line_id::text = $13::text)
            OR ($11::text <> '' AND sku = $11::text)
            OR ($12::text <> '' AND item_id::text = $12::text)
          )
        ORDER BY CASE
          WHEN id = $9 THEN 0
          WHEN $13::text IS NOT NULL AND line_id::text = $13::text THEN 1
          WHEN $11::text <> '' AND sku = $11::text THEN 2
          WHEN $12::text <> '' AND item_id::text = $12::text THEN 3
          ELSE 4
        END
        LIMIT 1
       ON CONFLICT (transfer_order_id, line_stage, line_id) WHERE line_id IS NOT NULL DO UPDATE
         SET quantity = EXCLUDED.quantity,
             pallet_qty = EXCLUDED.pallet_qty,
             layer_qty = EXCLUDED.layer_qty,
             section_qty = EXCLUDED.section_qty,
             piece_qty = EXCLUDED.piece_qty,
             netsuite_active = true,
             synced_at = now()`,
      [
        splitId,
        syntheticOrderId(`transfer-line:${order.id}:${item.lineRowId || item.lineId || item.sku}`),
        item.lineId || item.line_id || null,
        splitLineSalesQuantity(item),
        itemNumber(item.pallets),
        itemNumber(item.layers),
        itemNumber(item.sections),
        itemNumber(item.pieces),
        item.lineRowId || item.id,
        parent.netsuite_id,
        item.sku || item.itemName || "",
        item.itemId || item.item_id || "",
        item.lineId || item.line_id || null
      ]
    );
  }
  return splitId;
}

async function materializeDispatchSplitOrders(plan) {
  const splits = (plan.orders || [])
    .filter((order) => isSplitOrder(order) && ["SO", "TO"].includes(order.type))
    .map((order) => ({ ...order, originalOrderId: splitParentOrderId(order) }));
  const activeSplitRefs = splits.map((order) => String(order.id || ""));
  await query(
    `UPDATE sales_orders
        SET netsuite_active = false,
            dispatch_planned = false
      WHERE tranid LIKE '%-S%'
        AND dispatch_plan_date = $1::date
        AND NOT (tranid = ANY($2::text[]))`,
    [plan.planDate, activeSplitRefs]
  );
  await query(
    `UPDATE transfer_orders
        SET netsuite_active = false,
            dispatch_planned = false
      WHERE tranid LIKE '%-S%'
        AND dispatch_plan_date = $1::date
        AND NOT (tranid = ANY($2::text[]))`,
    [plan.planDate, activeSplitRefs]
  );

  for (const split of splits) {
    if (split.type === "SO") {
      const parent = await query("SELECT netsuite_id FROM sales_orders WHERE tranid = $1 LIMIT 1", [split.originalOrderId]);
      if (parent.rows[0]) await materializeSalesSplitOrder(split, parent.rows[0]);
    } else {
      const parent = await query("SELECT netsuite_id FROM transfer_orders WHERE tranid = $1 LIMIT 1", [split.originalOrderId]);
      if (parent.rows[0]) await materializeTransferSplitOrder(split, parent.rows[0]);
    }
  }

  return { splits: splits.length, splitRefs: activeSplitRefs };
}

export async function applyConfirmedDispatchPlanToDelivery(plan, { forceOrderRefs = [] } = {}) {
  if (!plan?.planDate || !Array.isArray(plan.trucks)) return { planned: 0 };
  const materializedSplits = await materializeDispatchSplitOrders(plan);
  const splitParentRefs = new Set((plan.orders || []).filter(isSplitOrder).map(splitParentOrderId));
  const forceRefs = new Set((forceOrderRefs || []).map((ref) => String(ref || "").trim()).filter(Boolean));
  const plannedRows = [];
  for (const truck of plan.trucks || []) {
    for (const load of truck.loads || []) {
      if (load.returnOnly) continue;
      const assignment = dispatchLoadAssignment(truck, load);
      for (const stop of load.stops || []) {
        if (stop.type !== "drop" || !stop.orderId) continue;
        const order = (plan.orders || []).find((item) => item.id === stop.orderId);
        if (!["SO", "TO"].includes(order?.type)) continue;
        if (!isSplitOrder(order) && splitParentRefs.has(String(order.id || ""))) continue;
        plannedRows.push({
          tranid: order.id,
          orderType: order.type,
          truckPlate: assignment.truckPlate,
          loadName: load.name || "",
          parkingSpot: assignment.parkingSpot,
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
  return { planned: plannedRows.length, ...materializedSplits };
}

export async function deactivateUnplannedDispatchSplitOrders({ originalOrderId = "", orderType = "", splitOrderIds = [] } = {}) {
  const originalRef = String(originalOrderId || "").trim();
  const requestedRefs = (Array.isArray(splitOrderIds) ? splitOrderIds : [])
    .map((ref) => String(ref || "").trim())
    .filter((ref) => ref && ref !== originalRef);
  if (!originalRef) throw new Error("Original order is required for unsplit.");

  const type = String(orderType || "").trim().toUpperCase();
  const isSales = type === "SO";
  const tableName = isSales ? "sales_orders" : "transfer_orders";
  const lineTableName = isSales ? "sales_order_lines" : "transfer_order_lines";
  const lineOrderIdColumn = isSales ? "sales_order_id" : "transfer_order_id";
  const splitPattern = `${originalRef}-S%`;

  const existing = await query(
    `SELECT netsuite_id, tranid, dispatch_planned, dispatch_plan_date, dispatch_truck_plate, dispatch_load_name, local_yard_order_status
       FROM ${tableName}
      WHERE tranid LIKE $1
        AND ($2::text[] IS NULL OR tranid = ANY($2::text[]))
      ORDER BY tranid`,
    [splitPattern, requestedRefs.length ? requestedRefs : null]
  );
  const refs = existing.rows.map((row) => String(row.tranid || ""));
  if (!refs.length) return { deactivated: [], deletedLines: 0 };

  const lineActivity = await query(
    `SELECT o.tranid,
            SUM(
              COALESCE(l.loaded_qty, 0)
              + COALESCE(l.packed_pallet_qty, 0)
              + COALESCE(l.packed_layer_qty, 0)
              + COALESCE(l.packed_section_qty, 0)
              + COALESCE(l.packed_piece_qty, 0)
            ) AS activity_qty
       FROM ${tableName} o
       LEFT JOIN ${lineTableName} l ON l.${lineOrderIdColumn} = o.netsuite_id
      WHERE o.tranid = ANY($1::text[])
      GROUP BY o.tranid`,
    [refs]
  );
  const activityByRef = new Map(lineActivity.rows.map((row) => [String(row.tranid || ""), Number(row.activity_qty || 0)]));
  const blocked = existing.rows.filter((row) =>
    row.dispatch_planned === true
    || row.dispatch_plan_date
    || row.dispatch_truck_plate
    || row.dispatch_load_name
    || activityByRef.get(String(row.tranid || "")) > 0
  );
  if (blocked.length) {
    throw new Error(`Unsplit blocked. Unplan or clear these split orders first: ${blocked.map((row) => row.tranid).join(", ")}.`);
  }

  const deleted = await query(
    `DELETE FROM ${lineTableName}
      WHERE ${lineOrderIdColumn} IN (
        SELECT netsuite_id FROM ${tableName} WHERE tranid = ANY($1::text[])
      )`,
    [refs]
  );
  await query(
    `UPDATE ${tableName}
        SET netsuite_active = false,
            dispatch_planned = false,
            dispatch_plan_date = null,
            dispatch_truck_plate = null,
            dispatch_load_name = null,
            dispatch_parking_spot = null,
            dispatch_planned_at = null,
            status_updated_at = now(),
            synced_at = now()
      WHERE tranid = ANY($1::text[])`,
    [refs]
  );
  await query(
    `UPDATE dispatch_plan_snapshots
        SET orders = (
              SELECT COALESCE(jsonb_agg(order_item), '[]'::jsonb)
                FROM jsonb_array_elements(orders) AS order_item
               WHERE NOT (order_item->>'id' = ANY($1::text[]))
            ),
            saved_at = now()
      WHERE orders::text LIKE $2`,
    [refs, `%${originalRef}%`]
  );

  return {
    deactivated: refs,
    deletedLines: deleted.rowCount || 0
  };
}

export async function getNextDispatchSplitSuffix({ originalOrderId = "", orderType = "" } = {}) {
  const originalRef = String(originalOrderId || "").trim();
  if (!originalRef) throw new Error("Original order is required for split numbering.");
  const type = String(orderType || "").trim().toUpperCase();
  const tableName = type === "SO" ? "sales_orders" : "transfer_orders";
  const result = await query(
    `SELECT COALESCE(MAX(NULLIF(substring(tranid FROM '-S([0-9]+)$'), '')::integer), 0) AS max_suffix
       FROM ${tableName}
      WHERE tranid LIKE $1`,
    [`${originalRef}-S%`]
  );
  const maxSuffix = Number(result.rows[0]?.max_suffix || 0);
  return {
    originalOrderId: originalRef,
    nextSuffix: maxSuffix + 1
  };
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
    return roundQuantity(linePackedSalesQuantity(line));
  }
  const convertedQuantity = (Math.max(positiveQuantity(line.packed_pallet_qty) - positiveQuantity(line.fulfilled_pallet_qty), 0) * positiveQuantity(line.to_plt))
    + (Math.max(positiveQuantity(line.packed_layer_qty) - positiveQuantity(line.fulfilled_layer_qty), 0) * positiveQuantity(line.to_lyr))
    + (Math.max(positiveQuantity(line.packed_section_qty) - positiveQuantity(line.fulfilled_section_qty), 0) * positiveQuantity(line.to_sec))
    + (Math.max(positiveQuantity(line.packed_piece_qty) - positiveQuantity(line.fulfilled_piece_qty), 0) * positiveQuantity(line.to_pcs));
  if (convertedQuantity > 0) return roundQuantity(convertedQuantity);
  return roundQuantity(salesQuantity);
}

export async function recordDeliveryFulfillment(orderId, operatorId, { photoDataUrls, payload, response, itemFulfillmentId, itemFulfillmentTranid }) {
  const photos = requirePhotoReferences(photoDataUrls);
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
       fulfillment_status, photo_data_url, photo_data_urls, payload, response
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)`,
    [
      orderId,
      operatorId || null,
      itemFulfillmentId || null,
      itemFulfillmentTranid || null,
      fulfillmentStatus,
      photos[0],
      JSON.stringify(photos),
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

async function recordLocalCoDeliveryLoad(order, operatorId, { photoDataUrls }) {
  if (!order || order.order_type !== "co_order") throw new Error("Local CO order not found.");
  if (String(order.status || "") !== "packed") {
    throw new Error("Local CO must be packed before loading.");
  }
  const validation = buildDeliveryLoadValidation(order);
  if (!validation.ok) {
    const error = new Error("Packed quantity must be corrected before loading.");
    error.code = "DELIVERY_LOAD_VALIDATION_FAILED";
    error.status = 409;
    error.validation = validation;
    throw error;
  }
  const loadRecord = await insertOperatorLoadRecord({
    loadType: "local_co_load",
    order,
    operatorId,
    photoDataUrls,
    sourceTable: "local_co_orders",
    sourceRecordId: order.local_co_id || Math.abs(Number(order.netsuite_id)),
    lineSnapshot: operatorLoadLineSnapshot(order.lines || []),
    response: {
      localYardOrderStatus: "Loaded",
      coStatus: "planned",
      sourceOrderRef: order.source_order_ref,
      fromLocation: order.source_location,
      toLocation: order.destination_location,
      dispatchPlanDate: order.dispatch_plan_date,
      dispatchTruckPlate: order.dispatch_truck_plate,
      dispatchLoadName: order.dispatch_load_name,
      dispatchParkingSpot: order.dispatch_parking_spot
    }
  });
  await query(
    `UPDATE local_co_order_lines line
        SET pallet_qty = COALESCE(line.packed_pallet_qty, 0),
            layer_qty = COALESCE(line.packed_layer_qty, 0),
            piece_qty = COALESCE(line.packed_piece_qty, 0),
            section_qty = COALESCE(line.packed_section_qty, 0),
            quantity = CASE
              WHEN (
                COALESCE(line.to_plt, 0)
                + COALESCE(line.to_lyr, 0)
                + COALESCE(line.to_sec, 0)
                + COALESCE(line.to_pcs, 0)
              ) > 0 THEN
                (COALESCE(line.packed_pallet_qty, 0) * COALESCE(line.to_plt, 0))
                + (COALESCE(line.packed_layer_qty, 0) * COALESCE(line.to_lyr, 0))
                + (COALESCE(line.packed_section_qty, 0) * COALESCE(line.to_sec, 0))
                + (COALESCE(line.packed_piece_qty, 0) * COALESCE(line.to_pcs, 0))
              ELSE
                COALESCE(line.packed_sales_qty, 0)
            END
      FROM local_co_orders co
      WHERE line.co_id = co.id
        AND (co.delivery_order_id = $1 OR co.co_ref = $2)`,
    [order.netsuite_id, order.tranid]
  );
  await query(
    `DELETE FROM local_co_order_lines line
      USING local_co_orders co
      WHERE line.co_id = co.id
        AND (co.delivery_order_id = $1 OR co.co_ref = $2)
        AND COALESCE(line.pallet_qty, 0) = 0
        AND COALESCE(line.layer_qty, 0) = 0
        AND COALESCE(line.section_qty, 0) = 0
        AND COALESCE(line.piece_qty, 0) = 0
        AND COALESCE(line.quantity, 0) = 0`,
    [order.netsuite_id, order.tranid]
  );
  const activatedCo = await query(
    `UPDATE local_co_orders
        SET status = 'planned',
            loaded_at = COALESCE(loaded_at, now()),
            details = details || $2::jsonb,
            updated_at = now()
      WHERE delivery_order_id = $1
         OR co_ref = $3
      RETURNING co_ref, from_location, to_location`,
    [
      order.netsuite_id,
      JSON.stringify({
        sourceLoaded: true,
        sourceLoadedAt: new Date().toISOString(),
        sourceDeliveryOrderId: order.netsuite_id
      }),
      order.tranid
    ]
  );
  await writeAudit({
    actorOperatorId: operatorId,
    action: "delivery.local_co.load",
    orderId: order.netsuite_id,
    details: {
      coRef: order.tranid,
      sourceOrderRef: order.source_order_ref,
      fromLocation: order.source_location,
      toLocation: order.destination_location,
      activatedCo: activatedCo.rows
    }
  });
  return {
    id: loadRecord?.id || null,
    localYardOrderStatus: "Loaded",
    dispatchPlanDate: order.dispatch_plan_date,
    dispatchTruckPlate: order.dispatch_truck_plate,
    dispatchLoadName: order.dispatch_load_name,
    dispatchParkingSpot: order.dispatch_parking_spot,
    activatedCo: activatedCo.rows,
    remainingLines: 0
  };
}

async function recordVrmaDeliveryLoad(order, operatorId, { photoDataUrls }) {
  if (!["packed", "loaded"].includes(order.operator_status)) {
    throw new Error("VRMA order must be packed before loading.");
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
    const packedSalesQty = roundQuantity(linePackedSalesQuantity(line));
    if (packedSalesQty <= 0) continue;
    const loadSalesQty = lineLoadSalesQuantity(line);
    await query(
      `UPDATE scm_vrma_order_lines
          SET loaded_qty = LEAST(quantity, COALESCE(loaded_qty, 0) + $3),
              loaded_uom = COALESCE(NULLIF(unit, ''), loaded_uom),
              packed_pallet_qty = 0,
              packed_layer_qty = 0,
              packed_piece_qty = 0,
              packed_section_qty = 0,
              packed_sales_qty = 0,
              confirmed = false,
              confirmed_at = null
        WHERE vrma_order_id = $1
          AND id = $2`,
      [order.vrma_order_id, line.line_id, loadSalesQty]
    );
  }

  const loadedSnapshotOrder = await getDeliveryOrder(order.netsuite_id);
  const remainingLines = (loadedSnapshotOrder.lines || []).filter((line) => {
    if (!line.netsuite_active || !isDeliveryPickableLine(line)) return false;
    return lineRequiredSalesQuantity(line) > lineLoadedSalesQuantity(line) + linePackedSalesQuantity(line) + 0.000001;
  });
  const nextStatus = remainingLines.length ? "partial_loaded" : "loaded";
  const loadRecord = await insertOperatorLoadRecord({
    loadType: "vrma_local_load",
    order,
    operatorId,
    photoDataUrls,
    sourceTable: null,
    sourceRecordId: null,
    lineSnapshot: operatorLoadLineSnapshot(loadedSnapshotOrder.lines || order.lines || []),
    response: {
      localOnly: true,
      netSuiteUpdated: false,
      inventoryUpdated: false,
      localYardOrderStatus: nextStatus === "loaded" ? "Loaded" : "Partial Loaded",
      dispatchPlanDate: order.dispatch_plan_date,
      dispatchTruckPlate: order.dispatch_truck_plate,
      dispatchLoadName: order.dispatch_load_name,
      dispatchParkingSpot: order.dispatch_parking_spot,
      remainingLines: remainingLines.length
    }
  });
  await query(
    `UPDATE scm_vrma_orders
        SET operator_status = $2,
            local_yard_order_status = $3,
            preparing_operator_id = null,
            preparing_started_at = null,
            loaded_at = CASE WHEN $2 = 'loaded' THEN now() ELSE loaded_at END,
            status_updated_at = now(),
            updated_at = now()
      WHERE id = $1`,
    [
      order.vrma_order_id,
      nextStatus,
      nextStatus === "loaded" ? "Loaded" : "Partial Loaded"
    ]
  );
  await writeAudit({
    actorOperatorId: operatorId,
    action: "delivery.vrma.load",
    orderId: order.vrma_order_id,
    details: {
      vrmaRef: order.tranid,
      loadRecordId: loadRecord?.id || null,
      remainingLines: remainingLines.length,
      localOnly: true,
      netSuiteUpdated: false,
      inventoryUpdated: false
    }
  });
  return {
    id: loadRecord?.id || null,
    localOnly: true,
    netSuiteUpdated: false,
    inventoryUpdated: false,
    localYardOrderStatus: nextStatus === "loaded" ? "Loaded" : "Partial Loaded",
    dispatchPlanDate: order.dispatch_plan_date,
    dispatchTruckPlate: order.dispatch_truck_plate,
    dispatchLoadName: order.dispatch_load_name,
    dispatchParkingSpot: order.dispatch_parking_spot,
    activatedCo: [],
    remainingLines: remainingLines.length
  };
}

export async function recordDeliveryLoad(orderId, operatorId, { photoDataUrls }) {
  const photos = requirePhotoReferences(photoDataUrls);
  if (isDispatchGroupOrderId(orderId)) return recordGroupedDeliveryLoad(orderId, operatorId, { photoDataUrls: photos });
  const order = await getDeliveryOrder(orderId);
  if (!order) throw new Error("Delivery order not found.");
  if (order.order_type === "co_order") return recordLocalCoDeliveryLoad(order, operatorId, { photoDataUrls: photos });
  if (isVrmaDeliveryOrder(order)) return recordVrmaDeliveryLoad(order, operatorId, { photoDataUrls: photos });
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
    const packedSalesQty = roundQuantity(linePackedSalesQuantity(line));
    if (packedSalesQty <= 0) continue;
    const loadSalesQty = lineLoadSalesQuantity(line);
    const lineTarget = canonicalLineTarget(order);
    await query(
      `UPDATE ${lineTarget.table}
          SET loaded_qty = LEAST($3, COALESCE(loaded_qty, 0) + $4),
              loaded_uom = COALESCE(NULLIF(unit, ''), loaded_uom),
              packed_pallet_qty = 0,
              packed_layer_qty = 0,
              packed_piece_qty = 0,
              packed_section_qty = 0,
              packed_sales_qty = 0,
              confirmed = false,
              confirmed_at = null
        WHERE ${lineTarget.orderColumn} = $1
          AND id = $2
          ${lineTarget.extraWhere}`,
      [orderId, line.id, roundQuantity(lineRequiredSalesQuantity(line)), loadSalesQty]
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
    photoDataUrls: photos,
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

export async function recordCustomerPickupLoad(orderId, operatorId, { photoDataUrls }) {
  const photos = requirePhotoReferences(photoDataUrls);
  const order = await getDeliveryOrder(orderId);
  if (!order || !isPickupOrder(order)) throw new Error("Customer pickup sales order not found.");
  const confirmedLines = (order.lines || []).filter((line) => {
    return positiveQuantity(line.packed_pallet_qty)
      + positiveQuantity(line.packed_layer_qty)
      + positiveQuantity(line.packed_piece_qty)
      + positiveQuantity(line.packed_section_qty)
      + positiveQuantity(line.packed_sales_qty) > 0;
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
    salesQuantity: sum.salesQuantity + roundQuantity(lineLoadSalesQuantity(line))
  }), { pallets: 0, layers: 0, pieces: 0, sections: 0, salesQuantity: 0 });
  const loadedUoms = [...new Set(confirmedLines.map((line) => String(line.unit || "").trim()).filter(Boolean))];
  const loadedUom = loadedUoms.length === 1 ? loadedUoms[0] : loadedUoms.length > 1 ? "MIXED" : "";
  const aggregateLoadedQty = loadedUom === "MIXED" ? null : roundQuantity(totals.salesQuantity);

  for (const line of confirmedLines) {
    await query(
      `UPDATE sales_order_lines
          SET loaded_qty = LEAST($3, COALESCE(loaded_qty, 0) + $4),
              loaded_uom = COALESCE(NULLIF(unit, ''), loaded_uom),
              packed_pallet_qty = 0,
              packed_layer_qty = 0,
              packed_piece_qty = 0,
              packed_section_qty = 0,
              packed_sales_qty = 0,
              confirmed = false,
              confirmed_at = null
        WHERE sales_order_id = $1
          AND id = $2`,
      [
        orderId,
        line.id,
        roundQuantity(lineRequiredSalesQuantity(line)),
        roundQuantity(lineLoadSalesQuantity(line))
      ]
    );
  }

  await query(
    `UPDATE sales_order_lines
        SET packed_pallet_qty = 0,
            packed_layer_qty = 0,
            packed_piece_qty = 0,
            packed_section_qty = 0,
            packed_sales_qty = 0,
            confirmed = false,
            confirmed_at = null
      WHERE sales_order_id = $1
        AND (
          COALESCE(packed_pallet_qty, 0) > 0
          OR COALESCE(packed_layer_qty, 0) > 0
          OR COALESCE(packed_piece_qty, 0) > 0
          OR COALESCE(packed_section_qty, 0) > 0
          OR COALESCE(packed_sales_qty, 0) > 0
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
    photoDataUrls: photos,
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

export async function recordDeliveryFulfillmentFailure(orderId, operatorId, { photoDataUrls, payload, error, stage }) {
  const message = error?.message || String(error || "Unknown fulfillment error");
  const photos = photoReferences(photoDataUrls);
  try {
    await query(
      `INSERT INTO delivery_fulfillment_records (
         order_id, operator_id, fulfillment_status, photo_data_url, photo_data_urls, payload, response
       ) VALUES ($1, $2, 'failed', $3, $4::jsonb, $5, $6)`,
      [
        orderId,
        operatorId || null,
        photos[0] || "",
        JSON.stringify(photos),
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
            left(COALESCE(l.photo_data_urls->>0, l.photo_data_url), 80) AS photo_preview,
            CASE
              WHEN jsonb_array_length(COALESCE(l.photo_data_urls, '[]'::jsonb)) > 0
                THEN jsonb_array_length(l.photo_data_urls)
              WHEN COALESCE(l.photo_data_url, '') <> '' THEN 1
              ELSE 0
            END AS photo_count
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
            SUM(CASE
              WHEN jsonb_array_length(COALESCE(l.photo_data_urls, '[]'::jsonb)) > 0
                THEN jsonb_array_length(l.photo_data_urls)
              WHEN COALESCE(l.photo_data_url, '') <> '' THEN 1
              ELSE 0
            END)::int AS photo_count
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
    `SELECT l.id, l.created_at, photo.photo_data_url, l.response
       FROM operator_load_records l
       CROSS JOIN LATERAL jsonb_array_elements_text(
         CASE
           WHEN jsonb_array_length(COALESCE(l.photo_data_urls, '[]'::jsonb)) > 0 THEN l.photo_data_urls
           WHEN COALESCE(l.photo_data_url, '') <> '' THEN jsonb_build_array(l.photo_data_url)
           ELSE '[]'::jsonb
         END
       ) photo(photo_data_url)
      WHERE l.order_family = $1
        AND l.order_id = $2
        AND l.load_type IN ('sales_order_delivery_load', 'transfer_order_load')
        AND l.created_at >= $3::date
        AND l.created_at < ($4::date + interval '1 day')
      ORDER BY l.created_at DESC, l.id DESC`,
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

async function activeConsolidationClaimForOrder(orderId) {
  const result = await query(
    `SELECT b.id AS batch_id,
            b.operator_id,
            o.order_key,
            o.order_ref
       FROM operator_consolidation_claims claim
       JOIN operator_consolidation_orders o ON o.id = claim.batch_order_id
       JOIN operator_consolidation_batches b ON b.id = o.batch_id
      WHERE claim.canonical_order_id = $1
        AND claim.released_at IS NULL
        AND b.status = 'active'
      LIMIT 1`,
    [orderId]
  );
  return result.rows[0] || null;
}

async function assertOrderEditable(orderId, operatorId, { allowConsolidation = false } = {}) {
  const order = await getDeliveryOrder(orderId);
  if (!order) throw new Error("Delivery order not found.");
  const consolidation = isVrmaDeliveryOrder(order)
    ? null
    : await activeConsolidationClaimForOrder(order.netsuite_id);
  if (consolidation && (!allowConsolidation || String(consolidation.operator_id) !== String(operatorId))) {
    const error = new Error(`${consolidation.order_ref || order.tranid} is reserved in Consolidation Pick.`);
    error.status = 409;
    error.code = "ORDER_RESERVED_FOR_CONSOLIDATION";
    throw error;
  }
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
          || positiveQuantity(line.packed_sales_qty) > 0
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

function isVrmaDeliveryOrder(order) {
  return order?.order_type === "vrma_order";
}

async function setVrmaDeliveryStatus(order, status, { clearPreparing = false, localYardOrderStatus = undefined } = {}) {
  const setClauses = [
    "operator_status = $2",
    "status_updated_at = now()",
    "updated_at = now()"
  ];
  const params = [order.vrma_order_id, status];
  if (clearPreparing) {
    setClauses.push("preparing_operator_id = null", "preparing_started_at = null");
  }
  if (localYardOrderStatus !== undefined) {
    params.push(localYardOrderStatus);
    setClauses.push(`local_yard_order_status = $${params.length}`);
  }
  await query(
    `UPDATE scm_vrma_orders
        SET ${setClauses.join(", ")}
      WHERE id = $1`,
    params
  );
}

async function claimVrmaPreparingOrder(order, operatorId) {
  await assertOrderEditable(order.netsuite_id, operatorId);
  const existing = await getCurrentOperatorDeliveryDraft(operatorId, {
    locationId: order.outbound_location_id
  });
  if (existing && String(existing.netsuite_id) !== String(order.netsuite_id)) {
    throw new Error("Pack your current preparing order before moving on.");
  }
  await query(
    `UPDATE scm_vrma_orders
        SET operator_status = CASE WHEN operator_status IN ('open', 'partial_loaded') THEN 'preparing' ELSE operator_status END,
            preparing_operator_id = CASE WHEN operator_status <> 'packed' THEN $2 ELSE preparing_operator_id END,
            preparing_started_at = CASE WHEN operator_status <> 'packed' THEN COALESCE(preparing_started_at, now()) ELSE preparing_started_at END,
            status_updated_at = now(),
            updated_at = now()
      WHERE id = $1`,
    [order.vrma_order_id, operatorId]
  );
  return getDeliveryOrder(order.netsuite_id);
}

async function updateVrmaLinePackedQuantity(orderId, lineId, values, operatorId, { absolute = false } = {}) {
  const order = await assertOrderEditable(orderId, operatorId);
  if (!isVrmaDeliveryOrder(order)) throw new Error("Local VRMA order not found.");
  const line = (order.lines || []).find((item) => String(item.id) === String(lineId));
  if (!line) throw new Error("VRMA line not found.");

  const requested = {
    pallets: normalizeQuantity(values?.pallets) || 0,
    layers: normalizeQuantity(values?.layers) || 0,
    pieces: normalizeQuantity(values?.pieces) || 0,
    sections: normalizeQuantity(values?.sections) || 0,
    salesQty: normalizeQuantity(values?.salesQty) || 0
  };
  const fallbackUom = isSalesQuantityOnlyLine(line);
  let next;
  let packedSalesQty = 0;
  if (fallbackUom) {
    const availableSales = Math.max(0, lineRequiredSalesQuantity(line) - lineLoadedSalesQuantity(line));
    const requestedSales = requested.salesQty || requested.pieces || requested.sections || requested.layers || requested.pallets;
    packedSalesQty = Math.min(
      availableSales,
      absolute ? requestedSales : positiveQuantity(line.packed_sales_qty) + requestedSales
    );
    next = { pallets: 0, layers: 0, pieces: 0, sections: 0 };
  } else {
    const available = remainingPackAvailability(line);
    next = absolute
      ? {
        pallets: Math.min(available.pallets, requested.pallets),
        layers: Math.min(available.layers, requested.layers),
        pieces: Math.min(available.pieces, requested.pieces),
        sections: Math.min(available.sections, requested.sections)
      }
      : {
        pallets: Math.min(available.pallets, positiveQuantity(line.packed_pallet_qty) + requested.pallets),
        layers: Math.min(available.layers, positiveQuantity(line.packed_layer_qty) + requested.layers),
        pieces: Math.min(available.pieces, positiveQuantity(line.packed_piece_qty) + requested.pieces),
        sections: Math.min(available.sections, positiveQuantity(line.packed_section_qty) + requested.sections)
      };
    packedSalesQty = resolveIndependentPackedSalesQuantity(line, next, requested.salesQty, {
      absolute,
      physicalChanged: requested.pallets + requested.layers + requested.pieces + requested.sections > 0
    });
  }
  const storageLineId = line.line_id;
  await query(
    `UPDATE scm_vrma_order_lines
        SET packed_pallet_qty = $3,
            packed_layer_qty = $4,
            packed_piece_qty = $5,
            packed_section_qty = $6,
            packed_sales_qty = $7,
            confirmed = ($3::numeric + $4::numeric + $5::numeric + $6::numeric + $7::numeric) > 0,
            confirmed_at = CASE
              WHEN ($3::numeric + $4::numeric + $5::numeric + $6::numeric + $7::numeric) > 0
                THEN COALESCE(confirmed_at, now())
              ELSE null
            END
      WHERE vrma_order_id = $1
        AND id = $2`,
    [order.vrma_order_id, storageLineId, next.pallets, next.layers, next.pieces, next.sections, packedSalesQty]
  );
  await writeAudit({
    actorOperatorId: operatorId,
    action: absolute ? "delivery.vrma.line.update_packed_quantity" : "delivery.vrma.line.confirm",
    orderId: order.vrma_order_id,
    lineId: storageLineId,
    details: { vrmaRef: order.tranid, ...next, salesQty: packedSalesQty, localOnly: true }
  });
}

async function refreshVrmaDeliveryProgressStatus(orderId, { clearPreparing = false } = {}) {
  const order = await getDeliveryOrder(orderId);
  if (!order || !isVrmaDeliveryOrder(order)) throw new Error("Local VRMA order not found.");
  const pickableLines = (order.lines || []).filter((line) => line.netsuite_active && isDeliveryPickableLine(line));
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
  } else if (hasLoaded) {
    status = "loaded";
    localYardOrderStatus = "Loaded";
  }
  await setVrmaDeliveryStatus(order, status, { clearPreparing, localYardOrderStatus });
  return getDeliveryOrder(orderId);
}

function isLocalCoDeliveryOrder(order) {
  return order?.order_type === "co_order";
}

async function setLocalCoDeliveryStatus(order, status, { clearPreparing = false } = {}) {
  const coStatus = status === "packed" ? "packed"
    : status === "preparing" ? "preparing"
      : "pending_load";
  const setClauses = [
    "status = $2",
    "updated_at = now()"
  ];
  if (clearPreparing) {
    setClauses.push("preparing_operator_id = null", "preparing_started_at = null");
  }
  await query(
    `UPDATE local_co_orders
        SET ${setClauses.join(", ")}
      WHERE delivery_order_id = $1
         OR co_ref = $3`,
    [order.netsuite_id, coStatus, order.tranid]
  );
}

async function claimLocalCoPreparingOrder(order, operatorId) {
  if (order.status === "preparing" && order.preparing_operator_id && String(order.preparing_operator_id) !== String(operatorId)) {
    throw new Error("This CO is preparing on another tablet.");
  }
  await query(
    `UPDATE local_co_orders
        SET status = CASE WHEN status = 'pending_load' THEN 'preparing' ELSE status END,
            preparing_operator_id = CASE WHEN status <> 'packed' THEN $2 ELSE preparing_operator_id END,
            preparing_started_at = CASE WHEN status <> 'packed' THEN COALESCE(preparing_started_at, now()) ELSE preparing_started_at END,
            updated_at = now()
      WHERE delivery_order_id = $1
         OR co_ref = $3`,
    [order.netsuite_id, operatorId, order.tranid]
  );
  return getDeliveryOrder(order.tranid);
}

async function updateLocalCoLinePackedQuantity(order, lineId, next) {
  await query(
    `UPDATE local_co_order_lines line
        SET packed_pallet_qty = $3,
            packed_layer_qty = $4,
            packed_piece_qty = $5,
            packed_section_qty = $6,
            packed_sales_qty = $7,
            confirmed_at = CASE WHEN ($3::numeric + $4::numeric + $5::numeric + $6::numeric + $7::numeric) > 0 THEN COALESCE(confirmed_at, now()) ELSE null END
      FROM local_co_orders co
      WHERE line.co_id = co.id
        AND (co.delivery_order_id = $1 OR co.co_ref = $8)
        AND line.id = $2`,
    [order.netsuite_id, lineId, next.pallets, next.layers, next.pieces, next.sections, next.salesQty, order.tranid]
  );
}

async function confirmLocalCoDeliveryLine(orderId, lineId, values, operatorId, { absolute = false } = {}) {
  const currentOrder = await getDeliveryOrder(orderId);
  if (!currentOrder || !isLocalCoDeliveryOrder(currentOrder)) throw new Error("Local CO order not found.");
  const order = await claimLocalCoPreparingOrder(currentOrder, operatorId);
  const line = (order.lines || []).find((item) => String(item.id) === String(lineId));
  if (!line) throw new Error("Local CO line not found.");
  const available = remainingPackAvailability(line);
  const valuesToApply = {
    pallets: normalizeQuantity(values?.pallets) || 0,
    layers: normalizeQuantity(values?.layers) || 0,
    pieces: normalizeQuantity(values?.pieces) || 0,
    sections: normalizeQuantity(values?.sections) || 0,
    salesQty: normalizeQuantity(values?.salesQty) || 0
  };
  const salesOnly = isSalesQuantityOnlyLine(line);
  const next = salesOnly
    ? {
      pallets: 0,
      layers: 0,
      pieces: 0,
      sections: 0,
      salesQty: resolveSalesOnlyPackedQuantity(line, values, { absolute })
    }
    : absolute
      ? {
      pallets: Math.min(available.pallets, valuesToApply.pallets),
      layers: Math.min(available.layers, valuesToApply.layers),
      pieces: Math.min(available.pieces, valuesToApply.pieces),
      sections: Math.min(available.sections, valuesToApply.sections),
      salesQty: resolveIndependentPackedSalesQuantity(line, valuesToApply, valuesToApply.salesQty, {
        absolute: true,
        physicalChanged: valuesToApply.pallets + valuesToApply.layers + valuesToApply.pieces + valuesToApply.sections > 0
      })
    }
      : {
      pallets: Math.min(available.pallets, positiveQuantity(line.packed_pallet_qty) + valuesToApply.pallets),
      layers: Math.min(available.layers, positiveQuantity(line.packed_layer_qty) + valuesToApply.layers),
      pieces: Math.min(available.pieces, positiveQuantity(line.packed_piece_qty) + valuesToApply.pieces),
      sections: Math.min(available.sections, positiveQuantity(line.packed_section_qty) + valuesToApply.sections),
      salesQty: 0
    };
  if (!salesOnly && !absolute) {
    next.salesQty = resolveIndependentPackedSalesQuantity(line, next, valuesToApply.salesQty, {
      physicalChanged: valuesToApply.pallets + valuesToApply.layers + valuesToApply.pieces + valuesToApply.sections > 0
    });
  }
  await updateLocalCoLinePackedQuantity(order, lineId, next);
  await writeAudit({
    actorOperatorId: operatorId,
    action: absolute ? "delivery.local_co.line.update_packed_quantity" : "delivery.local_co.line.confirm",
    orderId: order.netsuite_id,
    lineId,
    details: { coRef: order.tranid, pallets: next.pallets, layers: next.layers, pieces: next.pieces, sections: next.sections, salesQty: next.salesQty }
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
         UNION ALL
         SELECT o.delivery_order_id AS netsuite_id
           FROM local_co_orders o
          WHERE o.delivery_order_id::text <> $2::text
            AND o.status = 'preparing'
            AND o.preparing_operator_id::text = $1
       ) active_draft
      LIMIT 1`,
    [operatorId, orderId]
  );
  return result.rows[0]?.netsuite_id || null;
}

async function recordGroupedDeliveryLoad(groupId, operatorId, { photoDataUrls }) {
  const photos = requirePhotoReferences(photoDataUrls);
  const groupOrder = await getDispatchGroupDeliveryOrder(groupId);
  if (!groupOrder) throw new Error("Grouped delivery order not found.");
  const childOrders = (await Promise.all(groupChildOrderIds(groupOrder).map((id) => getDeliveryOrder(id)))).filter(Boolean);
  const loadResults = [];
  const validations = [];
  for (const child of childOrders) {
    if (!(child.lines || []).some(lineHasPackedQuantity)) continue;
    const validation = buildDeliveryLoadValidation(child);
    if (!validation.ok) validations.push(...(validation.issues || []).map((issue) => ({ ...issue, orderRef: child.tranid })));
  }
  if (validations.length) {
    const error = new Error("Packed quantity must be corrected before loading.");
    error.code = "DELIVERY_LOAD_VALIDATION_FAILED";
    error.status = 409;
    error.validation = { ok: false, issues: validations };
    throw error;
  }
  const groupLoadRef = crypto.randomUUID();
  for (const child of childOrders) {
    if (!(child.lines || []).some(lineHasPackedQuantity)) continue;
    if (!["packed", "loaded"].includes(child.operator_status)) {
      await setCanonicalDeliveryStatus(child, "packed", { clearPreparing: true });
    }
    const result = await recordDeliveryLoad(child.netsuite_id, operatorId, { photoDataUrls: photos });
    if (result?.id) {
      await query(
        `UPDATE operator_load_records
            SET response = COALESCE(response, '{}'::jsonb) || $2::jsonb
          WHERE id = $1`,
        [
          result.id,
          JSON.stringify({
            dispatchGroupId: normalizeDispatchGroupId(groupId),
            groupedOrderRef: groupOrder.tranid,
            groupLoadRef
          })
        ]
      );
    }
    loadResults.push({ orderId: child.netsuite_id, tranid: child.tranid, ...result });
  }
  if (!loadResults.length) throw new Error("No packed grouped lines to load.");
  await writeAudit({
    actorOperatorId: operatorId,
    action: "delivery.group.order.load",
    details: {
      groupId: normalizeDispatchGroupId(groupId),
      childOrders: childOrders.map((order) => order.tranid),
      loadRecordIds: loadResults.map((item) => item.id).filter(Boolean)
    }
  });
  const refreshed = await getDispatchGroupDeliveryOrder(groupId);
  return {
    id: loadResults[0]?.id || null,
    groupLoad: true,
    groupLoadRef,
    sourceLoadRecords: loadResults,
    localYardOrderStatus: refreshed?.local_yard_order_status || "Partial Loaded",
    dispatchPlanDate: groupOrder.dispatch_plan_date,
    dispatchTruckPlate: groupOrder.dispatch_truck_plate,
    dispatchLoadName: groupOrder.dispatch_load_name,
    dispatchParkingSpot: groupOrder.dispatch_parking_spot,
    remainingLines: (refreshed?.lines || []).filter(lineHasOpenQuantity).length
  };
}

async function findActiveDraftOrderExcluding(operatorId, excludedOrderIds = []) {
  const excluded = (excludedOrderIds || []).map((id) => String(id)).filter(Boolean);
  const result = await query(
    `SELECT netsuite_id
       FROM (
         SELECT o.netsuite_id
           FROM sales_orders o
          WHERE NOT (o.netsuite_id::text = ANY($2::text[]))
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
          WHERE NOT (o.netsuite_id::text = ANY($2::text[]))
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
    [operatorId, excluded]
  );
  return result.rows[0]?.netsuite_id || null;
}

async function assertGroupEditable(groupOrder, operatorId, { allowConsolidation = false } = {}) {
  const childIds = groupChildOrderIds(groupOrder);
  if (!childIds.length) throw new Error("Grouped delivery order has no source order.");
  const childOrders = Array.isArray(groupOrder.child_orders) && groupOrder.child_orders.length
    ? groupOrder.child_orders
    : (await Promise.all(childIds.map((childId) => assertOrderEditable(childId, operatorId, { allowConsolidation }))));
  for (const child of childOrders.filter(Boolean)) {
    const consolidation = await activeConsolidationClaimForOrder(child.netsuite_id);
    if (consolidation && (!allowConsolidation || String(consolidation.operator_id) !== String(operatorId))) {
      const error = new Error(`${consolidation.order_ref || groupOrder.tranid} is reserved in Consolidation Pick.`);
      error.status = 409;
      error.code = "ORDER_RESERVED_FOR_CONSOLIDATION";
      throw error;
    }
    if (child.preparing_operator_id && String(child.preparing_operator_id) !== String(operatorId)) {
      throw new Error(`${child.tranid} is preparing on another tablet.`);
    }
  }
  return childIds;
}

async function claimPreparingGroupOrder(groupOrder, operatorId) {
  const childIds = await assertGroupEditable(groupOrder, operatorId);
  const existing = await findActiveDraftOrderExcluding(operatorId, childIds);
  if (existing) throw new Error("Pack your current preparing order before moving on.");

  const target = canonicalOrderTarget(groupOrder);
  await query(
    `UPDATE ${target.table}
        SET ${target.statusColumn} = CASE WHEN ${target.statusColumn} = 'open' THEN 'preparing' ELSE ${target.statusColumn} END,
            preparing_operator_id = CASE WHEN ${target.statusColumn} <> 'packed' THEN $2 ELSE preparing_operator_id END,
            preparing_started_at = CASE WHEN ${target.statusColumn} <> 'packed' THEN COALESCE(preparing_started_at, now()) ELSE preparing_started_at END,
            status_updated_at = now()
      WHERE netsuite_id = ANY($1::bigint[])`,
    [childIds.map((id) => Number(id)).filter((id) => Number.isInteger(id)), operatorId]
  );
  return groupOrder;
}

function sourceLinesForGroupLine(groupOrder, groupLineId) {
  const aggregate = (groupOrder.lines || []).find((line) => String(line.id) === String(groupLineId));
  if (!aggregate) throw new Error("Grouped delivery line not found.");
  const sources = [];
  for (const source of aggregate.source_lines || []) {
    const child = (groupOrder.child_order_ids || []).includes(source.orderId)
      ? null
      : null;
    sources.push(source);
  }
  return { aggregate, sources };
}

async function resolveGroupSourceLines(groupOrder, groupLineId) {
  const { aggregate } = sourceLinesForGroupLine(groupOrder, groupLineId);
  const childOrders = Array.isArray(groupOrder.child_orders) && groupOrder.child_orders.length
    ? groupOrder.child_orders
    : (await Promise.all(groupChildOrderIds(groupOrder).map((id) => getDeliveryOrder(id)))).filter(Boolean);
  const sourceSet = new Set((aggregate.source_lines || []).map((source) => `${source.orderId}:${source.lineId}`));
  const lines = [];
  for (const order of childOrders) {
    for (const line of order.lines || []) {
      if (sourceSet.has(`${order.netsuite_id}:${line.id}`)) lines.push({ order, line });
    }
  }
  return { aggregate, lines };
}

function unitFieldMap() {
  return {
    pallets: "packed_pallet_qty",
    layers: "packed_layer_qty",
    pieces: "packed_piece_qty",
    sections: "packed_section_qty"
  };
}

async function updateSourceLinePackedQuantities(sources = []) {
  if (!sources.length) return;
  const lineTarget = canonicalLineTarget(sources[0].order);
  const updates = sources.map(({ order, line, next }) => ({
    orderId: Number(order.netsuite_id),
    lineId: Number(line.id),
    pallets: next.pallets,
    layers: next.layers,
    pieces: next.pieces,
    sections: next.sections,
    salesQty: next.salesQty
  }));
  await query(
    `UPDATE ${lineTarget.table} line
        SET packed_pallet_qty = source.pallets,
            packed_layer_qty = source.layers,
            packed_piece_qty = source.pieces,
            packed_section_qty = source.sections,
            packed_sales_qty = source."salesQty",
            confirmed = (source.pallets + source.layers + source.pieces + source.sections + source."salesQty") > 0,
            confirmed_at = CASE
              WHEN (source.pallets + source.layers + source.pieces + source.sections + source."salesQty") > 0
                THEN COALESCE(line.confirmed_at, now())
              ELSE null
            END
       FROM jsonb_to_recordset($1::jsonb) AS source(
         "orderId" bigint,
         "lineId" bigint,
         pallets numeric,
         layers numeric,
         pieces numeric,
         sections numeric,
         "salesQty" numeric
       )
      WHERE line.${lineTarget.orderColumn} = source."orderId"
        AND line.id = source."lineId"
        AND line.sync_exception IS NULL
        ${lineTarget.extraWhere.replaceAll("line_stage", "line.line_stage")}`,
    [JSON.stringify(updates)]
  );
}

async function applyGroupedLinePackedQuantityToOrder(groupOrder, lineId, values, operatorId, { absolute = false, claim = true, audit = true } = {}) {
  if (claim) await claimPreparingGroupOrder(groupOrder, operatorId);
  const { lines } = await resolveGroupSourceLines(groupOrder, lineId);
  if (!lines.length) throw new Error("Grouped delivery line not found.");
  const requested = {
    pallets: normalizeQuantity(values?.pallets) || 0,
    layers: normalizeQuantity(values?.layers) || 0,
    pieces: normalizeQuantity(values?.pieces) || 0,
    sections: normalizeQuantity(values?.sections) || 0,
    salesQty: normalizeQuantity(values?.salesQty) || 0
  };
  const packedFields = unitFieldMap();
  const working = lines.map(({ order, line }) => {
    const available = remainingPackAvailability(line);
    const current = {
      pallets: positiveQuantity(line.packed_pallet_qty),
      layers: positiveQuantity(line.packed_layer_qty),
      pieces: positiveQuantity(line.packed_piece_qty),
      sections: positiveQuantity(line.packed_section_qty),
      salesQty: positiveQuantity(line.packed_sales_qty)
    };
    return {
      order,
      line,
      current,
      next: absolute ? { pallets: 0, layers: 0, pieces: 0, sections: 0, salesQty: 0 } : { ...current },
      capacity: Object.fromEntries(Object.keys(packedFields).map((unit) => [
        unit,
        isSalesQuantityOnlyLine(line) ? 0 : positiveQuantity(available[unit])
      ]))
    };
  });

  for (const unit of Object.keys(packedFields)) {
    let remaining = positiveQuantity(requested[unit]);
    for (const source of working) {
      if (remaining <= 0) break;
      const canAdd = Math.max(0, source.capacity[unit] - source.next[unit]);
      const add = Math.min(canAdd, remaining);
      source.next[unit] = roundQuantity(source.next[unit] + add);
      remaining = roundQuantity(remaining - add);
    }
  }

  let remainingSalesQty = positiveQuantity(requested.salesQty);
  for (const source of working) {
    if (isSalesQuantityOnlyLine(source.line)) {
      const sourceSalesAvailable = Math.max(0, lineRequiredSalesQuantity(source.line) - lineLoadedSalesQuantity(source.line));
      const currentSalesQty = absolute ? 0 : positiveQuantity(source.current.salesQty);
      const canAdd = Math.max(0, sourceSalesAvailable - currentSalesQty);
      const add = Math.min(canAdd, remainingSalesQty);
      source.next.salesQty = roundQuantity(currentSalesQty + add);
      remainingSalesQty = roundQuantity(Math.max(0, remainingSalesQty - add));
      continue;
    }
    if (hasConversion(source.line)) {
      source.next.salesQty = 0;
      continue;
    }
    const sourceSalesAvailable = Math.max(0, lineRequiredSalesQuantity(source.line) - lineLoadedSalesQuantity(source.line));
    const explicitSalesQty = Math.min(remainingSalesQty, sourceSalesAvailable);
    const physicalChanged = Object.keys(packedFields).some((unit) => (
      Math.abs(positiveQuantity(source.next[unit]) - positiveQuantity(source.current[unit])) > 0.000001
    ));
    source.next.salesQty = resolveIndependentPackedSalesQuantity(source.line, source.next, explicitSalesQty, {
      absolute,
      physicalChanged
    });
    remainingSalesQty = roundQuantity(Math.max(0, remainingSalesQty - explicitSalesQty));
  }
  if (remainingSalesQty > 0.000001) {
    throw new Error("Grouped packed sales quantity exceeds the source lines' remaining sales quantity.");
  }

  await updateSourceLinePackedQuantities(working);
  if (audit) {
    await writeAudit({
      actorOperatorId: operatorId,
      action: absolute ? "delivery.group.line.update_packed_quantity" : "delivery.group.line.confirm",
      lineId: /^\d+$/.test(String(lineId || "")) ? lineId : null,
      details: {
        groupId: groupOrder.dispatch_group_id || groupOrder.netsuite_id,
        groupLineId: lineId,
        requested,
        childOrders: groupChildOrderIds(groupOrder)
      }
    });
  }
  return { lineId, requested, sourceCount: working.length };
}

async function applyGroupedLinePackedQuantity(groupId, lineId, values, operatorId, { absolute = false } = {}) {
  if (!operatorId) throw new Error("Operator ID is required.");
  return withTransaction(async () => {
    const groupOrder = await getDispatchGroupDeliveryOrder(groupId);
    if (!groupOrder) throw new Error("Grouped delivery order not found.");
    return applyGroupedLinePackedQuantityToOrder(groupOrder, lineId, values, operatorId, { absolute });
  });
}

export async function setConsolidationDeliveryLinePackedQuantity(orderId, lineId, values, operatorId) {
  if (!operatorId) throw new Error("Operator ID is required.");
  if (!isDispatchGroupOrderId(orderId)) {
    await setDeliveryLinePackedQuantity(orderId, lineId, values, operatorId, { allowConsolidation: true });
    return getDeliveryOrder(orderId);
  }
  return withTransaction(async () => {
    const groupOrder = await getDispatchGroupDeliveryOrder(orderId);
    if (!groupOrder) throw new Error("Grouped delivery order not found.");
    await assertGroupEditable(groupOrder, operatorId, { allowConsolidation: true });
    await applyGroupedLinePackedQuantityToOrder(groupOrder, lineId, values, operatorId, {
      absolute: true,
      claim: false,
      audit: false
    });
    await writeAudit({
      actorOperatorId: operatorId,
      action: "delivery.consolidation.group_line.updated",
      lineId: /^\d+$/.test(String(lineId)) ? lineId : null,
      details: { groupId: orderId, values }
    });
    return getDispatchGroupDeliveryOrder(orderId);
  });
}

export async function getCurrentOperatorDeliveryDraft(operatorId, { locationId = null } = {}) {
  if (!operatorId) return null;
  const params = [String(operatorId)];
  let salesLocationClause = "";
  let transferLocationClause = "";
  let vrmaLocationClause = "";
  if (locationId) {
    params.push(locationId);
    salesLocationClause = `AND o.outbound_location_id = $${params.length}`;
    transferLocationClause = `AND o.from_location_id = $${params.length}`;
    vrmaLocationClause = `AND CASE v.pickup_location
      WHEN '3445' THEN 1
      WHEN '2967' THEN 28
      WHEN '12441' THEN 15
      WHEN '150' THEN 26
      ELSE null
    END = $${params.length}::bigint`;
  }
  const result = await query(
    `SELECT *
       FROM (
         SELECT 'sales_order'::text AS order_type,
                o.netsuite_id::text AS netsuite_id,
                o.tranid,
                o.operator_status,
                o.local_yard_order_status,
                o.outbound_location_id AS location_id,
                o.outbound_location AS location,
                o.preparing_operator_id,
                o.preparing_started_at,
                COUNT(l.id) FILTER (
                  WHERE COALESCE(l.item_type, '') IN ('InvtPart', 'NonInvtPart')
                    AND (
                      COALESCE(l.packed_pallet_qty, 0) > 0
                      OR COALESCE(l.packed_layer_qty, 0) > 0
                      OR COALESCE(l.packed_section_qty, 0) > 0
                      OR COALESCE(l.packed_piece_qty, 0) > 0
                      OR COALESCE(l.packed_sales_qty, 0) > 0
                    )
                )::int AS draft_line_count
           FROM sales_orders o
           LEFT JOIN sales_order_lines l ON l.sales_order_id = o.netsuite_id
          WHERE o.preparing_operator_id::text = $1
            AND COALESCE(o.sales_order_type, '') <> '${CUSTOMER_PICKUP_DELIVERY_METHOD.replaceAll("'", "''")}'
            AND NOT EXISTS (
              SELECT 1
                FROM operator_consolidation_claims consolidation_claim
                JOIN operator_consolidation_orders consolidation_order ON consolidation_order.id = consolidation_claim.batch_order_id
                JOIN operator_consolidation_batches consolidation_batch ON consolidation_batch.id = consolidation_order.batch_id
               WHERE consolidation_claim.canonical_order_id = o.netsuite_id
                 AND consolidation_claim.released_at IS NULL
                 AND consolidation_batch.status = 'active'
            )
            ${salesLocationClause}
          GROUP BY o.netsuite_id
         UNION ALL
         SELECT 'transfer_order'::text AS order_type,
                o.netsuite_id::text AS netsuite_id,
                o.tranid,
                o.outbound_operator_status AS operator_status,
                o.local_yard_order_status,
                o.from_location_id AS location_id,
                o.from_location AS location,
                o.preparing_operator_id,
                o.preparing_started_at,
                COUNT(l.id) FILTER (
                  WHERE COALESCE(l.item_type, '') IN ('InvtPart', 'NonInvtPart')
                    AND (
                      COALESCE(l.packed_pallet_qty, 0) > 0
                      OR COALESCE(l.packed_layer_qty, 0) > 0
                      OR COALESCE(l.packed_section_qty, 0) > 0
                      OR COALESCE(l.packed_piece_qty, 0) > 0
                      OR COALESCE(l.packed_sales_qty, 0) > 0
                    )
                )::int AS draft_line_count
           FROM transfer_orders o
           LEFT JOIN transfer_order_lines l
             ON l.transfer_order_id = o.netsuite_id
            AND l.line_stage = 'outbound'
         WHERE o.preparing_operator_id::text = $1
            ${transferLocationClause}
          GROUP BY o.netsuite_id
         UNION ALL
         SELECT 'co_order'::text AS order_type,
                o.delivery_order_id::text AS netsuite_id,
                o.co_ref AS tranid,
                CASE WHEN o.status = 'preparing' THEN 'preparing' ELSE 'open' END AS operator_status,
                'Open'::text AS local_yard_order_status,
                o.from_location_id AS location_id,
                o.from_location AS location,
                o.preparing_operator_id,
                o.preparing_started_at,
                COUNT(l.id) FILTER (
                  WHERE COALESCE(l.item_type, '') IN ('InvtPart', 'NonInvtPart')
                    AND (
                      COALESCE(l.packed_pallet_qty, 0) > 0
                      OR COALESCE(l.packed_layer_qty, 0) > 0
                      OR COALESCE(l.packed_section_qty, 0) > 0
                      OR COALESCE(l.packed_piece_qty, 0) > 0
                      OR COALESCE(l.packed_sales_qty, 0) > 0
                    )
                )::int AS draft_line_count
           FROM local_co_orders o
           LEFT JOIN local_co_order_lines l ON l.co_id = o.id
          WHERE o.preparing_operator_id::text = $1
            AND o.status = 'preparing'
            ${locationId ? `AND o.from_location_id = $${params.length}` : ""}
          GROUP BY o.id
         UNION ALL
         SELECT 'vrma_order'::text AS order_type,
                ('VRMA:' || v.vrma_ref)::text AS netsuite_id,
                v.vrma_ref AS tranid,
                v.operator_status,
                v.local_yard_order_status,
                CASE v.pickup_location
                  WHEN '3445' THEN 1
                  WHEN '2967' THEN 28
                  WHEN '12441' THEN 15
                  WHEN '150' THEN 26
                  ELSE null
                END::bigint AS location_id,
                v.pickup_location AS location,
                v.preparing_operator_id,
                v.preparing_started_at,
                COUNT(l.id) FILTER (
                  WHERE COALESCE(l.packed_pallet_qty, 0) > 0
                     OR COALESCE(l.packed_layer_qty, 0) > 0
                     OR COALESCE(l.packed_section_qty, 0) > 0
                     OR COALESCE(l.packed_piece_qty, 0) > 0
                     OR COALESCE(l.packed_sales_qty, 0) > 0
                )::int AS draft_line_count
           FROM scm_vrma_orders v
           LEFT JOIN scm_vrma_order_lines l ON l.vrma_order_id = v.id
          WHERE v.preparing_operator_id::text = $1
            AND v.operator_status = 'preparing'
            ${vrmaLocationClause}
          GROUP BY v.id
       ) draft
      ORDER BY preparing_started_at DESC NULLS LAST, tranid
      LIMIT 1`,
    params
  );
  return result.rows[0] || null;
}

async function claimPreparingOrder(orderId, operatorId) {
  const order = await assertOrderEditable(orderId, operatorId);
  if (isLocalCoDeliveryOrder(order)) return claimLocalCoPreparingOrder(order, operatorId);

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

export async function releaseCurrentDeliveryDraft(orderId, operatorId) {
  if (!operatorId) throw new Error("Operator ID is required.");
  if (isDispatchGroupOrderId(orderId)) {
    const groupOrder = await getDispatchGroupDeliveryOrder(orderId);
    if (!groupOrder) throw new Error("Grouped delivery order not found.");
    const childIds = groupChildOrderIds(groupOrder).map((id) => Number(id)).filter((id) => Number.isInteger(id));
    if (!childIds.length) return groupOrder;
    const orderTarget = canonicalOrderTarget(groupOrder);
    const lineTarget = canonicalLineTarget(groupOrder);
    await query(
      `UPDATE ${lineTarget.table}
          SET packed_pallet_qty = 0,
              packed_layer_qty = 0,
              packed_piece_qty = 0,
              packed_section_qty = 0,
              packed_sales_qty = 0,
              confirmed = false,
              confirmed_at = null
        WHERE ${lineTarget.orderColumn} = ANY($1::bigint[])
          ${lineTarget.extraWhere}
          AND (
            confirmed = true
            OR COALESCE(packed_pallet_qty, 0) > 0
            OR COALESCE(packed_layer_qty, 0) > 0
            OR COALESCE(packed_piece_qty, 0) > 0
            OR COALESCE(packed_section_qty, 0) > 0
            OR COALESCE(packed_sales_qty, 0) > 0
          )`,
      [childIds]
    );
    await query(
      `UPDATE ${orderTarget.table}
          SET ${orderTarget.statusColumn} = CASE WHEN ${orderTarget.statusColumn} <> 'loaded' THEN 'open' ELSE ${orderTarget.statusColumn} END,
              preparing_operator_id = null,
              preparing_started_at = null,
              status_updated_at = now()
        WHERE netsuite_id = ANY($1::bigint[])
          AND preparing_operator_id::text = $2`,
      [childIds, String(operatorId)]
    );
    await writeAudit({
      actorOperatorId: operatorId,
      action: "delivery.group.draft.release",
      details: { groupId: orderId, childOrders: groupChildOrderIds(groupOrder) }
    });
    return getDispatchGroupDeliveryOrder(orderId);
  }
  const order = await getDeliveryOrder(orderId);
  if (!order) throw new Error("Delivery order not found.");
  if (!order.preparing_operator_id || String(order.preparing_operator_id) !== String(operatorId)) {
    const error = new Error("This order is not locked by your account.");
    error.status = 409;
    throw error;
  }
  if (isVrmaDeliveryOrder(order)) {
    await query(
      `UPDATE scm_vrma_order_lines
          SET packed_pallet_qty = 0,
              packed_layer_qty = 0,
              packed_piece_qty = 0,
              packed_section_qty = 0,
              packed_sales_qty = 0,
              confirmed = false,
              confirmed_at = null
        WHERE vrma_order_id = $1`,
      [order.vrma_order_id]
    );
    const refreshed = await refreshVrmaDeliveryProgressStatus(order.netsuite_id, { clearPreparing: true });
    await writeAudit({
      actorOperatorId: operatorId,
      action: "delivery.vrma.draft.release",
      orderId: order.vrma_order_id,
      details: { vrmaRef: order.tranid, localOnly: true }
    });
    return refreshed;
  }
  if (isPickupOrder(order)) {
    const error = new Error("Use customer pickup back/reset for pickup orders.");
    error.status = 409;
    throw error;
  }
  if (isLocalCoDeliveryOrder(order)) {
    await query(
      `UPDATE local_co_order_lines line
          SET packed_pallet_qty = 0,
              packed_layer_qty = 0,
              packed_piece_qty = 0,
              packed_section_qty = 0,
              packed_sales_qty = 0,
              confirmed_at = null
        FROM local_co_orders co
        WHERE line.co_id = co.id
          AND (co.delivery_order_id = $1 OR co.co_ref = $2)`,
      [order.netsuite_id, order.tranid]
    );
    await setLocalCoDeliveryStatus(order, "open", { clearPreparing: true });
    await writeAudit({
      actorOperatorId: operatorId,
      action: "delivery.local_co.draft.release",
      orderId,
      details: { coRef: order.tranid }
    });
    return getDeliveryOrder(order.tranid);
  }

  const lineTarget = canonicalLineTarget(order);
  await query(
    `UPDATE ${lineTarget.table}
        SET packed_pallet_qty = 0,
            packed_layer_qty = 0,
            packed_piece_qty = 0,
            packed_section_qty = 0,
            packed_sales_qty = 0,
            confirmed = false,
            confirmed_at = null
      WHERE ${lineTarget.orderColumn} = $1
        ${lineTarget.extraWhere}
        AND (
          confirmed = true
          OR COALESCE(packed_pallet_qty, 0) > 0
          OR COALESCE(packed_layer_qty, 0) > 0
          OR COALESCE(packed_piece_qty, 0) > 0
          OR COALESCE(packed_section_qty, 0) > 0
          OR COALESCE(packed_sales_qty, 0) > 0
        )`,
    [orderId]
  );

  const refreshed = await refreshDeliveryProgressStatus(orderId, { clearPreparing: true });
  await writeAudit({
    actorOperatorId: operatorId,
    action: "delivery.draft.release",
    orderId,
    details: { tranid: order.tranid, orderType: order.order_type }
  });
  return refreshed;
}

export async function confirmDeliveryLine(orderId, lineId, values, operatorId) {
  if (!operatorId) throw new Error("Operator ID is required.");
  if (isDispatchGroupOrderId(orderId)) {
    await applyGroupedLinePackedQuantity(orderId, lineId, values, operatorId);
    return;
  }
  const current = await getDeliveryOrder(orderId);
  if (isVrmaDeliveryOrder(current)) {
    await claimVrmaPreparingOrder(current, operatorId);
    await updateVrmaLinePackedQuantity(orderId, lineId, values, operatorId);
    return;
  }
  if (isLocalCoDeliveryOrder(current)) {
    await confirmLocalCoDeliveryLine(orderId, lineId, values, operatorId);
    return;
  }
  const order = await claimPreparingOrder(orderId, operatorId);
  const line = (order.lines || []).find((item) => String(item.id) === String(lineId));
  if (!line || line.sync_exception) throw new Error("Delivery line not found.");

  const pallets = normalizeQuantity(values?.pallets) || 0;
  const layers = normalizeQuantity(values?.layers) || 0;
  const pieces = normalizeQuantity(values?.pieces) || 0;
  const sections = normalizeQuantity(values?.sections) || 0;
  const requestedSalesQty = normalizeQuantity(values?.salesQty) || 0;
  const lineTarget = canonicalLineTarget(order);
  const salesOnly = isSalesQuantityOnlyLine(line);
  const available = remainingPackAvailability(line);
  const next = salesOnly
    ? { pallets: 0, layers: 0, pieces: 0, sections: 0 }
    : {
      pallets: Math.min(available.pallets, positiveQuantity(line.packed_pallet_qty) + pallets),
      layers: Math.min(available.layers, positiveQuantity(line.packed_layer_qty) + layers),
      pieces: Math.min(available.pieces, positiveQuantity(line.packed_piece_qty) + pieces),
      sections: Math.min(available.sections, positiveQuantity(line.packed_section_qty) + sections)
    };
  const packedSalesQty = salesOnly
    ? resolveSalesOnlyPackedQuantity(line, values)
    : resolveIndependentPackedSalesQuantity(line, next, requestedSalesQty, {
      physicalChanged: pallets + layers + pieces + sections > 0
    });

  await query(
    `UPDATE ${lineTarget.table}
     SET packed_pallet_qty = $3,
         packed_layer_qty = $4,
         packed_piece_qty = $5,
         packed_section_qty = $6,
         packed_sales_qty = $7,
         confirmed = ($3::numeric + $4::numeric + $5::numeric + $6::numeric + $7::numeric) > 0,
         confirmed_at = CASE WHEN ($3::numeric + $4::numeric + $5::numeric + $6::numeric + $7::numeric) > 0 THEN now() ELSE null END
     WHERE ${lineTarget.orderColumn} = $1
       AND sync_exception IS NULL
       AND id = $2
       ${lineTarget.extraWhere}`,
    [orderId, lineId, next.pallets, next.layers, next.pieces, next.sections, packedSalesQty]
  );

  await writeAudit({
    actorOperatorId: operatorId,
    action: "delivery.line.confirm",
    orderId,
    lineId,
    details: { pallets: next.pallets, layers: next.layers, pieces: next.pieces, sections: next.sections, salesQty: packedSalesQty }
  });
}

export async function confirmDeliveryLines(orderId, lines = [], operatorId) {
  if (!operatorId) throw new Error("Operator ID is required.");
  const requestedLines = Array.isArray(lines) ? lines : [];
  if (!requestedLines.length) return { confirmed: 0, failures: [] };

  if (isDispatchGroupOrderId(orderId)) {
    return withTransaction(async () => {
      const groupOrder = await getDispatchGroupDeliveryOrder(orderId);
      if (!groupOrder) throw new Error("Grouped delivery order not found.");
      await claimPreparingGroupOrder(groupOrder, operatorId);
      const results = [];
      const failures = [];
      for (const item of requestedLines) {
        const lineId = item?.lineId || item?.id;
        if (!lineId) continue;
        try {
          results.push(await applyGroupedLinePackedQuantityToOrder(groupOrder, lineId, item?.values || item || {}, operatorId, { claim: false, audit: false }));
        } catch (error) {
          failures.push({ lineId, error: error.message });
        }
      }
      await writeAudit({
        actorOperatorId: operatorId,
        action: "delivery.group.page.confirm",
        details: { groupId: orderId, confirmed: results.length, failures, childOrders: groupChildOrderIds(groupOrder) }
      });
      return { confirmed: results.length, failures };
    });
  }

  let confirmed = 0;
  const failures = [];
  for (const item of requestedLines) {
    const lineId = item?.lineId || item?.id;
    if (!lineId) continue;
    try {
      await confirmDeliveryLine(orderId, lineId, item?.values || item || {}, operatorId);
      confirmed += 1;
    } catch (error) {
      failures.push({ lineId, error: error.message });
    }
  }
  return { confirmed, failures };
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
  const requestedSalesQty = normalizeQuantity(values?.salesQty) || 0;
  const salesOnly = isSalesQuantityOnlyLine(line);
  const available = remainingPackAvailability(line);
  const next = salesOnly
    ? { pallets: 0, layers: 0, pieces: 0, sections: 0 }
    : {
      pallets: Math.min(available.pallets, positiveQuantity(line.packed_pallet_qty) + pallets),
      layers: Math.min(available.layers, positiveQuantity(line.packed_layer_qty) + layers),
      pieces: Math.min(available.pieces, positiveQuantity(line.packed_piece_qty) + pieces),
      sections: Math.min(available.sections, positiveQuantity(line.packed_section_qty) + sections)
    };
  const packedSalesQty = salesOnly
    ? resolveSalesOnlyPackedQuantity(line, values)
    : resolveIndependentPackedSalesQuantity(line, next, requestedSalesQty, {
      physicalChanged: pallets + layers + pieces + sections > 0
    });
  if ((next.pallets + next.layers + next.pieces + next.sections + packedSalesQty) <= 0) {
    throw new Error("This pickup line has no remaining quantity to load.");
  }

  await query(
    `UPDATE sales_order_lines
     SET packed_pallet_qty = $3,
         packed_layer_qty = $4,
         packed_piece_qty = $5,
         packed_section_qty = $6,
         packed_sales_qty = $7,
         confirmed = true,
         confirmed_at = now()
     WHERE sales_order_id = $1
       AND sync_exception IS NULL
       AND id = $2`,
    [orderId, lineId, next.pallets, next.layers, next.pieces, next.sections, packedSalesQty]
  );

  await writeAudit({
    actorOperatorId: operatorId,
    action: "customer_pickup.line.confirm",
    orderId,
    lineId,
    details: { pallets: next.pallets, layers: next.layers, pieces: next.pieces, sections: next.sections, salesQty: packedSalesQty }
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
            packed_sales_qty = 0,
            confirmed = false,
            confirmed_at = null
      WHERE sales_order_id = $1
        AND (
          COALESCE(packed_pallet_qty, 0) > 0
          OR COALESCE(packed_layer_qty, 0) > 0
          OR COALESCE(packed_piece_qty, 0) > 0
          OR COALESCE(packed_section_qty, 0) > 0
          OR COALESCE(packed_sales_qty, 0) > 0
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

export async function setDeliveryLinePackedQuantity(orderId, lineId, values, operatorId, { allowConsolidation = false } = {}) {
  if (!operatorId) throw new Error("Operator ID is required.");
  if (isDispatchGroupOrderId(orderId)) {
    await applyGroupedLinePackedQuantity(orderId, lineId, values, operatorId, { absolute: true });
    return;
  }
  const current = await getDeliveryOrder(orderId);
  if (isVrmaDeliveryOrder(current)) {
    await updateVrmaLinePackedQuantity(orderId, lineId, values, operatorId, { absolute: true });
    return;
  }
  if (isLocalCoDeliveryOrder(current)) {
    await confirmLocalCoDeliveryLine(orderId, lineId, values, operatorId, { absolute: true });
    return;
  }
  const order = await assertOrderEditable(orderId, operatorId, { allowConsolidation });

  const pallets = normalizeQuantity(values?.pallets) || 0;
  const layers = normalizeQuantity(values?.layers) || 0;
  const pieces = normalizeQuantity(values?.pieces) || 0;
  const sections = normalizeQuantity(values?.sections) || 0;
  const requestedSalesQty = normalizeQuantity(values?.salesQty) || 0;
  const lineTarget = canonicalLineTarget(order);
  const line = (order.lines || []).find((item) => String(item.id) === String(lineId));
  if (!line || line.sync_exception) throw new Error("Delivery line not found.");
  const salesOnly = isSalesQuantityOnlyLine(line);
  const available = remainingPackAvailability(line);
  const next = salesOnly
    ? { pallets: 0, layers: 0, pieces: 0, sections: 0 }
    : {
      pallets: Math.min(available.pallets, pallets),
      layers: Math.min(available.layers, layers),
      pieces: Math.min(available.pieces, pieces),
      sections: Math.min(available.sections, sections)
    };
  const packedSalesQty = salesOnly
    ? resolveSalesOnlyPackedQuantity(line, values, { absolute: true })
    : resolveIndependentPackedSalesQuantity(line, next, requestedSalesQty, {
      absolute: true,
      physicalChanged: pallets + layers + pieces + sections > 0
    });

  await query(
    `UPDATE ${lineTarget.table}
     SET packed_pallet_qty = $3,
         packed_layer_qty = $4,
         packed_piece_qty = $5,
         packed_section_qty = $6,
         packed_sales_qty = $7,
         confirmed = ($3::numeric + $4::numeric + $5::numeric + $6::numeric + $7::numeric) > 0,
         confirmed_at = CASE WHEN ($3::numeric + $4::numeric + $5::numeric + $6::numeric + $7::numeric) > 0 THEN COALESCE(confirmed_at, now()) ELSE null END
     WHERE ${lineTarget.orderColumn} = $1
       AND sync_exception IS NULL
       AND id = $2
       ${lineTarget.extraWhere}`,
    [orderId, lineId, next.pallets, next.layers, next.pieces, next.sections, packedSalesQty]
  );

  await writeAudit({
    actorOperatorId: operatorId,
    action: "delivery.line.update_packed_quantity",
    orderId,
    lineId,
    details: { pallets: next.pallets, layers: next.layers, pieces: next.pieces, sections: next.sections, salesQty: packedSalesQty }
  });
}

export async function unpackDeliveryLine(orderId, lineId, values, operatorId) {
  if (!operatorId) throw new Error("Operator ID is required.");
  if (isDispatchGroupOrderId(orderId)) {
    const groupOrder = await getDispatchGroupDeliveryOrder(orderId);
    if (!groupOrder) throw new Error("Grouped delivery order not found.");
    await assertGroupEditable(groupOrder, operatorId);
    const { lines } = await resolveGroupSourceLines(groupOrder, lineId);
    for (const { order, line } of lines) {
      const lineTarget = canonicalLineTarget(order);
      await query(
        `UPDATE ${lineTarget.table}
            SET packed_pallet_qty = 0,
                packed_layer_qty = 0,
                packed_piece_qty = 0,
                packed_section_qty = 0,
                packed_sales_qty = 0,
                confirmed = false,
                confirmed_at = null,
                sync_exception = null,
                sync_exception_at = null
          WHERE ${lineTarget.orderColumn} = $1
            AND id = $2
            ${lineTarget.extraWhere}`,
        [order.netsuite_id, line.id]
      );
      await refreshDeliveryProgressStatus(order.netsuite_id, { clearPreparing: true });
    }
    await writeAudit({
      actorOperatorId: operatorId,
      action: "delivery.group.line.unpack",
      lineId,
      details: { groupId: orderId, childOrders: groupChildOrderIds(groupOrder) }
    });
    return;
  }
  const order = await assertOrderEditable(orderId, operatorId);
  if (isVrmaDeliveryOrder(order)) {
    const line = (order.lines || []).find((item) => String(item.id) === String(lineId));
    if (!line) throw new Error("VRMA line not found.");
    await query(
      `UPDATE scm_vrma_order_lines
          SET packed_pallet_qty = 0,
              packed_layer_qty = 0,
              packed_piece_qty = 0,
              packed_section_qty = 0,
              packed_sales_qty = 0,
              confirmed = false,
              confirmed_at = null
        WHERE vrma_order_id = $1
          AND id = $2`,
      [order.vrma_order_id, line.line_id]
    );
    await refreshVrmaDeliveryProgressStatus(orderId, { clearPreparing: true });
    await writeAudit({
      actorOperatorId: operatorId,
      action: "delivery.vrma.line.unpack",
      orderId: order.vrma_order_id,
      lineId: line.line_id,
      details: { vrmaRef: order.tranid, localOnly: true }
    });
    return;
  }
  if (isLocalCoDeliveryOrder(order)) {
    const line = (order.lines || []).find((item) => String(item.id) === String(lineId));
    if (!line) throw new Error("Local CO line not found.");
    const packed = {
      pallets: positiveQuantity(line.packed_pallet_qty),
      layers: positiveQuantity(line.packed_layer_qty),
      pieces: positiveQuantity(line.packed_piece_qty),
      sections: positiveQuantity(line.packed_section_qty),
      salesQty: positiveQuantity(line.packed_sales_qty)
    };
    await updateLocalCoLinePackedQuantity(order, lineId, { pallets: 0, layers: 0, pieces: 0, sections: 0, salesQty: 0 });
    await setLocalCoDeliveryStatus(order, "preparing", { clearPreparing: false });
    await writeAudit({
      actorOperatorId: operatorId,
      action: "delivery.local_co.line.unpack",
      orderId,
      lineId,
      details: { coRef: order.tranid, ...packed }
    });
    return;
  }

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
         packed_sales_qty = 0,
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
  if (isDispatchGroupOrderId(orderId)) {
    const groupOrder = await getDispatchGroupDeliveryOrder(orderId);
    if (!groupOrder) throw new Error("Grouped delivery order not found.");
    await assertGroupEditable(groupOrder, operatorId);
    for (const childId of groupChildOrderIds(groupOrder)) {
      await unpackDeliveryOrder(childId, operatorId);
    }
    await writeAudit({
      actorOperatorId: operatorId,
      action: "delivery.group.order.unpack",
      details: { groupId: orderId, childOrders: groupChildOrderIds(groupOrder) }
    });
    return;
  }
  const order = await assertOrderEditable(orderId, operatorId);
  if (isVrmaDeliveryOrder(order)) {
    await query(
      `UPDATE scm_vrma_order_lines
          SET packed_pallet_qty = 0,
              packed_layer_qty = 0,
              packed_piece_qty = 0,
              packed_section_qty = 0,
              packed_sales_qty = 0,
              confirmed = false,
              confirmed_at = null
        WHERE vrma_order_id = $1`,
      [order.vrma_order_id]
    );
    await refreshVrmaDeliveryProgressStatus(orderId, { clearPreparing: true });
    await writeAudit({
      actorOperatorId: operatorId,
      action: "delivery.vrma.order.unpack",
      orderId: order.vrma_order_id,
      details: { vrmaRef: order.tranid, localOnly: true }
    });
    return;
  }
  if (isLocalCoDeliveryOrder(order)) {
    await query(
      `UPDATE local_co_order_lines line
          SET packed_pallet_qty = 0,
              packed_layer_qty = 0,
              packed_piece_qty = 0,
              packed_section_qty = 0,
              packed_sales_qty = 0,
              confirmed_at = null
        FROM local_co_orders co
        WHERE line.co_id = co.id
          AND (co.delivery_order_id = $1 OR co.co_ref = $2)`,
      [order.netsuite_id, order.tranid]
    );
    await setLocalCoDeliveryStatus(order, "open", { clearPreparing: true });
    await writeAudit({
      actorOperatorId: operatorId,
      action: "delivery.local_co.order.unpack",
      orderId,
      details: { coRef: order.tranid }
    });
    return;
  }
  const lineTarget = canonicalLineTarget(order);

  await query(
    `UPDATE ${lineTarget.table}
     SET packed_pallet_qty = 0,
         packed_layer_qty = 0,
         packed_piece_qty = 0,
         packed_section_qty = 0,
         packed_sales_qty = 0,
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

  if (isDispatchGroupOrderId(id)) {
    return withTransaction(async () => {
      const groupOrder = await getDispatchGroupDeliveryOrder(id);
      if (!groupOrder) throw new Error("Grouped delivery order not found.");
      if (status === "preparing") {
        await claimPreparingGroupOrder(groupOrder, operatorId);
      } else if (status === "packed") {
        if (!orderHasPackedQuantity(groupOrder)) {
          const error = new Error("Cannot mark this grouped order as packed because no order line has confirmed packed quantity.");
          error.status = 409;
          throw error;
        }
        await assertGroupEditable(groupOrder, operatorId);
        const childIds = groupChildOrderIds(groupOrder).map((childId) => Number(childId)).filter((childId) => Number.isInteger(childId));
        const orderTarget = canonicalOrderTarget(groupOrder);
        const lineTarget = canonicalLineTarget(groupOrder);
        await query(
          `UPDATE ${orderTarget.table} o
              SET ${orderTarget.statusColumn} = CASE
                    WHEN EXISTS (
                      SELECT 1
                        FROM ${lineTarget.table} l
                       WHERE l.${lineTarget.orderColumn} = o.netsuite_id
                         ${lineTarget.extraWhere}
                         AND COALESCE(l.item_type, '') IN ('InvtPart', 'NonInvtPart')
                         AND (${packedQtySql}) > 0
                    ) THEN 'packed'
                    ELSE 'open'
                  END,
                  preparing_operator_id = null,
                  preparing_started_at = null,
                  status_updated_at = now()
            WHERE o.netsuite_id = ANY($1::bigint[])`,
          [childIds]
        );
      } else {
        await assertGroupEditable(groupOrder, operatorId);
        const childIds = groupChildOrderIds(groupOrder).map((childId) => Number(childId)).filter((childId) => Number.isInteger(childId));
        const orderTarget = canonicalOrderTarget(groupOrder);
        await query(
          `UPDATE ${orderTarget.table}
              SET ${orderTarget.statusColumn} = CASE WHEN ${orderTarget.statusColumn} = 'loaded' THEN ${orderTarget.statusColumn} ELSE 'open' END,
                  preparing_operator_id = null,
                  preparing_started_at = null,
                  status_updated_at = now()
            WHERE netsuite_id = ANY($1::bigint[])`,
          [childIds]
        );
      }
      await writeAudit({
        actorOperatorId: operatorId,
        action: "delivery.group.order.status",
        details: { groupId: id, status, childOrders: groupChildOrderIds(groupOrder) }
      });
    });
  }
  const currentOrder = await getDeliveryOrder(id);
  if (isVrmaDeliveryOrder(currentOrder)) {
    if (status === "preparing") {
      await claimVrmaPreparingOrder(currentOrder, operatorId);
    } else {
      await assertOrderEditable(id, operatorId);
      if (status === "packed" && !orderHasPackedQuantity(currentOrder)) {
        const error = new Error("Cannot mark this VRMA as packed because no order line has confirmed packed quantity.");
        error.status = 409;
        throw error;
      }
      await setVrmaDeliveryStatus(currentOrder, status, {
        clearPreparing: status === "packed" || status === "open",
        localYardOrderStatus: status === "packed" ? "Ready" : "Open"
      });
    }
    await writeAudit({
      actorOperatorId: operatorId,
      action: "delivery.vrma.order.status",
      orderId: currentOrder.vrma_order_id,
      details: { vrmaRef: currentOrder.tranid, status, localOnly: true }
    });
    return;
  }
  if (isLocalCoDeliveryOrder(currentOrder)) {
    if (status === "preparing") {
      await claimLocalCoPreparingOrder(currentOrder, operatorId);
    } else if (status === "packed") {
      if (!orderHasPackedQuantity(currentOrder)) {
        const error = new Error("Cannot mark this CO as packed because no order line has confirmed packed quantity.");
        error.status = 409;
        throw error;
      }
      await setLocalCoDeliveryStatus(currentOrder, "packed", { clearPreparing: true });
    } else {
      await setLocalCoDeliveryStatus(currentOrder, "open", { clearPreparing: true });
    }
    await writeAudit({
      actorOperatorId: operatorId,
      action: "delivery.local_co.order.status",
      details: { coOrderId: id, coRef: currentOrder.tranid, status }
    });
    return;
  }

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

export async function markConsolidationDeliveryOrderPacked(id, operatorId) {
  if (!operatorId) throw new Error("Operator ID is required.");
  return withTransaction(async () => {
    if (isDispatchGroupOrderId(id)) {
      const groupOrder = await getDispatchGroupDeliveryOrder(id);
      if (!groupOrder) throw new Error("Grouped delivery order not found.");
      await assertGroupEditable(groupOrder, operatorId, { allowConsolidation: true });
      if (!orderHasPackedQuantity(groupOrder)) {
        const error = new Error("Cannot mark this grouped order as packed because no order line has confirmed packed quantity.");
        error.status = 409;
        throw error;
      }
      const childIds = groupChildOrderIds(groupOrder).map(Number).filter(Number.isInteger);
      await query(
        `UPDATE sales_orders o
            SET operator_status = CASE
                  WHEN EXISTS (
                    SELECT 1
                      FROM sales_order_lines l
                     WHERE l.sales_order_id = o.netsuite_id
                       AND COALESCE(l.item_type, '') IN ('InvtPart', 'NonInvtPart')
                       AND (${packedQtySql}) > 0
                  ) THEN 'packed'
                  ELSE 'open'
                END,
                preparing_operator_id = null,
                preparing_started_at = null,
                status_updated_at = now()
          WHERE o.netsuite_id = ANY($1::bigint[])`,
        [childIds]
      );
      await writeAudit({
        actorOperatorId: operatorId,
        action: "delivery.consolidation.group_order.packed",
        details: { groupId: id, childOrders: groupChildOrderIds(groupOrder) }
      });
      return getDispatchGroupDeliveryOrder(id);
    }

    const order = await assertOrderEditable(id, operatorId, { allowConsolidation: true });
    if (!orderHasPackedQuantity(order)) {
      const error = new Error("Cannot mark this order as packed because no order line has confirmed packed quantity.");
      error.status = 409;
      throw error;
    }
    await setCanonicalDeliveryStatus(order, "packed", { clearPreparing: true });
    await writeAudit({
      actorOperatorId: operatorId,
      action: "delivery.consolidation.order.packed",
      orderId: id,
      details: { tranid: order.tranid }
    });
    return getDeliveryOrder(id);
  });
}

export async function releaseConsolidationDeliveryOrder(id, operatorId) {
  if (!operatorId) throw new Error("Operator ID is required.");
  return withTransaction(async () => {
    if (isDispatchGroupOrderId(id)) {
      const groupOrder = await getDispatchGroupDeliveryOrder(id);
      if (!groupOrder) return null;
      await assertGroupEditable(groupOrder, operatorId, { allowConsolidation: true });
      for (const childId of groupChildOrderIds(groupOrder)) {
        await refreshDeliveryProgressStatus(childId, { clearPreparing: true });
      }
      return getDispatchGroupDeliveryOrder(id);
    }
    await assertOrderEditable(id, operatorId, { allowConsolidation: true });
    return refreshDeliveryProgressStatus(id, { clearPreparing: true });
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
