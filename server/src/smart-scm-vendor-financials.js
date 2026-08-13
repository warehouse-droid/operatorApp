function text(value) {
  return String(value ?? "").trim();
}

function optionalNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveNumber(value) {
  const parsed = optionalNumber(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function nonnegative(value) {
  const parsed = optionalNumber(value);
  return parsed === null ? 0 : Math.max(0, parsed);
}

function normalizedUnit(value) {
  return text(value).toUpperCase().replace(/\s+/g, " ");
}

function accountingRound(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function financialQuantity(line = {}) {
  for (const value of [line.purchaseQuantity, line.salesQuantity, line.quantity]) {
    const parsed = optionalNumber(value);
    if (parsed !== null) return Math.max(0, parsed);
  }
  return nonnegative(line.confirmedPallets ?? line.proposedPallets)
    * nonnegative(line.toPlt);
}

export function smartScmVendorFinancialLine({ line = {}, metadata = {} } = {}) {
  const stockUnit = text(line.unit || metadata.stockUnit || metadata.unit);
  const purchaseUnit = text(line.purchaseUnit) || text(metadata.purchaseUnit) || stockUnit;
  const snapshottedPrice = positiveNumber(line.lastPurchasePrice);
  const vendorPrice = positiveNumber(metadata.vendorPrice);
  const currentLastPurchasePrice = positiveNumber(metadata.lastPurchasePrice);
  const lastPurchasePrice = snapshottedPrice ?? vendorPrice ?? currentLastPurchasePrice;
  const recordedSnapshotSource = text(line.reason?.vendorReplyPriceSnapshot?.source);
  const snapshotSource = ["saved_load", "vendor_price", "last_purchase_price"].includes(recordedSnapshotSource)
    ? recordedSnapshotSource
    : "saved_load";
  const unitPriceSource = snapshottedPrice !== null
    ? snapshotSource
    : vendorPrice !== null
      ? "vendor_price"
      : currentLastPurchasePrice !== null
        ? "last_purchase_price"
        : "unavailable";
  const lastPurchasePriceSyncedAt = snapshottedPrice !== null
    ? line.lastPurchasePriceSyncedAt || null
    : unitPriceSource === "vendor_price"
      ? metadata.vendorPriceSyncedAt || null
      : unitPriceSource === "last_purchase_price"
        ? metadata.lastPurchasePriceSyncedAt || null
        : null;
  const purchaseQuantity = financialQuantity(line);
  const purchaseUnitMismatch = Boolean(normalizedUnit(stockUnit)
    && normalizedUnit(purchaseUnit)
    && normalizedUnit(stockUnit) !== normalizedUnit(purchaseUnit));
  return {
    ...line,
    unit: stockUnit || line.unit || null,
    purchaseUnit: purchaseUnit || null,
    purchaseQuantity,
    purchaseUnitMismatch,
    vendorPrice,
    fallbackLastPurchasePrice: currentLastPurchasePrice,
    lastPurchasePrice,
    lastPurchasePriceSyncedAt,
    unitPriceSource,
    purchaseAmount: lastPurchasePrice === null || purchaseUnitMismatch
      ? null
      : accountingRound(purchaseQuantity * lastPurchasePrice)
  };
}
