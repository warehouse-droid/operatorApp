function text(value) {
  return String(value ?? "").trim();
}

function optionalNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizedUnit(value) {
  const normalized = text(value).toUpperCase().replace(/[^A-Z0-9]+/g, "");
  if (["EA", "EACH"].includes(normalized)) return "EACH";
  if (["PC", "PCS", "PIECE", "PIECES"].includes(normalized)) return "PIECE";
  if (["SQFT", "SQUAREFOOT", "SQUAREFEET"].includes(normalized)) return "SQFT";
  return normalized;
}

function sameNumber(left, right) {
  const a = optionalNumber(left);
  const b = optionalNumber(right);
  return a !== null && b !== null && Math.abs(a - b) < 0.000001;
}

function accountingRound(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function proposalIdentity(line = {}) {
  return {
    itemId: positiveInteger(line.itemId ?? line.item_id),
    locationId: positiveInteger(
      line.destinationLocationId
      ?? line.destination_location_id
      ?? line.locationId
      ?? line.location_id
    ),
    unit: normalizedUnit(line.purchaseUnit ?? line.purchase_unit ?? line.unit),
    quantity: optionalNumber(line.purchaseQuantity ?? line.purchase_quantity ?? line.salesQuantity ?? line.sales_quantity)
  };
}

function purchaseOrderIdentity(line = {}) {
  return {
    itemId: positiveInteger(line.itemId ?? line.item_id),
    locationId: positiveInteger(line.locationId ?? line.location_id),
    unit: normalizedUnit(line.unit),
    quantity: optionalNumber(line.quantity)
  };
}

function activeFinancialCandidate(line = {}) {
  const active = line.netsuiteActive ?? line.netsuite_active;
  return active !== false && optionalNumber(line.rate) !== null;
}

function exactCandidates(line, purchaseOrderLines) {
  const proposal = proposalIdentity(line);
  if (!proposal.itemId || !proposal.locationId) return [];
  return purchaseOrderLines.filter((candidate) => {
    if (!candidate || typeof candidate !== "object" || !activeFinancialCandidate(candidate)) return false;
    const order = purchaseOrderIdentity(candidate);
    if (proposal.itemId !== order.itemId || proposal.locationId !== order.locationId) return false;
    return !proposal.unit || !order.unit || proposal.unit === order.unit;
  });
}

function selectCandidate(line, purchaseOrderLines) {
  const candidates = exactCandidates(line, purchaseOrderLines);
  if (candidates.length === 1) return candidates[0];
  if (candidates.length < 2) return null;
  const quantity = proposalIdentity(line).quantity;
  if (quantity === null) return null;
  const quantityMatches = candidates.filter((candidate) => sameNumber(candidate.quantity, quantity));
  return quantityMatches.length === 1 ? quantityMatches[0] : null;
}

function overlayLine(line, candidate) {
  const rate = Math.abs(optionalNumber(candidate.rate));
  const canonicalQuantity = optionalNumber(candidate.quantity);
  const displayQuantity = canonicalQuantity ?? proposalIdentity(line).quantity ?? 0;
  const rawAmount = optionalNumber(candidate.amount);
  const amount = rawAmount === null
    ? accountingRound(Math.abs(displayQuantity) * rate)
    : Math.abs(rawAmount);
  const confirmedPrice = optionalNumber(line.lastPurchasePrice ?? line.last_purchase_price);
  const confirmedAmount = optionalNumber(line.purchaseAmount ?? line.purchase_amount);
  return {
    ...line,
    vendorReplyConfirmedUnitPrice: confirmedPrice,
    vendorReplyConfirmedAmount: confirmedAmount,
    lastPurchasePrice: rate,
    purchaseAmount: amount,
    unitPriceSource: "netsuite_po_rate",
    lastPurchasePriceSyncedAt: candidate.syncedAt ?? candidate.synced_at ?? null,
    netsuitePurchaseOrderLineId: positiveInteger(candidate.lineId ?? candidate.line_id ?? candidate.id),
    netsuitePurchaseQuantity: canonicalQuantity,
    netsuitePurchaseAmount: amount,
    priceChangedSinceVendorReply: confirmedPrice === null || !sameNumber(confirmedPrice, rate)
  };
}

export function overlaySmartScmVendorPoFinancials({ lines = [], purchaseOrderLines = [] } = {}) {
  const sourceLines = Array.isArray(lines) ? lines : [];
  const canonicalLines = Array.isArray(purchaseOrderLines) ? purchaseOrderLines : [];
  if (!sourceLines.length || !canonicalLines.length) return [...sourceLines];
  return sourceLines.map((line) => {
    const candidate = selectCandidate(line, canonicalLines);
    return candidate ? overlayLine(line, candidate) : line;
  });
}
