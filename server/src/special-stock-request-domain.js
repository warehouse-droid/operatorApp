import { normalizeSpecialExpiry } from '../public/special-stock-expiry.js';
import { normalizeSpecialSalesInternalRemark } from '../public/special-stock-internal-remark.js';
import { specialStage } from '../public/special-stock-workflow.js';
import { normalizeSpecialDeliveryFee, specialDeliveryFeeLine } from '../public/special-stock-delivery-fee.js';
import { normalizeSpecialRate, normalizeSpecialDiscount, specialPalletQuantity, assertSpecialDeliveryDate, specialDiscountLineSubtotal as specialLineSubtotal } from '../public/special-stock-pricing.js';
export const SPECIAL_CASE_MAX_LINES = 100;
export const SPECIAL_CASE_MAX_QUANTITY = 1_000_000_000;
export const SPECIAL_MEDIA_MAX_BYTES = 25 * 1024 * 1024;
export const SPECIAL_CASE_UOMS = Object.freeze(["PLT", "LYR", "SEC", "PCS", "EACH", "SQFT"]);

const SPECIAL_YARD_LOCATION_IDS = new Set([1, 28, 15, 26]);
const SPECIAL_CASE_UOM_SET = new Set(SPECIAL_CASE_UOMS);
const SUPPLY_STATUSES = new Set(["in_stock", "low_inventory", "vendor_transfer", "production", "allocation", "no_stock"]);
const AVAILABILITY_MODES = new Set(["dated", "no_projection"]);
const SALES_DECISIONS = new Set(["accepted", "request_update", "declined", "closed"]);
const TERMINAL_SALES_DECISIONS = new Set(["accepted", "declined", "closed"]);
const FULFILLMENT_METHODS = new Set(["vendor_pickup", "yard_pickup", "mbt_delivery"]);
const HANDOFF_ROUTES = new Set(["direct", "via_yard"]);
const MEDIA_MIME_PATTERN = /^(?:image|video)\/[a-z0-9.+-]+$/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function domainError(message, code, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function text(value, { required = false, label = "Value", max = 4_000, code = "SPECIAL_FIELD_REQUIRED" } = {}) {
  const normalized = String(value ?? "").trim().replace(/\r\n?/g, "\n");
  if (required && !normalized) throw domainError(`${label} is required.`, code);
  if (normalized.length > max) throw domainError(`${label} is too long.`, "SPECIAL_FIELD_TOO_LONG");
  return normalized;
}

function positiveId(value, label, code = "SPECIAL_ID_INVALID") {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw domainError(`${label} must be a positive integer.`, code);
  }
  return normalized;
}

function optionalPositiveId(value, label, code = "SPECIAL_ID_INVALID") {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  return positiveId(value, label, code);
}

function finiteNumber(value, label, {
  minimum = 0,
  maximum = SPECIAL_CASE_MAX_QUANTITY,
  allowZero = false,
  code = "SPECIAL_NUMBER_INVALID"
} = {}) {
  const normalized = Number(value);
  const lowerBoundValid = allowZero ? normalized >= minimum : normalized > minimum;
  if (!Number.isFinite(normalized) || !lowerBoundValid || normalized > maximum) {
    throw domainError(`${label} must be a finite ${allowZero ? "non-negative" : "positive"} number.`, code);
  }
  return normalized;
}

function optionalMoney(value, label) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || Math.abs(normalized) > SPECIAL_CASE_MAX_QUANTITY) {
    throw domainError(`${label} must be a finite number.`, "SPECIAL_MONEY_INVALID");
  }
  return normalized;
}

function isoDate(value, { required = false, code = "SPECIAL_DATE_INVALID", label = "Date" } = {}) {
  const normalized = text(value);
  if (!normalized) {
    if (required) throw domainError(`${label} is required.`, code);
    return null;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw domainError(`${label} must use YYYY-MM-DD.`, code);
  }
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== normalized) {
    throw domainError(`${label} is invalid.`, code);
  }
  return normalized;
}

function clockTime(value, label) {
  const normalized = text(value);
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(normalized)) {
    throw domainError(`${label} must use 24-hour HH:MM.`, "SPECIAL_SO_WINDOW_INVALID");
  }
  return normalized;
}

function torontoCalendarDate(now) {
  const value = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(value.getTime())) {
    throw domainError("The working-day calculation date is invalid.", "SPECIAL_CASE_REQUIRED_DATE_INVALID");
  }
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(value).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function minimumSpecialCaseRequiredDate(now = new Date()) {
  return torontoCalendarDate(now);
}

function normalizeCaseLine(line, index, { minimumRequiredDate }) {
  if (!line || typeof line !== "object" || Array.isArray(line)) {
    throw domainError(`Line ${index + 1} is invalid.`, "SPECIAL_CASE_LINES_INVALID");
  }
  const uom = text(line.uom, {
    required: true,
    label: `Line ${index + 1} UOM`,
    max: 40,
    code: "SPECIAL_CASE_UOM_REQUIRED"
  }).toUpperCase();
  if (!SPECIAL_CASE_UOM_SET.has(uom)) {
    throw domainError(
      `Line ${index + 1} UOM must be PLT, LYR, SEC, PCS, EACH, or SQFT.`,
      "SPECIAL_CASE_UOM_INVALID"
    );
  }
  const requiredDate = isoDate(line.requiredDate, {
    required: true,
    label: `Line ${index + 1} required date`,
    code: "SPECIAL_CASE_REQUIRED_DATE_INVALID"
  });
  if (requiredDate < minimumRequiredDate) {
    throw domainError(
      `Line ${index + 1} required date must be ${minimumRequiredDate} or later (requested dates cannot be in the past).`,
      "SPECIAL_CASE_REQUIRED_DATE_TOO_SOON"
    );
  }
  return {
    brand: text(line.brand, { max: 200 }),
    productName: text(line.productName, {
      required: true,
      label: `Line ${index + 1} product name`,
      max: 500,
      code: "SPECIAL_CASE_PRODUCT_REQUIRED"
    }),
    color: text(line.color, { max: 200 }),
    size: text(line.size, { max: 200 }),
    detailSpec: text(line.detailSpec, { max: 2000 }),
    ...Object.fromEntries(["palletQty", "layerQty", "sectionQty", "pieceQty"].map(field => [field, finiteNumber(line[field] ?? 0, field, {allowZero:true,code:"SPECIAL_PACK_QUANTITY_INVALID"})])),
    quantity: finiteNumber(line.quantity, `Line ${index + 1} quantity`, {
      maximum: SPECIAL_CASE_MAX_QUANTITY,
      code: "SPECIAL_CASE_QUANTITY_INVALID"
    }),
    uom,
    rate: normalizeSpecialRate(line.rate),
    discountPercent: normalizeSpecialDiscount(line.discountPercent),
    subtotal: specialLineSubtotal(line.quantity, line.rate, line.discountPercent),
    requiredDate,
    estimateLineReference: text(line.estimateLineReference, { max: 200 }),
    customerNote: text(line.customerNote, { max: 4_000 })
  };
}

/** @param {unknown} lines @param {{existingLineCount:number,minimumRequiredDate?:string}} options @returns {Array<Record<string,any>>} */
export function normalizeSpecialAdditionalLines(lines, {
  existingLineCount,
  minimumRequiredDate = minimumSpecialCaseRequiredDate()
}) {
  if (!Number.isSafeInteger(existingLineCount) || existingLineCount < 1
      || !Array.isArray(lines) || lines.length < 1 || existingLineCount + lines.length > SPECIAL_CASE_MAX_LINES) {
    throw domainError(`A case requires 1 to ${SPECIAL_CASE_MAX_LINES} line items.`, 'SPECIAL_CASE_LINES_INVALID');
  }
  const earliestRequiredDate = isoDate(minimumRequiredDate, {
    required: true, label: 'Minimum required date', code: 'SPECIAL_CASE_REQUIRED_DATE_INVALID'
  });
  return lines.map((line,index) => normalizeCaseLine(line,existingLineCount + index,{minimumRequiredDate:earliestRequiredDate}));
}

/** @param {{palletTotal?:unknown,palletRate?:unknown}} input */
export function normalizeSpecialQuotePallet(input = {}) {
  const palletTotal = specialPalletQuantity(input.palletTotal ?? 0);
  const value = input.palletRate;
  const palletRate = value == null || (typeof value === 'string' && value.trim() === '') ? null : normalizeSpecialRate(value);
  if (palletTotal > 0 && palletRate === null) throw domainError('Review the pallet rate.', 'SPECIAL_PALLET_RATE_REQUIRED');
  if (palletTotal > 0) specialLineSubtotal(palletTotal, palletRate, 0);
  return { palletTotal, palletRate };
}

export function normalizeSpecialCaseDraft(input = {}, {
  authorizedStoreLocationIds = [],
  minimumRequiredDate = minimumSpecialCaseRequiredDate()
} = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw domainError("Special stock request data is required.", "SPECIAL_CASE_INVALID");
  }
  const storeLocationId = positiveId(input.storeLocationId, "Inquiry store", "SPECIAL_CASE_STORE_INVALID");
  if (!SPECIAL_YARD_LOCATION_IDS.has(storeLocationId)) {
    throw domainError("Select a supported inquiry store.", "SPECIAL_CASE_STORE_INVALID");
  }
  const authorized = new Set((authorizedStoreLocationIds || []).map(Number).filter(Number.isSafeInteger));
  if (!authorized.has(storeLocationId)) {
    throw domainError("Your Sales account cannot create a request for this store.", "SPECIAL_CASE_STORE_FORBIDDEN", 403);
  }
  if (!Array.isArray(input.lines) || input.lines.length < 1 || input.lines.length > SPECIAL_CASE_MAX_LINES) {
    throw domainError(`A case requires 1 to ${SPECIAL_CASE_MAX_LINES} line items.`, "SPECIAL_CASE_LINES_INVALID");
  }
  const earliestRequiredDate = isoDate(minimumRequiredDate, {
    required: true,
    label: "Minimum required date",
    code: "SPECIAL_CASE_REQUIRED_DATE_INVALID"
  });
  const salesInternalRemark = /** @type {{salesInternalRemark?:unknown}} */ (input).salesInternalRemark;
  return {
    storeLocationId,
    expiresOn: normalizeSpecialExpiry(input.expiresOn, earliestRequiredDate),
    netsuiteSalesRepId: optionalPositiveId(input.netsuiteSalesRep?.id, "NetSuite Sales Rep"),
    netsuiteSalesRepName: text(input.netsuiteSalesRep?.name, {max:500}),
    ...normalizeSpecialFulfillment(input),
    ...normalizeSpecialQuotePallet(input),
    deliveryFeeRate: normalizeSpecialDeliveryFee(input),
    inquiryDate: isoDate(input.inquiryDate, {
      required: true,
      label: "Inquiry date",
      code: "SPECIAL_CASE_INQUIRY_DATE_INVALID"
    }),
    customerId: optionalPositiveId(input.customerId, "Customer", "SPECIAL_CASE_CUSTOMER_INVALID"),
    customerName: text(input.customerName, {
      required: true,
      label: "Customer name",
      max: 500,
      code: "SPECIAL_CASE_CUSTOMER_REQUIRED"
    }),
    customerPhone: text(input.customerPhone, { max: 100 }),
    vendorId: optionalPositiveId(input.vendorId, "Vendor", "SPECIAL_CASE_VENDOR_INVALID"),
    vendorName: text(input.vendorName, {
      required: true,
      label: "Vendor",
      max: 500,
      code: "SPECIAL_CASE_VENDOR_REQUIRED"
    }),
    requiredDate: isoDate(input.requiredDate, { label: "Case required date" }),
    estimateId: optionalPositiveId(input.estimateId, "Estimate", "SPECIAL_CASE_ESTIMATE_INVALID"),
    estimateNumber: text(input.estimateNumber, { max: 100 }),
    remarks: text(input.remarks, { max: 8_000 }),
    salesInternalRemark: normalizeSpecialSalesInternalRemark(salesInternalRemark === undefined ? '' : salesInternalRemark),
    lines: input.lines.map((line, index) => normalizeCaseLine(line, index, {
      minimumRequiredDate: earliestRequiredDate
    }))
  };
}

function normalizeItemResolution(value, { required }) {
  if (value === undefined || value === null) {
    if (required) throw domainError("Resolve the NetSuite item before responding.", "SPECIAL_RESPONSE_ITEM_REQUIRED");
    return null;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw domainError("The NetSuite item resolution is invalid.", "SPECIAL_RESPONSE_ITEM_INVALID");
  }
  return {
    itemId: positiveId(value.itemId, "NetSuite item", "SPECIAL_RESPONSE_ITEM_INVALID"),
    itemName: text(value.itemName, {
      required: true,
      label: "NetSuite item name",
      max: 500,
      code: "SPECIAL_RESPONSE_ITEM_INVALID"
    }),
    description: text(value.description, {
      required: true,
      label: "Order line description",
      max: 4_000,
      code: "SPECIAL_RESPONSE_ITEM_INVALID"
    }),
    salesUom: text(value.salesUom, {
      required: true,
      label: "Sales UOM",
      max: 40,
      code: "SPECIAL_RESPONSE_ITEM_INVALID"
    }).toUpperCase(),
    purchaseUom: text(value.purchaseUom, {
      required: true,
      label: "Purchase UOM",
      max: 40,
      code: "SPECIAL_RESPONSE_ITEM_INVALID"
    }).toUpperCase(),
    salesQuantity: finiteNumber(value.salesQuantity, "Sales quantity", { code: "SPECIAL_RESPONSE_QUANTITY_INVALID" }),
    purchaseQuantity: value.purchaseQuantity === undefined || value.purchaseQuantity === null || String(value.purchaseQuantity).trim() === ""
      ? null
      : finiteNumber(value.purchaseQuantity, "Purchase quantity", { code: "SPECIAL_RESPONSE_QUANTITY_INVALID" }),
    palletQuantity: value.palletQuantity === undefined || value.palletQuantity === null || String(value.palletQuantity).trim() === ""
      ? null
      : finiteNumber(value.palletQuantity, "Pallet quantity", { code: "SPECIAL_RESPONSE_QUANTITY_INVALID" })
  };
}

export function normalizeSpecialSupplyResponse(input = {}) {
  const supplyStatus = text(input.supplyStatus).toLowerCase();
  if (!SUPPLY_STATUSES.has(supplyStatus)) {
    throw domainError("Select a supported vendor supply status.", "SPECIAL_RESPONSE_STATUS_INVALID");
  }
  const availabilityMode = text(input.availabilityMode).toLowerCase();
  if (!AVAILABILITY_MODES.has(availabilityMode)) {
    throw domainError("Select a dated projection or no projection.", "SPECIAL_RESPONSE_AVAILABILITY_INVALID");
  }
  const suppliedDate = text(input.availableDate);
  if (supplyStatus === 'vendor_transfer' && (availabilityMode !== 'dated' || !suppliedDate)) {
    throw domainError('An ETA is required for stock waiting for transfer.', 'SPECIAL_RESPONSE_DATE_REQUIRED');
  }
  if (availabilityMode === "dated" && !suppliedDate) {
    throw domainError("An estimated available date is required.", "SPECIAL_RESPONSE_DATE_REQUIRED");
  }
  if (availabilityMode === "no_projection" && suppliedDate) {
    throw domainError("Remove the estimated date when no projection is selected.", "SPECIAL_RESPONSE_DATE_CONFLICT");
  }
  const itemResolution = normalizeItemResolution(input.itemResolution, { required: false });
  const productName = /** @type {{productName?: unknown}} */ (input).productName;
  return {
    ...(productName === undefined ? {} : { productName: text(productName, {
      required: true, label: 'Item name', max: 500, code: 'SPECIAL_RESPONSE_PRODUCT_REQUIRED'
    }) }),
    supplyStatus,
    availabilityMode,
    availableDate: availabilityMode === "dated"
      ? isoDate(suppliedDate, { required: true, label: "Estimated available date", code: "SPECIAL_RESPONSE_DATE_INVALID" })
      : null,
    vendorId: positiveId(input.vendorId, "Vendor", "SPECIAL_RESPONSE_VENDOR_INVALID"),
    vendorName: text(input.vendorName, {
      required: true,
      label: "Vendor name",
      max: 500,
      code: "SPECIAL_RESPONSE_VENDOR_INVALID"
    }),
    vendorYard: text(input.vendorYard, { required: supplyStatus !== "no_stock", label: "Vendor yard", max: 1_000, code: "SPECIAL_RESPONSE_YARD_REQUIRED" }),
    vendorReference: text(input.vendorReference, { max: 500 }),
    salesVisibleNote: text(input.salesVisibleNote, { max: 8_000 }),
    scmInternalNote: text(input.scmInternalNote, { max: 8_000 }),
    unitPurchaseCost: optionalMoney(input.unitPurchaseCost, "Unit purchase cost"),
    currency: text(input.currency || "CAD", { required: true, label: "Currency", max: 3 }).toUpperCase(),
    itemResolution,
    createsInternalTransfer: false
  };
}

export function normalizeSpecialSalesDecision(input = {}) {
  const decision = text(input.decision).toLowerCase();
  if (!SALES_DECISIONS.has(decision)) {
    throw domainError("Select a supported customer decision.", "SPECIAL_DECISION_INVALID");
  }
  const reason = text(input.reason, { max: 4_000 });
  if (decision !== "accepted" && !reason) {
    throw domainError("A reason is required for a non-acceptance decision.", "SPECIAL_DECISION_REASON_REQUIRED");
  }
  let itemResolution = null;
  if (decision === "accepted" && input.itemResolution) {
    const value = input.itemResolution;
    if (!value || typeof value !== "object" || Array.isArray(value)
        || !Number.isSafeInteger(Number(value.itemId)) || Number(value.itemId) <= 0) {
      throw domainError(
        "Select the exact NetSuite item, Sales UOM, and Sales quantity before accepting.",
        "SPECIAL_DECISION_ITEM_REQUIRED"
      );
    }
    const salesUom = text(value.salesUom, {
      required: true,
      label: "Sales UOM",
      max: 40,
      code: "SPECIAL_DECISION_ITEM_INVALID"
    }).toUpperCase();
    const salesQuantity = finiteNumber(value.salesQuantity, "Sales quantity", {
      code: "SPECIAL_DECISION_QUANTITY_INVALID"
    });
    itemResolution = {
      itemId: positiveId(value.itemId, "NetSuite item", "SPECIAL_DECISION_ITEM_INVALID"),
      itemName: text(value.itemName, {
        required: true,
        label: "NetSuite item name",
        max: 500,
        code: "SPECIAL_DECISION_ITEM_INVALID"
      }),
      description: text(value.description, {
        required: true,
        label: "Sales Order line description",
        max: 4_000,
        code: "SPECIAL_DECISION_ITEM_INVALID"
      }),
      salesUom,
      purchaseUom: salesUom,
      salesQuantity,
      purchaseQuantity: salesQuantity,
      palletQuantity: value.palletQuantity === undefined || value.palletQuantity === null || String(value.palletQuantity).trim() === ""
        ? null
        : finiteNumber(value.palletQuantity, "Pallet quantity", { code: "SPECIAL_DECISION_QUANTITY_INVALID" })
    };
  }
  return {
    decision,
    customerNote: text(input.customerNote, { max: 8_000 }),
    reason,
    itemResolution
  };
}

export function deriveSpecialCaseStage(evidence = {}) {
  return specialStage(evidence);
}

export function assertSpecialOrderRelease(lines = [], { requireMapping = true } = {}) {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw domainError("The case has no lines to release.", "SPECIAL_RELEASE_LINES_INVALID");
  }
  if (lines.some((line) => !TERMINAL_SALES_DECISIONS.has(String(line?.salesDecision || "").toLowerCase()))) {
    throw domainError("Every case line must have a terminal Sales decision.", "SPECIAL_RELEASE_LINES_PENDING", 409);
  }
  const vendorIds = new Set(lines.map((line) => Number(line?.responseVendorId)).filter((id) => Number.isSafeInteger(id) && id > 0));
  if (vendorIds.size !== 1 || lines.some((line) => !Number.isSafeInteger(Number(line?.responseVendorId)))) {
    throw domainError("Every resolved line must use the same vendor.", "SPECIAL_RELEASE_MIXED_VENDOR", 409);
  }
  const acceptedLines = lines.filter((line) => String(line.salesDecision).toLowerCase() === "accepted");
  if (!acceptedLines.length) {
    throw domainError("At least one line must be accepted before an order can be created.", "SPECIAL_RELEASE_NO_ACCEPTED_LINES", 409);
  }
  if (requireMapping && acceptedLines.some((line) => !Number.isSafeInteger(Number(line?.itemResolution?.itemId)) || Number(line.itemResolution.itemId) <= 0)) {
    throw domainError("Every accepted line requires an exact NetSuite item mapping.", "SPECIAL_RELEASE_ITEM_UNRESOLVED", 409);
  }
  return { vendorId: [...vendorIds][0], acceptedLines };
}

export function assertSpecialPurchaseRelease(lines = []) {
  const release = assertSpecialOrderRelease(lines);
  if (release.acceptedLines.some((line) => line?.poReady !== true)) {
    throw domainError(
      "SCM must review the purchase details for every accepted product before creating or linking a Purchase Order.",
      "SPECIAL_PO_SECOND_RESPONSE_REQUIRED",
      409
    );
  }
  return release;
}

function normalizeOrderLine(line, index, { material }) {
  if (!line || typeof line !== "object" || Array.isArray(line)) {
    throw domainError(`Order line ${index + 1} is invalid.`, "SPECIAL_SO_LINE_INVALID");
  }
  const normalized = {
    itemId: positiveId(line.itemId, `Order line ${index + 1} item`, "SPECIAL_SO_LINE_INVALID"),
    quantity: finiteNumber(line.quantity, `Order line ${index + 1} quantity`, { code: "SPECIAL_SO_LINE_INVALID" }),
    uom: text(line.uom, { max: 40 }).toUpperCase() || null,
    rate: optionalMoney(line.rate, `Order line ${index + 1} rate`),
    description: text(line.description, { max: 4_000 })
  };
  if (material) {
    normalized.discountPercent = line.discountPercent === undefined ? null : normalizeSpecialDiscount(line.discountPercent);
    normalized.packageQuantity = line.packageQuantity ?? null;
    normalized.conversionToPc = line.conversionToPc ?? null;
    normalized.caseLineId = positiveId(line.caseLineId, `Order line ${index + 1} case line`, "SPECIAL_SO_LINE_INVALID");
    if (normalized.itemId !== 2055) throw domainError('Special products must use MBBS-Special Order.', 'SPECIAL_SO_ITEM_INVALID');
    if (!normalized.description || !normalized.uom || normalized.rate === null || normalized.rate < 0) {
      throw domainError('Review the description, Sales UOM, quantity, and price for every product.', 'SPECIAL_SO_LINE_INVALID');
    }
  }
  return normalized;
}

function normalizeStagedMedia(media, index) {
  if (!media || typeof media !== "object" || Array.isArray(media)) {
    throw domainError(`Delivery media ${index + 1} is invalid.`, "SPECIAL_SO_MEDIA_INVALID");
  }
  const id = text(media.id).toLowerCase();
  const mimeType = text(media.mimeType).toLowerCase();
  const byteSize = Number(media.byteSize);
  if (!UUID_PATTERN.test(id) || !MEDIA_MIME_PATTERN.test(mimeType)
      || !Number.isSafeInteger(byteSize) || byteSize < 1 || byteSize > SPECIAL_MEDIA_MAX_BYTES) {
    throw domainError(`Delivery media ${index + 1} is invalid or exceeds 25 MB.`, "SPECIAL_SO_MEDIA_INVALID");
  }
  return { id, mimeType, byteSize };
}

export function normalizeSpecialFulfillment(input = {}) {
  const fulfillmentMethod = text(input.fulfillmentMethod).toLowerCase();
  if (!FULFILLMENT_METHODS.has(fulfillmentMethod)) throw domainError('Select a delivery method.', 'SPECIAL_SO_FULFILLMENT_INVALID');
  const delivery = fulfillmentMethod === 'mbt_delivery';
  const fields = { fulfillmentMethod };
  for (const key of ['deliveryAddress', 'deliveryContactName', 'deliveryContactPhone']) {
    fields[key] = delivery ? text(input[key], { required: key === 'deliveryAddress', label: key.replace(/([A-Z])/g, ' $1'), max: 2000, code: 'SPECIAL_SO_DELIVERY_REQUIRED' }) : null;
  }
  fields.deliveryDate = delivery ? isoDate(input.deliveryDate, { label: 'Delivery date' }) : null;
  fields.deliveryInstructions = delivery ? text(input.deliveryInstructions, { max: 8000 }) : null;
  fields.windowStart = delivery && text(input.windowStart) ? clockTime(input.windowStart, 'Window start') : null;
  fields.windowEnd = delivery && text(input.windowEnd) ? clockTime(input.windowEnd, 'Window end') : null;
  if (Boolean(fields.windowStart) !== Boolean(fields.windowEnd) || (fields.windowStart && fields.windowStart >= fields.windowEnd)) {
    throw domainError('Provide a complete delivery window with end after start.', 'SPECIAL_SO_WINDOW_INVALID');
  }
  return fields;
}

export function normalizeSpecialSalesOrderDraft(input = {}, { now = new Date() } = {}) {
  const fulfillmentMethod = text(input.fulfillmentMethod).toLowerCase();
  if (!FULFILLMENT_METHODS.has(fulfillmentMethod)) {
    throw domainError("Select a supported fulfillment method.", "SPECIAL_SO_FULFILLMENT_INVALID");
  }
  const operationalYardLocationId = positiveId(input.operationalYardLocationId, "Operational yard", "SPECIAL_SO_YARD_INVALID");
  if (!SPECIAL_YARD_LOCATION_IDS.has(operationalYardLocationId)) {
    throw domainError("Select a supported operational yard.", "SPECIAL_SO_YARD_INVALID");
  }
  if (!Array.isArray(input.materialLines) || !input.materialLines.length) {
    throw domainError("At least one accepted material line is required.", "SPECIAL_SO_MATERIAL_LINES_REQUIRED");
  }
  const materialLines = input.materialLines.map((line, index) => normalizeOrderLine(line, index, { material: true }));
  if (new Set(materialLines.map((line) => line.caseLineId)).size !== materialLines.length) {
    throw domainError("Each accepted case line may appear only once in the Sales Order.", "SPECIAL_SO_LINE_DUPLICATE");
  }
  const identities = materialLines.map(line => JSON.stringify([line.itemId, normalizedOrderDescription(line.description, 'MBBS-Special Order'), line.quantity, normalizedOrderText(line.uom)]));
  if (new Set(identities).size !== identities.length) throw domainError('Use distinct descriptions for otherwise identical product lines so each SO line can be verified.', 'SPECIAL_ORDER_LINE_AMBIGUOUS');
  const ancillaryInput = input.ancillaryLines ?? [];
  if (!Array.isArray(ancillaryInput)) throw domainError("Ancillary order lines are invalid.", "SPECIAL_SO_LINE_INVALID");
  const deliveryFeeRate = normalizeSpecialDeliveryFee({ ...input, fulfillmentMethod });
  const ancillaryLines = ancillaryInput.filter(line => Number(line?.itemId) !== 1987
    || (fulfillmentMethod === 'mbt_delivery' && deliveryFeeRate == null))
    .map((line, index) => normalizeOrderLine(line, index, { material: false }));
  if (!['number', 'string'].includes(typeof input.palletTotal) || input.palletTotal === undefined || input.palletTotal === null || String(input.palletTotal).trim() === ''
      || !Number.isSafeInteger(Number(input.palletTotal)) || Number(input.palletTotal) < 0 || Number(input.palletTotal) > SPECIAL_CASE_MAX_QUANTITY) {
    throw domainError('Pallets needed must be a whole number of zero or more.', 'SPECIAL_PALLET_TOTAL_INVALID');
  }
  const palletTotal = Number(input.palletTotal);
  if (ancillaryLines.some(line => line.itemId === 1784)) throw domainError('Use Pallets needed for the PALLET line.', 'SPECIAL_PALLET_DUPLICATE');
  const palletRate = optionalMoney(input.palletRate, 'Pallet rate');
  if (palletRate !== null && palletRate < 0) throw domainError('Pallet rate cannot be negative.', 'SPECIAL_PALLET_RATE_REQUIRED');
  if (palletTotal > 0) {
    if (palletRate === null || palletRate < 0) throw domainError('Review the pallet rate.', 'SPECIAL_PALLET_RATE_REQUIRED');
    ancillaryLines.push({ itemId: 1784, description: 'PALLET', quantity: palletTotal, uom: 'EACH', rate: palletRate });
  }
  const mediaInput = input.media ?? [];
  if (deliveryFeeRate != null) ancillaryLines.push(specialDeliveryFeeLine(deliveryFeeRate));
  if (!Array.isArray(mediaInput)) throw domainError("Delivery media is invalid.", "SPECIAL_SO_MEDIA_INVALID");
  const media = mediaInput.map(normalizeStagedMedia);

  const fulfillment = normalizeSpecialFulfillment(input);
  if (fulfillment.fulfillmentMethod === 'mbt_delivery') assertSpecialDeliveryDate(fulfillment.deliveryDate, { now });

  return {
    customerId: positiveId(input.customerId, "Customer", "SPECIAL_SO_CUSTOMER_REQUIRED"),
    operationalYardLocationId,
    ...fulfillment,
    palletTotal,
    palletRate,
    deliveryFeeRate,
    media,
    materialLines,
    ancillaryLines
  };
}

export function normalizeSpecialHandoffRoute({ fulfillmentMethod, requestedRoute } = {}) {
  const method = text(fulfillmentMethod).toLowerCase();
  if (!FULFILLMENT_METHODS.has(method)) {
    throw domainError("Select a supported fulfillment method.", "SPECIAL_ROUTE_FULFILLMENT_INVALID");
  }
  if (method === "vendor_pickup") return { required: false, route: "none" };
  const route = text(requestedRoute).toLowerCase();
  if (!HANDOFF_ROUTES.has(route)) {
    throw domainError("Select Direct or Via Yard before planning.", "SPECIAL_ROUTE_REQUIRED");
  }
  if (method === "yard_pickup" && route !== "via_yard") {
    throw domainError("Customer pickup at an MBBS yard must route via that yard.", "SPECIAL_ROUTE_FORBIDDEN", 409);
  }
  return { required: true, route };
}

export function normalizeSpecialVendorPickupCompletion(input = {}) {
  return {
    pickupDate: isoDate(input.pickupDate, {
      required: true,
      label: "Customer pickup date",
      code: "SPECIAL_VENDOR_PICKUP_DATE_REQUIRED"
    }),
    pickupReference: text(input.pickupReference, {
      required: true,
      label: "Customer pickup reference",
      max: 500,
      code: "SPECIAL_VENDOR_PICKUP_REFERENCE_REQUIRED"
    })
  };
}

function normalizedOrderText(value) {
  return String(value || "").normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizedOrderDescription(value, itemName = "") {
  const item = normalizedOrderText(itemName);
  const parts = String(value || "").normalize("NFKC").split(/\r?\n/u)
    .map(normalizedOrderText).filter(Boolean);
  if (parts.length && item && parts[0] === item) parts.shift();
  return parts.join(" ");
}

/**
 * One-to-one coverage matcher used before a manual link and after a newly
 * created NetSuite order reaches the canonical mirror. It deliberately
 * rejects extras: an operator must review every commercial line in the case.
 */
export function matchSpecialOrderCoverage(expectedLines = [], canonicalLines = [], { orderKind = "order", reviewedDescriptionChanges = [] } = {}) {
  if (!Array.isArray(expectedLines) || !expectedLines.length) {
    throw domainError(`Save the reviewed ${orderKind} lines before linking.`, "SPECIAL_ORDER_DRAFT_REQUIRED", 409);
  }
  const candidates = (Array.isArray(canonicalLines) ? canonicalLines : [])
    .filter((line) => line?.active !== false)
    .map((line) => ({ ...line, used: false }))
    .sort((left, right) => Number(left.id) - Number(right.id));
  const mappings = [];
  for (const expected of [...expectedLines].sort((left, right) => Number(left.id) - Number(right.id))) {
    const expectedDescription = normalizedOrderDescription(expected.description, expected.itemName);
    // A pending SCM review is an alternative complete tuple only for this
    // already-linked special-item line. Never accept a mix of old/new values.
    const reviewedChange = Number(expected.itemId) === 2055 && Number(expected.remoteLineId) > 0
      ? reviewedDescriptionChanges.find(change => Number(change.expectedLineId) === Number(expected.id)
        && Number(change.remoteLineId) === Number(expected.remoteLineId)) : null;
    const reviewedDescription = normalizedOrderDescription(reviewedChange?.description, expected.itemName);
    const matches = candidates.map((candidate, index) => ({ candidate, index })).filter(({ candidate }) => {
      if (expected.remoteLineId && Number(candidate.lineId) !== Number(expected.remoteLineId)) return false;
      if (candidate.used || Number(candidate.itemId) !== Number(expected.itemId)) return false;
      if (!Number.isSafeInteger(Number(candidate.id)) || Number(candidate.id) <= 0
          || !Number.isSafeInteger(Number(candidate.lineId)) || Number(candidate.lineId) <= 0) return false;
      const candidateUom = normalizedOrderText(candidate.uom);
      const candidateDescription = normalizedOrderDescription(candidate.description, candidate.itemName);
      const tupleMatches = (quantity, uom, description) => Number.isFinite(Number(candidate.quantity))
        && Math.abs(Number(candidate.quantity) - Number(quantity)) <= 0.000001
        && (!normalizedOrderText(uom) || normalizedOrderText(uom) === candidateUom)
        && (!description || description === candidateDescription);
      return tupleMatches(expected.quantity, expected.uom, expectedDescription)
        || (Boolean(reviewedDescription) && tupleMatches(reviewedChange.quantity ?? expected.quantity,
          reviewedChange.uom ?? expected.uom, reviewedDescription));
    });
    if (matches.length > 1) throw domainError('The reviewed order has indistinguishable lines; verify their identities before linking.', 'SPECIAL_ORDER_LINE_AMBIGUOUS', 409);
    const index = matches[0]?.index ?? -1;
    if (index < 0) {
      throw domainError(
        `${orderKind} does not contain the exact reviewed item, quantity, UOM, and description for ${expected.itemName || expected.itemId}.`,
        "SPECIAL_ORDER_COVERAGE_MISMATCH",
        409
      );
    }
    candidates[index].used = true;
    mappings.push({ expectedLineId: Number(expected.id), canonicalLineId: Number(candidates[index].id), remoteLineId: Number(candidates[index].lineId) });
  }
  const unexpected = candidates.filter((candidate) => !candidate.used);
  if (unexpected.length) {
    throw domainError(
      `${orderKind} has ${unexpected.length} unreviewed item line(s). Save those lines in the case or select another order.`,
      "SPECIAL_ORDER_COVERAGE_EXTRA_LINES",
      409
    );
  }
  return mappings;
}

function marker(caseId, type) {
  const id = positiveId(caseId, "Special case ID", "SPECIAL_CASE_ID_INVALID");
  return `MBBS-SPECIAL-${type}:${id}`;
}

export function specialSalesOrderMarker(caseId) {
  return marker(caseId, "SO");
}

export function specialPurchaseOrderMarker(caseId) {
  return marker(caseId, "PO");
}
