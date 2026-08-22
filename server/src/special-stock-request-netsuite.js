import {
  specialPurchaseOrderMarker,
  specialSalesOrderMarker
} from "./special-stock-request-domain.js";

function remoteError(message, code, status = 409) {
  return Object.assign(new Error(message), { code, status, specialStockAttention: true });
}

function reference(id) {
  return { id: String(id) };
}

function finite(value, label, { allowNegative = false } = {}) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || (!allowNegative && normalized <= 0)) {
    throw remoteError(`${label} is invalid.`, "SPECIAL_REMOTE_PAYLOAD_INVALID", 400);
  }
  return normalized;
}

function itemPayload(line, { purchase = false } = {}) {
  const payload = {
    item: reference(line.itemId),
    quantity: finite(line.quantity, "Order quantity"),
    description: String(line.description || "").trim()
  };
  const rate = purchase ? line.unitPurchaseCost ?? line.rate : line.rate;
  if (rate !== undefined && rate !== null && String(rate).trim() !== "") {
    payload.rate = finite(rate, "Order rate", { allowNegative: !purchase });
  }
  return payload;
}

export function buildSpecialSalesOrderPayload({
  caseId,
  draft,
  netsuiteLocationId,
  subsidiaryId = null,
  deliveryMethodId = null,
  pickupMethodId = null
} = {}) {
  const marker = specialSalesOrderMarker(caseId);
  const delivery = draft?.fulfillmentMethod === "mbt_delivery";
  const deliveryMethod = delivery ? deliveryMethodId : pickupMethodId;
  if (!netsuiteLocationId || !deliveryMethod) {
    throw remoteError("NetSuite location and delivery-method mappings are required.", "SPECIAL_REMOTE_CONFIGURATION_MISSING", 503);
  }
  const instructions = delivery
    ? [
        `Delivery Address: ${String(draft.deliveryAddress || "").trim()}`,
        `Delivery Date: ${draft.deliveryDate}`,
        `Delivery Time: ${draft.windowStart}-${draft.windowEnd}`,
        `Drop-off Loc: ${draft.deliveryInstructions}`
      ].join("\n")
    : "";
  const payload = {
    entity: reference(draft.customerId),
    location: reference(netsuiteLocationId),
    custbody3: reference(deliveryMethod),
    memo: ["MBBS Special Item request", marker].join(" | "),
    item: {
      items: [...(draft.materialLines || []), ...(draft.ancillaryLines || [])]
        .map((line) => itemPayload(line))
    }
  };
  if (!payload.item.items.length) {
    throw remoteError("The Special Item Sales Order has no lines.", "SPECIAL_REMOTE_PAYLOAD_INVALID", 400);
  }
  if (subsidiaryId) payload.subsidiary = reference(subsidiaryId);
  if (delivery) {
    payload.custbody4 = draft.deliveryDate;
    payload.custbody7 = instructions;
    // `shipAddress` is the rendered summary returned by NetSuite. A custom
    // transaction address is written through the shippingAddress subrecord.
    payload.shipOverride = true;
    payload.shippingAddress = {
      override: true,
      addrText: String(draft.deliveryAddress || "").trim()
    };
  }
  return payload;
}

export function buildSpecialPurchaseOrderPayload({
  caseId,
  vendorId,
  netsuiteLocationId,
  subsidiaryId = null,
  lines = []
} = {}) {
  const marker = specialPurchaseOrderMarker(caseId);
  if (!vendorId || !netsuiteLocationId) {
    throw remoteError("NetSuite vendor and location mappings are required.", "SPECIAL_REMOTE_CONFIGURATION_MISSING", 503);
  }
  const items = lines.map((line) => itemPayload(line, { purchase: true }));
  if (!items.length) throw remoteError("The Special Item Purchase Order has no lines.", "SPECIAL_REMOTE_PAYLOAD_INVALID", 400);
  const payload = {
    entity: reference(vendorId),
    location: reference(netsuiteLocationId),
    memo: ["MBBS Special Item purchase", marker].join(" | "),
    item: { items }
  };
  if (subsidiaryId) payload.subsidiary = reference(subsidiaryId);
  return payload;
}

export function selectSpecialMarkerRecord(rows = [], { marker, entityId = null, locationId = null } = {}) {
  const matches = Array.isArray(rows) ? rows : [];
  if (matches.length > 1) {
    throw remoteError(`More than one NetSuite transaction uses marker ${marker}.`, "SPECIAL_REMOTE_MARKER_DUPLICATE");
  }
  if (!matches.length) return null;
  const row = matches[0];
  const id = Number(row.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw remoteError(`NetSuite returned an invalid transaction for marker ${marker}.`, "SPECIAL_REMOTE_MARKER_INVALID", 502);
  }
  const actualEntityId = Number(row.entity_id ?? row.entityId);
  const expectedEntityId = Number(entityId);
  const actualLocationId = Number(row.location_id ?? row.locationId);
  const expectedLocationId = Number(locationId);
  if ((Number.isSafeInteger(expectedEntityId) && expectedEntityId > 0
      && actualEntityId !== expectedEntityId)
      || (Number.isSafeInteger(expectedLocationId) && expectedLocationId > 0
        && Number.isSafeInteger(actualLocationId) && actualLocationId > 0
        && actualLocationId !== expectedLocationId)) {
    throw remoteError(`The NetSuite transaction using marker ${marker} belongs to a different entity or location.`, "SPECIAL_REMOTE_MARKER_MISMATCH");
  }
  return { ...row, id };
}
