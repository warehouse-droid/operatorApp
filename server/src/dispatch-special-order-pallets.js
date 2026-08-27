const MBBS_SPECIAL_ITEM_ID = 2055;
const OFFICIAL_PALLET_ITEM_ID = 1784;

function nonNegativeNumber(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Math.max(parsed, 0) : 0;
}

function normalizedItemLabel(item = {}) {
  return String(item.sku || item.itemName || item.item_name || "").trim().toUpperCase();
}

function isMbbsSpecialItem(item = {}) {
  return Number(item.itemId ?? item.item_id) === MBBS_SPECIAL_ITEM_ID
    || /^MBBS[-\s]*SPECIAL(?:\s+ORDER)?$/u.test(normalizedItemLabel(item));
}

function isOfficialPalletItem(item = {}) {
  return Number(item.itemId ?? item.item_id) === OFFICIAL_PALLET_ITEM_ID
    || normalizedItemLabel(item) === "PALLET";
}

export function specialOrderPalletItemQuantity(items = []) {
  const lines = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!lines.some(isMbbsSpecialItem)) return null;
  const palletLines = lines.filter(isOfficialPalletItem);
  if (!palletLines.length) return null;
  return Number(palletLines.reduce(
    (sum, line) => sum + nonNegativeNumber(line.quantity ?? line.salesQty),
    0
  ).toFixed(6));
}

export function dispatchOrderPalletQuantity({
  items = [],
  reportedPallets = 0,
  fallbackSalesQuantity = 0,
  preserveReportedPallets = false
} = {}) {
  const reported = nonNegativeNumber(reportedPallets);
  if (preserveReportedPallets) return reported;
  const specialPallets = specialOrderPalletItemQuantity(items);
  if (specialPallets !== null) return specialPallets;
  return reported || Math.floor(nonNegativeNumber(fallbackSalesQuantity) / 100);
}
