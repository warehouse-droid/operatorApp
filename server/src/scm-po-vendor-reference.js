function text(value) {
  return String(value ?? "").trim();
}

export function resolveScmVendorReference({
  snapshotVendorReference = "",
  currentVendorReference = "",
  source = "reconciliation",
  requestedChanges = {}
} = {}) {
  const incoming = text(snapshotVendorReference).slice(0, 300);
  const explicitApplicationEdit = source === "application"
    && Object.prototype.hasOwnProperty.call(requestedChanges?.header || {}, "vendorReference");
  if (incoming || explicitApplicationEdit) return incoming;
  return text(currentVendorReference).slice(0, 300);
}
