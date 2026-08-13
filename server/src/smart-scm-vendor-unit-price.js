export const SMART_SCM_VENDOR_UNIT_PRICE_MAX = 999_999_999;

function httpError(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function isBlank(value) {
  return value === null || value === undefined || String(value).trim() === "";
}

export function normalizeSmartScmVendorUnitPrice(value, label = "Unit price") {
  if (isBlank(value)) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw httpError(`${label} must be a valid number.`);
  }
  if (parsed <= 0) {
    throw httpError(`${label} must be greater than zero.`);
  }
  if (parsed > SMART_SCM_VENDOR_UNIT_PRICE_MAX) {
    throw httpError(`${label} must be below 1,000,000,000.`);
  }
  const normalized = Math.round((parsed + Number.EPSILON) * 1_000_000) / 1_000_000;
  if (normalized <= 0) {
    throw httpError(`${label} must be greater than zero after six-decimal normalization.`);
  }
  return normalized;
}

export function smartScmVendorUnitPriceEdit(savedDraft = {}, input = {}, {
  updatedAt = null,
  updatedBy = null
} = {}) {
  const draft = savedDraft && typeof savedDraft === "object" && !Array.isArray(savedDraft)
    ? { ...savedDraft }
    : {};
  if (!Object.hasOwn(input || {}, "unitPrice")) {
    return {
      provided: false,
      unitPrice: draft.unitPriceOverride === true
        ? normalizeSmartScmVendorUnitPrice(draft.unitPrice)
        : null,
      draft
    };
  }

  const unitPrice = normalizeSmartScmVendorUnitPrice(input.unitPrice);
  if (unitPrice === null) {
    delete draft.unitPriceOverride;
    delete draft.unitPrice;
    delete draft.unitPriceUpdatedAt;
    delete draft.unitPriceUpdatedBy;
    return { provided: true, unitPrice: null, draft };
  }

  draft.unitPriceOverride = true;
  draft.unitPrice = unitPrice;
  draft.unitPriceUpdatedAt = updatedAt;
  draft.unitPriceUpdatedBy = updatedBy;
  return { provided: true, unitPrice, draft };
}
