const POLICIES = Object.freeze([
  "ALLOWED",
  "APPROVAL_REQUIRED",
  "NOT_RETURNABLE"
]);

export const RETURN_POLICIES = POLICIES;

export function normalizeReturnPolicy(value, { nullable = false } = {}) {
  if (value === null || value === undefined || String(value).trim() === "" || String(value).trim().toUpperCase() === "DEFAULT") {
    if (nullable) return null;
    throw Object.assign(new Error("Select a valid return policy."), { status: 400 });
  }
  const normalized = String(value).trim().toUpperCase().replaceAll("-", "_").replaceAll(" ", "_");
  if (!POLICIES.includes(normalized)) {
    throw Object.assign(new Error("Return policy must be ALLOWED, APPROVAL_REQUIRED, NOT_RETURNABLE, or DEFAULT."), { status: 400 });
  }
  return normalized;
}

export function defaultReturnPolicy(productType) {
  const normalized = String(productType || "")
    .trim()
    .toLowerCase()
    .replaceAll("_", " ")
    .replace(/\s+/g, " ");
  if (normalized === "interlocking") return "ALLOWED";
  if (normalized === "natural stone") {
    return "APPROVAL_REQUIRED";
  }
  return "NOT_RETURNABLE";
}

export function effectiveReturnPolicy({ productType = "", override = null } = {}) {
  const defaultPolicy = defaultReturnPolicy(productType);
  const normalizedOverride = normalizeReturnPolicy(override, { nullable: true });
  return {
    default: defaultPolicy,
    override: normalizedOverride,
    effective: normalizedOverride || defaultPolicy,
    source: normalizedOverride ? "OVERRIDE" : "DEFAULT"
  };
}

function finiteNonNegativeNumber(value, label) {
  if (value === null || value === undefined || value === "") return 0;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw Object.assign(new Error(`${label} must be a non-negative number.`), { status: 400 });
  }
  return number;
}

function wholeNumber(value, label) {
  const number = finiteNonNegativeNumber(value, label);
  if (!Number.isInteger(number)) {
    throw Object.assign(new Error(`${label} must be a whole number.`), { status: 400 });
  }
  return number;
}

export function canonicalReturnQuantity(input = {}, line = {}) {
  const conversions = {
    pallets: finiteNonNegativeNumber(line.toPlt ?? line.to_plt, "PLT conversion"),
    layers: finiteNonNegativeNumber(line.toLyr ?? line.to_lyr, "LYR conversion"),
    sections: finiteNonNegativeNumber(line.toSec ?? line.to_sec, "SEC conversion"),
    pieces: finiteNonNegativeNumber(line.toPcs ?? line.to_pcs, "PCS conversion")
  };
  const hasConversion = Object.values(conversions).some((value) => value > 0);
  if (!hasConversion) {
    const quantity = finiteNonNegativeNumber(
      input.salesQuantity ?? input.sales_quantity ?? input.quantity,
      "Return quantity"
    );
    if (!(quantity > 0)) {
      throw Object.assign(new Error("Return quantity must be above zero."), { status: 400 });
    }
    return {
      entryMode: "sales_uom",
      salesQuantity: quantity,
      pallets: 0,
      layers: 0,
      sections: 0,
      pieces: 0
    };
  }

  const units = {
    pallets: wholeNumber(input.pallets ?? input.palletQuantity ?? 0, "PLT"),
    layers: wholeNumber(input.layers ?? input.layerQuantity ?? 0, "LYR"),
    sections: wholeNumber(input.sections ?? input.sectionQuantity ?? 0, "SEC"),
    pieces: wholeNumber(input.pieces ?? input.pieceQuantity ?? 0, "PCS")
  };
  for (const [key, value] of Object.entries(units)) {
    if (value > 0 && !(conversions[key] > 0)) {
      throw Object.assign(new Error(`${key.toUpperCase()} is unavailable because this item has no valid conversion.`), { status: 400 });
    }
  }
  const quantity = Object.entries(units)
    .reduce((total, [key, value]) => total + (value * conversions[key]), 0);
  if (!(quantity > 0)) {
    throw Object.assign(new Error("At least one return unit must be above zero."), { status: 400 });
  }
  return {
    entryMode: "physical_units",
    salesQuantity: Math.round(quantity * 1e8) / 1e8,
    ...units
  };
}

export function assertCrossYardReturn({
  orderingLocationId,
  receivingLocationId,
  allowCrossYardReturns = false
} = {}) {
  const ordering = Number(orderingLocationId);
  const receiving = Number(receivingLocationId);
  if (!Number.isInteger(ordering) || ordering <= 0 || !Number.isInteger(receiving) || receiving <= 0) {
    throw Object.assign(new Error("A valid ordering and receiving yard are required."), { status: 400 });
  }
  if (ordering === receiving || allowCrossYardReturns) {
    return { crossYard: ordering !== receiving, allowed: true };
  }
  throw Object.assign(new Error(`This return must be processed at location ${ordering}.`), {
    status: 409,
    code: "CROSS_YARD_RETURN_BLOCKED",
    requiredReturnLocation: ordering
  });
}

export function returnBalance({
  fulfilled = 0,
  netsuiteReturned = 0,
  localReserved = 0
} = {}) {
  const values = {
    fulfilled: finiteNonNegativeNumber(fulfilled, "Fulfilled quantity"),
    netsuiteReturned: finiteNonNegativeNumber(netsuiteReturned, "NetSuite returned quantity"),
    localReserved: finiteNonNegativeNumber(localReserved, "Local reserved quantity")
  };
  return {
    ...values,
    available: Math.max(
      Math.round((values.fulfilled - values.netsuiteReturned - values.localReserved) * 1e8) / 1e8,
      0
    )
  };
}

export function deriveStockReturnStatus(lines = []) {
  const statuses = (lines || []).map((line) => line.approvalStatus || line.approval_status);
  if (!statuses.length) return "rejected";
  const pending = statuses.filter((value) => value === "pending").length;
  const rejected = statuses.filter((value) => value === "rejected").length;
  const accepted = statuses.filter((value) => value === "approved" || value === "not_required").length;
  if (pending && accepted) return "partially_pending";
  if (pending) return "pending_approval";
  if (rejected && accepted) return "partially_rejected";
  if (rejected && !accepted) return "rejected";
  return "accepted";
}
