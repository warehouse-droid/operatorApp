export const STOCK_REQUEST_MAX_QUANTITY = 1_000_000_000;

export const STOCK_REQUEST_YARDS = Object.freeze([
  Object.freeze({ yardCode: "3445", locationId: 1 }),
  Object.freeze({ yardCode: "2967", locationId: 28 }),
  Object.freeze({ yardCode: "12441", locationId: 15 }),
  Object.freeze({ yardCode: "150", locationId: 26 })
]);

const STOCK_REQUEST_LOCATION_IDS = new Set(STOCK_REQUEST_YARDS.map((yard) => yard.locationId));
const TERMINAL_LINE_STATUSES = new Set(["received", "rejected", "cancelled", "closed"]);

function httpError(message, status = 400, code = "STOCK_REQUEST_INVALID") {
  return Object.assign(new Error(message), { status, code });
}

function finiteNumber(value, label, { nullable = false, whole = false } = {}) {
  if (nullable && (value === undefined || value === null || String(value).trim() === "")) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > STOCK_REQUEST_MAX_QUANTITY) {
    throw httpError(`${label} quantity must be a finite non-negative number no greater than ${STOCK_REQUEST_MAX_QUANTITY}.`);
  }
  if (whole && !Number.isInteger(parsed)) {
    throw httpError(`${label} quantity must be a whole number.`);
  }
  return parsed;
}

function positiveConversion(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function fieldProvided(input, key) {
  return Object.hasOwn(input || {}, key)
    && input[key] !== undefined
    && input[key] !== null
    && String(input[key]).trim() !== "";
}

function locationId(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && STOCK_REQUEST_LOCATION_IDS.has(parsed) ? parsed : null;
}

export function normalizeStockRequestYardId(value, label = "yard") {
  const normalized = locationId(value);
  if (!normalized) throw httpError(`Select a valid supported ${label}.`);
  return normalized;
}

export function assertStockRequestDestinationAccess(value, authorizedLocationIds = []) {
  const destinationLocationId = normalizeStockRequestYardId(value, "destination yard");
  const authorized = new Set((authorizedLocationIds || []).map(Number).filter(Number.isInteger));
  if (!authorized.has(destinationLocationId)) {
    throw httpError("Your Sales account does not have yard access to that destination.", 403, "STOCK_REQUEST_YARD_FORBIDDEN");
  }
  return destinationLocationId;
}

export function normalizeStockRequestQuantity(input = {}, item = {}) {
  const conversions = {
    pallets: positiveConversion(item.toPlt ?? item.to_plt),
    layers: positiveConversion(item.toLyr ?? item.to_lyr),
    sections: positiveConversion(item.toSec ?? item.to_sec),
    pieces: positiveConversion(item.toPcs ?? item.to_pcs)
  };
  const hasConversion = Object.values(conversions).some(Boolean);
  const conversionInput = ["pallets", "layers", "sections", "pieces"].some((key) => fieldProvided(input, key));
  const salesInput = fieldProvided(input, "salesQty");
  if (conversionInput && salesInput) {
    throw httpError("Enter either conversion fields or Sales quantity, not both.");
  }
  if (hasConversion && !conversionInput) {
    throw httpError("Enter a positive quantity using the available PLT, LYR, SEC, or PCS fields.");
  }
  if (!hasConversion && !salesInput) {
    throw httpError("Enter a positive Sales quantity.");
  }

  const salesUom = String(item.stockUnit ?? item.stock_unit ?? item.salesUom ?? "").trim();
  if (conversionInput) {
    const quantities = {
      pallets: finiteNumber(input.pallets, "PLT", { nullable: true }) ?? 0,
      layers: finiteNumber(input.layers, "LYR", { nullable: true, whole: true }) ?? 0,
      sections: finiteNumber(input.sections, "SEC", { nullable: true }) ?? 0,
      pieces: finiteNumber(input.pieces, "PCS", { nullable: true }) ?? 0
    };
    for (const [key, value] of Object.entries(quantities)) {
      if (value > 0 && !conversions[key]) {
        throw httpError(`${key.toUpperCase()} is not available for this item.`);
      }
    }
    const salesQty = Object.entries(quantities)
      .reduce((sum, [key, value]) => sum + (value * (conversions[key] || 0)), 0);
    if (!Number.isFinite(salesQty) || salesQty <= 0 || salesQty > STOCK_REQUEST_MAX_QUANTITY) {
      throw httpError("The converted Sales quantity must be positive and within the supported quantity limit.");
    }
    return { ...quantities, salesQty, salesUom, mode: "conversion" };
  }

  const salesQty = finiteNumber(input.salesQty, "Sales");
  if (salesQty <= 0) throw httpError("Sales quantity must be greater than zero.");
  if (!salesUom) throw httpError("This item does not have a Sales UOM.");
  return {
    pallets: null,
    layers: null,
    sections: null,
    pieces: null,
    salesQty,
    salesUom,
    mode: "sales"
  };
}

export function stockRequestAvailableQuantity({ liveAvailable = 0, activeReserved = 0 } = {}) {
  const live = Number(liveAvailable);
  const reserved = Number(activeReserved);
  if (!Number.isFinite(live) || live <= 0) return 0;
  return Math.max(0, live - (Number.isFinite(reserved) && reserved > 0 ? reserved : 0));
}

export function stockRequestBackorder({
  requestedQuantity = 0,
  liveAvailable = 0,
  activeReserved = 0,
  ownReserved = 0
} = {}) {
  const requested = Number(requestedQuantity);
  const reserved = Number(activeReserved);
  const own = Number(ownReserved);
  const requestableAvailable = stockRequestAvailableQuantity({
    liveAvailable,
    activeReserved: Math.max(
      0,
      (Number.isFinite(reserved) ? reserved : 0) - (Number.isFinite(own) ? own : 0)
    )
  });
  const normalizedRequested = Number.isFinite(requested) && requested > 0 ? requested : 0;
  return {
    requestedQuantity: normalizedRequested,
    requestableAvailable,
    backorderQuantity: Math.max(0, normalizedRequested - requestableAvailable)
  };
}

export function groupStockRequestLinesForTransfer(lines = []) {
  const groups = new Map();
  for (const line of lines || []) {
    const sourceLocationId = locationId(line.sourceLocationId ?? line.source_location_id);
    const destinationLocationId = locationId(line.destinationLocationId ?? line.destination_location_id);
    if (!sourceLocationId || !destinationLocationId || sourceLocationId === destinationLocationId) {
      throw httpError("Every converted line requires different supported source and destination yards.");
    }
    const key = `${sourceLocationId}:${destinationLocationId}`;
    if (!groups.has(key)) groups.set(key, { key, sourceLocationId, destinationLocationId, lines: [] });
    groups.get(key).lines.push(line);
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      lines: [...group.lines].sort((left, right) => Number(left.id) - Number(right.id))
    }))
    .sort((left, right) => left.sourceLocationId - right.sourceLocationId
      || left.destinationLocationId - right.destinationLocationId);
}

export function stockRequestPalletQuantity(lines = []) {
  const byItem = new Map();
  let requiresManualQuantity = false;
  for (const line of lines || []) {
    const itemId = String(line.itemId ?? line.item_id ?? "").trim();
    const salesQty = Number(line.salesQty ?? line.sales_qty);
    const toPlt = positiveConversion(line.toPlt ?? line.to_plt);
    if (!itemId || !Number.isFinite(salesQty) || salesQty <= 0) continue;
    if (!toPlt) {
      requiresManualQuantity = true;
      continue;
    }
    const current = byItem.get(itemId);
    if (current && Math.abs(current.toPlt - toPlt) > 1e-9) {
      throw httpError("The same item has conflicting PLT conversion snapshots.", 409, "STOCK_REQUEST_CONVERSION_CONFLICT");
    }
    byItem.set(itemId, { salesQty: (current?.salesQty || 0) + salesQty, toPlt });
  }
  const automaticQuantity = [...byItem.values()]
    .reduce((sum, item) => sum + Math.ceil(item.salesQty / item.toPlt), 0);
  return { automaticQuantity, requiresManualQuantity };
}

export function stockRequestBucket(request = {}) {
  const lines = Array.isArray(request.lines) ? request.lines : [];
  if (!lines.length) return "pending";
  const statuses = lines.map((line) => String(line.status || "").trim().toLowerCase());
  if (statuses.every((status) => TERMINAL_LINE_STATUSES.has(status))) return "completed";
  if (statuses.some((status) => ["converted", "pending_to", "confirmed", "fulfilled", "pending_receipt", "received"].includes(status))) {
    return "accepted";
  }
  return "pending";
}

export function stockTransferQuantityRevisionBlock(order = {}) {
  if (Number(order.fulfilledQty ?? order.fulfilled_qty ?? 0) > 0) {
    return "This Transfer Order has fulfilled quantity and cannot be revised.";
  }
  const status = String(order.statusText ?? order.status_text ?? order.status ?? "")
    .trim()
    .replaceAll("_", " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2");
  if (/partially fulfilled|pending receipt|partially received|received|closed|cancel(?:led)?/i.test(status)) {
    return `This Transfer Order is ${status || "already executing"} and cannot be revised.`;
  }
  if (/^(?:a|b|pending approval|pending fulfillment|pending local)$/i.test(status)) return null;
  return `This Transfer Order status ${status || "unknown"} is not safe and cannot be revised.`;
}

export function stockRequestMemoMarker(transferId) {
  const id = Number(transferId);
  if (!Number.isInteger(id) || id <= 0) throw httpError("A valid local stock transfer ID is required.");
  return `MBBS-STOCK-REQUEST-TO:${id}`;
}

export function selectStockRequestMarkerTransferOrder(rows = [], {
  transferId,
  sourceLocationId = null,
  destinationLocationId = null
} = {}) {
  const marker = stockRequestMemoMarker(transferId);
  const matches = Array.isArray(rows) ? rows : [];
  if (matches.length > 1) {
    throw Object.assign(new Error(`More than one NetSuite Transfer Order uses marker ${marker}. Reconcile duplicates before retrying.`), {
      status: 409,
      code: "STOCK_REQUEST_DUPLICATE_REMOTE_MARKER",
      stockRequestAttention: true
    });
  }
  if (!matches.length) return null;
  const row = matches[0];
  const id = Number(row.id);
  if (!Number.isInteger(id) || id <= 0) {
    throw Object.assign(new Error(`NetSuite returned an invalid TO ID for ${marker}.`), {
      status: 502,
      stockRequestAttention: true
    });
  }
  const expectedSource = Number(sourceLocationId);
  const actualSource = Number(row.source_location_id ?? row.sourceLocationId);
  if (Number.isInteger(expectedSource) && expectedSource > 0
      && Number.isInteger(actualSource) && actualSource > 0
      && actualSource !== expectedSource) {
    throw Object.assign(new Error("The stock-request TO marker exists under a different NetSuite source location."), {
      status: 409,
      stockRequestAttention: true
    });
  }
  const expectedDestination = Number(destinationLocationId);
  const actualDestination = Number(row.destination_location_id ?? row.destinationLocationId);
  if (Number.isInteger(expectedDestination) && expectedDestination > 0
      && Number.isInteger(actualDestination) && actualDestination > 0
      && actualDestination !== expectedDestination) {
    throw Object.assign(new Error("The stock-request TO marker exists under a different NetSuite destination location."), {
      status: 409,
      stockRequestAttention: true
    });
  }
  return { ...row, id };
}

export function normalizeStockRequestListLimit(value, { defaultLimit = 40, maximum = 100 } = {}) {
  if (value === undefined || value === null || String(value).trim() === "") return defaultLimit;
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed)) return defaultLimit;
  return Math.min(Math.max(parsed, 1), maximum);
}
