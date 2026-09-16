export function isLocalCoLoaded(co = {}) {
  if (["loaded", "completed"].includes(co.status)) return true;
  return co.status === "planned" && Boolean(co.loaded_at || co.details?.sourceCompletionCleanup);
}

export function projectLoadedCoLine(line, requiredQuantity) {
  return { ...line, loaded_qty: requiredQuantity, confirmed: false,
    packed_pallet_qty: 0, packed_layer_qty: 0, packed_section_qty: 0, packed_piece_qty: 0, packed_sales_qty: 0 };
}
