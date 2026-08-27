import crypto from "node:crypto";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
const QUANTITY_TOLERANCE = 0.000001;

function correctionError(message, code, status = 409) {
  return Object.assign(new Error(message), { code, status });
}

function finiteQuantity(value, label) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw correctionError(`${label} is invalid.`, "REATTEMPT_CORRECTION_QUANTITY_INVALID", 400);
  }
  return Number(parsed.toFixed(6));
}

function comparableQuantity(value) {
  return Number((Number(value ?? 0) || 0).toFixed(6));
}

function fingerprintState(input = {}) {
  return {
    childOrderId: Number(input.childOrderId || 0),
    cycleId: Number(input.cycleId || 0),
    parentSalesOrderId: Number(input.parentSalesOrderId || 0),
    netsuiteLineId: Number(input.netsuiteLineId || 0),
    beforeItemId: Number(input.beforeItemId || 0),
    beforeSku: String(input.beforeSku || ""),
    afterItemId: Number(input.afterItemId || 0),
    afterSku: String(input.afterSku || ""),
    currentSalesQty: comparableQuantity(input.currentSalesQty),
    currentPalletQty: comparableQuantity(input.currentPalletQty),
    targetSalesQty: comparableQuantity(input.targetSalesQty),
    targetPalletQty: comparableQuantity(input.targetPalletQty),
    childStatus: String(input.childStatus || ""),
    cycleStatus: String(input.cycleStatus || "")
  };
}

export function buildReattemptIdentityFingerprint(input = {}) {
  return crypto.createHash("sha256").update(JSON.stringify(fingerprintState(input))).digest("hex");
}

export function normalizeReattemptCorrectionCommand(input = {}) {
  const orderRef = String(input.orderRef || "").trim();
  if (!orderRef || orderRef.length > 100) {
    throw correctionError("A valid re-attempt reference is required.", "REATTEMPT_CORRECTION_ORDER_REF_INVALID", 400);
  }
  const idempotencyKey = String(input.idempotencyKey || "").trim().toLowerCase();
  if (!UUID_PATTERN.test(idempotencyKey)) {
    throw correctionError("A UUID idempotency key is required.", "REATTEMPT_CORRECTION_IDEMPOTENCY_INVALID", 400);
  }
  const expectedStateFingerprint = String(input.expectedStateFingerprint || "").trim().toLowerCase();
  if (!FINGERPRINT_PATTERN.test(expectedStateFingerprint)) {
    throw correctionError("The expected re-attempt state fingerprint is invalid.", "REATTEMPT_CORRECTION_FINGERPRINT_INVALID", 400);
  }
  const reason = String(input.reason || "").trim();
  if (!reason || reason.length > 500) {
    throw correctionError("A correction reason from 1 to 500 characters is required.", "REATTEMPT_CORRECTION_REASON_INVALID", 400);
  }
  if (input.physicallyDeliveredCurrentItem !== true) {
    throw correctionError(
      "Confirm that the physical re-attempt delivered the current item.",
      "REATTEMPT_CORRECTION_PHYSICAL_CONFIRMATION_REQUIRED",
      400
    );
  }
  return {
    orderRef,
    idempotencyKey,
    expectedStateFingerprint,
    reason,
    physicallyDeliveredCurrentItem: true
  };
}

export function applyEffectiveReattemptIdentity(line = {}, correction = null) {
  const historicalItemId = line.historicalItemId ?? line.itemId ?? null;
  const historicalSku = String(line.historicalSku || line.sku || line.itemName || "");
  if (!correction) {
    return {
      ...line,
      historicalItemId,
      historicalSku,
      effectiveItemId: line.itemId ?? null,
      effectiveSku: String(line.sku || line.itemName || ""),
      identityCorrected: false
    };
  }
  const lineSalesQty = finiteQuantity(
    line.salesQty ?? line.quantity ?? line.targetSalesQty ?? line.loadedQty,
    "Re-attempt sales quantity"
  );
  const correctionSalesQty = finiteQuantity(correction.targetSalesQty, "Correction sales quantity");
  const linePalletQty = finiteQuantity(
    line.pallets ?? line.palletQty ?? line.targetPalletQty ?? line.packedPallets,
    "Re-attempt pallet quantity"
  );
  const correctionPalletQty = finiteQuantity(correction.targetPalletQty, "Correction pallet quantity");
  if (
    Math.abs(lineSalesQty - correctionSalesQty) > QUANTITY_TOLERANCE
    || Math.abs(linePalletQty - correctionPalletQty) > QUANTITY_TOLERANCE
  ) {
    throw correctionError(
      "The correction quantity differs from the immutable authorized re-attempt.",
      "REATTEMPT_CORRECTION_QUANTITY_DRIFT"
    );
  }
  const effectiveItemId = correction.afterItemId ?? line.currentItemId ?? line.itemId ?? null;
  const effectiveSku = String(correction.afterSku || line.currentSku || line.sku || "");
  return {
    ...line,
    itemId: effectiveItemId,
    sku: effectiveSku,
    itemName: correction.afterItemName || effectiveSku,
    description: correction.afterDescription || line.description || "",
    itemDescription: correction.afterDescription || line.itemDescription || line.description || "",
    unit: correction.afterSalesUom || line.unit || "",
    salesUom: correction.afterSalesUom || line.salesUom || line.unit || "",
    historicalItemId,
    historicalSku,
    effectiveItemId,
    effectiveSku,
    identityCorrected: true,
    identityCorrectionId: correction.correctionId ?? correction.id ?? null,
    identityCorrectionReason: correction.reason || "",
    identityCorrectedAt: correction.createdAt || null
  };
}

export function evaluateReattemptDriverReadiness(input = {}) {
  if (String(input.workflowKind || "") !== "sales_order_reattempt") {
    return { allowed: true, code: "" };
  }
  const allowed = String(input.cycleStatus || "") === "completed"
    && String(input.completionSource || "") === "operator_load"
    && input.hasOperatorLoad === true;
  return allowed
    ? { allowed: true, code: "" }
    : { allowed: false, code: "DRIVER_REATTEMPT_OPERATOR_LOAD_REQUIRED" };
}
