// @ts-check

import crypto from "node:crypto";

import { query } from "../db.js";
import { canonicalSha256, canonicalize } from "./canonical-json.js";
import { executeMbtCommand } from "./command-repository.js";
import { calculateDistanceBandChargeMinor } from "./distance-band-pricing.js";
import { MbtError } from "./errors.js";
import {
  calculateBillingUnitAmount,
  resolveManualBillingAmount
} from "./mbbs-driver-billing-planner.js";
import { requireMbbsRateCardPolicy } from "./mbbs-rate-card-policy.js";
import {
  calculateMbbsPurchaseRouteAmount,
  normalizeMbbsVendorRouteRates,
  selectMbbsVendorRouteRate
} from "./mbbs-vendor-route-rates.js";
import {
  calculateTorontoRentalExtensionDays,
  calculateMbbsCrossCharges,
  calculateMbtLocalBilling
} from "./local-billing-calculator.js";
import { selectRateBand } from "./rate-bands.js";
import { assertExpectedRevision, nextRevision } from "./revisions.js";

const QUANTITY_SCALE = 1_000_000;

/** @typedef {import("./audit-repository.js").MbtActor} MbtActor */

/** @param {number} status @param {string} code @param {string} message */
function failure(status, code, message) {
  return new MbtError({ status, code, message });
}

/** @param {unknown} value @param {string} label */
function requiredText(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw failure(400, "MBT_BILLING_INPUT_INVALID", `${label} is required.`);
  }
  return normalized;
}

/** @param {unknown} value @param {string} label */
function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw failure(400, "MBT_BILLING_INPUT_INVALID", `${label} is required.`);
  }
  return /** @type {Record<string, any>} */ (value);
}

/** @param {unknown} value */
function billingActor(value) {
  const supplied = object(value, "Billing actor");
  const roles = Array.isArray(supplied.roles)
    ? supplied.roles.map((role) => String(role).trim().toLowerCase()).filter(Boolean)
    : [];
  if (!roles.includes("admin") && !roles.includes("mbt_billing")) {
    throw failure(403, "MBT_BILLING_FORBIDDEN", "An MBT Billing or Admin actor is required.");
  }
  return /** @type {MbtActor} */ ({
    operatorId: requiredText(supplied.operatorId, "Actor ID"),
    roles,
    actorType: String(supplied.actorType || "operator")
  });
}

/** @param {unknown} value @param {string} label */
function uuid(value, label) {
  const normalized = requiredText(value, label).toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(normalized)) {
    throw failure(400, "MBT_BILLING_INPUT_INVALID", `${label} must be a UUID.`);
  }
  return normalized;
}

/** @param {unknown} value @param {string} label */
function nonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw failure(422, "MBT_BILLING_MONEY_INVALID", `${label} must be a non-negative safe integer.`);
  }
  return Number(value);
}

/** @param {unknown} value */
function cad(value) {
  const normalized = requiredText(value, "Currency").toUpperCase();
  if (normalized !== "CAD") {
    throw failure(409, "MBT_BILLING_CURRENCY_MISMATCH", "P3.10 local billing requires CAD evidence.");
  }
  return normalized;
}

/** @param {unknown} value */
function canonicalObject(value) {
  return /** @type {Record<string, any>} */ (canonicalize(object(value, "Snapshot")));
}

/** @param {string} hash */
function deterministicUuid(hash) {
  const value = hash.slice(0, 32).split("");
  value[12] = "5";
  value[16] = ((Number.parseInt(value[16] || "0", 16) & 0x3) | 0x8).toString(16);
  const hex = value.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** @param {string} scope @param {unknown} identity */
function stableId(scope, identity) {
  return deterministicUuid(canonicalSha256({ scope, identity }));
}

/** @param {unknown} value @param {string} label */
function decimalMicrounits(value, label) {
  const normalized = String(value ?? "").trim();
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/u.test(normalized)) {
    throw failure(422, "MBT_BILLING_QUANTITY_INVALID", `${label} must have at most six decimal places.`);
  }
  const [whole, fraction = ""] = normalized.split(".");
  const result = (Number(whole) * QUANTITY_SCALE) + Number(fraction.padEnd(6, "0"));
  if (!Number.isSafeInteger(result) || result < 0) {
    throw failure(422, "MBT_BILLING_QUANTITY_INVALID", `${label} exceeds the safe quantity range.`);
  }
  return result;
}

/** @param {number} value */
function decimalQuantity(value) {
  const whole = Math.floor(value / QUANTITY_SCALE);
  const fraction = String(value % QUANTITY_SCALE).padStart(6, "0");
  return `${whole}.${fraction}`;
}

/** @param {unknown} value */
function databaseIso(value) {
  return value === null || value === undefined ? null : new Date(String(value)).toISOString();
}

/** @param {Record<string, any>} row */
function publicLine(row) {
  return {
    billingLineId: String(row.billing_line_id),
    sequenceNumber: Number(row.sequence_number),
    lineKey: String(row.line_key),
    lineType: String(row.line_type),
    description: String(row.description),
    quantity: String(row.quantity),
    unitOfMeasure: String(row.unit_of_measure),
    unitAmountMinor: Number(row.unit_amount_minor),
    netAmountMinor: Number(row.net_amount_minor),
    estimatedTaxMinor: Number(row.estimated_tax_minor),
    totalAmountMinor: Number(row.total_amount_minor),
    currency: String(row.currency),
    localItemCode: String(row.local_item_code),
    localItemRevision: Number(row.local_item_revision),
    deduplicationKey: row.deduplication_key === null ? null : String(row.deduplication_key),
    customerChargeMinor: row.customer_charge_minor === null ? null : Number(row.customer_charge_minor),
    actualCostMinor: row.actual_cost_minor === null ? null : Number(row.actual_cost_minor),
    marginMinor: row.margin_minor === null ? null : Number(row.margin_minor),
    calculationDetail: row.calculation_detail
  };
}

/** @param {string} versionId */
async function selectedBillingLines(versionId) {
  const result = await query(
    `SELECT billing_line_id, sequence_number, line_key, line_type, description,
            quantity::text AS quantity, unit_of_measure, unit_amount_minor,
            net_amount_minor, estimated_tax_minor, total_amount_minor,
            currency, local_item_code, local_item_revision,
            deduplication_key, customer_charge_minor, actual_cost_minor,
            margin_minor, calculation_detail
       FROM mbt_billing_lines
      WHERE billing_version_id = $1
      ORDER BY sequence_number, billing_line_id`,
    [versionId]
  );
  return result.rows.map(publicLine);
}

/** @param {Record<string, any>} row @param {Array<Record<string, any>>} lines */
function draftBody(row, lines) {
  const calculation = row.calculation_snapshot;
  return {
    schemaVersion: "mbt-local-billing-draft-v1",
    billingCaseId: String(row.billing_case_id),
    billingVersionId: String(row.billing_version_id),
    versionNumber: Number(row.version_number),
    status: String(row.status),
    postingMode: String(row.posting_mode),
    subtotalMinor: Number(row.subtotal_minor),
    estimatedTaxMinor: Number(row.estimated_tax_minor),
    totalMinor: Number(row.total_minor),
    currency: String(row.currency),
    caseRevision: nextRevision(Number(row.billing_case_revision_before)),
    lines,
    dumpEconomics: calculation?.dumpEconomics ?? null,
    amendsBillingVersionId: row.original_billing_version_id
      ? String(row.original_billing_version_id)
      : null
  };
}

/** @param {string} billingVersionId */
async function selectedDraft(billingVersionId) {
  const result = await query(
    `SELECT version.*, amendment.original_billing_version_id
       FROM mbt_billing_versions version
       LEFT JOIN mbt_billing_version_amendments amendment
         ON amendment.amended_billing_version_id = version.billing_version_id
      WHERE version.billing_version_id = $1`,
    [billingVersionId]
  );
  if (!result.rowCount) {
    throw failure(500, "MBT_BILLING_DRAFT_INCOMPLETE", "The local billing draft was not retained.");
  }
  const lines = await selectedBillingLines(billingVersionId);
  return draftBody(result.rows[0], lines);
}

/** @param {string} billingCaseId */
async function selectedBillingCase(billingCaseId) {
  const result = await query(
    `SELECT billing_case.*, contract.customer_netsuite_id AS contract_customer_id,
            contract.rate_card_version_id,
            COALESCE(service_line.bin_type_id, contract.bin_type_id) AS bin_type_id,
            contract.tax_snapshot,
            COALESCE(service_line.pricing_snapshot, contract.pricing_snapshot) AS pricing_snapshot,
            contract.revision AS contract_revision,
            COALESCE(service_line.actual_delivery_completed_at,
                     contract.actual_delivery_completed_at) AS actual_delivery_completed_at,
            COALESCE(service_line.actual_collected_at,
                     contract.actual_closed_at) AS actual_closed_at,
            COALESCE(service_line.planned_return_at,
                     contract.planned_return_at) AS planned_return_at,
            contract.rental_calendar_days,
            bin_type.type_code AS bin_type_code
       FROM mbt_billing_cases billing_case
       JOIN mbt_contracts contract USING (contract_id)
       JOIN mbt_service_visits visit
         ON visit.service_visit_id = billing_case.service_visit_id
       LEFT JOIN mbt_contract_service_lines service_line
         ON service_line.service_line_id = visit.service_line_id
       JOIN mbt_bin_types bin_type
         ON bin_type.bin_type_id = COALESCE(service_line.bin_type_id, contract.bin_type_id)
      WHERE billing_case.billing_case_id = $1
      FOR UPDATE OF billing_case`,
    [billingCaseId]
  );
  if (!result.rowCount) {
    throw failure(404, "MBT_BILLING_CASE_NOT_FOUND", "The local billing case was not found.");
  }
  return result.rows[0];
}

/** @param {Record<string, any>} billingCase */
function assertLocalMbtCase(billingCase) {
  if (String(billingCase.case_type) !== "mbt_contract") {
    throw failure(409, "MBT_BILLING_CASE_TYPE_INVALID", "This operation requires an MBT contract billing case.");
  }
  if (String(billingCase.posting_mode) !== "local_only") {
    throw failure(409, "MBT_BILLING_POSTING_MODE_INVALID", "P3.10 can calculate only local-only billing cases.");
  }
  cad(billingCase.currency);
}

/** @param {Record<string, any>} input @param {Record<string, any>} billingCase */
async function selectedCalculationVisit(input, billingCase) {
  const visitId = uuid(input.serviceVisitId, "Service-visit ID");
  if (String(billingCase.service_visit_id) !== visitId) {
    throw failure(409, "MBT_BILLING_VISIT_MISMATCH", "The service visit is not the billing case source visit.");
  }
  const visitResult = await query(
    `SELECT service_visit_id, contract_id, revision, service_action,
            status, actual_completed_at, service_snapshot
       FROM mbt_service_visits
      WHERE service_visit_id = $1
        AND contract_id = $2`,
    [visitId, billingCase.contract_id]
  );
  if (!visitResult.rowCount) {
    throw failure(409, "MBT_BILLING_VISIT_MISMATCH", "The service visit does not belong to the billing contract.");
  }
  const visit = visitResult.rows[0];
  if (String(visit.status) !== "completed" || !visit.actual_completed_at) {
    throw failure(409, "MBT_BILLING_VISIT_INCOMPLETE", "Local shadow billing requires a durably completed service visit.");
  }
  return { visitId, visit };
}

/**
 * New Front Desk BIN lines price delivery through the selected delivery-fee
 * item's own rate card. The contract still retains its operational rate card
 * for rental/visit rules, so the immutable visit distance can legitimately
 * carry a different version. Accept that seam only when all of the delivery
 * identifiers and cents exactly match the locked service-line snapshot.
 *
 * @param {Record<string, any>} distance
 * @param {Record<string, any>} billingCase
 */
function matchesLockedItemDelivery(distance, billingCase) {
  const pricing = billingCase.pricing_snapshot;
  if (!pricing || typeof pricing !== "object" || Array.isArray(pricing)
      || !Array.isArray(pricing.lines)) {
    return false;
  }
  return pricing.lines.some((/** @type {Record<string, any>} */ line) => {
    if (!line || typeof line !== "object" || Array.isArray(line)
        || line.code !== "one_way_delivery"
        || !Number.isSafeInteger(line.amountMinor)) {
      return false;
    }
    return String(line.rateCardVersionId || "") === String(distance.rate_card_version_id)
      && String(line.rateDistanceBandId || "") === String(distance.rate_distance_band_id)
      && Number(line.amountMinor) === Number(distance.calculated_amount_minor);
  });
}

/** @param {Record<string, any>} input @param {Record<string, any>} billingCase @param {string} visitId */
async function selectedCalculationDistance(input, billingCase, visitId) {
  const distanceId = uuid(input.distanceSnapshotId, "Distance-snapshot ID");
  const distanceResult = await query(
    `SELECT distance_snapshot_id, subject_type, subject_id,
            rate_card_version_id, rate_distance_band_id, provider,
            provider_metres, origin_snapshot, destination_snapshot,
            calculated_amount_minor, currency, override_metres,
            override_amount_minor, override_reason, overridden_by,
            overridden_at
       FROM mbt_distance_snapshots
      WHERE distance_snapshot_id = $1`,
    [distanceId]
  );
  if (!distanceResult.rowCount) {
    throw failure(404, "MBT_BILLING_DISTANCE_NOT_FOUND", "The immutable billing distance was not found.");
  }
  const distance = distanceResult.rows[0];
  const contractRateMatches = String(distance.rate_card_version_id) === String(billingCase.rate_card_version_id);
  if (String(distance.subject_type) !== "visit" || String(distance.subject_id) !== visitId
      || (!contractRateMatches && !matchesLockedItemDelivery(distance, billingCase))) {
    throw failure(409, "MBT_BILLING_DISTANCE_MISMATCH", "The distance snapshot does not match the visit and locked rate version.");
  }
  cad(distance.currency);
  return { distanceId, distance };
}

/** @param {Record<string, any>} billingCase */
async function selectedCalculationLocalItem(billingCase) {
  const localItemResult = await query(
    `SELECT item_code, revision, pricing_mode
       FROM mbt_local_item_settings
      WHERE item_code = $1
        AND active`,
    [billingCase.bin_type_code]
  );
  if (!localItemResult.rowCount) {
    throw failure(409, "MBT_BILLING_LOCAL_ITEM_INVALID", "The locked bin local item is not active.");
  }
  return {
    code: String(localItemResult.rows[0].item_code),
    revision: Number(localItemResult.rows[0].revision)
  };
}

/** @param {Record<string, any>} component @param {Record<string, any>} suppliedQuantities @param {Record<string, any>} localItem */
function calculatedComponentEvidence(component, suppliedQuantities, localItem) {
  const supportedTypes = {
    rental: "rental",
    extension: "extension",
    exchange: "exchange",
    pickup: "pickup",
    downtown_surcharge: "surcharge",
    service: "surcharge",
    discount: "discount",
    other: "surcharge"
  };
  const componentKind = String(component.component_kind);
  const lineType = /** @type {Record<string, string>} */ (supportedTypes)[componentKind];
  if (!lineType) {
    throw failure(409, "MBT_BILLING_RATE_COMPONENT_INVALID", `Unsupported configured component kind: ${componentKind}.`);
  }
  const componentCode = String(component.component_code);
  const rateBasis = String(component.rate_basis);
  const currency = cad(component.currency);
  const quantityValue = Object.hasOwn(suppliedQuantities, componentCode)
    ? suppliedQuantities[componentCode]
    : component.default_quantity;
  return {
    componentId: String(component.rate_component_id),
    lineCode: componentCode,
    lineType,
    rateBasis,
    amountMinor: component.amount_minor === null ? undefined : Number(component.amount_minor),
    percentageBasisPoints: component.percentage_basis_points === null
      ? undefined
      : Number(component.percentage_basis_points),
    quantityMicrounits: rateBasis === "flat" || rateBasis === "percentage"
      ? QUANTITY_SCALE
      : decimalMicrounits(quantityValue, `Quantity for ${componentCode}`),
    currency,
    taxable: component.taxable === true,
    description: String(component.description || componentCode),
    localItem
  };
}

/** @param {Record<string, any>} input @param {Record<string, any>} billingCase @param {Record<string, any>} visit @param {Record<string, any>} localItem */
async function selectedCalculationComponents(input, billingCase, visit, localItem) {
  const serviceCode = String(visit.service_action);
  const componentsResult = await query(
    `SELECT rate_component_id, component_code, component_kind, rate_basis,
            amount_minor, percentage_basis_points, default_quantity::text,
            currency, taxable, description
       FROM mbt_rate_components
      WHERE rate_card_version_id = $1
        AND active
        AND (service_code IS NULL OR service_code = $2)
        AND (bin_type_id IS NULL OR bin_type_id = $3)
        AND component_kind <> 'base_transport'
      ORDER BY component_code, rate_component_id`,
    [billingCase.rate_card_version_id, serviceCode, billingCase.bin_type_id]
  );
  const suppliedQuantities = input.componentQuantities === undefined
    ? {}
    : object(input.componentQuantities, "Component quantities");
  const configuredCodes = new Set(componentsResult.rows.map(
    (/** @type {Record<string, any>} */ component) => String(component.component_code)
  ));
  const unknownCode = Object.keys(suppliedQuantities).find((code) => !configuredCodes.has(code));
  if (unknownCode) {
    throw failure(
      409,
      "MBT_BILLING_QUANTITY_COMPONENT_UNKNOWN",
      `Component quantity ${unknownCode} is not part of the locked rate version.`
    );
  }
  const rentalEnd = billingCase.actual_closed_at || billingCase.planned_return_at;
  const extensionDays = billingCase.actual_delivery_completed_at && rentalEnd
    ? calculateTorontoRentalExtensionDays(
      billingCase.actual_delivery_completed_at,
      rentalEnd,
      Number(billingCase.rental_calendar_days || 14)
    )
    : null;
  return componentsResult.rows
    .filter((/** @type {Record<string, any>} */ component) => (
      String(component.component_kind) !== "extension" || extensionDays === null || extensionDays > 0
    ))
    .map((/** @type {Record<string, any>} */ component) => calculatedComponentEvidence(
      component,
      String(component.component_kind) === "extension" && extensionDays !== null
        ? { ...suppliedQuantities, [String(component.component_code)]: extensionDays }
        : suppliedQuantities,
      localItem
    ));
}

/** @param {Record<string, any>} input @param {Record<string, any>} billingCase */
async function selectedCalculationCustomPrices(input, billingCase) {
  const customPricesInput = input.customPrices === undefined ? [] : input.customPrices;
  if (!Array.isArray(customPricesInput)) {
    throw failure(400, "MBT_BILLING_INPUT_INVALID", "Custom prices must be an array.");
  }
  const customPrices = [];
  for (const customPriceValue of customPricesInput) {
    const customPrice = object(customPriceValue, "Custom price");
    const itemCode = requiredText(customPrice.localItemCode, "Custom local-item code");
    const itemResult = await query(
      `SELECT item_code, revision, pricing_mode
         FROM mbt_local_item_settings
        WHERE item_code = $1
          AND active`,
      [itemCode]
    );
    if (!itemResult.rowCount || String(itemResult.rows[0].pricing_mode) !== "custom_price"
        || Number(itemResult.rows[0].revision) !== Number(customPrice.localItemRevision)) {
      throw failure(409, "MBT_BILLING_CUSTOM_PRICE_ITEM_INVALID", "Custom price evidence does not match an active locked local item.");
    }
    customPrices.push({
      lineCode: requiredText(customPrice.lineCode, "Custom-price line code"),
      description: String(customPrice.description || customPrice.lineCode),
      amountMinor: nonnegativeInteger(customPrice.amountMinor, "Custom price"),
      taxable: customPrice.taxable === true,
      unitOfMeasure: String(customPrice.unitOfMeasure || "EA"),
      localItemCode: itemCode,
      localItemRevision: Number(itemResult.rows[0].revision),
      currency: String(billingCase.currency)
    });
  }
  return customPrices;
}

/** @param {Record<string, any>} input @param {Record<string, any>} localItem @param {Record<string, any>} billingCase */
function selectedCalculationWaivers(input, localItem, billingCase) {
  if (input.waiver === undefined || input.waiver === null) {
    return [];
  }
  const waiver = object(input.waiver, "Billing waiver");
  const amountMinor = nonnegativeInteger(waiver.amountMinor, "Waiver amount");
  if (amountMinor === 0) {
    throw failure(422, "MBT_BILLING_WAIVER_INVALID", "A billing waiver must reduce the charge by at least one cent.");
  }
  const reason = requiredText(waiver.reason, "Waiver audit reason");
  return [{
    amountMinor,
    reason,
    description: String(waiver.description || "Audited billing waiver").trim() || "Audited billing waiver",
    taxable: waiver.taxable === true,
    localItem: { ...localItem, currency: String(billingCase.currency) }
  }];
}

/** @param {Record<string, any>} tariff */
function dumpTariffLocalItemCode(tariff) {
  return tariff.item_code ? String(tariff.item_code) : "DUMP";
}

/** @param {Record<string, any>} input @param {Record<string, any>} billingCase @param {string} visitId */
async function selectedCalculationDump(input, billingCase, visitId) {
  if (input.dumpReceiptId === undefined || input.dumpReceiptId === null) {
    return null;
  }
  const receiptId = uuid(input.dumpReceiptId, "Dump-receipt ID");
  const receiptResult = await query(
      `SELECT receipt.dump_receipt_id, receipt.service_visit_id,
              receipt.dump_site_id, receipt.material_id,
              receipt.ticket_number, receipt.weight::text,
              receipt.quantity::text, receipt.unit_of_measure,
              receipt.subtotal_minor, receipt.tax_minor, receipt.total_minor,
              receipt.currency, receipt.captured_at,
              receipt.receipt_snapshot, receipt.receipt_photo_evidence_id,
              evidence.storage_provider AS photo_storage_provider,
              evidence.storage_key AS photo_storage_key,
              evidence.content_sha256 AS photo_content_sha256,
              evidence.mime_type AS photo_mime_type,
              evidence.size_bytes AS photo_size_bytes
         FROM mbt_dump_receipts receipt
         JOIN mbt_evidence evidence
           ON evidence.evidence_id = receipt.receipt_photo_evidence_id
        WHERE receipt.dump_receipt_id = $1
          AND receipt.service_visit_id = $2`,
      [receiptId, visitId]
    );
  if (!receiptResult.rowCount) {
    throw failure(409, "MBT_BILLING_RECEIPT_MISMATCH", "The dump receipt does not belong to the selected visit.");
  }
  const receipt = receiptResult.rows[0];
  const tariffResult = await query(
      `SELECT dump_tariff_id, item_code, pricing_basis, unit_of_measure,
              amount_minor, minimum_amount_minor, currency, description
         FROM mbt_dump_tariffs
        WHERE rate_card_version_id = $1
          AND (dump_site_id = $2 OR dump_site_id IS NULL)
          AND (material_id IS NULL OR material_id = $3)
          AND active
        ORDER BY (material_id IS NOT NULL) DESC, (dump_site_id IS NOT NULL) ASC, tariff_code, dump_tariff_id
        LIMIT 1`,
      [billingCase.rate_card_version_id, receipt.dump_site_id, receipt.material_id]
    );
  if (!tariffResult.rowCount) {
    throw failure(409, "MBT_BILLING_DUMP_TARIFF_NOT_FOUND", "No locked dump tariff matches the receipt.");
  }
  const tariff = tariffResult.rows[0];
  const dumpItemResult = await query(
      `SELECT item_code, revision
         FROM mbt_local_item_settings
        WHERE item_code = $1
          AND item_type = 'dump'
          AND active`,
      [dumpTariffLocalItemCode(tariff)]
    );
  if (!dumpItemResult.rowCount) {
    throw failure(409, "MBT_BILLING_LOCAL_ITEM_INVALID", "The DUMP local item is not active.");
  }
  cad(receipt.currency);
  cad(tariff.currency);
  const pricingBasis = String(tariff.pricing_basis);
  const measurement = pricingBasis === "fixed"
    ? "1.000000"
    : pricingBasis === "per_weight"
      ? receipt.weight
      : receipt.quantity;
  if (measurement === null || measurement === undefined) {
    throw failure(409, "MBT_BILLING_RECEIPT_MEASUREMENT_MISSING", "The receipt is missing the measurement required by its locked dump tariff.");
  }
  return {
      receiptSnapshot: {
        dumpReceiptId: String(receipt.dump_receipt_id),
        dumpSiteId: String(receipt.dump_site_id),
        materialId: String(receipt.material_id),
        ticketNumber: String(receipt.ticket_number),
        weight: receipt.weight,
        quantity: receipt.quantity,
        quantityMicrounits: decimalMicrounits(measurement, "Dump receipt measurement"),
        unitOfMeasure: String(receipt.unit_of_measure),
        subtotalMinor: Number(receipt.subtotal_minor),
        taxMinor: Number(receipt.tax_minor),
        totalMinor: Number(receipt.total_minor),
        currency: String(receipt.currency),
        capturedAt: databaseIso(receipt.captured_at),
        receipt: receipt.receipt_snapshot,
        photoEvidence: {
          evidenceId: String(receipt.receipt_photo_evidence_id),
          storageProvider: String(receipt.photo_storage_provider),
          storageKey: String(receipt.photo_storage_key),
          contentSha256: String(receipt.photo_content_sha256),
          mimeType: String(receipt.photo_mime_type),
          sizeBytes: Number(receipt.photo_size_bytes)
        }
      },
      tariff: {
        dumpTariffId: String(tariff.dump_tariff_id),
        pricingBasis,
        unitOfMeasure: tariff.unit_of_measure === null ? null : String(tariff.unit_of_measure),
        amountMinor: Number(tariff.amount_minor),
        minimumAmountMinor: Number(tariff.minimum_amount_minor),
        currency: String(tariff.currency),
        taxable: true,
        description: String(tariff.description || "Dump customer tariff")
      },
      localItem: {
        code: String(dumpItemResult.rows[0].item_code),
        revision: Number(dumpItemResult.rows[0].revision)
      }
    };
}

/** @param {Record<string, any>} input @param {Record<string, any>} billingCase */
async function calculationEvidence(input, billingCase) {
  const { visitId, visit } = await selectedCalculationVisit(input, billingCase);
  const { distanceId, distance } = await selectedCalculationDistance(input, billingCase, visitId);
  const localItem = await selectedCalculationLocalItem(billingCase);
  const components = await selectedCalculationComponents(input, billingCase, visit, localItem);
  const customPrices = await selectedCalculationCustomPrices(input, billingCase);
  const waivers = selectedCalculationWaivers(input, localItem, billingCase);
  const dump = await selectedCalculationDump(input, billingCase, visitId);
  const taxSnapshot = canonicalObject(billingCase.tax_snapshot || {});
  const taxBasisPoints = nonnegativeInteger(taxSnapshot.basisPoints ?? 0, "Contract tax basis points");
  return {
    calculationInput: {
      rateCardVersionId: String(billingCase.rate_card_version_id),
      currency: String(billingCase.currency),
      taxBasisPoints,
      contractSnapshot: {
        contractId: String(billingCase.contract_id),
        revision: Number(billingCase.contract_revision),
        customerNetsuiteId: String(billingCase.contract_customer_id),
        rateCardVersionId: String(billingCase.rate_card_version_id),
        binTypeId: String(billingCase.bin_type_id),
        tax: taxSnapshot,
        pricing: billingCase.pricing_snapshot
      },
      visitSnapshot: {
        serviceVisitId: String(visit.service_visit_id),
        revision: Number(visit.revision),
        serviceAction: String(visit.service_action),
        status: String(visit.status),
        service: visit.service_snapshot
      },
      distanceSnapshot: {
        distanceSnapshotId: String(distance.distance_snapshot_id),
        provider: String(distance.provider),
        rawMetres: Number(distance.override_metres ?? distance.provider_metres),
        selectedBandId: String(distance.rate_distance_band_id),
        amountMinor: Number(distance.override_amount_minor ?? distance.calculated_amount_minor),
        currency: String(distance.currency),
        origin: distance.origin_snapshot,
        destination: distance.destination_snapshot,
        override: distance.override_metres === null
          ? null
          : {
              metres: Number(distance.override_metres),
              amountMinor: Number(distance.override_amount_minor),
              reason: String(distance.override_reason),
              overriddenBy: String(distance.overridden_by),
              overriddenAt: databaseIso(distance.overridden_at)
            },
        taxable: true
      },
      localItem,
      components,
      customPrices,
      waivers,
      dump
    },
    distanceId,
    receiptId: dump?.receiptSnapshot.dumpReceiptId ?? null
  };
}

/** @param {Record<string, any>} input @param {Record<string, any>} billingCase */
async function validatedAmendment(input, billingCase) {
  if (input.amendsBillingVersionId === undefined || input.amendsBillingVersionId === null) {
    if (!new Set(["open", "ready", "in_review"]).has(String(billingCase.status))) {
      throw failure(409, "MBT_BILLING_AMENDMENT_REQUIRED", "An approved case requires explicit amendment lineage.");
    }
    if (Number(billingCase.current_version_number) !== 0) {
      throw failure(409, "MBT_BILLING_DRAFT_EXISTS", "The billing case already has a calculated version.");
    }
    return null;
  }
  const originalVersionId = uuid(input.amendsBillingVersionId, "Original billing-version ID");
  const amendmentKind = requiredText(input.amendmentKind, "Amendment kind");
  if (!new Set(["correction", "amendment", "reversal", "recalculation"]).has(amendmentKind)) {
    throw failure(400, "MBT_BILLING_AMENDMENT_KIND_INVALID", "The amendment kind is not supported.");
  }
  const original = await query(
    `SELECT billing_version_id, version_number, status
       FROM mbt_billing_versions
      WHERE billing_version_id = $1
        AND billing_case_id = $2`,
    [originalVersionId, billingCase.billing_case_id]
  );
  if (!original.rowCount || String(original.rows[0].status) !== "approved") {
    throw failure(409, "MBT_BILLING_AMENDMENT_ORIGINAL_INVALID", "The amendment original must be an approved version in this case.");
  }
  if (Number(original.rows[0].version_number) !== Number(billingCase.current_version_number)) {
    throw failure(409, "MBT_BILLING_AMENDMENT_NOT_CURRENT", "Only the current approved version can be amended.");
  }
  return { originalVersionId, amendmentKind };
}

/** @param {Record<string, any>} line @param {Record<string, any>} evidence @param {Record<string, any>} billingCase */
function calculatedLinePersistence(line, evidence, billingCase) {
  const sourceType = String(line.source.type);
  return {
    lineItem: line.localItem || evidence.calculationInput.localItem,
    rateComponentId: sourceType === "rate_component" ? line.source.id : null,
    dumpTariffId: sourceType === "dump_tariff" ? line.source.id : null,
    distanceSnapshotId: sourceType === "distance_snapshot" ? line.source.id : null,
    sourceEntityType: sourceType === "dump_tariff" ? "dump_receipt" : "contract",
    sourceEntityId: sourceType === "dump_tariff" ? line.source.receiptId : billingCase.contract_id,
    evidenceReferences: [
      ...(sourceType === "distance_snapshot" ? [evidence.distanceId] : []),
      ...(sourceType === "dump_tariff" && evidence.receiptId ? [evidence.receiptId] : [])
    ]
  };
}

/**
 * Calculate and persist one complete MBT draft plus all lines atomically.
 * The optional dependencies object is intentionally limited to local failure
 * hooks; a supplied transport is never invoked.
 *
 * @param {unknown} rawInput
 * @param {{hooks?: Record<string, Function>, transport?: Function}} [dependencies]
 */
export async function calculateMbtBillingCase(rawInput, dependencies = {}) {
  const input = object(rawInput, "Billing calculation");
  const actor = billingActor(input.actor);
  const billingCaseId = uuid(input.billingCaseId, "Billing-case ID");
  const reason = requiredText(input.reason, "Calculation reason");
  const payload = canonicalObject({
    billingCaseId,
    expectedRevision: input.expectedRevision,
    serviceVisitId: input.serviceVisitId,
    distanceSnapshotId: input.distanceSnapshotId,
    dumpReceiptId: input.dumpReceiptId ?? null,
    componentQuantities: input.componentQuantities ?? {},
    customPrices: input.customPrices ?? [],
    waiver: input.waiver ?? null,
    amendsBillingVersionId: input.amendsBillingVersionId ?? null,
    amendmentKind: input.amendmentKind ?? null,
    reason
  });
  const hooks = dependencies.hooks || {};
  return executeMbtCommand({
    actor,
    commandName: "mbt.billing.calculate",
    idempotencyKey: requiredText(input.idempotencyKey, "Idempotency key"),
    payload,
    correlationId: requiredText(input.correlationId, "Correlation ID"),
    requestId: requiredText(input.requestId, "Request ID"),
    mutation: async () => {
      const billingCase = await selectedBillingCase(billingCaseId);
      assertLocalMbtCase(billingCase);
      const revisionBefore = Number(billingCase.revision);
      assertExpectedRevision(revisionBefore, input.expectedRevision);
      const amendment = await validatedAmendment(input, billingCase);
      const evidence = await calculationEvidence(input, billingCase);
      const calculation = /** @type {Record<string, any>} */ (
        calculateMbtLocalBilling(evidence.calculationInput)
      );
      const versionNumber = Number(billingCase.current_version_number) + 1;
      const billingVersionId = crypto.randomUUID();
      await query(
        `INSERT INTO mbt_billing_versions (
           billing_version_id, billing_case_id, version_number, status,
           rate_card_version_id, calculation_snapshot, source_revision_snapshot,
           subtotal_minor, estimated_tax_minor, total_minor, currency,
           posting_mode, billing_case_revision_before, calculated_by,
           calculation_reason, calculated_at, correlation_id, idempotency_key
         ) VALUES (
           $1, $2, $3, 'draft', $4, $5::jsonb, $6::jsonb,
           $7, $8, $9, $10, 'local_only', $11, $12, $13,
           clock_timestamp(), $14, $15
         )`,
        [
          billingVersionId,
          billingCaseId,
          versionNumber,
          billingCase.rate_card_version_id,
          JSON.stringify(calculation),
          JSON.stringify({
            contract: calculation.contractSnapshot,
            visit: calculation.visitSnapshot,
            distance: calculation.distanceSnapshot,
            receipt: calculation.receiptSnapshot,
            localItems: calculation.lines.map((/** @type {Record<string, any>} */ line) => line.localItem)
          }),
          calculation.subtotalMinor,
          calculation.estimatedTaxMinor,
          calculation.totalMinor,
          calculation.currency,
          revisionBefore,
          requiredText(actor.operatorId, "Actor ID"),
          reason,
          requiredText(input.correlationId, "Correlation ID"),
          requiredText(input.idempotencyKey, "Idempotency key")
        ]
      );
      if (typeof hooks.afterVersionInsert === "function") {
        await hooks.afterVersionInsert({ billingCaseId, billingVersionId });
      }
      for (const line of calculation.lines) {
        const persistence = calculatedLinePersistence(line, evidence, billingCase);
        const billingLineId = crypto.randomUUID();
        await query(
          `INSERT INTO mbt_billing_lines (
             billing_line_id, billing_version_id, sequence_number, line_key,
             line_type, description, quantity, unit_of_measure,
             unit_amount_minor, net_amount_minor, estimated_tax_minor,
             total_amount_minor, currency, revenue_class,
             rate_component_id, dump_tariff_id, distance_snapshot_id,
             source_entity_type, source_entity_id, netsuite_item_mapping_key,
             calculation_detail, evidence_references, local_item_code,
             local_item_revision, deduplication_key, customer_charge_minor,
             actual_cost_minor, margin_minor
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7::numeric, $8,
             $9, $10, $11, $12, $13, $14,
             $15, $16, $17, $18, $19, NULL,
             $20::jsonb, $21::uuid[], $22, $23, NULL, $24, $25, $26
           )`,
          [
            billingLineId,
            billingVersionId,
            line.sequenceNumber,
            line.lineKey,
            line.lineType,
            line.description,
            decimalQuantity(line.quantityMicrounits),
            line.unitOfMeasure,
            line.unitAmountMinor,
            line.netAmountMinor,
            line.estimatedTaxMinor,
            line.totalAmountMinor,
            calculation.currency,
            line.lineType,
            persistence.rateComponentId,
            persistence.dumpTariffId,
            persistence.distanceSnapshotId,
            persistence.sourceEntityType,
            persistence.sourceEntityId,
            JSON.stringify(line),
            persistence.evidenceReferences,
            persistence.lineItem.code,
            persistence.lineItem.revision,
            line.customerChargeMinor,
            line.actualCostMinor,
            line.marginMinor
          ]
        );
        if (typeof hooks.afterLineInsert === "function") {
          await hooks.afterLineInsert({ billingCaseId, billingVersionId, billingLineId, line });
        }
      }
      if (amendment) {
        await query(
          `INSERT INTO mbt_billing_version_amendments (
             billing_version_amendment_id, billing_case_id,
             original_billing_version_id, amended_billing_version_id,
             amendment_kind, reason, created_by, evidence_snapshot
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
          [
            crypto.randomUUID(),
            billingCaseId,
            amendment.originalVersionId,
            billingVersionId,
            amendment.amendmentKind,
            reason,
            requiredText(actor.operatorId, "Actor ID"),
            JSON.stringify({
              calculationHash: canonicalSha256(calculation),
              sourceRevisionSnapshot: {
                contract: calculation.contractSnapshot,
                visit: calculation.visitSnapshot
              }
            })
          ]
        );
      }
      await query(
        `UPDATE mbt_billing_cases
            SET status = 'ready', current_version_number = $2,
                revision = $3, updated_by = $4, updated_at = clock_timestamp()
          WHERE billing_case_id = $1`,
        [billingCaseId, versionNumber, nextRevision(revisionBefore), requiredText(actor.operatorId, "Actor ID")]
      );
      const body = await selectedDraft(billingVersionId);
      return {
        status: 201,
        body,
        audit: {
          action: "mbt.billing.calculated",
          entityType: "mbt_billing_case",
          entityId: billingCaseId,
          beforeState: {
            status: String(billingCase.status),
            revision: revisionBefore,
            currentVersionNumber: Number(billingCase.current_version_number)
          },
          afterState: {
            status: "ready",
            revision: nextRevision(revisionBefore),
            currentVersionNumber: versionNumber,
            billingVersionId,
            lineCount: body.lines.length,
            postingMode: "local_only"
          },
          reason,
          revisionBefore,
          revisionAfter: nextRevision(revisionBefore),
          source: "p3_local_shadow_billing"
        }
      };
    }
  });
}

/** @param {string} billingVersionId */
async function assertNoOpenBillingVariance(billingVersionId) {
  const result = await query(
    `SELECT 1
       FROM mbt_pilot_reconciliation_rows reconciliation_row
       LEFT JOIN mbt_pilot_reconciliation_resolutions resolution
         USING (reconciliation_row_id)
      WHERE reconciliation_row.comparison_result = 'open_variance'
        AND reconciliation_row.blocking
        AND resolution.reconciliation_resolution_id IS NULL
        AND (
          (
            reconciliation_row.comparison_kind = 'billing_line'
            AND reconciliation_row.application_evidence_id IN (
              SELECT billing_line_id
                FROM mbt_billing_lines
               WHERE billing_version_id = $1
            )
          )
          OR (
            reconciliation_row.comparison_kind = 'distance'
            AND reconciliation_row.application_evidence_id IN (
              SELECT distance_snapshot_id
                FROM mbt_billing_lines
               WHERE billing_version_id = $1
                 AND distance_snapshot_id IS NOT NULL
            )
          )
          OR (
            reconciliation_row.comparison_kind = 'receipt'
            AND reconciliation_row.application_evidence_id IN (
              SELECT source_entity_id
                FROM mbt_billing_lines
               WHERE billing_version_id = $1
                 AND source_entity_type = 'dump_receipt'
            )
          )
        )
      LIMIT 1`,
    [billingVersionId]
  );
  if (result.rowCount) {
    throw failure(409, "MBT_BILLING_OPEN_VARIANCE", "Resolve every blocking billing variance before local approval.");
  }
}

/** @param {Record<string, any>} version @param {Record<string, any>} complete */
function assertCompleteBillingDraft(version, complete) {
  const snapshotLines = version.calculation_snapshot?.lines;
  const expectedLineCount = Array.isArray(snapshotLines)
    ? snapshotLines.length
    : Number(version.calculation_snapshot?.expectedLineCount);
  const completeDraft = Number.isSafeInteger(expectedLineCount)
    && expectedLineCount >= 1
    && Number(complete.line_count) === expectedLineCount
    && Number(complete.subtotal_minor) === Number(version.subtotal_minor)
    && Number(complete.tax_minor) === Number(version.estimated_tax_minor)
    && Number(complete.total_minor) === Number(version.total_minor);
  if (!completeDraft) {
    throw failure(409, "MBT_BILLING_DRAFT_INCOMPLETE", "The draft version and all calculated lines are not complete.");
  }
}

/**
 * Approve one already-complete immutable draft locally. No dependency passed
 * here can enqueue or transport anything; transport is deliberately unused.
 *
 * @param {unknown} rawInput
 * @param {{transport?: Function}} [dependencies]
 */
export async function approveLocalBillingVersion(rawInput, dependencies = {}) {
  void dependencies;
  const input = object(rawInput, "Local billing approval");
  const actor = billingActor(input.actor);
  const billingCaseId = uuid(input.billingCaseId, "Billing-case ID");
  const billingVersionId = uuid(input.billingVersionId, "Billing-version ID");
  const reason = requiredText(input.reason, "Approval reason");
  const payload = { billingCaseId, billingVersionId, expectedRevision: input.expectedRevision, reason };
  return executeMbtCommand({
    actor,
    commandName: "mbt.billing.approve_local",
    idempotencyKey: requiredText(input.idempotencyKey, "Idempotency key"),
    payload,
    correlationId: requiredText(input.correlationId, "Correlation ID"),
    requestId: requiredText(input.requestId, "Request ID"),
    mutation: async () => {
      const selectedCase = await query(
        `SELECT billing_case_id, status, posting_mode,
                current_version_number, revision
           FROM mbt_billing_cases
          WHERE billing_case_id = $1
          FOR UPDATE`,
        [billingCaseId]
      );
      if (!selectedCase.rowCount) {
        throw failure(404, "MBT_BILLING_CASE_NOT_FOUND", "The local billing case was not found.");
      }
      const billingCase = selectedCase.rows[0];
      const revisionBefore = Number(billingCase.revision);
      assertExpectedRevision(revisionBefore, input.expectedRevision);
      if (String(billingCase.posting_mode) !== "local_only" || String(billingCase.status) !== "ready") {
        throw failure(409, "MBT_BILLING_NOT_APPROVABLE", "Only a ready local-only billing case can be approved.");
      }
      const version = await query(
        `SELECT billing_version_id, version_number, status, posting_mode,
                subtotal_minor, estimated_tax_minor, total_minor, currency,
                calculation_snapshot
           FROM mbt_billing_versions
          WHERE billing_version_id = $1
            AND billing_case_id = $2
          FOR UPDATE`,
        [billingVersionId, billingCaseId]
      );
      if (!version.rowCount || String(version.rows[0].status) !== "draft"
          || String(version.rows[0].posting_mode) !== "local_only"
          || Number(version.rows[0].version_number) !== Number(billingCase.current_version_number)) {
        throw failure(409, "MBT_BILLING_DRAFT_NOT_CURRENT", "Approval requires the complete current local draft.");
      }
      await assertNoOpenBillingVariance(billingVersionId);
      const totals = await query(
        `SELECT count(*)::int AS line_count,
                COALESCE(sum(net_amount_minor), 0)::bigint AS subtotal_minor,
                COALESCE(sum(estimated_tax_minor), 0)::bigint AS tax_minor,
                COALESCE(sum(total_amount_minor), 0)::bigint AS total_minor
           FROM mbt_billing_lines
          WHERE billing_version_id = $1`,
        [billingVersionId]
      );
      const complete = totals.rows[0];
      assertCompleteBillingDraft(version.rows[0], complete);
      const actorId = requiredText(actor.operatorId, "Actor ID");
      await query(
        `UPDATE mbt_billing_versions
            SET status = 'approved', approved_by = $2,
                approval_reason = $3, approved_at = clock_timestamp()
          WHERE billing_version_id = $1`,
        [billingVersionId, actorId, reason]
      );
      await query(
        `UPDATE mbt_billing_cases
            SET status = 'approved', revision = $2,
                updated_by = $3, updated_at = clock_timestamp()
          WHERE billing_case_id = $1`,
        [billingCaseId, nextRevision(revisionBefore), actorId]
      );
      const body = {
        schemaVersion: "mbt-local-billing-approval-v1",
        billingCaseId,
        billingVersionId,
        versionNumber: Number(version.rows[0].version_number),
        status: "approved",
        postingMode: "local_only",
        caseRevision: nextRevision(revisionBefore),
        subtotalMinor: Number(version.rows[0].subtotal_minor),
        estimatedTaxMinor: Number(version.rows[0].estimated_tax_minor),
        totalMinor: Number(version.rows[0].total_minor),
        currency: String(version.rows[0].currency),
        externalWork: null
      };
      return {
        status: 200,
        body,
        audit: {
          action: "mbt.billing.approved_local",
          entityType: "mbt_billing_case",
          entityId: billingCaseId,
          beforeState: { status: "ready", revision: revisionBefore, billingVersionId },
          afterState: { status: "approved", revision: nextRevision(revisionBefore), billingVersionId, postingMode: "local_only" },
          reason,
          revisionBefore,
          revisionAfter: nextRevision(revisionBefore),
          source: "p3_local_shadow_billing"
        }
      };
    }
  });
}

/** @param {Record<string, any>} input */
function normalizedMbbsInput(input) {
  if (!Array.isArray(input.loads)) {
    throw failure(400, "MBT_BILLING_INPUT_INVALID", "Completed MBBS loads are required.");
  }
  return {
    customerNetsuiteId: requiredText(input.customerNetsuiteId, "Customer NetSuite ID"),
    rateCardVersionId: uuid(input.rateCardVersionId, "Rate-card version ID"),
    rateDistanceBandId: uuid(input.rateDistanceBandId, "Rate distance-band ID"),
    currency: cad(input.currency),
    loads: canonicalize(input.loads)
  };
}

/** @param {Record<string, any>} calculatedCase @param {Record<string, any>} source */
function crossChargeEvidence(calculatedCase, source) {
  const sourceSnapshot = canonicalize({
    schemaVersion: "mbbs-cross-charge-source-v1",
    completedLoadSnapshotId: source.completedLoadSnapshotIdsByPhysicalLoad?.[calculatedCase.physicalLoadId] ?? null,
    physicalLoadId: calculatedCase.physicalLoadId,
    planDate: calculatedCase.planDate,
    completedAt: calculatedCase.completedAt,
    truckId: calculatedCase.truckId,
    driverId: calculatedCase.driverId,
    calculatedMetres: calculatedCase.calculatedMetres,
    sourceType: calculatedCase.sourceType,
    rootReference: calculatedCase.rootReference,
    ...(calculatedCase.billingEvidence === undefined
      ? {}
      : { billingEvidence: calculatedCase.billingEvidence }),
    rateCardVersionId: source.rateCardVersionId,
    rateDistanceBandId: source.rateDistanceBandId,
    currency: source.currency,
    localItem: {
      code: source.localItemCode,
      revision: source.localItemRevision,
      mappingKey: source.localItemMappingKey ?? null
    }
  });
  const calculationSnapshot = canonicalize({
    schemaVersion: "mbbs-cross-charge-calculation-v1",
    deduplicationKey: calculatedCase.deduplicationKey,
    allocationKey: calculatedCase.allocationKey,
    sharedTotalMinor: calculatedCase.sharedTotalMinor,
    allocatedAmountMinor: calculatedCase.allocatedAmountMinor,
    ...(calculatedCase.billingEvidence === undefined
      ? {}
      : { billingEvidence: calculatedCase.billingEvidence }),
    currency: source.currency
  });
  const lineDetail = canonicalize({
    deduplicationKey: calculatedCase.deduplicationKey,
    allocationKey: calculatedCase.allocationKey,
    physicalLoadId: calculatedCase.physicalLoadId,
    sourceType: calculatedCase.sourceType,
    rootReference: calculatedCase.rootReference,
    ...(calculatedCase.billingEvidence === undefined
      ? {}
      : { billingEvidence: calculatedCase.billingEvidence }),
    rateCardVersionId: source.rateCardVersionId,
    rateDistanceBandId: source.rateDistanceBandId,
    localItemRevision: source.localItemRevision
  });
  return { sourceSnapshot, calculationSnapshot, lineDetail };
}

/** @param {Record<string, any>} row @param {Record<string, any>} calculatedCase @param {Record<string, any>} source @param {ReturnType<typeof crossChargeEvidence>} evidence @param {Record<string, string>} ids */
function assertExistingCrossCharge(row, calculatedCase, source, evidence, ids) {
  /** @param {unknown} value */
  const nullableText = (value) => value === null || value === undefined ? null : String(value);
  const identityPairs = [
    [String(row.cross_charge_case_id), ids.crossChargeCaseId],
    [String(row.billing_case_id), ids.billingCaseId],
    [String(row.billing_version_id), ids.billingVersionId],
    [String(row.billing_line_id), ids.billingLineId],
    [String(row.customer_netsuite_id), source.customerNetsuiteId],
    [String(row.rate_card_version_id), source.rateCardVersionId],
    [nullableText(row.rate_distance_band_id), nullableText(source.rateDistanceBandId)],
    [String(row.currency), source.currency],
    [String(row.line_currency), source.currency],
    [String(row.local_item_code), source.localItemCode],
    [Number(row.local_item_revision), source.localItemRevision],
    [Number(row.allocated_amount_minor), calculatedCase.allocatedAmountMinor],
    [Number(row.line_amount_minor), calculatedCase.allocatedAmountMinor]
  ];
  const identityMatches = identityPairs.every(([actual, expected]) => actual === expected);
  const evidencePairs = [
    [row.source_snapshot, evidence.sourceSnapshot],
    [row.calculation_snapshot, evidence.calculationSnapshot],
    [row.calculation_detail, evidence.lineDetail]
  ];
  const evidenceMatches = evidencePairs.every(
    ([actual, expected]) => canonicalSha256(actual) === canonicalSha256(expected)
  );
  if (!identityMatches || !evidenceMatches) {
    throw failure(409, "MBT_CROSS_CHARGE_IDENTITY_CONFLICT", "The cross-charge dedupe key is bound to different immutable evidence.");
  }
}

/** @param {Record<string, any>} calculatedCase @param {Record<string, any>} source */
async function insertOrVerifyCrossCharge(calculatedCase, source) {
  const crossChargeCaseId = stableId("mbt.cross_charge.case", calculatedCase.deduplicationKey);
  const billingCaseId = stableId("mbt.cross_charge.billing_case", calculatedCase.deduplicationKey);
  const billingVersionId = stableId("mbt.cross_charge.billing_version", calculatedCase.deduplicationKey);
  const billingLineId = stableId("mbt.cross_charge.billing_line", calculatedCase.deduplicationKey);
  const ids = { crossChargeCaseId, billingCaseId, billingVersionId, billingLineId };
  const evidence = crossChargeEvidence(calculatedCase, source);
  const existing = await query(
    `SELECT cross_charge.cross_charge_case_id,
            cross_charge.allocated_amount_minor,
            cross_charge.rate_card_version_id,
            cross_charge.rate_distance_band_id,
            cross_charge.currency, cross_charge.source_snapshot,
            cross_charge.calculation_snapshot,
            billing_case.billing_case_id,
            billing_case.customer_netsuite_id::text AS customer_netsuite_id,
            version.billing_version_id, version.status AS version_status,
            version.posting_mode, line.billing_line_id,
            line.net_amount_minor AS line_amount_minor,
            line.currency AS line_currency, line.local_item_code,
            line.local_item_revision, line.calculation_detail
       FROM mbt_cross_charge_cases cross_charge
       JOIN mbt_billing_cases billing_case USING (cross_charge_case_id)
       JOIN mbt_billing_versions version USING (billing_case_id)
       JOIN mbt_billing_lines line USING (billing_version_id)
      WHERE cross_charge.deduplication_key = $1`,
    [calculatedCase.deduplicationKey]
  );
  if (existing.rowCount) {
    const row = existing.rows[0];
    assertExistingCrossCharge(row, calculatedCase, source, evidence, ids);
    return {
      crossChargeCaseId,
      billingCaseId,
      billingVersionId,
      billingLineId,
      versionStatus: String(row.version_status),
      postingMode: String(row.posting_mode)
    };
  }
  const allocationGroupId = calculatedCase.allocationKey
    ? stableId("mbt.cross_charge.allocation_group", calculatedCase.allocationKey)
    : null;
  await query(
    `INSERT INTO mbt_cross_charge_cases (
       cross_charge_case_id, source_type, root_reference, physical_load_id,
       allocation_group_id, plan_date, truck_id, driver_id,
       rate_card_version_id, rate_distance_band_id, calculated_metres,
       base_amount_minor, downtown_surcharge_minor, allocated_amount_minor,
       currency, status, source_snapshot, calculation_snapshot,
       completed_load_at, deduplication_key
     ) VALUES (
       $1, $2, $3, $4, $5, $6::date, $7, $8, $9, $10, $11,
       $12, 0, $13, $14, 'ready', $15::jsonb, $16::jsonb,
       $17::timestamptz, $18
     )`,
    [
      crossChargeCaseId,
      calculatedCase.sourceType,
      calculatedCase.rootReference,
      calculatedCase.physicalLoadId,
      allocationGroupId,
      calculatedCase.planDate,
      calculatedCase.truckId,
      calculatedCase.driverId,
      source.rateCardVersionId,
      source.rateDistanceBandId,
      calculatedCase.calculatedMetres,
      Number(calculatedCase.billingEvidence?.calculatedAmountMinor ?? calculatedCase.sharedTotalMinor),
      calculatedCase.allocatedAmountMinor,
      source.currency,
      JSON.stringify(evidence.sourceSnapshot),
      JSON.stringify(evidence.calculationSnapshot),
      calculatedCase.completedAt,
      calculatedCase.deduplicationKey
    ]
  );
  if (allocationGroupId) {
    const group = source.calculation.allocationGroups.find(
      (/** @type {Record<string, any>} */ candidate) => candidate.allocationKey === calculatedCase.allocationKey
    );
    const allocation = group.allocations.find(
      (/** @type {Record<string, any>} */ candidate) => candidate.sourceType === calculatedCase.sourceType
        && candidate.rootReference === calculatedCase.rootReference
    );
    await query(
      `INSERT INTO mbt_cross_charge_allocations (
         cross_charge_allocation_id, cross_charge_case_id,
         allocation_group_id, source_type, root_reference, sorted_ordinal,
         eligible_reference_count, shared_total_minor, allocated_amount_minor,
         remainder_minor, currency, allocation_snapshot
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)`,
      [
        stableId("mbt.cross_charge.allocation", calculatedCase.deduplicationKey),
        crossChargeCaseId,
        allocationGroupId,
        calculatedCase.sourceType,
        calculatedCase.rootReference,
        allocation.sortedOrdinal,
        allocation.eligibleReferenceCount,
        allocation.sharedTotalMinor,
        allocation.allocatedAmountMinor,
        allocation.remainderMinor,
        source.currency,
        JSON.stringify(allocation)
      ]
    );
  }
  await query(
    `INSERT INTO mbt_billing_cases (
       billing_case_id, case_type, cross_charge_case_id,
       customer_netsuite_id, status, currency, posting_mode,
       current_version_number, revision, created_by, updated_by
     ) VALUES ($1, 'mbbs_cross_charge', $2, $3, 'ready', $4,
               'local_only', 1, 1, $5, $5)`,
    [billingCaseId, crossChargeCaseId, source.customerNetsuiteId, source.currency, source.actorId]
  );
  await query(
    `INSERT INTO mbt_billing_versions (
       billing_version_id, billing_case_id, version_number, status,
       rate_card_version_id, calculation_snapshot, source_revision_snapshot,
       subtotal_minor, estimated_tax_minor, total_minor, currency,
       posting_mode, billing_case_revision_before, calculated_by,
       calculation_reason, calculated_at, correlation_id, idempotency_key
     ) VALUES (
       $1, $2, 1, 'draft', $3, $4::jsonb, $5::jsonb,
       $6, 0, $6, $7, 'local_only', 1, $8, $9,
       clock_timestamp(), $10, $11
     )`,
    [
      billingVersionId,
      billingCaseId,
      source.rateCardVersionId,
      JSON.stringify({
        schemaVersion: source.calculation.schemaVersion,
        deduplicationKey: calculatedCase.deduplicationKey,
        allocationKey: calculatedCase.allocationKey,
        allocatedAmountMinor: calculatedCase.allocatedAmountMinor,
        calculationExplanation: source.calculation.calculationExplanation,
        expectedLineCount: 1,
        lines: [{
          lineKey: "cross_charge",
          amountMinor: calculatedCase.allocatedAmountMinor,
          currency: source.currency
        }]
      }),
      JSON.stringify({
        physicalLoadId: calculatedCase.physicalLoadId,
        completedAt: calculatedCase.completedAt,
        sourceType: calculatedCase.sourceType,
        rootReference: calculatedCase.rootReference,
        rateCardVersionId: source.rateCardVersionId
      }),
      calculatedCase.allocatedAmountMinor,
      source.currency,
      source.actorId,
      source.reason,
      source.correlationId,
      `mbbs:${calculatedCase.deduplicationKey}`
    ]
  );
  await query(
    `INSERT INTO mbt_billing_lines (
       billing_line_id, billing_version_id, sequence_number, line_key,
       line_type, description, quantity, unit_of_measure, unit_amount_minor,
       net_amount_minor, estimated_tax_minor, total_amount_minor, currency,
       revenue_class, source_entity_type, source_entity_id,
       netsuite_item_mapping_key, calculation_detail, local_item_code,
       local_item_revision, deduplication_key
     ) VALUES (
       $1, $2, 0, 'cross_charge', 'cross_charge', $3, 1, 'LOAD', $4,
       $4, 0, $4, $5, 'cross_charge', 'cross_charge_case', $6,
       $7, $8::jsonb, $9, $10, $11
     )`,
    [
      billingLineId,
      billingVersionId,
      `${calculatedCase.sourceType} ${calculatedCase.rootReference} delivery cross-charge`,
      calculatedCase.allocatedAmountMinor,
      source.currency,
      crossChargeCaseId,
      source.localItemMappingKey,
      JSON.stringify(evidence.lineDetail),
      source.localItemCode,
      source.localItemRevision,
      calculatedCase.deduplicationKey
    ]
  );
  return {
    crossChargeCaseId,
    billingCaseId,
    billingVersionId,
    billingLineId,
    versionStatus: "draft",
    postingMode: "local_only"
  };
}

/** @param {Array<Record<string, any>>} calculations @param {string} customerNetsuiteId */
// eslint-disable-next-line complexity -- Conversion independently validates every active graph edge and policy invariant.
async function validatedCandidateRateGraphs(calculations, customerNetsuiteId) {
  const versionIds = [...new Set(calculations.map((entry) => uuid(
    entry.rateCardVersionId,
    "Rate-card version ID"
  )))];
  const selected = await query(
    `SELECT version.rate_card_version_id::text, card.currency,
            card.customer_netsuite_id::text AS rate_customer_netsuite_id,
            band.currency AS band_currency, band.rate_distance_band_id::text,
            band.item_code, band.service_code, band.sequence_number::int,
            band.minimum_metres::int, band.maximum_metres::int,
            band.amount_minor::int, band.pricing_basis, band.boundary_rule,
            band.base_amount_minor::int, band.included_metres::int,
            policy.schema_version AS policy_schema_version,
            policy.currency AS policy_currency,
            policy.direct_pickup_unit_amount_minor,
            policy.po_additional_drop_unit_amount_minor,
            policy.po_vrma_additional_stop_unit_amount_minor,
            policy.so_charge_basis, policy.to_replenishment_charge_basis,
            policy.to_direct_pickup_charge_basis, policy.po_charge_basis,
            policy.po_additional_drop_basis, policy.dispatch_load_split_basis,
            policy.po_vrma_base_charge_basis, policy.vrma_direction_basis,
            policy.po_vrma_additional_stop_basis, policy.endpoint_override_basis,
            policy.to_replenishment_additional_drop_unit_amount_minor,
            policy.to_replenishment_multi_drop_basis
       FROM mbt_rate_card_versions version
       JOIN mbt_rate_cards card USING (rate_card_id)
       JOIN mbt_rate_distance_bands band USING (rate_card_version_id)
       JOIN mbt_mbbs_rate_card_policies policy USING (rate_card_version_id)
      WHERE version.rate_card_version_id = ANY($1::uuid[])
        AND version.status = 'active'
        AND card.active
        AND version.effective_from <= now()
        AND (version.effective_to IS NULL OR version.effective_to > now())
        AND band.item_code = 'DELIVERY_CHARGE_MBBS'
        AND band.service_code = 'mbbs_cross_charge'
      ORDER BY version.rate_card_version_id, band.sequence_number, band.minimum_metres`,
    [versionIds]
  );
  const routeRateRows = await query(
    `SELECT route_rate.rate_card_version_id::text,
            route_rate.rate_name AS "rateName",
            route_rate.display_name AS "displayName",
            route_rate.local_vendor_id::int AS "localVendorId",
            vendor.name AS "localVendorName",
            route_rate.vendor_yard_name AS "vendorYardName",
            route_rate.vendor_yard_address AS "vendorYardAddress",
            yard.yard_code AS "destinationYardCode",
            route_rate.base_amount_minor::text AS "baseAmountMinor",
            route_rate.currency
       FROM mbt_mbbs_vendor_route_rates route_rate
       JOIN dispatch_local_vendors vendor ON vendor.id = route_rate.local_vendor_id
       JOIN mbt_yards yard ON yard.yard_id = route_rate.destination_yard_id
      WHERE route_rate.rate_card_version_id = ANY($1::uuid[])
      ORDER BY route_rate.rate_card_version_id, lower(vendor.name),
               lower(route_rate.vendor_yard_name), yard.yard_code`,
    [versionIds]
  );
  const routeRatesByVersion = new Map();
  for (const rawRate of routeRateRows.rows) {
    const versionId = String(rawRate.rate_card_version_id);
    const rows = routeRatesByVersion.get(versionId) || [];
    rows.push({
      rateName: String(rawRate.rateName),
      displayName: String(rawRate.displayName),
      localVendorId: Number(rawRate.localVendorId),
      localVendorName: String(rawRate.localVendorName),
      vendorYardName: String(rawRate.vendorYardName),
      vendorYardAddress: String(rawRate.vendorYardAddress),
      destinationYardCode: String(rawRate.destinationYardCode),
      baseAmountMinor: Number(rawRate.baseAmountMinor),
      currency: String(rawRate.currency)
    });
    routeRatesByVersion.set(versionId, rows);
  }
  /** @type {Map<string, Array<Record<string, any>>>} */
  const graphs = new Map();
  for (const row of selected.rows) {
    const versionId = String(row.rate_card_version_id);
    const graph = graphs.get(versionId) || [];
    graph.push({
      rateDistanceBandId: String(row.rate_distance_band_id),
      itemCode: String(row.item_code),
      serviceCode: String(row.service_code),
      sequenceNumber: Number(row.sequence_number),
      minimumMetres: Number(row.minimum_metres),
      maximumMetres: row.maximum_metres === null ? null : Number(row.maximum_metres),
      amountMinor: Number(row.amount_minor),
      pricingBasis: String(row.pricing_basis),
      boundaryRule: String(row.boundary_rule),
      baseAmountMinor: row.base_amount_minor === null ? null : Number(row.base_amount_minor),
      includedMetres: row.included_metres === null ? null : Number(row.included_metres),
      currency: cad(row.currency),
      bandCurrency: cad(row.band_currency),
      mbbsChargingPolicy: requireMbbsRateCardPolicy(Number(row.policy_schema_version) === 3
        ? {
            schemaVersion: 3,
            currency: String(row.policy_currency),
            directPickupUnitAmountMinor: Number(row.direct_pickup_unit_amount_minor),
            poVrmaAdditionalStopUnitAmountMinor: Number(row.po_vrma_additional_stop_unit_amount_minor),
            toReplenishmentAdditionalDropUnitAmountMinor: Number(row.to_replenishment_additional_drop_unit_amount_minor),
            soChargeBasis: String(row.so_charge_basis),
            toReplenishmentChargeBasis: String(row.to_replenishment_charge_basis),
            toDirectPickupChargeBasis: String(row.to_direct_pickup_charge_basis),
            poChargeBasis: String(row.po_charge_basis),
            dispatchLoadSplitBasis: String(row.dispatch_load_split_basis),
            poVrmaBaseChargeBasis: String(row.po_vrma_base_charge_basis),
            vrmaDirectionBasis: String(row.vrma_direction_basis),
            poVrmaAdditionalStopBasis: String(row.po_vrma_additional_stop_basis),
            endpointOverrideBasis: String(row.endpoint_override_basis),
            toReplenishmentMultiDropBasis: String(row.to_replenishment_multi_drop_basis)
          }
        : Number(row.policy_schema_version) === 2
          ? {
            schemaVersion: 2,
            currency: String(row.policy_currency),
            directPickupUnitAmountMinor: Number(row.direct_pickup_unit_amount_minor),
            poVrmaAdditionalStopUnitAmountMinor: Number(row.po_vrma_additional_stop_unit_amount_minor),
            soChargeBasis: String(row.so_charge_basis),
            toReplenishmentChargeBasis: String(row.to_replenishment_charge_basis),
            toDirectPickupChargeBasis: String(row.to_direct_pickup_charge_basis),
            poChargeBasis: String(row.po_charge_basis),
            dispatchLoadSplitBasis: String(row.dispatch_load_split_basis),
            poVrmaBaseChargeBasis: String(row.po_vrma_base_charge_basis),
            vrmaDirectionBasis: String(row.vrma_direction_basis),
            poVrmaAdditionalStopBasis: String(row.po_vrma_additional_stop_basis),
            endpointOverrideBasis: String(row.endpoint_override_basis)
            }
          : {
            schemaVersion: 1,
            currency: String(row.policy_currency),
            directPickupUnitAmountMinor: Number(row.direct_pickup_unit_amount_minor),
            poAdditionalDropUnitAmountMinor: Number(row.po_additional_drop_unit_amount_minor),
            soChargeBasis: String(row.so_charge_basis),
            toReplenishmentChargeBasis: String(row.to_replenishment_charge_basis),
            toDirectPickupChargeBasis: String(row.to_direct_pickup_charge_basis),
            poChargeBasis: String(row.po_charge_basis),
            poAdditionalDropBasis: String(row.po_additional_drop_basis),
            dispatchLoadSplitBasis: String(row.dispatch_load_split_basis)
          }),
      mbbsVendorRouteRates: normalizeMbbsVendorRouteRates(routeRatesByVersion.get(versionId) || []),
      rateCustomerNetsuiteId: row.rate_customer_netsuite_id === null
        ? null
        : String(row.rate_customer_netsuite_id)
    });
    graphs.set(versionId, graph);
  }
  if (graphs.size !== versionIds.length) {
    throw failure(409, "MBT_MBBS_RATE_SELECTION_UNAVAILABLE", "Every selected MBBS rate card must remain active during billing conversion.");
  }
  for (const [versionId, graph] of graphs) {
    if (graph.some((band) => band.currency !== band.bandCurrency)) {
      throw failure(409, "MBT_MBBS_RATE_INVALID", `MBBS rate version ${versionId} has inconsistent currency evidence.`);
    }
    const mappedCustomerId = graph[0]?.rateCustomerNetsuiteId;
    if (mappedCustomerId && mappedCustomerId !== customerNetsuiteId) {
      throw failure(409, "MBT_CROSS_CHARGE_CUSTOMER_RATE_MISMATCH", `MBBS rate version ${versionId} is mapped to a different canonical customer.`);
    }
    selectRateBand(graph, 0);
  }
  return graphs;
}

/** @param {unknown} value */
function candidateBillingCustomerId(value) {
  const selected = requiredText(value, "Customer NetSuite ID");
  if (!/^\d+$/u.test(selected) || BigInt(selected) < 1n) {
    throw failure(400, "MBT_CROSS_CHARGE_CUSTOMER_INVALID", "Choose a valid canonical billing customer.");
  }
  return selected;
}

/** @param {unknown} value */
function candidateCalculations(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    throw failure(400, "MBT_BILLING_CANDIDATE_BATCH_INVALID", "Provide between 1 and 100 server-calculated MBBS orders.");
  }
  return value.map((entry) => object(entry, "Calculated MBBS candidate"));
}

/** @param {string} customerNetsuiteId */
async function assertActiveCandidateCustomer(customerNetsuiteId) {
  const customer = await query(
    `SELECT netsuite_id::text
       FROM netsuite_customers
      WHERE netsuite_id = $1::bigint
        AND active
        AND currency = 'CAD'`,
    [customerNetsuiteId]
  );
  if (!customer.rowCount) {
    throw failure(409, "MBT_CROSS_CHARGE_CUSTOMER_INVALID", "The selected billing customer is not an active CAD customer in the canonical customer master.");
  }
}

async function selectedCandidateLocalItem() {
  const selected = await query(
    `SELECT item_code, revision::int, netsuite_mapping_local_key
       FROM mbt_local_item_settings
      WHERE item_code = 'DELIVERY_CHARGE_MBBS'
        AND item_type = 'delivery_fee'
        AND active`
  );
  if (!selected.rowCount) {
    throw failure(409, "MBT_BILLING_LOCAL_ITEM_INVALID", "DELIVERY_CHARGE_MBBS must remain an active delivery item.");
  }
  return selected.rows[0];
}

/** @param {Record<string, any> | null} actual @param {unknown} retained */
function sameVendorRouteRate(actual, retained) {
  if (!actual) {
    return retained === null || retained === undefined;
  }
  if (!retained || typeof retained !== "object" || Array.isArray(retained)) {
    return false;
  }
  const supplied = /** @type {Record<string, any>} */ (retained);
  return [
    [actual.rateName, supplied.rateName],
    [actual.displayName, supplied.displayName],
    [actual.localVendorId, Number(supplied.localVendorId)],
    [actual.localVendorName, supplied.localVendorName],
    [actual.vendorYardName, supplied.vendorYardName],
    [actual.vendorYardAddress, supplied.vendorYardAddress],
    [actual.destinationYardCode, supplied.destinationYardCode],
    [actual.baseAmountMinor, Number(supplied.baseAmountMinor)],
    [actual.currency, supplied.currency]
  ].every(([left, right]) => left === right);
}

/**
 * Independently recompute a schema-v2/v3 PO/VRMA amount from the active graph.
 * Browser-supplied money and the earlier preview are evidence only.
 *
 * @param {Record<string, any>} entry
 * @param {Record<string, any>} candidate
 * @param {Array<Record<string, any>>} graph
 * @param {number} distanceMetres
 * @param {Record<string, any>} charge
 */
// eslint-disable-next-line complexity -- Fail-closed shadow pricing verifies every retained PO/VRMA evidence branch.
function candidateVendorRouteBillingLoad(entry, candidate, graph, distanceMetres, charge) {
  const firstBand = graph[0];
  if (!firstBand) {
    throw failure(409, "MBT_MBBS_CALCULATION_STALE", "The active MBBS rate graph is unavailable.");
  }
  const policy = firstBand.mbbsChargingPolicy;
  const pricingMethod = requiredText(entry.pricingMethod, "PO/VRMA pricing method");
  if (!["vendor_yard_flat", "distance_band"].includes(pricingMethod)) {
    throw failure(409, "MBT_MBBS_CALCULATION_STALE", "The retained PO/VRMA pricing method is invalid.");
  }
  const identity = object(candidate.vendorRouteEvidence, "Vendor-route identity evidence");
  const vendorRate = selectMbbsVendorRouteRate(firstBand.mbbsVendorRouteRates, {
    sourceType: Array.isArray(candidate.references)
      ? candidate.references.map((reference) => String(reference.sourceType)).find((type) => ["PO", "VRMA"].includes(type))
      : null,
    localVendorId: Number(identity.localVendorId),
    vendorYardName: String(identity.vendorYardName || ""),
    vendorYardAliases: [],
    mbbsYardCode: String(identity.mbbsYardCode || "")
  });
  if (!sameVendorRouteRate(vendorRate, entry.selectedVendorRouteRate)) {
    throw failure(409, "MBT_MBBS_CALCULATION_STALE", "The retained vendor-yard rate no longer matches the active rate graph.");
  }
  if (pricingMethod === "vendor_yard_flat" && !vendorRate) {
    throw failure(409, "MBT_MBBS_CALCULATION_STALE", "The selected vendor-yard flat rate is no longer active.");
  }
  if (pricingMethod === "distance_band" && vendorRate && identity.endpointOverride !== true) {
    throw failure(409, "MBT_MBBS_CALCULATION_STALE", "Distance pricing is not allowed without retained endpoint-override evidence.");
  }
  const selected = pricingMethod === "distance_band"
    ? /** @type {(Record<string, any> & {amountMinor: unknown}) | undefined} */ (selectRateBand(graph, distanceMetres))
    : null;
  const retainedBand = entry.selectedBand;
  if (pricingMethod === "vendor_yard_flat" && retainedBand !== null) {
    throw failure(409, "MBT_MBBS_CALCULATION_STALE", "A flat vendor-yard charge cannot retain a selected distance band.");
  }
  if (pricingMethod === "distance_band") {
    const suppliedBand = object(retainedBand, "Selected rate band");
    if (!selected || String(selected.rateDistanceBandId) !== String(suppliedBand.rateDistanceBandId)) {
      throw failure(409, "MBT_MBBS_CALCULATION_STALE", "The selected distance band changed before conversion.");
    }
  }
  const amount = calculateMbbsPurchaseRouteAmount({
    pricingMethod,
    vendorRouteAmountMinor: vendorRate?.baseAmountMinor ?? 0,
    distanceBandAmountMinor: selected
      ? calculateDistanceBandChargeMinor(selected, distanceMetres)
      : 0,
    routeStopCount: nonnegativeInteger(candidate.routeStopCount, "Candidate route-stop count"),
    mbbsChargingPolicy: policy
  });
  const manualAmount = resolveManualBillingAmount({
    calculatedAmountMinor: amount.calculatedAmountMinor,
    adjustmentMinor: charge.adjustmentMinor,
    finalAmountMinor: charge.finalAmountMinor
  });
  if (String(charge.itemCode) !== "DELIVERY_CHARGE_MBBS"
      || cad(charge.currency) !== firstBand.currency
      || Number(charge.calculatedAmountMinor) !== amount.calculatedAmountMinor
      || Number(charge.amountMinor) !== manualAmount.finalAmountMinor
      || Number(charge.totalMinor) !== manualAmount.finalAmountMinor) {
    throw failure(409, "MBT_MBBS_CALCULATION_STALE", "The PO/VRMA amount no longer matches the active rate graph.");
  }
  return {
    physicalLoadId: requiredText(candidate.physicalLoadId, "Physical-load ID"),
    completedAt: requiredText(candidate.completedAt, "Completed-load time"),
    planDate: requiredText(candidate.planDate || String(candidate.completedAt).slice(0, 10), "Plan date"),
    truckId: null,
    driverId: null,
    calculatedMetres: distanceMetres,
    sharedTotalMinor: nonnegativeInteger(manualAmount.finalAmountMinor, "Shared cross-charge total"),
    references: candidate.references,
    billingEvidence: canonicalize({
      schemaVersion: "mbbs-billing-manual-amount-v2",
      billingRule: requiredText(candidate.billingRule, "Candidate billing rule"),
      billingLegId: requiredText(candidate.billingLegId, "Candidate billing-leg ID"),
      driverLoadIds: Array.isArray(candidate.driverLoadIds) ? candidate.driverLoadIds : [],
      driverLoadNumbers: Array.isArray(candidate.driverLoadNumbers) ? candidate.driverLoadNumbers : [],
      memberReferences: Array.isArray(candidate.memberReferences) ? candidate.memberReferences : [],
      relationship: candidate.relationship || null,
      routeStops: Array.isArray(candidate.routeStops) ? candidate.routeStops : [],
      calculationSteps: Array.isArray(entry.calculationSteps) ? entry.calculationSteps : [],
      distanceAvailable: entry.distanceAvailable === true,
      pricingMethod,
      pricingSource: pricingMethod,
      vendorRouteEvidence: identity,
      selectedVendorRouteRate: vendorRate,
      mbbsChargingPolicy: policy,
      baseAmountMinor: amount.baseAmountMinor,
      distanceBandAmountMinor: amount.distanceBandAmountMinor,
      vendorRouteAmountMinor: amount.vendorRouteAmountMinor,
      additionalDropCount: amount.additionalStopCount,
      additionalDropUnitAmountMinor: amount.additionalStopUnitAmountMinor,
      additionalDropFeeMinor: amount.additionalStopFeeMinor,
      ...manualAmount,
      edited: manualAmount.adjustmentMinor !== 0,
      editorId: String(object(entry.manualAmount, "Manual amount evidence").editorId || "")
    }),
    _rate: {
      rateCardVersionId: String(entry.rateCardVersionId),
      rateDistanceBandId: selected ? String(selected.rateDistanceBandId) : null,
      currency: firstBand.currency
    }
  };
}

/** @param {Record<string, any>} entry @param {Map<string, Array<Record<string, any>>>} graphs */
// eslint-disable-next-line complexity
function candidateBillingLoad(entry, graphs) {
  const candidate = object(entry.candidate, "Calculated candidate identity");
  const graph = graphs.get(String(entry.rateCardVersionId));
  const distanceMetres = nonnegativeInteger(entry.distanceMetres, "Cross-charge distance");
  const automaticRate = entry.automaticRate && typeof entry.automaticRate === "object"
    ? object(entry.automaticRate, "Automatic rate evidence")
    : { available: true };
  const charge = object(entry.charge, "Calculated charge");
  if (automaticRate.available !== false
      && Number(graph?.[0]?.mbbsChargingPolicy?.schemaVersion) >= 2
      && ["po_shared_leg", "po_group"].includes(String(candidate.billingRule))) {
    return candidateVendorRouteBillingLoad(entry, candidate, /** @type {Array<Record<string, any>>} */ (graph), distanceMetres, charge);
  }
  if (automaticRate.available === false) {
    const firstBand = graph?.[0];
    if (!firstBand
        || entry.selectedBand !== null
        || entry.distanceAvailable !== false
        || Number(charge.calculatedAmountMinor) !== 0
        || String(charge.itemCode) !== "DELIVERY_CHARGE_MBBS"
        || cad(charge.currency) !== firstBand.currency) {
      throw failure(409, "MBT_MBBS_CALCULATION_STALE", "A manual MBBS charge no longer matches its retained no-rate evidence.");
    }
    const manualAmount = resolveManualBillingAmount({
      calculatedAmountMinor: 0,
      adjustmentMinor: charge.adjustmentMinor,
      finalAmountMinor: charge.finalAmountMinor
    });
    const manualEvidence = object(entry.manualAmount, "Manual amount evidence");
    return {
      physicalLoadId: requiredText(candidate.physicalLoadId, "Physical-load ID"),
      completedAt: requiredText(candidate.completedAt, "Completed-load time"),
      planDate: requiredText(candidate.planDate || String(candidate.completedAt).slice(0, 10), "Plan date"),
      truckId: null,
      driverId: null,
      calculatedMetres: distanceMetres,
      sharedTotalMinor: nonnegativeInteger(manualAmount.finalAmountMinor, "Shared cross-charge total"),
      references: candidate.references,
      billingEvidence: canonicalize({
        schemaVersion: "mbbs-billing-manual-amount-v1",
        billingRule: requiredText(candidate.billingRule, "Candidate billing rule"),
        billingLegId: requiredText(candidate.billingLegId, "Candidate billing-leg ID"),
        driverLoadIds: Array.isArray(candidate.driverLoadIds) ? candidate.driverLoadIds : [],
        driverLoadNumbers: Array.isArray(candidate.driverLoadNumbers) ? candidate.driverLoadNumbers : [],
        memberReferences: Array.isArray(candidate.memberReferences) ? candidate.memberReferences : [],
        relationship: candidate.relationship || null,
        routeStops: Array.isArray(candidate.routeStops) ? candidate.routeStops : [],
        calculationSteps: Array.isArray(entry.calculationSteps) ? entry.calculationSteps : [],
        distanceAvailable: false,
        automaticRate,
        mbbsChargingPolicy: firstBand.mbbsChargingPolicy,
        distanceBandAmountMinor: 0,
        additionalDropCount: 0,
        additionalDropUnitAmountMinor: 0,
        additionalDropFeeMinor: 0,
        ...manualAmount,
        edited: true,
        editorId: requiredText(manualEvidence.editorId, "Manual-rate editor ID")
      }),
      _rate: {
        rateCardVersionId: String(entry.rateCardVersionId),
        rateDistanceBandId: null,
        currency: firstBand.currency
      }
    };
  }
  const selected = graph
    ? /** @type {(Record<string, any> & {amountMinor: unknown}) | undefined} */ (
      selectRateBand(graph, distanceMetres)
    )
    : null;
  const selectedBand = object(entry.selectedBand, "Selected rate band");
  const chargeCurrency = cad(charge.currency);
  const rateAmountMinor = selected
    ? calculateDistanceBandChargeMinor(selected, distanceMetres)
    : null;
  const policyAmount = selected
    ? calculateBillingUnitAmount({
        billingRule: requiredText(candidate.billingRule, "Candidate billing rule"),
        distanceBandAmountMinor: rateAmountMinor,
        dropCount: nonnegativeInteger(candidate.dropCount, "Candidate drop count"),
        mbbsChargingPolicy: selected.mbbsChargingPolicy
      })
    : null;
  const manualAmount = policyAmount
    ? resolveManualBillingAmount({
        calculatedAmountMinor: policyAmount.calculatedAmountMinor,
        adjustmentMinor: charge.adjustmentMinor,
        finalAmountMinor: charge.finalAmountMinor
      })
    : null;
  const matches = selected && [
    [selected.rateDistanceBandId, String(selectedBand.rateDistanceBandId)],
    [selected.itemCode, String(charge.itemCode)],
    [policyAmount?.calculatedAmountMinor, Number(charge.calculatedAmountMinor)],
    [manualAmount?.finalAmountMinor, Number(charge.amountMinor)],
    [manualAmount?.finalAmountMinor, Number(charge.totalMinor)],
    [chargeCurrency, selected.currency]
  ].every(([actual, expected]) => actual === expected);
  if (!matches || !selected || !policyAmount || !manualAmount) {
    throw failure(409, "MBT_MBBS_CALCULATION_STALE", "A selected MBBS calculation no longer matches the active rate graph.");
  }
  return {
    physicalLoadId: requiredText(candidate.physicalLoadId, "Physical-load ID"),
    completedAt: requiredText(candidate.completedAt, "Completed-load time"),
    planDate: requiredText(candidate.planDate || String(candidate.completedAt).slice(0, 10), "Plan date"),
    truckId: null,
    driverId: null,
    calculatedMetres: distanceMetres,
    sharedTotalMinor: nonnegativeInteger(manualAmount.finalAmountMinor, "Shared cross-charge total"),
    references: candidate.references,
    billingEvidence: canonicalize({
      schemaVersion: "mbbs-billing-manual-amount-v1",
      billingRule: requiredText(candidate.billingRule, "Candidate billing rule"),
      billingLegId: requiredText(candidate.billingLegId, "Candidate billing-leg ID"),
      driverLoadIds: Array.isArray(candidate.driverLoadIds) ? candidate.driverLoadIds : [],
      driverLoadNumbers: Array.isArray(candidate.driverLoadNumbers) ? candidate.driverLoadNumbers : [],
      memberReferences: Array.isArray(candidate.memberReferences) ? candidate.memberReferences : [],
      relationship: candidate.relationship || null,
      routeStops: Array.isArray(candidate.routeStops) ? candidate.routeStops : [],
      calculationSteps: Array.isArray(entry.calculationSteps) ? entry.calculationSteps : [],
      mbbsChargingPolicy: selected.mbbsChargingPolicy,
      distanceBandAmountMinor: policyAmount.distanceBandAmountMinor,
      additionalDropCount: policyAmount.additionalDropCount,
      additionalDropUnitAmountMinor: policyAmount.additionalDropUnitAmountMinor,
      additionalDropFeeMinor: policyAmount.additionalDropFeeMinor,
      ...manualAmount,
      edited: manualAmount.adjustmentMinor !== 0,
      editorId: String(object(entry.manualAmount, "Manual amount evidence").editorId || "")
    }),
    _rate: {
      rateCardVersionId: String(entry.rateCardVersionId),
      rateDistanceBandId: selected.rateDistanceBandId,
      currency: selected.currency
    }
  };
}

/**
 * Persist a server-calculated candidate batch without opening another command
 * receipt. The caller must already be inside executeMbtCommand's transaction;
 * this boundary independently revalidates every active rate band and cent.
 *
 * @param {unknown} rawInput
 * @param {{hooks?: Record<string, Function>}} [dependencies]
 */
export async function persistCalculatedMbbsCandidateBatch(rawInput, dependencies = {}) {
  const input = object(rawInput, "MBBS candidate billing batch");
  const actor = billingActor(input.actor);
  const customerNetsuiteId = candidateBillingCustomerId(input.customerNetsuiteId);
  const reason = requiredText(input.reason, "Generation reason");
  const correlationId = requiredText(input.correlationId, "Correlation ID");
  const calculations = candidateCalculations(input.calculations);
  await assertActiveCandidateCustomer(customerNetsuiteId);
  const graphs = await validatedCandidateRateGraphs(calculations, customerNetsuiteId);
  const item = await selectedCandidateLocalItem();
  const loads = calculations.map((entry) => candidateBillingLoad(entry, graphs));
  const calculation = calculateMbbsCrossCharges({
    currency: "CAD",
    loads: loads.map(({ _rate, ...load }) => load)
  });
  const rateByLoad = new Map(loads.map((load) => [load.physicalLoadId, load._rate]));
  const sourceBase = {
    customerNetsuiteId,
    calculation,
    completedLoadSnapshotIdsByPhysicalLoad: object(
      input.completedLoadSnapshotIdsByPhysicalLoad,
      "Completed-load snapshot map"
    ),
    actorId: requiredText(actor.operatorId, "Actor ID"),
    reason,
    correlationId,
    localItemCode: String(item.item_code),
    localItemRevision: Number(item.revision),
    localItemMappingKey: item.netsuite_mapping_local_key
  };
  const cases = [];
  for (const calculatedCase of calculation.cases) {
    const rate = rateByLoad.get(calculatedCase.physicalLoadId);
    if (!rate) {
      throw failure(500, "MBT_BILLING_DRAFT_INCOMPLETE", "A calculated MBBS load lost its validated rate identity.");
    }
    const durable = await insertOrVerifyCrossCharge(calculatedCase, {
      ...sourceBase,
      ...rate
    });
    cases.push({
      deduplicationKey: calculatedCase.deduplicationKey,
      sourceType: calculatedCase.sourceType,
      rootReference: calculatedCase.rootReference,
      physicalLoadId: calculatedCase.physicalLoadId,
      allocatedAmountMinor: calculatedCase.allocatedAmountMinor,
      rateCardVersionId: rate.rateCardVersionId,
      rateDistanceBandId: rate.rateDistanceBandId,
      ...durable
    });
    if (typeof dependencies.hooks?.afterCaseInsert === "function") {
      await dependencies.hooks.afterCaseInsert({ calculatedCase, durable });
    }
  }
  return {
    generationId: stableId("mbt.cross_charge.candidate_generation", cases.map((entry) => entry.deduplicationKey)),
    currency: "CAD",
    cases,
    allocationGroups: calculation.allocationGroups.map((group) => ({
      ...group,
      allocationGroupId: stableId("mbt.cross_charge.allocation_group", group.allocationKey)
    })),
    postingMode: "local_only"
  };
}

/**
 * Generate durable MBBS local-only shadow cases from completed normalized
 * physical loads. A generation-wide advisory lock makes independent exact
 * requests converge on the same deterministic case/version/line identities.
 *
 * @param {unknown} rawInput
 * @param {{hooks?: Record<string, Function>, transport?: Function, completedLoadSnapshotIdsByPhysicalLoad?: Record<string, string>}} [dependencies]
 */
export async function generateMbbsShadowBilling(rawInput, dependencies = {}) {
  const input = object(rawInput, "MBBS generation");
  const actor = billingActor(input.actor);
  const normalized = normalizedMbbsInput(input);
  const calculation = calculateMbbsCrossCharges({
    currency: normalized.currency,
    loads: normalized.loads
  });
  const reason = requiredText(input.reason, "Generation reason");
  const hooks = dependencies.hooks || {};
  const payload = { ...normalized, reason };
  return executeMbtCommand({
    actor,
    commandName: "mbt.billing.generate_mbbs",
    idempotencyKey: requiredText(input.idempotencyKey, "Idempotency key"),
    payload,
    correlationId: requiredText(input.correlationId, "Correlation ID"),
    requestId: requiredText(input.requestId, "Request ID"),
    mutation: async () => {
      await query(
        "SELECT pg_advisory_xact_lock(hashtextextended('mbt.shadow.billing.generation', 0))"
      );
      const rate = await query(
        `SELECT version.rate_card_version_id, card.currency,
                band.currency AS band_currency, band.item_code
           FROM mbt_rate_card_versions version
           JOIN mbt_rate_cards card USING (rate_card_id)
           JOIN mbt_rate_distance_bands band
             ON band.rate_distance_band_id = $2
            AND band.rate_card_version_id = version.rate_card_version_id
          WHERE version.rate_card_version_id = $1
            AND version.status = 'active'`,
        [normalized.rateCardVersionId, normalized.rateDistanceBandId]
      );
      if (!rate.rowCount || cad(rate.rows[0].currency) !== normalized.currency
          || cad(rate.rows[0].band_currency) !== normalized.currency) {
        throw failure(409, "MBT_CROSS_CHARGE_RATE_INVALID", "The active cross-charge rate version and distance band must match the billing currency.");
      }
      const customer = await query(
        "SELECT 1 FROM netsuite_customers WHERE netsuite_id = $1",
        [normalized.customerNetsuiteId]
      );
      if (!customer.rowCount) {
        throw failure(409, "MBT_CROSS_CHARGE_CUSTOMER_INVALID", "The cross-charge customer is not in the canonical customer master.");
      }
      const item = await query(
        `SELECT item_code, revision, netsuite_mapping_local_key
           FROM mbt_local_item_settings
          WHERE item_code = $1
            AND item_type = 'delivery_fee'
            AND active`,
        [String(rate.rows[0].item_code || "DELIVERY_CROSS_CHARGE")]
      );
      if (!item.rowCount) {
        throw failure(409, "MBT_BILLING_LOCAL_ITEM_INVALID", "The cross-charge local item is not active.");
      }
      const source = {
        ...normalized,
        calculation,
        completedLoadSnapshotIdsByPhysicalLoad: dependencies.completedLoadSnapshotIdsByPhysicalLoad || {},
        actorId: requiredText(actor.operatorId, "Actor ID"),
        reason,
        correlationId: requiredText(input.correlationId, "Correlation ID"),
        localItemCode: String(item.rows[0].item_code),
        localItemRevision: Number(item.rows[0].revision),
        localItemMappingKey: item.rows[0].netsuite_mapping_local_key
      };
      const cases = [];
      for (const calculatedCase of calculation.cases) {
        const durable = await insertOrVerifyCrossCharge(calculatedCase, source);
        cases.push({
          deduplicationKey: calculatedCase.deduplicationKey,
          sourceType: calculatedCase.sourceType,
          rootReference: calculatedCase.rootReference,
          physicalLoadId: calculatedCase.physicalLoadId,
          allocatedAmountMinor: calculatedCase.allocatedAmountMinor,
          ...durable
        });
        if (typeof hooks.afterCaseInsert === "function") {
          await hooks.afterCaseInsert({ calculatedCase, durable });
        }
      }
      const allocationGroups = calculation.allocationGroups.map((group) => ({
        ...group,
        allocationGroupId: stableId("mbt.cross_charge.allocation_group", group.allocationKey)
      }));
      const generationId = stableId(
        "mbt.cross_charge.generation",
        cases.map((entry) => entry.deduplicationKey)
      );
      const body = {
        schemaVersion: "mbbs-local-shadow-billing-v1",
        generationId,
        currency: normalized.currency,
        cases,
        allocationGroups,
        postingMode: "local_only"
      };
      return {
        status: 201,
        body,
        audit: {
          action: "mbt.billing.mbbs.generated",
          entityType: "mbt_cross_charge_generation",
          entityId: generationId,
          beforeState: { cases: 0 },
          afterState: {
            cases: cases.length,
            deduplicationKeys: cases.map((entry) => entry.deduplicationKey),
            postingMode: "local_only"
          },
          reason,
          revisionBefore: 1,
          revisionAfter: 1,
          source: "p3_local_shadow_billing"
        }
      };
    }
  });
}

/** @param {Record<string, any>} row */
function completedLoadFromSnapshot(row) {
  const sourceSnapshot = canonicalObject(row.source_snapshot);
  const references = canonicalize(row.source_references);
  const retainedIdentity = {
    physicalLoadId: String(row.physical_load_id),
    completedAt: databaseIso(row.completed_at),
    planDate: String(row.plan_date),
    truckId: row.truck_id === null ? null : String(row.truck_id),
    driverId: row.driver_id === null ? null : String(row.driver_id),
    calculatedMetres: Number(row.calculated_metres),
    sharedTotalMinor: Number(row.shared_total_minor),
    references
  };
  const snapshotMatches = canonicalSha256(sourceSnapshot) === String(row.source_snapshot_hash)
    && sourceSnapshot.completed === true
    && String(sourceSnapshot.physicalLoadId) === retainedIdentity.physicalLoadId
    && databaseIso(sourceSnapshot.completedAt) === retainedIdentity.completedAt;
  if (!snapshotMatches) {
    throw failure(409, "MBT_CROSS_CHARGE_SOURCE_INVALID", "The completed-load snapshot failed its immutable source checks.");
  }
  return retainedIdentity;
}

/**
 * Public-safe generation boundary: callers identify immutable server-owned
 * completed-load rows and cannot supply physical-load amounts or references.
 *
 * @param {unknown} rawInput
 * @param {{hooks?: Record<string, Function>, transport?: Function}} [dependencies]
 */
export async function generateMbbsShadowBillingFromSnapshots(rawInput, dependencies = {}) {
  const input = object(rawInput, "MBBS snapshot generation");
  const actor = billingActor(input.actor);
  if (Object.hasOwn(input, "loads")) {
    throw failure(
      400,
      "MBT_CROSS_CHARGE_SNAPSHOT_INPUT_INVALID",
      "Public cross-charge generation accepts completed-load snapshot IDs, not caller-authored load evidence."
    );
  }
  if (!Array.isArray(input.completedLoadSnapshotIds)
      || input.completedLoadSnapshotIds.length < 1
      || input.completedLoadSnapshotIds.length > 100) {
    throw failure(400, "MBT_CROSS_CHARGE_SNAPSHOT_IDS_INVALID", "Provide between 1 and 100 completed-load snapshot IDs.");
  }
  const snapshotIds = input.completedLoadSnapshotIds.map(
    (value) => uuid(value, "Completed-load snapshot ID")
  );
  if (new Set(snapshotIds).size !== snapshotIds.length) {
    throw failure(409, "MBT_CROSS_CHARGE_SNAPSHOT_IDS_DUPLICATE", "Completed-load snapshot IDs must be unique.");
  }
  const selected = await query(
    `SELECT completed_load_snapshot_id, plan_date::text, physical_load_id,
            completed_at, truck_id, driver_id, calculated_metres,
            shared_total_minor, currency, source_references,
            source_snapshot, source_snapshot_hash
       FROM mbt_mbbs_completed_load_snapshots
      WHERE completed_load_snapshot_id = ANY($1::uuid[])
      ORDER BY physical_load_id, completed_load_snapshot_id`,
    [snapshotIds]
  );
  if (selected.rowCount !== snapshotIds.length) {
    throw failure(404, "MBT_CROSS_CHARGE_SNAPSHOT_NOT_FOUND", "One or more completed-load snapshots are unavailable.");
  }
  const currencies = new Set(selected.rows.map(
    (/** @type {Record<string, any>} */ row) => cad(row.currency)
  ));
  if (currencies.size !== 1 || !currencies.has(cad(input.currency))) {
    throw failure(409, "MBT_BILLING_CURRENCY_MISMATCH", "Completed-load snapshots must share the requested CAD currency.");
  }
  const loads = selected.rows.map(completedLoadFromSnapshot);
  const snapshotMap = Object.fromEntries(selected.rows.map((/** @type {Record<string, any>} */ row) => [
    String(row.physical_load_id),
    String(row.completed_load_snapshot_id)
  ]));
  return generateMbbsShadowBilling({
    actor,
    customerNetsuiteId: input.customerNetsuiteId,
    rateCardVersionId: input.rateCardVersionId,
    rateDistanceBandId: input.rateDistanceBandId,
    currency: input.currency,
    loads,
    reason: input.reason,
    idempotencyKey: input.idempotencyKey,
    correlationId: input.correlationId,
    requestId: input.requestId
  }, {
    ...dependencies,
    completedLoadSnapshotIdsByPhysicalLoad: snapshotMap
  });
}

/** @param {unknown} value @param {string} label */
function optionalQueueFilter(value, label) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return null;
  }
  return requiredText(value, label).toLowerCase();
}

/** @param {unknown} value */
function optionalTorontoBillingMonth(value) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return null;
  }
  const month = String(value).trim();
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(month)) {
    throw failure(400, "MBT_BILLING_INPUT_INVALID", "Billing month must use YYYY-MM in America/Toronto.");
  }
  return month;
}

/** @param {unknown} value */
function queueLimit(value) {
  const normalized = value === undefined ? 50 : Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1 || normalized > 100) {
    throw failure(400, "MBT_BILLING_INPUT_INVALID", "Billing queue limit must be an integer from 1 through 100.");
  }
  return normalized;
}

/** @param {unknown} value */
function nullableString(value) {
  return value === null || value === undefined ? null : String(value);
}

/** @param {unknown} value */
function nullableNumber(value) {
  return value === null || value === undefined ? null : Number(value);
}

/** @param {Record<string, any>} row */
function publicBillingCaseSummary(row) {
  return {
    billingCaseId: String(row.billing_case_id),
    caseType: String(row.case_type),
    contractId: nullableString(row.contract_id),
    serviceVisitId: nullableString(row.service_visit_id),
    visitDistanceSnapshotId: nullableString(row.visit_distance_snapshot_id),
    crossChargeCaseId: nullableString(row.cross_charge_case_id),
    customerNetsuiteId: String(row.customer_netsuite_id),
    status: String(row.status),
    postingMode: String(row.posting_mode),
    currency: String(row.currency),
    exceptionCodes: Array.isArray(row.exception_codes) ? row.exception_codes.map(String) : [],
    reviewNote: String(row.review_note || ""),
    currentVersionNumber: Number(row.current_version_number),
    revision: Number(row.revision),
    billingVersionId: nullableString(row.billing_version_id),
    versionStatus: nullableString(row.version_status),
    subtotalMinor: nullableNumber(row.subtotal_minor),
    estimatedTaxMinor: nullableNumber(row.estimated_tax_minor),
    totalMinor: nullableNumber(row.total_minor),
    completedAt: databaseIso(row.actual_completed_at ?? row.completed_load_at),
    createdAt: databaseIso(row.created_at),
    updatedAt: databaseIso(row.updated_at)
  };
}

/**
 * Read-only recovery queue. Operational gates intentionally live at mutation
 * boundaries so closing billing generation never hides retained local truth.
 *
 * @param {unknown} [rawInput]
 */
export async function listLocalBillingCases(rawInput = {}) {
  const input = object(rawInput, "Billing queue request");
  billingActor(input.actor);
  const status = optionalQueueFilter(input.status, "Billing status");
  const caseType = optionalQueueFilter(input.caseType, "Billing case type");
  const billingMonth = optionalTorontoBillingMonth(input.billingMonth);
  const allowedStatuses = new Set([
    "open", "ready", "in_review", "approved", "posting", "posted", "attention", "voided"
  ]);
  const allowedCaseTypes = new Set(["mbt_contract", "mbbs_cross_charge"]);
  if (status !== null && !allowedStatuses.has(status)) {
    throw failure(400, "MBT_BILLING_INPUT_INVALID", "The billing queue status filter is invalid.");
  }
  if (caseType !== null && !allowedCaseTypes.has(caseType)) {
    throw failure(400, "MBT_BILLING_INPUT_INVALID", "The billing queue case-type filter is invalid.");
  }
  const cursor = input.cursor === undefined || input.cursor === null || input.cursor === ""
    ? null
    : uuid(input.cursor, "Billing queue cursor");
  const limit = queueLimit(input.limit);
  const result = await query(
    `SELECT billing_case.billing_case_id, billing_case.case_type,
            billing_case.contract_id, billing_case.service_visit_id,
            billing_case.cross_charge_case_id, billing_case.customer_netsuite_id,
            billing_case.status, billing_case.posting_mode, billing_case.currency,
            billing_case.exception_codes, billing_case.review_note,
            billing_case.current_version_number, billing_case.revision,
            billing_case.created_at, billing_case.updated_at,
            visit.actual_completed_at AS actual_completed_at,
            cross_charge.completed_load_at AS completed_load_at,
            version.billing_version_id, version.status AS version_status,
            version.subtotal_minor, version.estimated_tax_minor, version.total_minor,
            visit_distance.distance_snapshot_id AS visit_distance_snapshot_id
       FROM mbt_billing_cases billing_case
       LEFT JOIN mbt_service_visits visit
         ON visit.service_visit_id = billing_case.service_visit_id
       LEFT JOIN mbt_cross_charge_cases cross_charge
         ON cross_charge.cross_charge_case_id = billing_case.cross_charge_case_id
       LEFT JOIN mbt_contracts contract
         ON contract.contract_id = billing_case.contract_id
       LEFT JOIN mbt_billing_versions version
         ON version.billing_case_id = billing_case.billing_case_id
        AND version.version_number = billing_case.current_version_number
       LEFT JOIN LATERAL (
         SELECT distance_snapshot.distance_snapshot_id
           FROM mbt_distance_snapshots distance_snapshot
          WHERE distance_snapshot.subject_type = 'visit'
            AND distance_snapshot.subject_id = billing_case.service_visit_id
            AND distance_snapshot.rate_card_version_id = contract.rate_card_version_id
          ORDER BY distance_snapshot.calculated_at DESC,
                   distance_snapshot.distance_snapshot_id DESC
          LIMIT 1
       ) visit_distance ON true
      WHERE ($1::text IS NULL OR billing_case.status = $1)
        AND ($2::text IS NULL OR billing_case.case_type = $2)
        AND (
          (
            billing_case.case_type = 'mbt_contract'
            AND visit.status = 'completed'
            AND visit.actual_completed_at IS NOT NULL
          )
          OR (
            billing_case.case_type = 'mbbs_cross_charge'
            AND cross_charge.completed_load_at IS NOT NULL
          )
        )
        AND ($3::text IS NULL OR to_char(
          (COALESCE(visit.actual_completed_at, cross_charge.completed_load_at) AT TIME ZONE 'America/Toronto'),
          'YYYY-MM'
        ) = $3)
        AND ($4::uuid IS NULL OR billing_case.billing_case_id > $4)
      ORDER BY billing_case.billing_case_id
      LIMIT $5`,
    [status, caseType, billingMonth, cursor, limit + 1]
  );
  const hasMore = result.rows.length > limit;
  const page = result.rows.slice(0, limit).map(publicBillingCaseSummary);
  return {
    schemaVersion: "mbt-local-billing-queue-v1",
    postingMode: "local_only",
    billingMonth,
    items: page,
    nextCursor: hasMore ? page.at(-1)?.billingCaseId ?? null : null
  };
}

/** @param {string} billingCaseId @param {unknown} actor */
export async function getLocalBillingCase(billingCaseId, actor) {
  billingActor(actor);
  const normalizedId = uuid(billingCaseId, "Billing-case ID");
  const result = await query(
    `SELECT billing_case.billing_case_id, billing_case.case_type,
            billing_case.contract_id, billing_case.service_visit_id,
            billing_case.cross_charge_case_id, billing_case.customer_netsuite_id,
            billing_case.status, billing_case.posting_mode,
            billing_case.current_version_number, billing_case.revision,
            billing_case.currency,
            visit_distance.distance_snapshot_id AS visit_distance_snapshot_id
       FROM mbt_billing_cases billing_case
       LEFT JOIN mbt_contracts contract
         ON contract.contract_id = billing_case.contract_id
       LEFT JOIN LATERAL (
         SELECT distance_snapshot.distance_snapshot_id
           FROM mbt_distance_snapshots distance_snapshot
          WHERE distance_snapshot.subject_type = 'visit'
            AND distance_snapshot.subject_id = billing_case.service_visit_id
            AND distance_snapshot.rate_card_version_id = contract.rate_card_version_id
          ORDER BY distance_snapshot.calculated_at DESC,
                   distance_snapshot.distance_snapshot_id DESC
          LIMIT 1
       ) visit_distance ON true
      WHERE billing_case.billing_case_id = $1`,
    [normalizedId]
  );
  if (!result.rowCount) {
    throw failure(404, "MBT_BILLING_CASE_NOT_FOUND", "The local billing case was not found.");
  }
  const versions = await query(
    `SELECT billing_version_id, version_number, status, posting_mode,
            subtotal_minor, estimated_tax_minor, total_minor,
            calculated_at, approved_at
       FROM mbt_billing_versions
      WHERE billing_case_id = $1
      ORDER BY version_number DESC, billing_version_id`,
    [normalizedId]
  );
  return {
    schemaVersion: "mbt-local-billing-case-v1",
    billingCaseId: normalizedId,
    caseType: String(result.rows[0].case_type),
    contractId: result.rows[0].contract_id === null ? null : String(result.rows[0].contract_id),
    serviceVisitId: result.rows[0].service_visit_id === null
      ? null
      : String(result.rows[0].service_visit_id),
    visitDistanceSnapshotId: result.rows[0].visit_distance_snapshot_id === null
      || result.rows[0].visit_distance_snapshot_id === undefined
      ? null
      : String(result.rows[0].visit_distance_snapshot_id),
    crossChargeCaseId: result.rows[0].cross_charge_case_id === null
      ? null
      : String(result.rows[0].cross_charge_case_id),
    customerNetsuiteId: String(result.rows[0].customer_netsuite_id),
    status: String(result.rows[0].status),
    postingMode: String(result.rows[0].posting_mode),
    currentVersionNumber: Number(result.rows[0].current_version_number),
    revision: Number(result.rows[0].revision),
    currency: String(result.rows[0].currency),
    versions: await Promise.all(versions.rows.map(async (/** @type {Record<string, any>} */ version) => ({
      billingVersionId: String(version.billing_version_id),
      versionNumber: Number(version.version_number),
      status: String(version.status),
      postingMode: String(version.posting_mode),
      subtotalMinor: Number(version.subtotal_minor),
      estimatedTaxMinor: Number(version.estimated_tax_minor),
      totalMinor: Number(version.total_minor),
      calculatedAt: databaseIso(version.calculated_at),
      approvedAt: databaseIso(version.approved_at),
      lines: await selectedBillingLines(String(version.billing_version_id))
    })))
  };
}
