/** @param {{purchaseOrderRef?:unknown,purchaseOrderReference?:unknown}} detail */
export function specialPurchaseOrderDisplayRef(detail) {
  const native = String(detail.purchaseOrderRef || '').trim();
  const reference = String(detail.purchaseOrderReference || '').trim();
  if (!native) return reference;
  if (!reference || reference.toLowerCase() === native.toLowerCase()) return native;
  return `${native} / ${reference}`;
}

/** @param {unknown} method @returns {'sales'|'dispatch'|null} */
export function poReferenceAlertAudience(method) {
  if (method === 'vendor_pickup') return 'sales';
  if (method === 'yard_pickup' || method === 'mbt_delivery') return 'dispatch';
  return null;
}
