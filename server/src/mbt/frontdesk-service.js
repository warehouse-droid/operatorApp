// @ts-check

import crypto from "node:crypto";

import { query } from "../db.js";
import { createDispatchCustomOrder } from "../dispatch-custom-order-repository.js";
import { executeMbtCommand } from "./command-repository.js";
import {
  persistPreparedFrontdeskInitialCharge,
  prepareFrontdeskInitialCharge
} from "./customer-charge-request-service.js";
import { MbtError } from "./errors.js";
import { calculateDistanceBandChargeMinor } from "./distance-band-pricing.js";

const FRONTDESK_ROLES = new Set(["admin", "mbt_admin", "mbt_frontdesk"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n;
const PRICING_ORIGIN_YARD_CODES = new Set(["3445", "150"]);

/** @param {number} status @param {string} code @param {string} message @param {Record<string, unknown>} [details] */
function failure(status, code, message, details = {}) {
  return new MbtError({ status, code, message, details });
}

/** @param {unknown} value @param {string} label */
function requiredText(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw failure(400, "MBT_FRONTDESK_INPUT_INVALID", `${label} is required.`);
  }
  return normalized;
}

/** @param {unknown} value @param {string} label */
function requiredUuid(value, label) {
  const normalized = requiredText(value, label);
  if (!UUID_PATTERN.test(normalized)) {
    throw failure(400, "MBT_FRONTDESK_INPUT_INVALID", `${label} must be a UUID.`);
  }
  return normalized;
}

/** @param {unknown} value @param {string} label */
function positiveRevision(value, label = "Expected revision") {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw failure(400, "MBT_FRONTDESK_INPUT_INVALID", `${label} must be a positive integer.`);
  }
  return Number(value);
}

/** @param {unknown} value @param {string} label */
function timestamp(value, label) {
  const normalized = requiredText(value, label);
  const parsed = new Date(normalized);
  if (!Number.isFinite(parsed.getTime())) {
    throw failure(400, "MBT_FRONTDESK_INPUT_INVALID", `${label} must be an ISO timestamp.`);
  }
  return parsed;
}

/** @param {unknown} value @param {string} label */
function safeNonnegativeInteger(value, label) {
  const normalized = typeof value === "string" && value.trim() ? Number(value) : value;
  if (!Number.isSafeInteger(normalized) || Number(normalized) < 0) {
    throw failure(422, "MBT_FRONTDESK_CONFIGURATION_INVALID", `${label} must be a nonnegative integer.`);
  }
  return Number(normalized);
}

/** @param {unknown} value @param {string} label */
function localItemCode(value, label) {
  const code = requiredText(value, label).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_]{0,63}$/u.test(code)) {
    throw failure(400, "MBT_FRONTDESK_INPUT_INVALID", `${label} is invalid.`);
  }
  return code;
}

/**
 * The printed tariff has two origin price tables. `3445` is the canonical
 * persisted value for the shared 3445 / 2967 table; `150` selects the 150
 * table. Older clients omitted this field and safely retain the standard
 * table rather than changing historical behaviour.
 *
 * @param {unknown} value
 */
export function normalizePricingOriginYardCode(value) {
  const code = String(value ?? "3445").trim();
  if (!PRICING_ORIGIN_YARD_CODES.has(code)) {
    throw failure(
      400,
      "MBT_FRONTDESK_INPUT_INVALID",
      "Pricing origin must use the standard 3445 / 2967 table or the 150-yard table."
    );
  }
  return code;
}

/**
 * Store estimated weight as integer kilograms. This is quote evidence only;
 * the scale ticket remains the source of actual billable weight.
 * @param {unknown} value
 * @param {string} [label]
 */
export function normalizeEstimatedDumpWeightKg(value, label = "Estimated tonnes") {
  const text = String(value ?? "").trim();
  const match = /^(\d{1,3})(?:\.(\d{1,3}))?$/u.exec(text);
  if (!match) {
    throw failure(400, "MBT_FRONTDESK_INPUT_INVALID", `${label} must be between 0.001 and 100 tonnes with at most three decimals.`);
  }
  const kilograms = (Number(match[1]) * 1000) + Number((match[2] || "").padEnd(3, "0"));
  if (!Number.isSafeInteger(kilograms) || kilograms < 1 || kilograms > 100_000) {
    throw failure(400, "MBT_FRONTDESK_INPUT_INVALID", `${label} must be between 0.001 and 100 tonnes with at most three decimals.`);
  }
  return kilograms;
}

/**
 * @param {{amountMinorPerTonne: unknown, minimumAmountMinor: unknown, estimatedWeightKg: unknown}} input
 */
export function calculateEstimatedDumpChargeMinor(input) {
  const amountMinorPerTonne = safeNonnegativeInteger(input.amountMinorPerTonne, "Dump rate per tonne");
  const minimumAmountMinor = safeNonnegativeInteger(input.minimumAmountMinor, "Dump minimum amount");
  const estimatedWeightKg = Number(input.estimatedWeightKg);
  if (!Number.isSafeInteger(estimatedWeightKg) || estimatedWeightKg < 1 || estimatedWeightKg > 100_000) {
    throw failure(422, "MBT_FRONTDESK_CONFIGURATION_INVALID", "Estimated dump weight must be valid integer kilograms.");
  }
  const numerator = amountMinorPerTonne * estimatedWeightKg;
  if (!Number.isSafeInteger(numerator)) {
    throw failure(422, "MBT_FRONTDESK_CONFIGURATION_INVALID", "The estimated dump charge exceeds safe integer limits.");
  }
  return Math.max(minimumAmountMinor, Math.round(numerator / 1000));
}

/** @param {unknown} value */
export function normalizeFrontdeskSurcharges(value) {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value) || value.length > 20) {
    throw failure(400, "MBT_FRONTDESK_INPUT_INVALID", "Order surcharges must be a list of at most 20 entries.");
  }
  const entries = value.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw failure(400, "MBT_FRONTDESK_INPUT_INVALID", `Surcharge ${index + 1} is invalid.`);
    }
    const row = /** @type {Record<string, unknown>} */ (raw);
    if (Object.keys(row).some((key) => !["itemCode", "amountMinor"].includes(key))) {
      throw failure(400, "MBT_FRONTDESK_INPUT_INVALID", `Surcharge ${index + 1} is invalid.`);
    }
    const itemCode = localItemCode(row.itemCode, `Surcharge ${index + 1} item`);
    const amountMinor = Number(row.amountMinor);
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
      throw failure(400, "MBT_FRONTDESK_INPUT_INVALID", `Surcharge amount ${index + 1} must be positive whole cents.`);
    }
    return { itemCode, amountMinor };
  });
  if (new Set(entries.map(({ itemCode }) => itemCode)).size !== entries.length) {
    throw failure(400, "MBT_FRONTDESK_INPUT_INVALID", "Each surcharge item may be entered once.");
  }
  return entries;
}

/** @param {unknown} value @param {string} label */
function jsonObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw failure(422, "MBT_FRONTDESK_CONFIGURATION_INVALID", `${label} must be an object.`);
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {{operatorId?: unknown, roles?: readonly unknown[]}} actor */
function assertFrontdeskActor(actor) {
  requiredText(actor?.operatorId, "Actor operator ID");
  const roles = Array.isArray(actor?.roles) ? actor.roles.map(String) : [];
  if (!roles.some((role) => FRONTDESK_ROLES.has(role))) {
    throw failure(403, "MBT_FRONTDESK_FORBIDDEN", "Front Desk access is required.");
  }
}

/** @param {Date} value */
function iso(value) {
  return value.toISOString();
}

/** @param {unknown} value */
function optionalText(value) {
  return value === null || value === undefined ? "" : String(value);
}

/** @param {unknown} value */
function databaseIso(value) {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

/** @param {string} prefix @param {string} id */
function publicNumber(prefix, id) {
  return `${prefix}-${id.replaceAll("-", "").slice(0, 12).toUpperCase()}`;
}

/** @param {number} amountMinor @param {number} basisPoints */
function percentageAmount(amountMinor, basisPoints) {
  const numerator = amountMinor * basisPoints;
  if (!Number.isSafeInteger(numerator)) {
    throw failure(422, "MBT_FRONTDESK_CONFIGURATION_INVALID", "The configured monetary calculation exceeds safe integer limits.");
  }
  return Math.round(numerator / 10_000);
}

/** @param {any} row */
function customerSnapshot(row) {
  return {
    netsuiteId: String(row.customer_netsuite_id),
    entityNumber: String(row.entity_number),
    legalName: String(row.legal_name),
    displayName: String(row.display_name),
    currency: String(row.customer_currency),
    terms: row.customer_terms === null ? null : String(row.customer_terms),
    taxStatus: row.customer_tax_status === null ? null : String(row.customer_tax_status),
    creditStatus: row.customer_credit_status === null ? null : String(row.customer_credit_status),
    sourceVersion: String(row.customer_source_version)
  };
}

/** @param {any} row */
function siteSnapshot(row) {
  return {
    siteProfileId: String(row.site_profile_id),
    siteRevision: Number(row.site_revision),
    addressId: String(row.address_id),
    addressSourceVersion: String(row.address_source_version),
    label: optionalText(row.address_label),
    addressee: optionalText(row.addressee),
    addressLine1: optionalText(row.address_line_1),
    addressLine2: optionalText(row.address_line_2),
    addressLine3: optionalText(row.address_line_3),
    city: optionalText(row.city),
    region: optionalText(row.region),
    postalCode: optionalText(row.postal_code),
    countryCode: optionalText(row.country_code),
    siteInstructions: optionalText(row.site_instructions),
    accessRestrictions: optionalText(row.access_restrictions),
    contactOnArrivalNotes: optionalText(row.contact_on_arrival_notes),
    serviceWarnings: Array.isArray(row.service_warnings) ? row.service_warnings.map(String) : []
  };
}

/** @param {any} row */
function publicSite(row) {
  return {
    siteProfileId: String(row.site_profile_id),
    addressId: String(row.address_id),
    label: String(row.address_label || ""),
    addressLine1: String(row.address_line_1 || ""),
    addressLine2: String(row.address_line_2 || ""),
    city: String(row.city || ""),
    region: String(row.region || ""),
    postalCode: String(row.postal_code || ""),
    active: Boolean(row.site_active && row.address_active),
    revision: Number(row.site_revision)
  };
}

/** @param {any} row */
function publicQuote(row) {
  const pricing = row.pricing_snapshot || {};
  return {
    quoteId: String(row.quote_id),
    quoteNumber: String(row.quote_number),
    customerNetsuiteId: String(row.customer_netsuite_id),
    siteProfileId: String(row.customer_site_profile_id),
    serviceTemplateVersionId: String(row.service_template_version_id),
    rateCardVersionId: String(row.rate_card_version_id),
    binTypeId: String(row.bin_type_id),
    binTypeCode: String(row.bin_type_code || ""),
    proposedDeliveryAt: row.proposed_delivery_at ? databaseIso(row.proposed_delivery_at) : null,
    proposedReturnAt: row.proposed_return_at ? databaseIso(row.proposed_return_at) : null,
    validUntil: row.valid_until ? databaseIso(row.valid_until) : null,
    acceptedAt: row.accepted_at ? databaseIso(row.accepted_at) : null,
    status: String(row.status),
    revision: Number(row.revision),
    pricing,
    serviceLines: Array.isArray(pricing.serviceLines)
      // Command-response redaction uses object-identity cycle protection. The
      // public convenience list must therefore be a deep copy rather than a
      // shallow alias of `pricing.serviceLines`, or valid rate/tax evidence is
      // incorrectly returned as "[REDACTED]" on the first response.
      ? pricing.serviceLines.map((/** @type {Record<string, unknown>} */ line) => structuredClone(line))
      : [],
    depositRequiredMinor: Number(row.deposit_required_minor)
  };
}

/** @param {any} row */
function publicContract(row) {
  return {
    contractId: String(row.contract_id),
    contractNumber: String(row.contract_number),
    quoteId: row.quote_id ? String(row.quote_id) : null,
    status: String(row.status),
    revision: Number(row.revision),
    plannedDeliveryAt: row.planned_delivery_at ? databaseIso(row.planned_delivery_at) : null,
    plannedReturnAt: row.planned_return_at ? databaseIso(row.planned_return_at) : null,
    rentalCalendarDays: Number(row.rental_calendar_days),
    customer: row.customer_snapshot,
    site: row.site_snapshot,
    terms: row.terms_snapshot,
    tax: row.tax_snapshot,
    pricing: row.pricing_snapshot,
    depositRequiredMinor: Number(row.deposit_required_minor),
    currency: String(row.currency)
  };
}

/** @param {any} row */
function publicVisit(row) {
  return {
    visitId: String(row.service_visit_id),
    serviceLineId: row.service_line_id ? String(row.service_line_id) : null,
    visitNumber: Number(row.visit_number),
    visitReference: String(row.visit_reference),
    serviceAction: String(row.service_action),
    displayName: String(row.service_snapshot?.displayName || row.service_action),
    status: String(row.status),
    predecessorVisitId: row.predecessor_visit_id ? String(row.predecessor_visit_id) : null,
    scheduledStartAt: row.scheduled_start_at ? databaseIso(row.scheduled_start_at) : null,
    scheduledEndAt: row.scheduled_end_at ? databaseIso(row.scheduled_end_at) : null,
    actualStartedAt: row.actual_started_at ? databaseIso(row.actual_started_at) : null,
    actualCompletedAt: row.actual_completed_at ? databaseIso(row.actual_completed_at) : null,
    revision: Number(row.revision)
  };
}

/** @param {unknown} value */
function nullableDatabaseIso(value) {
  return value ? databaseIso(value) : null;
}

/** @param {unknown} value */
function nullableText(value) {
  return value ? String(value) : null;
}

/** @param {any} row */
// eslint-disable-next-line complexity -- One DTO preserves legacy and item-owned service-line snapshots during rollout.
function publicServiceLine(row) {
  const pricing = row.pricing_snapshot || {};
  return {
    serviceLineId: String(row.service_line_id),
    contractId: String(row.contract_id),
    lineNumber: Number(row.line_number),
    binTypeId: String(row.bin_type_id),
    binTypeCode: String(row.bin_type_code || ""),
    binItemCode: nullableText(row.bin_item_code || pricing.binItemCode),
    dumpItemCode: nullableText(row.dump_item_code || pricing.dumpItemCode),
    materialId: nullableText(row.material_id || pricing.materialId),
    estimatedWeightKg: row.estimated_weight_kg === null || row.estimated_weight_kg === undefined
      ? (pricing.estimatedWeightKg ?? null)
      : Number(row.estimated_weight_kg),
    estimatedTonnes: row.estimated_weight_kg === null || row.estimated_weight_kg === undefined
      ? nullableText(pricing.estimatedTonnes)
      : (Number(row.estimated_weight_kg) / 1000).toFixed(3),
    siteProfileId: row.customer_site_profile_id ? String(row.customer_site_profile_id) : null,
    site: row.site_snapshot || {},
    status: String(row.status),
    plannedDeliveryAt: nullableDatabaseIso(row.planned_delivery_at),
    plannedReturnAt: nullableDatabaseIso(row.planned_return_at),
    actualDeliveryCompletedAt: nullableDatabaseIso(row.actual_delivery_completed_at),
    actualCollectedAt: nullableDatabaseIso(row.actual_collected_at),
    pricing,
    customerConfirmation: {
      status: String(row.customer_confirmation_status || "not_required"),
      reason: nullableText(row.customer_confirmation_reason),
      requestedAt: nullableDatabaseIso(row.customer_confirmation_requested_at),
      confirmedAt: nullableDatabaseIso(row.customer_confirmation_confirmed_at),
      confirmedBy: nullableText(row.customer_confirmation_confirmed_by)
    },
    waiver: row.waiver_snapshot || {},
    revision: Number(row.revision)
  };
}

/** @param {any} row */
function publicAmendment(row) {
  return {
    amendmentId: String(row.amendment_id),
    amendmentNumber: Number(row.amendment_number),
    amendmentType: String(row.amendment_type),
    status: String(row.status),
    reason: String(row.reason),
    before: row.before_snapshot,
    after: row.after_snapshot,
    approvedAt: row.approved_at ? databaseIso(row.approved_at) : null,
    approvedBy: row.approved_by ? String(row.approved_by) : null,
    revision: Number(row.revision)
  };
}

/**
 * Search active canonical customers. A service site is optional here because
 * it belongs to an individual BIN order and may be entered while that order is
 * created. Existing saved sites are returned only as reusable choices.
 *
 * @param {{actor: {operatorId?: unknown, roles?: readonly unknown[]}, query?: unknown, limit?: unknown, pilotCustomerIds?: unknown}} input
 */
export async function searchFrontdeskCustomers(input) {
  assertFrontdeskActor(input.actor);
  const search = requiredText(input.query, "Customer search");
  const limit = Number.isSafeInteger(input.limit)
    ? Math.min(100, Math.max(1, Number(input.limit)))
    : 25;
  const rawPilotScope = input.pilotCustomerIds;
  const explicitPilotScope = Array.isArray(rawPilotScope);
  const pilotCustomerIds = Array.isArray(rawPilotScope)
    ? [...new Set(rawPilotScope
      .map((/** @type {unknown} */ value) => String(value).trim())
      .filter((/** @type {string} */ value) => /^\d+$/.test(value)))]
    : [];
  if (explicitPilotScope && pilotCustomerIds.length === 0) {
    return { schemaVersion: "mbt-frontdesk-customers-v1", items: [] };
  }
  const result = await query(
    `SELECT c.netsuite_id::text AS customer_netsuite_id,
            c.entity_number, c.display_name, c.currency, COALESCE(c.phone, '') AS customer_phone,
            s.site_profile_id::text, s.address_id::text,
            s.active AS site_active, s.revision::int AS site_revision,
            a.active AS address_active, a.label AS address_label,
            a.address_line_1, a.address_line_2, a.city, a.region, a.postal_code
       FROM netsuite_customers c
       LEFT JOIN mbt_customer_site_profiles s
         ON s.customer_netsuite_id = c.netsuite_id
        AND s.active
       LEFT JOIN netsuite_customer_addresses a
         ON a.customer_netsuite_id = c.netsuite_id
        AND a.address_id = s.address_id
        AND a.active
      WHERE c.active
        AND ($4::boolean OR c.netsuite_id = ANY($1::bigint[]))
        AND (
          c.entity_number ILIKE '%' || $2 || '%'
          OR c.legal_name ILIKE '%' || $2 || '%'
          OR c.display_name ILIKE '%' || $2 || '%'
          OR (
            regexp_replace($2, '\\D', '', 'g') <> ''
            AND regexp_replace(COALESCE(c.phone, ''), '\\D', '', 'g')
              LIKE '%' || regexp_replace($2, '\\D', '', 'g') || '%'
          )
        )
      ORDER BY lower(c.display_name), c.netsuite_id, a.shipping_default DESC NULLS LAST,
               lower(a.label) NULLS LAST, a.address_id NULLS LAST
      LIMIT $3`,
    [pilotCustomerIds, search, limit * 20, !explicitPilotScope]
  );
  /** @type {Map<string, any>} */
  const customers = new Map();
  for (const row of result.rows) {
    let customer = customers.get(String(row.customer_netsuite_id));
    if (!customer) {
      if (customers.size >= limit) {
        break;
      }
      customer = {
        customerNetsuiteId: String(row.customer_netsuite_id),
        entityNumber: String(row.entity_number),
        displayName: String(row.display_name),
        phone: String(row.customer_phone || ""),
        currency: String(row.currency),
        serviceReady: true,
        binOrderSiteRequired: true,
        sites: []
      };
      customers.set(customer.customerNetsuiteId, customer);
    }
    if (row.site_profile_id && row.address_id) {
      customer.sites.push(publicSite(row));
    }
  }
  return {
    schemaVersion: "mbt-frontdesk-customers-v1",
    items: [...customers.values()]
  };
}

/**
 * Return only active local BIN, delivery, dump, surcharge, and workflow choices. This endpoint exposes no
 * customer, financial-ledger, NetSuite payload, or posting configuration.
 *
 * @param {{actor: {operatorId?: unknown, roles?: readonly unknown[]}}} input
 */
export async function getFrontdeskConfiguration(input) {
  assertFrontdeskActor(input.actor);
  const [binResult, deliveryResult, dumpResult, surchargeResult, serviceResult] = await Promise.all([
    query(
      `SELECT item.item_code, item.display_name, item.description,
              bin.bin_type_id::text, bin.type_code, bin.nominal_yards::int
         FROM mbt_local_item_settings item
         JOIN mbt_bin_types bin ON bin.bin_type_id = item.bin_type_id
        WHERE item.item_type = 'bin'
          AND item.active
          AND bin.active
        ORDER BY lower(item.display_name), item.item_code`
    ),
    query(
      `SELECT item_code, display_name, description
         FROM mbt_local_item_settings
        WHERE item_type = 'delivery_fee'
          AND active
        ORDER BY lower(display_name), item_code`
    ),
    query(
      `SELECT item_code, display_name, description
         FROM mbt_local_item_settings
        WHERE item_type = 'dump'
          AND active
        ORDER BY lower(display_name), item_code`
    ),
    query(
      `SELECT item_code, display_name, description
         FROM mbt_local_item_settings
        WHERE item_type = 'surcharge'
          AND active
        ORDER BY lower(display_name), item_code`
    ),
    query(
      `SELECT DISTINCT ON (d.service_code, tv.template_version_id, rv.rate_card_version_id)
              d.service_code,
              t.display_name,
              tv.template_version_id::text,
              tv.default_rental_calendar_days::int,
              rv.rate_card_version_id::text
         FROM mbt_rate_distance_bands d
         JOIN mbt_rate_card_versions rv
           ON rv.rate_card_version_id = d.rate_card_version_id
          AND rv.status = 'active'
         JOIN mbt_rate_cards r
           ON r.rate_card_id = rv.rate_card_id
          AND r.active
         JOIN mbt_service_templates t
           ON t.template_id = r.service_template_id
          AND t.active
         JOIN mbt_service_template_versions tv
           ON tv.template_id = t.template_id
          AND tv.status = 'active'
        ORDER BY d.service_code, tv.template_version_id,
                 rv.rate_card_version_id, d.sequence_number`
    )
  ]);
  return {
    schemaVersion: "mbt-frontdesk-configuration-v1",
    binItems: binResult.rows.map((/** @type {any} */ row) => ({
      itemCode: String(row.item_code),
      binTypeId: String(row.bin_type_id),
      typeCode: String(row.type_code),
      displayName: String(row.display_name),
      description: String(row.description || ""),
      nominalYards: Number(row.nominal_yards)
    })),
    // Compatibility alias for an already-open Front Desk tab.
    binTypes: binResult.rows.map((/** @type {any} */ row) => ({
      itemCode: String(row.item_code),
      binTypeId: String(row.bin_type_id),
      typeCode: String(row.type_code),
      displayName: String(row.display_name),
      nominalYards: Number(row.nominal_yards)
    })),
    deliveryItems: deliveryResult.rows.map((/** @type {any} */ row) => ({
      itemCode: String(row.item_code),
      displayName: String(row.display_name),
      description: String(row.description || "")
    })),
    dumpItems: dumpResult.rows.map((/** @type {any} */ row) => ({
      itemCode: String(row.item_code),
      displayName: String(row.display_name),
      description: String(row.description || "")
    })),
    surchargeItems: surchargeResult.rows.map((/** @type {any} */ row) => ({
      itemCode: String(row.item_code),
      displayName: String(row.display_name),
      description: String(row.description || "")
    })),
    services: serviceResult.rows.map((/** @type {any} */ row) => ({
      serviceCode: String(row.service_code),
      displayName: String(row.display_name),
      templateVersionId: String(row.template_version_id),
      rateCardVersionId: String(row.rate_card_version_id),
      defaultRentalCalendarDays: Number(row.default_rental_calendar_days)
    }))
  };
}

/**
 * Create a local, non-contract A-to-B delivery directly in the established
 * Dispatch custom-order pool. Dispatch assigns its truck/day and Driver PWA
 * receives it through the same planner as other custom delivery work.
 *
 * @param {Record<string, unknown>} input
 */
export async function createFrontdeskDeliveryOrder(input) {
  const actor = /** @type {any} */ (input.actor);
  assertFrontdeskActor(actor);
  const customerNetsuiteId = requiredText(input.customerNetsuiteId, "Customer NetSuite ID");
  if (!/^\d+$/u.test(customerNetsuiteId)) {
    throw failure(400, "MBT_FRONTDESK_INPUT_INVALID", "Customer NetSuite ID is invalid.");
  }
  const itemCode = requiredText(input.itemCode, "Delivery-fee item").toUpperCase();
  const pickupLocation = requiredText(input.pickupLocation, "Pickup location");
  const dropoffLocation = requiredText(input.dropoffLocation, "Drop-off location");
  const orderDetails = requiredText(input.orderDetails, "Delivery details");
  const weightLbs = Number(input.weightLbs);
  const stopMinutes = Number(input.stopMinutes ?? 30);
  if (!Number.isSafeInteger(weightLbs) || weightLbs < 1 || weightLbs > 1_000_000
      || !Number.isSafeInteger(stopMinutes) || stopMinutes < 0 || stopMinutes > 1_440) {
    throw failure(400, "MBT_FRONTDESK_INPUT_INVALID", "Delivery weight or stop time is invalid.");
  }
  const payload = {
    customerNetsuiteId,
    itemCode,
    pickupLocation,
    dropoffLocation,
    orderDetails,
    weightLbs,
    stopMinutes
  };
  return executeMbtCommand({
    actor,
    commandName: "mbt.frontdesk.delivery.create",
    idempotencyKey: requiredText(input.idempotencyKey, "Idempotency key"),
    payload,
    correlationId: requiredText(input.correlationId, "Correlation ID"),
    requestId: requiredText(input.requestId, "Request ID"),
    mutation: async () => {
      const selected = await query(
        `SELECT customer.netsuite_id::text, customer.display_name,
                item.item_code, item.display_name AS item_display_name
           FROM netsuite_customers customer
           JOIN mbt_local_item_settings item
             ON item.item_code = $2
            AND item.item_type = 'delivery_fee'
            AND item.active
          WHERE customer.netsuite_id = $1::bigint
            AND customer.active
          FOR KEY SHARE OF customer, item`,
        [customerNetsuiteId, itemCode]
      );
      if (!selected.rowCount) {
        throw failure(
          409,
          "MBT_FRONTDESK_CONFIGURATION_INCOMPLETE",
          "The selected customer or Delivery fee item is no longer active."
        );
      }
      const configuration = selected.rows[0];
      const refNumber = `MBT-DLV-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;
      const customOrder = await createDispatchCustomOrder({
        refNumber,
        pickupLocation,
        dropoffLocation,
        orderDetails: `${configuration.item_display_name} · ${configuration.display_name}\n${orderDetails}`,
        weightLbs,
        stopMinutes
      }, String(actor.operatorId));
      if (!customOrder) {
        throw failure(500, "MBT_FRONTDESK_DELIVERY_CREATE_FAILED", "The local Delivery order was not retained.");
      }
      await query(
        `UPDATE dispatch_custom_orders
            SET mbt_local_item_code = $2,
                mbt_customer_netsuite_id = $3::bigint,
                mbt_source = 'frontdesk_delivery',
                updated_by = $4,
                updated_at = now()
          WHERE id = $1`,
        [customOrder.id, itemCode, customerNetsuiteId, String(actor.operatorId)]
      );
      const deliveryOrder = {
        ...customOrder,
        itemCode,
        customerNetsuiteId,
        customerDisplayName: String(configuration.display_name),
        source: "frontdesk_delivery"
      };
      return {
        status: 201,
        body: { schemaVersion: "mbt-frontdesk-delivery-v1", deliveryOrder },
        audit: {
          action: "mbt.frontdesk.delivery.created",
          entityType: "dispatch_custom_order",
          entityId: String(customOrder.id),
          beforeState: { exists: false },
          afterState: deliveryOrder,
          reason: "Created local A-to-B Delivery order from Front Desk",
          revisionBefore: 1,
          revisionAfter: 1,
          source: "frontdesk_local"
        }
      };
    }
  });
}

/**
 * Return the master contract list for one selected customer. Detail remains
 * behind the existing contract-timeline endpoint, so Front Desk never loads a
 * cross-customer operational history into an autocomplete result.
 *
 * @param {{actor: {operatorId?: unknown, roles?: readonly unknown[]}, customerNetsuiteId: unknown, limit?: unknown}} input
 */
export async function getFrontdeskCustomerContracts(input) {
  assertFrontdeskActor(input.actor);
  const customerNetsuiteId = requiredText(input.customerNetsuiteId, "Customer NetSuite ID");
  if (!/^\d+$/.test(customerNetsuiteId)) {
    throw failure(400, "MBT_FRONTDESK_INPUT_INVALID", "Customer NetSuite ID is invalid.");
  }
  const limit = Number.isSafeInteger(input.limit)
    ? Math.min(100, Math.max(1, Number(input.limit)))
    : 50;
  const contracts = await query(
    `SELECT c.*,
            count(line.service_line_id)::int AS service_line_count,
            count(*) FILTER (WHERE line.status NOT IN ('closed', 'cancelled'))::int AS open_service_line_count
       FROM mbt_contracts c
       LEFT JOIN mbt_contract_service_lines line ON line.contract_id = c.contract_id
      WHERE c.customer_netsuite_id = $1::bigint
      GROUP BY c.contract_id
      ORDER BY (c.status NOT IN ('closed', 'cancelled')) DESC,
               c.planned_delivery_at DESC NULLS LAST, c.created_at DESC, c.contract_id
      LIMIT $2`,
    [customerNetsuiteId, limit]
  );
  return {
    schemaVersion: "mbt-frontdesk-customer-contracts-v1",
    customerNetsuiteId,
    items: contracts.rows.map((/** @type {any} */ row) => ({
      ...publicContract(row),
      serviceLineCount: Number(row.service_line_count),
      openServiceLineCount: Number(row.open_service_line_count)
    }))
  };
}

/** @param {string} quoteId */
async function selectedQuote(quoteId) {
  const selected = await query(
    `SELECT q.*, b.type_code AS bin_type_code
       FROM mbt_quotes q
       JOIN mbt_bin_types b ON b.bin_type_id = q.bin_type_id
      WHERE q.quote_id = $1::uuid
      FOR UPDATE OF q`,
    [quoteId]
  );
  if (!selected.rowCount) {
    throw failure(404, "MBT_FRONTDESK_QUOTE_NOT_FOUND", "The Front Desk quote was not found.");
  }
  return selected.rows[0];
}

/** @param {unknown} value @param {string} label */
function applicableDate(value, label) {
  const parsed = timestamp(value, label);
  return parsed;
}

/** @param {Record<string, unknown>} input */
function requestedServiceLineGroups(input) {
  return Array.isArray(input.serviceLines) && input.serviceLines.length
    ? input.serviceLines
    : [{
      binItemCode: input.binItemCode,
      binTypeId: input.binTypeId,
      contentCode: input.contentCode,
      discountMinor: input.discountMinor,
      discountReason: input.discountReason,
      dumpItemCode: input.dumpItemCode,
      estimatedTonnes: input.estimatedTonnes,
      proposedDeliveryAt: input.proposedDeliveryAt,
      proposedReturnAt: input.proposedReturnAt
    }];
}

/** @param {unknown} value @param {string} label @param {number} maximum @param {boolean} [required] */
function siteText(value, label, maximum, required = false) {
  const normalized = String(value ?? "").trim();
  if (required && !normalized) {
    throw failure(400, "MBT_FRONTDESK_INPUT_INVALID", `${label} is required.`);
  }
  if (normalized.length > maximum) {
    throw failure(400, "MBT_FRONTDESK_INPUT_INVALID", `${label} is too long.`);
  }
  return normalized;
}

/** @param {unknown} value @param {string} label */
function normalizedInlineSite(value, label) {
  const site = jsonObject(value, label);
  const countryCode = siteText(site.countryCode || "CA", `${label} country`, 2, true).toUpperCase();
  if (!/^[A-Z]{2}$/u.test(countryCode)) {
    throw failure(400, "MBT_FRONTDESK_INPUT_INVALID", `${label} country must be a two-letter code.`);
  }
  const normalized = /** @type {Record<string, string>} */ ({
    label: siteText(site.label, `${label} label`, 200, true),
    addressLine1: siteText(site.addressLine1, `${label} address`, 500, true),
    city: siteText(site.city, `${label} city`, 200, true),
    region: siteText(site.region, `${label} province or region`, 100, true),
    postalCode: siteText(site.postalCode, `${label} postal code`, 30, true),
    countryCode
  });
  for (const [field, maximum] of /** @type {const} */ ([
    ["addressLine2", 500],
    ["addressLine3", 500],
    ["phone", 100],
    ["siteInstructions", 2000],
    ["accessRestrictions", 2000],
    ["contactOnArrivalNotes", 2000]
  ])) {
    const text = siteText(site[field], `${label} ${field}`, maximum);
    if (text) {
      normalized[field] = text;
    }
  }
  return normalized;
}

/** @param {unknown} value */
function suppliedSiteValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

/** @param {boolean} hasInlineSite @param {boolean} hasSiteId */
function conflictingSiteSelection(hasInlineSite, hasSiteId) {
  return hasInlineSite && hasSiteId;
}

/** @param {Record<string, unknown>} group @param {Record<string, unknown>} input @param {string} label */
function requestedServiceLineSite(group, input, label) {
  const groupHasInlineSite = group.site !== undefined && group.site !== null;
  const groupHasSiteId = suppliedSiteValue(group.siteProfileId);
  if (conflictingSiteSelection(groupHasInlineSite, groupHasSiteId)) {
    throw failure(400, "MBT_FRONTDESK_INPUT_INVALID", `${label} must select an existing site or enter a new site, not both.`);
  }
  let inlineSite = null;
  if (groupHasInlineSite) {
    inlineSite = normalizedInlineSite(group.site, `${label} service site`);
  } else if (!groupHasSiteId && input.site !== undefined && input.site !== null) {
    inlineSite = normalizedInlineSite(input.site, `${label} service site`);
  }
  const siteProfileValue = groupHasSiteId
    ? group.siteProfileId
    : inlineSite
      ? null
      : input.siteProfileId;
  const siteProfileId = suppliedSiteValue(siteProfileValue)
    ? requiredUuid(siteProfileValue, `${label} customer site profile ID`)
    : null;
  if (!siteProfileId && !inlineSite) {
    throw failure(400, "MBT_FRONTDESK_INPUT_INVALID", `${label} service site is required.`);
  }
  return { siteProfileId, site: inlineSite };
}

/**
 * @template T
 * @param {T[]} values
 * @param {number} index
 * @param {string} label
 * @returns {T}
 */
function requiredArrayEntry(values, index, label) {
  const value = values[index];
  if (!value) {
    throw failure(422, "MBT_FRONTDESK_CONFIGURATION_INVALID", `${label} is missing.`);
  }
  return value;
}

/** @param {Record<string, unknown>} group @param {Record<string, unknown>} input @param {string} label */
function normalizedFixedServiceLinePricing(group, input, label) {
  const contentCode = requiredText(group.contentCode ?? input.contentCode, `${label} content`).toLowerCase();
  if (!["garbage", "soil", "asphalt", "concrete"].includes(contentCode)) {
    throw failure(400, "MBT_FRONTDESK_INPUT_INVALID", `${label} content is not supported.`);
  }
  return {
    contentCode,
    dumpItemCode: null,
    estimatedWeightKg: null,
    discountMinor: safeNonnegativeInteger(Number(group.discountMinor ?? input.discountMinor ?? 0), `${label} discount`),
    discountReason: String(group.discountReason ?? input.discountReason ?? "").trim()
  };
}

/** @param {Record<string, unknown>} group @param {Record<string, unknown>} input @param {string} label */
function normalizedLegacyServiceLinePricing(group, input, label) {
  return {
    contentCode: null,
    dumpItemCode: localItemCode(group.dumpItemCode ?? input.dumpItemCode, `${label} dump item`),
    estimatedWeightKg: normalizeEstimatedDumpWeightKg(
      group.estimatedTonnes ?? input.estimatedTonnes,
      `${label} estimated tonnes`
    ),
    discountMinor: 0,
    discountReason: ""
  };
}

/** @param {Record<string, unknown>} group @param {Record<string, unknown>} input @param {string} label */
function normalizedServiceLinePricing(group, input, label) {
  if (input.paymentMethod !== undefined && input.paymentMethod !== null) {
    return normalizedFixedServiceLinePricing(group, input, label);
  }
  return normalizedLegacyServiceLinePricing(group, input, label);
}

/** @param {unknown} value @param {number} groupIndex @param {Record<string, unknown>} input */
function normalizedServiceLineGroup(value, groupIndex, input) {
  const label = `Service line ${groupIndex + 1}`;
  const group = jsonObject(value, label);
  if (group.quantity !== undefined && Number(group.quantity) !== 1) {
    throw failure(400, "MBT_FRONTDESK_INPUT_INVALID", `${label} must represent one physical bin. Add another bin row instead of quantity.`);
  }
  const binItemCode = localItemCode(group.binItemCode ?? input.binItemCode, `${label} bin item`);
  const binTypeId = requiredUuid(group.binTypeId ?? input.binTypeId, `${label} bin type ID`);
  const pricing = normalizedServiceLinePricing(group, input, label);
  const deliveryAt = applicableDate(group.proposedDeliveryAt ?? input.proposedDeliveryAt, `${label} proposed delivery time`);
  const returnAt = applicableDate(group.proposedReturnAt ?? input.proposedReturnAt, `${label} proposed return time`);
  if (returnAt <= deliveryAt) {
    throw failure(400, "MBT_FRONTDESK_INPUT_INVALID", `${label} return time must follow delivery time.`);
  }
  return {
    binItemCode, binTypeId, ...pricing,
    deliveryAt, returnAt, ...requestedServiceLineSite(group, input, label)
  };
}

/**
 * Each requested row is exactly one independently addressable physical bin.
 * All rows in the contract share one customer site, while bin item, dump item,
 * estimated weight, and schedule remain immutable per-line quote evidence.
 *
 * @param {Record<string, unknown>} input
 */
export function normalizeFrontdeskServiceLines(input) {
  const candidateGroups = requestedServiceLineGroups(input);
  if (input.paymentMethod !== undefined && candidateGroups.length !== 1) {
    throw failure(400, "MBT_FRONTDESK_INPUT_INVALID", "A fixed-price customer request must contain exactly one physical bin.");
  }
  if (candidateGroups.length > 25) {
    throw failure(400, "MBT_FRONTDESK_INPUT_INVALID", "A contract can contain at most 25 physical bins.");
  }
  /** @type {Array<{lineNumber: number, binItemCode: string, binTypeId: string, contentCode: string | null, discountMinor: number, discountReason: string, dumpItemCode: string | null, estimatedWeightKg: number | null, estimatedTonnes: string | null, siteProfileId: string | null, site: Record<string, string> | null, proposedDeliveryAt: string, proposedReturnAt: string}>} */
  const lines = [];
  for (const [groupIndex, value] of candidateGroups.entries()) {
    const group = normalizedServiceLineGroup(value, groupIndex, input);
    lines.push({
      lineNumber: lines.length + 1,
      binItemCode: group.binItemCode,
      binTypeId: group.binTypeId,
      dumpItemCode: group.dumpItemCode,
      estimatedWeightKg: group.estimatedWeightKg,
      contentCode: group.contentCode,
      discountMinor: group.discountMinor,
      discountReason: group.discountReason,
      estimatedTonnes: group.estimatedWeightKg === null ? null : (group.estimatedWeightKg / 1000).toFixed(3),
      siteProfileId: group.siteProfileId,
      site: group.site,
      proposedDeliveryAt: iso(group.deliveryAt),
      proposedReturnAt: iso(group.returnAt)
    });
  }
  const siteKeys = new Set(lines.map((line) => (
    line.siteProfileId ? `id:${line.siteProfileId}` : `inline:${JSON.stringify(line.site)}`
  )));
  if (siteKeys.size !== 1) {
    throw failure(400, "MBT_FRONTDESK_INPUT_INVALID", "Every physical bin in a contract must use one service site.");
  }
  return lines;
}

async function verifiedMbtSubsidiaryId() {
  const result = await query(
    `SELECT external_id
       FROM mbt_netsuite_mappings
      WHERE mapping_type = 'subsidiary'
        AND local_key = 'mbt'
        AND is_current
        AND active
        AND validation_status = 'valid'
        AND external_id ~ '^[0-9]+$'
      ORDER BY revision DESC, mapping_id DESC
      LIMIT 1`
  );
  return result.rowCount ? String(result.rows[0].external_id) : null;
}

/** @param {string} customerNetsuiteId @param {unknown} localSubsidiaryId */
async function assertConfiguredCustomerSubsidiary(customerNetsuiteId, localSubsidiaryId) {
  const local = localSubsidiaryId === null || localSubsidiaryId === undefined
    ? ""
    : String(localSubsidiaryId).trim();
  const configuredSubsidiaryId = local || await verifiedMbtSubsidiaryId();
  if (!configuredSubsidiaryId) {
    return null;
  }
  if (!/^\d+$/u.test(configuredSubsidiaryId)
      || BigInt(configuredSubsidiaryId) < 1n
      || BigInt(configuredSubsidiaryId) > MAX_POSTGRES_BIGINT) {
    throw failure(422, "MBT_FRONTDESK_SUBSIDIARY_CONFIGURATION_INVALID", "The configured MBT subsidiary ID is invalid.");
  }
  const relationship = await query(
    `SELECT 1
       FROM netsuite_customer_subsidiaries
      WHERE customer_netsuite_id = $1::bigint
        AND subsidiary_netsuite_id = $2::bigint
        AND active
      LIMIT 1`,
    [customerNetsuiteId, configuredSubsidiaryId]
  );
  if (!relationship.rowCount) {
    throw failure(
      409,
      "MBT_FRONTDESK_CUSTOMER_SUBSIDIARY_MISMATCH",
      "The customer is not active for the configured MBT subsidiary.",
      { configuredSubsidiaryId }
    );
  }
  return configuredSubsidiaryId;
}

/** @param {string} customerNetsuiteId @param {string} siteProfileId */
async function selectedCustomerSite(customerNetsuiteId, siteProfileId) {
  const selected = await query(
    `SELECT s.site_profile_id::text, s.address_id::text,
            s.site_instructions, s.access_restrictions,
            s.contact_on_arrival_notes, s.service_warnings,
            s.active AS site_active, s.revision::int AS site_revision,
            a.label AS address_label, a.addressee,
            a.address_line_1, a.address_line_2, a.address_line_3,
            a.city, a.region, a.postal_code, a.country_code,
            a.active AS address_active,
            a.source_version AS address_source_version
       FROM mbt_customer_site_profiles s
       JOIN netsuite_customer_addresses a
         ON a.customer_netsuite_id = s.customer_netsuite_id
        AND a.address_id = s.address_id
      WHERE s.customer_netsuite_id = $1::bigint
        AND s.site_profile_id = $2::uuid
        AND s.active
        AND a.active`,
    [customerNetsuiteId, siteProfileId]
  );
  if (!selected.rowCount) {
    throw failure(409, "MBT_FRONTDESK_SITE_NOT_ACTIVE", "The selected BIN order service site is not active for this customer.");
  }
  return siteSnapshot(selected.rows[0]);
}

/** @param {string} customerNetsuiteId @param {Record<string, string>} site @param {string} actorId @param {string} customerDisplayName */
async function createOrReuseLocalCustomerSite(customerNetsuiteId, site, actorId, customerDisplayName) {
  const existing = await query(
    `SELECT s.site_profile_id::text
       FROM mbt_customer_site_profiles s
       JOIN netsuite_customer_addresses a
         ON a.customer_netsuite_id = s.customer_netsuite_id
        AND a.address_id = s.address_id
      WHERE s.customer_netsuite_id = $1::bigint
        AND s.active
        AND a.active
        AND lower(btrim(a.address_line_1)) = lower(btrim($2))
        AND lower(btrim(a.address_line_2)) = lower(btrim($3))
        AND lower(btrim(a.city)) = lower(btrim($4))
        AND lower(btrim(a.region)) = lower(btrim($5))
        AND upper(regexp_replace(a.postal_code, '\\s', '', 'g')) = upper(regexp_replace($6, '\\s', '', 'g'))
        AND upper(a.country_code) = upper($7)
      ORDER BY s.created_at, s.site_profile_id
      LIMIT 1`,
    [
      customerNetsuiteId, site.addressLine1, site.addressLine2 || "",
      site.city, site.region, site.postalCode, site.countryCode
    ]
  );
  if (existing.rowCount) {
    return selectedCustomerSite(customerNetsuiteId, String(existing.rows[0].site_profile_id));
  }

  const addressId = crypto.randomUUID();
  const siteProfileId = crypto.randomUUID();
  const sourcePayload = {
    schemaVersion: "mbt-local-customer-site-v1",
    customerNetsuiteId,
    ...site
  };
  const payloadHash = crypto.createHash("sha256").update(JSON.stringify(sourcePayload)).digest("hex");
  const sourceVersion = `frontdesk-local:${payloadHash}`;
  await query(
    `INSERT INTO netsuite_customer_addresses (
       address_id, customer_netsuite_id, netsuite_address_id, label,
       addressee, address_line_1, address_line_2, address_line_3,
       city, region, postal_code, country_code, phone, active,
       source_modified_at, source_version, payload_hash
     ) VALUES (
       $1::uuid, $2::bigint, $3, $4, $5, $6, $7, $8,
       $9, $10, $11, $12, $13, true, now(), $14, $15
     )`,
    [
      addressId, customerNetsuiteId, `LOCAL:${addressId}`, site.label,
      customerDisplayName, site.addressLine1, site.addressLine2 || "",
      site.addressLine3 || "", site.city, site.region, site.postalCode,
      site.countryCode, site.phone || "", sourceVersion, payloadHash
    ]
  );
  await query(
    `INSERT INTO mbt_customer_site_profiles (
       site_profile_id, customer_netsuite_id, address_id,
       site_instructions, access_restrictions, contact_on_arrival_notes,
       created_by, updated_by
     ) VALUES ($1::uuid, $2::bigint, $3::uuid, $4, $5, $6, $7, $7)`,
    [
      siteProfileId, customerNetsuiteId, addressId,
      site.siteInstructions || "", site.accessRestrictions || "",
      site.contactOnArrivalNotes || "", actorId
    ]
  );
  return selectedCustomerSite(customerNetsuiteId, siteProfileId);
}

/**
 * @param {string} customerNetsuiteId
 * @param {Array<Record<string, any>>} requestedServiceLines
 * @param {string} actorId
 * @param {string} customerDisplayName
 */
async function resolveRequestedServiceLineSites(customerNetsuiteId, requestedServiceLines, actorId, customerDisplayName) {
  /** @type {Map<string, any>} */
  const resolved = new Map();
  /** @type {Array<Record<string, any>>} */
  const lines = [];
  for (const line of requestedServiceLines) {
    const key = line.siteProfileId
      ? `existing:${line.siteProfileId}`
      : `inline:${JSON.stringify(line.site)}`;
    let site = resolved.get(key);
    if (!site) {
      site = line.siteProfileId
        ? await selectedCustomerSite(customerNetsuiteId, line.siteProfileId)
        : await createOrReuseLocalCustomerSite(
          customerNetsuiteId,
          /** @type {Record<string, string>} */ (jsonObject(line.site, `Service line ${line.lineNumber} site`)),
          actorId,
          customerDisplayName
        );
      resolved.set(key, site);
    }
    lines.push({
      ...line,
      siteProfileId: String(site.siteProfileId),
      siteSnapshot: site
    });
  }
  return lines;
}

/** @param {Record<string, any>} rental */
function physicalRentalPriceLine(rental) {
  return {
    code: "bin_base_rental",
    label: String(rental.display_name || "Base BIN rental"),
    itemCode: String(rental.item_code),
    amountMinor: safeNonnegativeInteger(rental.amount_minor, "Base BIN rental amount"),
    taxable: Boolean(rental.taxable),
    rateCardId: String(rental.rate_card_id),
    rateCardVersionId: String(rental.rate_card_version_id),
    rateComponentId: String(rental.rate_component_id)
  };
}

/** @param {Record<string, any>} dump @param {number} estimatedWeightKg @param {number} amountMinor */
function physicalDumpPriceLine(dump, estimatedWeightKg, amountMinor) {
  return {
    code: "estimated_dump_weight",
    label: `${String(dump.display_name || dump.item_code)} · ${(estimatedWeightKg / 1000).toFixed(3)} t estimated`,
    itemCode: String(dump.item_code),
    amountMinor,
    taxable: true,
    estimatedWeightKg,
    estimatedTonnes: (estimatedWeightKg / 1000).toFixed(3),
    unitAmountMinor: safeNonnegativeInteger(dump.amount_minor, "Dump unit amount"),
    minimumAmountMinor: safeNonnegativeInteger(dump.minimum_amount_minor, "Dump minimum amount"),
    unitOfMeasure: "TONNE",
    materialId: String(dump.material_id),
    rateCardId: String(dump.rate_card_id),
    rateCardVersionId: String(dump.rate_card_version_id),
    dumpTariffId: String(dump.dump_tariff_id)
  };
}

/** @param {Record<string, any>} delivery @param {{providerMetres: number, originYardCode: string}} input @param {number} amountMinor */
function physicalDeliveryPriceLine(delivery, input, amountMinor) {
  const pricingBasis = String(delivery.pricing_basis || "flat");
  const perKilometre = pricingBasis === "per_km";
  const originYardCodes = Array.isArray(delivery.origin_yard_codes)
    ? delivery.origin_yard_codes.map(String)
    : [];
  return {
    code: "one_way_delivery",
    label: String(delivery.description || delivery.display_name || "One-way delivery fee"),
    itemCode: String(delivery.item_code),
    amountMinor,
    taxable: true,
    pricingBasis,
    quantity: perKilometre ? input.providerMetres / 1000 : 1,
    unitOfMeasure: perKilometre ? "KM" : "TRIP",
    unitAmountMinor: safeNonnegativeInteger(delivery.amount_minor, "One-way delivery unit amount"),
    pricingOriginYardCode: input.originYardCode,
    originYardCodes,
    rateCardId: String(delivery.rate_card_id),
    rateCardVersionId: String(delivery.rate_card_version_id),
    rateDistanceBandId: String(delivery.rate_distance_band_id)
  };
}

/**
 * Resolve the independently item-owned rate evidence for one physical bin:
 * fixed base rental + one-way delivery band + estimated dump weight.
 *
 * @param {{binItemCode: string, deliveryItemCode: string, dumpItemCode: string, estimatedWeightKg: number, serviceCode: string, binTypeId: string, providerMetres: number, originYardCode: string, deliveryAt: string, expectedCurrency: string}} input
 */
async function quotePhysicalBinRate(input) {
  const rentalResult = await query(
      `SELECT item.item_code, item.display_name, card.rate_card_id::text,
              version.rate_card_version_id::text, component.rate_component_id::text,
              component.amount_minor, component.currency, component.taxable
         FROM mbt_local_item_settings item
         JOIN mbt_rate_components component
           ON component.item_code = item.item_code
         JOIN mbt_rate_card_versions version
           ON version.rate_card_version_id = component.rate_card_version_id
          AND version.status = 'active'
          AND (version.effective_from IS NULL OR version.effective_from <= $3::timestamptz)
          AND (version.effective_to IS NULL OR version.effective_to > $3::timestamptz)
         JOIN mbt_rate_cards card
           ON card.rate_card_id = version.rate_card_id AND card.active
        WHERE component.component_kind = 'rental'
          AND component.rate_basis = 'flat'
          AND component.active
          AND (component.service_code IS NULL OR component.service_code = 'delivery')
          AND (component.bin_type_id IS NULL OR component.bin_type_id = $2::uuid)
          AND item.item_code = $1
          AND item.item_type = 'bin'
          AND item.bin_type_id = $2::uuid
          AND item.active
        ORDER BY version.effective_from DESC NULLS LAST, version.version_number DESC,
                 (component.bin_type_id IS NOT NULL) DESC, component.rate_component_id
        LIMIT 2`,
      [input.binItemCode, input.binTypeId, input.deliveryAt]
    );
  const deliveryResult = await query(
      `SELECT item.item_code, item.display_name, card.rate_card_id::text,
              version.rate_card_version_id::text, band.rate_distance_band_id::text,
              band.amount_minor, band.pricing_basis, band.boundary_rule,
              band.origin_yard_codes, band.currency, band.description
         FROM mbt_local_item_settings item
         JOIN mbt_rate_distance_bands band
           ON band.item_code = item.item_code
         JOIN mbt_rate_card_versions version
           ON version.rate_card_version_id = band.rate_card_version_id
          AND version.status = 'active'
          AND (version.effective_from IS NULL OR version.effective_from <= $5::timestamptz)
          AND (version.effective_to IS NULL OR version.effective_to > $5::timestamptz)
         JOIN mbt_rate_cards card
           ON card.rate_card_id = version.rate_card_id AND card.active
        WHERE band.service_code = $2
          AND (band.bin_type_id IS NULL OR band.bin_type_id = $3::uuid)
          AND (
            (
              band.boundary_rule = 'upper_inclusive'
              AND (CASE WHEN band.minimum_metres = 0 THEN $4 >= band.minimum_metres ELSE $4 > band.minimum_metres END)
              AND (band.maximum_metres IS NULL OR $4 <= band.maximum_metres)
            )
            OR
            (
              band.boundary_rule = 'lower_inclusive'
              AND band.minimum_metres <= $4
              AND (band.maximum_metres IS NULL OR band.maximum_metres > $4)
            )
          )
          AND (cardinality(band.origin_yard_codes) = 0 OR $6 = ANY(band.origin_yard_codes))
          AND item.item_code = $1
          AND item.item_type = 'delivery_fee'
          AND item.active
        ORDER BY version.effective_from DESC NULLS LAST, version.version_number DESC,
                 (band.bin_type_id IS NOT NULL) DESC, band.minimum_metres DESC,
                 band.sequence_number, band.rate_distance_band_id
        LIMIT 2`,
      [input.deliveryItemCode, input.serviceCode, input.binTypeId, input.providerMetres, input.deliveryAt, input.originYardCode]
    );
  const dumpResult = await query(
      `SELECT item.item_code, item.display_name, material.material_id::text,
              card.rate_card_id::text, version.rate_card_version_id::text,
              tariff.dump_tariff_id::text, tariff.amount_minor,
              tariff.minimum_amount_minor, tariff.currency, tariff.description
         FROM mbt_local_item_settings item
         JOIN mbt_materials material ON material.material_code = item.item_code
         JOIN mbt_dump_tariffs tariff
           ON tariff.item_code = item.item_code
         JOIN mbt_rate_card_versions version
           ON version.rate_card_version_id = tariff.rate_card_version_id
          AND version.status = 'active'
          AND (version.effective_from IS NULL OR version.effective_from <= $2::timestamptz)
          AND (version.effective_to IS NULL OR version.effective_to > $2::timestamptz)
         JOIN mbt_rate_cards card
           ON card.rate_card_id = version.rate_card_id AND card.active
        WHERE tariff.material_id = material.material_id
          AND tariff.dump_site_id IS NULL
          AND tariff.pricing_basis = 'per_weight'
          AND upper(tariff.unit_of_measure) = 'TONNE'
          AND tariff.active
          AND item.item_code = $1
          AND item.item_type = 'dump'
          AND item.active
          AND material.active
        ORDER BY version.effective_from DESC NULLS LAST, version.version_number DESC,
                 tariff.dump_tariff_id
        LIMIT 2`,
      [input.dumpItemCode, input.deliveryAt]
    );
  if (rentalResult.rowCount !== 1) {
    throw failure(422, "MBT_FRONTDESK_RENTAL_RATE_MISSING", "The selected BIN item needs one active base-rental rate for the delivery date.");
  }
  if (deliveryResult.rowCount !== 1) {
    throw failure(422, "MBT_FRONTDESK_RATE_BAND_MISSING", "The selected Delivery fee item needs one matching one-way distance band.");
  }
  if (dumpResult.rowCount !== 1) {
    throw failure(422, "MBT_FRONTDESK_DUMP_RATE_MISSING", "The selected dump item needs one active per-tonne customer rate for the delivery date.");
  }
  const rental = rentalResult.rows[0];
  const delivery = deliveryResult.rows[0];
  const dump = dumpResult.rows[0];
  const currencies = new Set([rental.currency, delivery.currency, dump.currency].map(String));
  if (currencies.size !== 1 || !currencies.has(input.expectedCurrency)) {
    throw failure(422, "MBT_FRONTDESK_CURRENCY_MISMATCH", "Rental, delivery, dump, and operational rate currencies must match.");
  }
  const dumpAmountMinor = calculateEstimatedDumpChargeMinor({
    amountMinorPerTonne: dump.amount_minor,
    minimumAmountMinor: dump.minimum_amount_minor,
    estimatedWeightKg: input.estimatedWeightKg
  });
  const deliveryAmountMinor = calculateDistanceBandChargeMinor({
    amountMinor: safeNonnegativeInteger(delivery.amount_minor, "One-way delivery unit amount"),
    pricingBasis: delivery.pricing_basis
  }, input.providerMetres);
  const lines = [
    physicalRentalPriceLine(rental),
    physicalDumpPriceLine(dump, input.estimatedWeightKg, dumpAmountMinor),
    physicalDeliveryPriceLine(delivery, input, deliveryAmountMinor)
  ];
  const subtotalMinor = lines.reduce((total, line) => total + line.amountMinor, 0);
  const taxableSubtotalMinor = lines.filter((line) => line.taxable)
    .reduce((total, line) => total + line.amountMinor, 0);
  if (!Number.isSafeInteger(subtotalMinor) || !Number.isSafeInteger(taxableSubtotalMinor)) {
    throw failure(422, "MBT_FRONTDESK_CONFIGURATION_INVALID", "The configured quote total exceeds safe integer limits.");
  }
  return {
    currency: String(delivery.currency),
    distanceRateCardVersionId: String(delivery.rate_card_version_id),
    rateDistanceBandId: String(delivery.rate_distance_band_id),
    materialId: String(dump.material_id),
    subtotalMinor,
    taxableSubtotalMinor,
    lines
  };
}

/**
 * @param {{rateCardVersionId: string, serviceCode: string, binTypeId: string, currency: string, totalMinor: number}} input
 */
async function quotePhysicalBinDeposit(input) {
  const depositResult = await query(
    `SELECT *
       FROM mbt_deposit_rules
      WHERE rate_card_version_id = $1::uuid
        AND active
        AND (bin_type_id IS NULL OR bin_type_id = $2::uuid)
        AND (service_code IS NULL OR service_code = $3)
      ORDER BY (bin_type_id IS NOT NULL) DESC,
               (service_code IS NOT NULL) DESC,
               rule_code, deposit_rule_id
      LIMIT 1`,
    [input.rateCardVersionId, input.binTypeId, input.serviceCode]
  );
  if (!depositResult.rowCount) {
    return { depositRuleId: null, depositRequiredMinor: 0 };
  }
  const deposit = depositResult.rows[0];
  if (String(deposit.currency) !== input.currency) {
    throw failure(422, "MBT_FRONTDESK_CURRENCY_MISMATCH", "The deposit rule and quote currencies do not match.");
  }
  const depositRequiredMinor = deposit.rule_type === "percentage"
    ? percentageAmount(input.totalMinor, safeNonnegativeInteger(deposit.percentage_basis_points, "Deposit basis points"))
    : safeNonnegativeInteger(deposit.fixed_amount_minor, "Deposit amount");
  return { depositRuleId: String(deposit.deposit_rule_id), depositRequiredMinor };
}

/** @param {Record<string, any>} calculation @param {string} chargeRequestId */
function fixedQuoteAttachedAggregate(calculation, chargeRequestId) {
  const lines = /** @type {Array<Record<string, any>>} */ (calculation.lines);
  const materials = lines.filter((line) => line.lineType === "aggregate_material");
  if (!materials.length) {
    return null;
  }
  const loading = lines.find((line) => line.lineType === "aggregate_loading_fee");
  return {
    schemaVersion: "mbt-attached-aggregate-v1",
    chargeRequestId,
    materials: materials.map((line) => ({
      itemCode: line.itemCode,
      displayName: line.label,
      quantityMilliYards: line.quantityMilliUnits,
      unitOfMeasure: "YARD",
      derivedWeightLbs: line.derivedWeightLbs
    })),
    totalWeightLbs: materials.reduce((sum, line) => sum + Number(line.derivedWeightLbs), 0),
    loadingFeeMinor: loading ? Number(loading.configuredAmountMinor) : 0
  };
}

/**
 * Build the new fixed-price initial-bin quote while preserving the existing
 * operational quote/contract lifecycle and route snapshots.
 *
 * @param {Record<string, any>} input
 */
async function createFixedPriceInitialQuoteMutation(input) {
  const line = input.serviceLine;
  const selectedBin = input.selectedBin;
  const distance = input.distance;
  const prepared = await prepareFrontdeskInitialCharge({
    actor: input.actor,
    customerNetsuiteId: input.customerNetsuiteId,
    rateCardVersionId: input.rateCardVersionId,
    paymentMethod: input.paymentMethod,
    billingAddressText: input.billingAddressText,
    serviceAddressText: input.serviceAddressText,
    contractTelephone: input.contractTelephone,
    orderFrom150: input.orderFrom150,
    distanceMetres: distance.providerMetres,
    bin: {
      incomingContentCode: line.contentCode,
      incomingBinSizeYards: Number(selectedBin.nominal_yards),
      incomingBinTypeId: line.binTypeId,
      binItemCode: line.binItemCode,
      deliveryItemCode: input.deliveryItemCode,
      discountMinor: line.discountMinor,
      discountReason: line.discountReason || null,
      proposedDeliveryAt: line.proposedDeliveryAt,
      proposedReturnAt: line.proposedReturnAt
    },
    aggregateLines: input.aggregateLines,
    reason: input.reason
  });
  const calculation = prepared.calculation;
  const binRate = prepared.binRate;
  if (!binRate) {
    throw failure(422, "MBT_FRONTDESK_CONFIGURATION_INVALID", "The initial fixed-price quote has no bin rate evidence.");
  }
  const quoteId = crypto.randomUUID();
  const quoteNumber = publicNumber("MBT-Q", quoteId);
  const attachedAggregate = fixedQuoteAttachedAggregate(calculation, prepared.chargeRequestId);
  const displayLines = calculation.lines.map((priceLine) => ({
    ...priceLine,
    code: priceLine.lineCode,
    amountMinor: priceLine.customerAmountMinor
  }));
  const linePricing = {
    schemaVersion: "mbt-frontdesk-service-line-pricing-v2",
    pricingModel: "fixed_bin_customer_charge",
    chargeRequestId: prepared.chargeRequestId,
    lineNumber: 1,
    binItemCode: line.binItemCode,
    binTypeId: line.binTypeId,
    contentCode: line.contentCode,
    deliveryItemCode: input.deliveryItemCode,
    pricingOriginYardCode: input.orderFrom150 ? "150" : "3445",
    dumpItemCode: null,
    materialId: null,
    estimatedWeightKg: null,
    estimatedTonnes: null,
    siteProfileId: line.siteProfileId,
    siteSnapshot: line.siteSnapshot,
    binTypeCode: String(selectedBin.type_code),
    binTypeDisplayName: String(selectedBin.display_name),
    proposedDeliveryAt: line.proposedDeliveryAt,
    proposedReturnAt: line.proposedReturnAt,
    distanceSnapshotId: distance.distanceSnapshotId,
    distance,
    rateCardVersionId: input.rateCardVersionId,
    rateDistanceBandId: binRate.itemEvidence.deliveryRateDistanceBandId,
    subtotalMinor: calculation.preTaxRevenueMinor,
    taxableSubtotalMinor: calculation.preTaxRevenueMinor,
    taxMinor: calculation.addedHstMinor,
    totalMinor: calculation.newRequestChargeableMinor,
    tax: {
      code: "ON_HST_13",
      label: calculation.taxMode === "included" ? "Included Ontario HST" : "Ontario HST",
      basisPoints: calculation.taxRateBasisPoints,
      mode: calculation.taxMode,
      includedHstMinor: calculation.includedHstMinor,
      amountMinor: calculation.addedHstMinor
    },
    lines: displayLines,
    depositRequiredMinor: calculation.requiredDepositMinor,
    depositRuleId: line.contentCode === "garbage"
      ? binRate.itemEvidence.depositRuleId
      : null,
    ...(attachedAggregate ? { attachedAggregate } : {})
  };
  const pricingSnapshot = {
    pricingModel: "fixed_bin_customer_charge",
    chargeRequestId: prepared.chargeRequestId,
    paymentMethod: calculation.paymentMethod,
    paymentCategory: calculation.paymentCategory,
    taxMode: calculation.taxMode,
    taxRateBasisPoints: calculation.taxRateBasisPoints,
    currency: calculation.currency,
    distanceMetres: distance.providerMetres,
    currentContractTotalMinor: 0,
    preTaxRevenueMinor: calculation.preTaxRevenueMinor,
    includedHstMinor: calculation.includedHstMinor,
    addedHstMinor: calculation.addedHstMinor,
    subtotalMinor: calculation.preTaxRevenueMinor,
    taxableSubtotalMinor: calculation.preTaxRevenueMinor,
    taxMinor: calculation.addedHstMinor,
    totalMinor: calculation.newRequestChargeableMinor,
    customerTotalMinor: calculation.newRequestChargeableMinor,
    requiredDepositMinor: calculation.requiredDepositMinor,
    dueNowMinor: calculation.dueNowMinor,
    netsuiteExportPolicy: calculation.netsuiteExportPolicy,
    netsuiteReadySnapshot: calculation.netsuiteReadySnapshot,
    lines: displayLines,
    serviceLines: [linePricing],
    tax: linePricing.tax,
    serviceCode: input.serviceCode,
    deliveryItemCode: input.deliveryItemCode,
    pricingOriginYardCode: input.orderFrom150 ? "150" : "3445",
    surcharges: [],
    serviceTemplateVersionId: input.serviceTemplateVersionId,
    serviceTemplateCode: String(input.configuration.template_code),
    serviceTemplateDisplayName: String(input.configuration.template_display_name),
    rateCardVersionId: input.rateCardVersionId,
    configuredSubsidiaryId: input.configuredSubsidiaryId,
    rateCardCode: String(input.configuration.rate_card_code),
    rateCardDisplayName: String(input.configuration.rate_display_name),
    binTypeId: line.binTypeId,
    binTypeCode: String(selectedBin.type_code),
    binTypeDisplayName: String(selectedBin.display_name),
    rentalCalendarDays: Number(input.configuration.default_rental_calendar_days),
    billingOwnership: String(input.configuration.billing_ownership)
  };
  const transportLine = calculation.lines.find((priceLine) => priceLine.lineType === "bin_transport");
  await query(
    `INSERT INTO mbt_distance_snapshots (
       distance_snapshot_id, subject_type, subject_id,
       rate_card_version_id, rate_distance_band_id,
       provider, provider_metres, route_hash,
       origin_snapshot, destination_snapshot, route_snapshot,
       calculated_amount_minor, currency
     ) VALUES (
       $1::uuid, 'quote', $2::uuid, $3::uuid, $4::uuid,
       $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12
     )`,
    [
      distance.distanceSnapshotId, quoteId, input.rateCardVersionId,
      binRate.itemEvidence.deliveryRateDistanceBandId,
      distance.provider, distance.providerMetres, distance.routeHash,
      JSON.stringify(distance.originSnapshot), JSON.stringify(distance.destinationSnapshot),
      JSON.stringify({ ...distance.routeSnapshot, physicalBinLineNumber: 1 }),
      Number(transportLine?.configuredAmountMinor || 0), calculation.currency
    ]
  );
  const inserted = await query(
    `INSERT INTO mbt_quotes (
       quote_id, quote_number, customer_netsuite_id,
       customer_site_profile_id, service_template_version_id,
       rate_card_version_id, bin_type_id, distance_snapshot_id,
       deposit_rule_id, status, proposed_delivery_at,
       proposed_return_at, customer_snapshot, site_snapshot,
       pricing_snapshot, deposit_required_minor, currency,
       created_by, updated_by
     ) VALUES (
       $1::uuid, $2, $3::bigint, $4::uuid, $5::uuid,
       $6::uuid, $7::uuid, $8::uuid, $9::uuid, 'draft',
       $10::timestamptz, $11::timestamptz, $12::jsonb,
       $13::jsonb, $14::jsonb, $15, $16, $17, $17
     ) RETURNING *`,
    [
      quoteId, quoteNumber, input.customerNetsuiteId, line.siteProfileId,
      input.serviceTemplateVersionId, input.rateCardVersionId, line.binTypeId,
      distance.distanceSnapshotId, linePricing.depositRuleId,
      line.proposedDeliveryAt, line.proposedReturnAt,
      JSON.stringify(input.canonicalCustomer), JSON.stringify(line.siteSnapshot),
      JSON.stringify(pricingSnapshot), calculation.requiredDepositMinor,
      calculation.currency, String(input.actor.operatorId)
    ]
  );
  const chargeRequest = await persistPreparedFrontdeskInitialCharge(prepared, quoteId);
  const quote = publicQuote({ ...inserted.rows[0], bin_type_code: selectedBin.type_code });
  return {
    status: 201,
    body: { schemaVersion: "mbt-frontdesk-quote-v2", quote, chargeRequest },
    audit: {
      action: "mbt.frontdesk.quote.created",
      entityType: "mbt_quote",
      entityId: quoteId,
      beforeState: { quoteId, exists: false },
      afterState: { quote, chargeRequest },
      reason: input.reason,
      revisionBefore: 1,
      revisionAfter: 1,
      source: "frontdesk_local"
    }
  };
}

/** @param {unknown} value */
function frontdeskCustomerNetsuiteId(value) {
  const customerNetsuiteId = requiredText(value, "Customer NetSuite ID");
  if (!/^\d+$/u.test(customerNetsuiteId)) {
    throw failure(400, "MBT_FRONTDESK_INPUT_INVALID", "Customer NetSuite ID is invalid.");
  }
  return customerNetsuiteId;
}

/** @param {unknown} value */
function frontdeskServiceCode(value) {
  const serviceCode = requiredText(value, "Service code");
  if (!/^[a-z][a-z0-9_]*$/u.test(serviceCode)) {
    throw failure(400, "MBT_FRONTDESK_INPUT_INVALID", "Service code is invalid.");
  }
  return serviceCode;
}

/** @param {Record<string, unknown>} input @param {boolean} fixedChargeMode */
function fixedChargeSnapshots(input, fixedChargeMode) {
  if (!fixedChargeMode) {
    return { billingAddressText: "", serviceAddressText: "", contractTelephone: "", aggregateLines: [] };
  }
  return {
    billingAddressText: siteText(input.billingAddressText, "Billing address", 1_000, true),
    serviceAddressText: siteText(input.serviceAddressText, "Service address", 1_000, true),
    contractTelephone: siteText(input.contractTelephone, "Contract telephone", 100, true),
    aggregateLines: Array.isArray(input.aggregateLines) ? input.aggregateLines : []
  };
}

/** @param {Record<string, unknown>} input */
function normalizedQuotePricingMode(input) {
  const fixedChargeMode = input.paymentMethod !== undefined && input.paymentMethod !== null;
  const orderFrom150 = fixedChargeMode
    ? input.orderFrom150 === true
    : String(input.pricingOriginYardCode || "") === "150";
  const pricingOriginYardCode = normalizePricingOriginYardCode(
    fixedChargeMode ? (orderFrom150 ? "150" : "3445") : input.pricingOriginYardCode
  );
  const requestedSurcharges = normalizeFrontdeskSurcharges(input.surcharges);
  if (fixedChargeMode && requestedSurcharges.length) {
    throw failure(400, "MBT_FRONTDESK_INPUT_INVALID", "Fixed-price bin requests use the per-bin discount field instead of manual surcharges.");
  }
  return {
    fixedChargeMode,
    orderFrom150,
    pricingOriginYardCode,
    requestedSurcharges,
    ...fixedChargeSnapshots(input, fixedChargeMode)
  };
}

/** @param {{resolveDistance?: Function, resolveTaxPolicy?: Function}} options @param {boolean} fixedChargeMode */
function quotePricingResolvers(options, fixedChargeMode) {
  if (typeof options.resolveDistance !== "function"
      || (!fixedChargeMode && typeof options.resolveTaxPolicy !== "function")) {
    throw failure(503, "MBT_FRONTDESK_PRICING_UNAVAILABLE", "Server-owned distance and tax resolvers are required.");
  }
  return {
    resolveDistance: /** @type {Function} */ (options.resolveDistance),
    resolveTaxPolicy: /** @type {Function} */ (options.resolveTaxPolicy)
  };
}

/**
 * @param {Record<string, unknown>} input
 * @param {{resolveDistance?: Function, resolveTaxPolicy?: Function}} [options]
 */
export async function createFrontdeskQuote(input, options = {}) {
  const actor = /** @type {any} */ (input.actor);
  assertFrontdeskActor(actor);
  const customerNetsuiteId = frontdeskCustomerNetsuiteId(input.customerNetsuiteId);
  const serviceTemplateVersionId = requiredUuid(input.serviceTemplateVersionId, "Service template version ID");
  const rateCardVersionId = requiredUuid(input.rateCardVersionId, "Rate card version ID");
  const requestedServiceLines = normalizeFrontdeskServiceLines(input);
  const deliveryItemCode = localItemCode(input.deliveryItemCode, "Delivery fee item");
  const {
    fixedChargeMode, orderFrom150, pricingOriginYardCode, requestedSurcharges,
    billingAddressText, serviceAddressText, contractTelephone, aggregateLines
  } = normalizedQuotePricingMode(input);
  const primaryServiceLine = requiredArrayEntry(requestedServiceLines, 0, "Physical-bin service line");
  const binTypeId = primaryServiceLine.binTypeId;
  const serviceCode = frontdeskServiceCode(input.serviceCode);
  const proposedDeliveryAt = new Date(primaryServiceLine.proposedDeliveryAt);
  const proposedReturnAt = new Date(primaryServiceLine.proposedReturnAt);
  const reason = requiredText(input.reason, "Audit reason");
  const { resolveDistance, resolveTaxPolicy } = quotePricingResolvers(options, fixedChargeMode);
  const payload = {
    customerNetsuiteId,
    serviceTemplateVersionId,
    rateCardVersionId,
    binTypeId,
    serviceCode,
    proposedDeliveryAt: iso(proposedDeliveryAt),
    proposedReturnAt: iso(proposedReturnAt),
    deliveryItemCode,
    pricingOriginYardCode,
    fixedChargeMode,
    paymentMethod: fixedChargeMode ? input.paymentMethod : null,
    billingAddressText,
    serviceAddressText,
    contractTelephone,
    orderFrom150,
    aggregateLines,
    surcharges: requestedSurcharges,
    serviceLines: requestedServiceLines,
    reason
  };
  return executeMbtCommand({
    actor,
    commandName: "mbt.frontdesk.quote.create",
    idempotencyKey: requiredText(input.idempotencyKey, "Idempotency key"),
    payload,
    correlationId: requiredText(input.correlationId, "Correlation ID"),
    requestId: requiredText(input.requestId, "Request ID"),
    // eslint-disable-next-line complexity -- Atomic quote orchestration keeps all pricing evidence in one command transaction.
    mutation: async () => {
      const selected = await query(
        `SELECT c.netsuite_id::text AS customer_netsuite_id,
                c.entity_number, c.legal_name, c.display_name,
                c.currency AS customer_currency, c.terms AS customer_terms,
                c.tax_status AS customer_tax_status,
                c.credit_status AS customer_credit_status,
                c.source_version AS customer_source_version,
                c.active AS customer_active,
                tv.template_version_id::text, tv.template_id::text,
                tv.version_number::int AS template_version_number,
                tv.status AS template_status,
                tv.default_rental_calendar_days::int,
                tv.billing_ownership,
                t.template_code, t.display_name AS template_display_name,
                t.active AS template_active,
                rv.rate_card_version_id::text, rv.rate_card_id::text,
                rv.version_number::int AS rate_version_number,
                rv.status AS rate_status,
                rv.effective_from AS rate_effective_from,
                rv.effective_to AS rate_effective_to,
                r.rate_card_code, r.display_name AS rate_display_name,
                r.currency AS rate_currency, r.active AS rate_card_active,
                r.subsidiary_netsuite_id::text AS rate_subsidiary_netsuite_id,
                r.service_template_id::text AS rate_template_id,
                b.bin_type_id::text, b.type_code AS bin_type_code,
                b.display_name AS bin_type_display_name, b.active AS bin_type_active
           FROM netsuite_customers c
           JOIN mbt_service_template_versions tv
             ON tv.template_version_id = $2::uuid
           JOIN mbt_service_templates t ON t.template_id = tv.template_id
           JOIN mbt_rate_card_versions rv
             ON rv.rate_card_version_id = $3::uuid
           JOIN mbt_rate_cards r ON r.rate_card_id = rv.rate_card_id
           JOIN mbt_bin_types b ON b.bin_type_id = $4::uuid
          WHERE c.netsuite_id = $1::bigint`,
        [customerNetsuiteId, serviceTemplateVersionId, rateCardVersionId, binTypeId]
      );
      if (!selected.rowCount) {
        throw failure(422, "MBT_FRONTDESK_CONFIGURATION_INCOMPLETE", "The selected customer, template, rate, or bin configuration is incomplete.");
      }
      const configuration = selected.rows[0];
      if (!configuration.customer_active) {
        throw failure(409, "MBT_FRONTDESK_CUSTOMER_NOT_READY", "The customer is not active for local service.");
      }
      const configuredSubsidiaryId = await assertConfiguredCustomerSubsidiary(
        customerNetsuiteId,
        configuration.rate_subsidiary_netsuite_id
      );
      const serviceLinesWithSites = await resolveRequestedServiceLineSites(
        customerNetsuiteId,
        requestedServiceLines,
        String(actor.operatorId),
        String(configuration.display_name)
      );
      if (!configuration.template_active || configuration.template_status !== "active") {
        throw failure(409, "MBT_FRONTDESK_TEMPLATE_NOT_ACTIVE", "The selected service template is not active.");
      }
      if (!configuration.rate_card_active || configuration.rate_status !== "active") {
        throw failure(409, "MBT_FRONTDESK_RATE_NOT_ACTIVE", "The selected rate version is not active.");
      }
      if (!configuration.bin_type_active) {
        throw failure(409, "MBT_FRONTDESK_BIN_TYPE_NOT_ACTIVE", "The selected bin type is not active.");
      }
      if (configuration.rate_template_id
          && String(configuration.rate_template_id) !== String(configuration.template_id)) {
        throw failure(422, "MBT_FRONTDESK_CONFIGURATION_MISMATCH", "The selected rate card does not belong to the service template.");
      }
      const effectiveFrom = configuration.rate_effective_from
        ? new Date(configuration.rate_effective_from)
        : null;
      const effectiveTo = configuration.rate_effective_to
        ? new Date(configuration.rate_effective_to)
        : null;
      if (requestedServiceLines.some((/** @type {{proposedDeliveryAt: string}} */ line) => {
        const deliveryAt = new Date(line.proposedDeliveryAt);
        return (effectiveFrom && deliveryAt < effectiveFrom)
          || (effectiveTo && deliveryAt >= effectiveTo);
      })) {
        throw failure(409, "MBT_FRONTDESK_RATE_NOT_EFFECTIVE", "The selected rate version is not effective for the proposed delivery time.");
      }

      const selectedBinTypes = await query(
        `SELECT bin_type_id::text, type_code, display_name, nominal_yards::int, active
           FROM mbt_bin_types
          WHERE bin_type_id = ANY($1::uuid[])`,
        [[...new Set(requestedServiceLines.map((/** @type {{binTypeId: string}} */ line) => line.binTypeId))]]
      );
      if (selectedBinTypes.rowCount !== new Set(requestedServiceLines.map((/** @type {{binTypeId: string}} */ line) => line.binTypeId)).size
          || selectedBinTypes.rows.some((/** @type {any} */ row) => !row.active)) {
        throw failure(409, "MBT_FRONTDESK_BIN_TYPE_NOT_ACTIVE", "Every requested bin type must be active for local service.");
      }
      const binTypeById = new Map(selectedBinTypes.rows.map((/** @type {any} */ row) => [String(row.bin_type_id), row]));
      const surchargeResult = requestedSurcharges.length
        ? await query(
          `SELECT item_code, display_name
             FROM mbt_local_item_settings
            WHERE item_code = ANY($1::text[])
              AND item_type = 'surcharge'
              AND active`,
          [requestedSurcharges.map(({ itemCode }) => itemCode)]
        )
        : { rowCount: 0, rows: [] };
      if (surchargeResult.rowCount !== requestedSurcharges.length) {
        throw failure(409, "MBT_FRONTDESK_SURCHARGE_NOT_ACTIVE", "Every selected surcharge item must still be active.");
      }
      const surchargeByCode = new Map(surchargeResult.rows.map(
        (/** @type {Record<string, any>} */ row) => [String(row.item_code), row]
      ));
      const surchargeLines = requestedSurcharges.map((surcharge) => ({
        code: `manual_surcharge_${surcharge.itemCode.toLowerCase()}`,
        label: String(surchargeByCode.get(surcharge.itemCode)?.display_name || surcharge.itemCode),
        itemCode: surcharge.itemCode,
        amountMinor: surcharge.amountMinor,
        taxable: true,
        manual: true
      }));

      const canonicalCustomer = customerSnapshot(configuration);
      /** @type {Array<Record<string, any>>} */
      const distanceEvidence = [];
      for (const line of serviceLinesWithSites) {
        const raw = jsonObject(await resolveDistance({
          customer: canonicalCustomer,
          site: line.siteSnapshot,
          serviceCode,
          binTypeId: line.binTypeId,
          originYardCode: pricingOriginYardCode,
          pricingOriginYardCode,
          proposedDeliveryAt: line.proposedDeliveryAt
        }), `Service line ${line.lineNumber} distance evidence`);
        const routeHash = requiredText(raw.routeHash, `Service line ${line.lineNumber} route hash`);
        if (!/^[0-9a-f]{64}$/u.test(routeHash)) {
          throw failure(422, "MBT_FRONTDESK_DISTANCE_INVALID", "Distance route hash is invalid.");
        }
        distanceEvidence.push({
          distanceSnapshotId: crypto.randomUUID(),
          provider: requiredText(raw.provider, `Service line ${line.lineNumber} distance provider`),
          providerMetres: safeNonnegativeInteger(raw.providerMetres, `Service line ${line.lineNumber} provider metres`),
          routeHash,
          originSnapshot: jsonObject(raw.originSnapshot, `Service line ${line.lineNumber} distance origin snapshot`),
          destinationSnapshot: jsonObject(raw.destinationSnapshot, `Service line ${line.lineNumber} distance destination snapshot`),
          routeSnapshot: jsonObject(raw.routeSnapshot || {}, `Service line ${line.lineNumber} distance route snapshot`)
        });
      }

      if (fixedChargeMode) {
        const line = requiredArrayEntry(serviceLinesWithSites, 0, "Fixed-price physical-bin line");
        const selectedBin = binTypeById.get(line.binTypeId);
        if (!selectedBin) {
          throw failure(422, "MBT_FRONTDESK_CONFIGURATION_INVALID", "The fixed-price bin configuration is missing.");
        }
        return createFixedPriceInitialQuoteMutation({
          actor,
          customerNetsuiteId,
          rateCardVersionId,
          serviceTemplateVersionId,
          serviceCode,
          deliveryItemCode,
          orderFrom150,
          paymentMethod: input.paymentMethod,
          billingAddressText,
          serviceAddressText,
          contractTelephone,
          aggregateLines,
          reason,
          configuration,
          configuredSubsidiaryId,
          canonicalCustomer,
          serviceLine: line,
          selectedBin,
          distance: requiredArrayEntry(distanceEvidence, 0, "Fixed-price distance evidence")
        });
      }

      /** @type {Array<Record<string, any>>} */
      const physicalRates = [];
      for (const [index, line] of serviceLinesWithSites.entries()) {
        physicalRates.push(await quotePhysicalBinRate({
          binItemCode: line.binItemCode,
          deliveryItemCode,
          dumpItemCode: line.dumpItemCode,
          estimatedWeightKg: line.estimatedWeightKg,
          serviceCode,
          binTypeId: line.binTypeId,
          providerMetres: requiredArrayEntry(distanceEvidence, index, "Physical-bin distance evidence").providerMetres,
          originYardCode: pricingOriginYardCode,
          deliveryAt: line.proposedDeliveryAt,
          expectedCurrency: String(configuration.rate_currency)
        }));
      }
      const primaryRate = physicalRates[0];
      if (!primaryRate) {
        throw failure(422, "MBT_FRONTDESK_CONFIGURATION_INVALID", "The quote has no physical-bin rate evidence.");
      }
      const currency = primaryRate.currency;
      /** @type {Array<Record<string, any>>} */
      const taxPolicies = [];
      for (const line of serviceLinesWithSites) {
        const taxPolicy = jsonObject(await resolveTaxPolicy({
          customer: canonicalCustomer,
          site: line.siteSnapshot,
          serviceCode,
          proposedDeliveryAt: line.proposedDeliveryAt,
          currency
        }), "Tax policy");
        taxPolicies.push({
          code: requiredText(taxPolicy.code, "Tax code"),
          basisPoints: safeNonnegativeInteger(taxPolicy.basisPoints, "Tax basis points"),
          label: String(taxPolicy.label || taxPolicy.code)
        });
      }
      /** @type {Array<Record<string, any>>} */
      const serviceLinePricing = serviceLinesWithSites.map((line, index) => {
        const selectedBin = binTypeById.get(line.binTypeId);
        const rate = requiredArrayEntry(physicalRates, index, "Physical-bin rate evidence");
        const taxPolicy = requiredArrayEntry(taxPolicies, index, "Physical-bin tax evidence");
        const distance = requiredArrayEntry(distanceEvidence, index, "Physical-bin distance evidence");
        const lineItems = [
          ...rate.lines.map((/** @type {Record<string, any>} */ lineItem) => ({ ...lineItem })),
          ...(index === 0 ? surchargeLines.map((lineItem) => ({ ...lineItem })) : [])
        ];
        const subtotalMinor = lineItems.reduce((total, lineItem) => total + lineItem.amountMinor, 0);
        const taxableSubtotalMinor = lineItems.filter((lineItem) => lineItem.taxable)
          .reduce((total, lineItem) => total + lineItem.amountMinor, 0);
        const taxMinor = percentageAmount(taxableSubtotalMinor, taxPolicy.basisPoints);
        const totalMinor = subtotalMinor + taxMinor;
        if (!Number.isSafeInteger(totalMinor)) {
          throw failure(422, "MBT_FRONTDESK_CONFIGURATION_INVALID", "The configured quote total exceeds safe integer limits.");
        }
        return {
          schemaVersion: "mbt-frontdesk-service-line-pricing-v1",
          lineNumber: line.lineNumber,
          binItemCode: line.binItemCode,
          binTypeId: line.binTypeId,
          deliveryItemCode,
          pricingOriginYardCode,
          dumpItemCode: line.dumpItemCode,
          materialId: rate.materialId,
          estimatedWeightKg: line.estimatedWeightKg,
          estimatedTonnes: line.estimatedTonnes,
          siteProfileId: line.siteProfileId,
          siteSnapshot: line.siteSnapshot,
          binTypeCode: String(selectedBin?.type_code || ""),
          binTypeDisplayName: String(selectedBin?.display_name || ""),
          proposedDeliveryAt: line.proposedDeliveryAt,
          proposedReturnAt: line.proposedReturnAt,
          distanceSnapshotId: distance.distanceSnapshotId,
          distance: {
            provider: distance.provider,
            providerMetres: distance.providerMetres,
            routeHash: distance.routeHash,
            originSnapshot: distance.originSnapshot,
            destinationSnapshot: distance.destinationSnapshot,
            routeSnapshot: distance.routeSnapshot
          },
          rateDistanceBandId: rate.rateDistanceBandId,
          subtotalMinor,
          taxableSubtotalMinor,
          taxMinor,
          totalMinor,
          tax: taxPolicy,
          lines: lineItems
        };
      });
      const subtotalMinor = serviceLinePricing.reduce((total, line) => total + line.subtotalMinor, 0);
      const taxableSubtotalMinor = serviceLinePricing.reduce((total, line) => total + line.taxableSubtotalMinor, 0);
      const taxMinor = serviceLinePricing.reduce((total, line) => total + line.taxMinor, 0);
      const totalMinor = serviceLinePricing.reduce((total, line) => total + line.totalMinor, 0);
      if (!Number.isSafeInteger(totalMinor)) {
        throw failure(422, "MBT_FRONTDESK_CONFIGURATION_INVALID", "The configured quote total exceeds safe integer limits.");
      }

      const lineDeposits = [];
      for (const line of serviceLinePricing) {
        lineDeposits.push(await quotePhysicalBinDeposit({
          rateCardVersionId,
          serviceCode,
          binTypeId: line.binTypeId,
          currency,
          totalMinor: line.totalMinor
        }));
      }
      const depositRequiredMinor = lineDeposits.reduce((total, line) => total + line.depositRequiredMinor, 0);
      const depositRuleId = lineDeposits[0]?.depositRuleId || null;
      for (const [index, line] of serviceLinePricing.entries()) {
        const deposit = requiredArrayEntry(lineDeposits, index, "Physical-bin deposit evidence");
        line.depositRequiredMinor = deposit.depositRequiredMinor;
        line.depositRuleId = deposit.depositRuleId;
      }

      const quoteId = crypto.randomUUID();
      const quoteNumber = publicNumber("MBT-Q", quoteId);
      const primaryTax = requiredArrayEntry(taxPolicies, 0, "Primary tax evidence");
      const primaryDistance = requiredArrayEntry(distanceEvidence, 0, "Primary distance evidence");
      const primarySite = requiredArrayEntry(serviceLinesWithSites, 0, "Primary service site");
      const taxSnapshot = {
        code: primaryTax.code,
        label: primaryTax.label,
        basisPoints: primaryTax.basisPoints,
        taxableSubtotalMinor,
        amountMinor: taxMinor
      };
      const pricingSnapshot = {
        currency,
        distanceMetres: primaryDistance.providerMetres,
        subtotalMinor,
        taxMinor,
        totalMinor,
        lines: serviceLinesWithSites.length === 1
          ? requiredArrayEntry(serviceLinePricing, 0, "Primary service-line pricing").lines
          : serviceLinePricing.flatMap((line) => line.lines.map((/** @type {any} */ lineItem) => ({
            ...lineItem,
            code: `line_${line.lineNumber}_${lineItem.code}`,
            label: `Bin ${line.lineNumber} · ${lineItem.label}`
          }))),
        serviceLines: serviceLinePricing,
        tax: taxSnapshot,
        serviceCode,
        deliveryItemCode,
        pricingOriginYardCode,
        surcharges: requestedSurcharges,
        serviceTemplateVersionId,
        serviceTemplateCode: String(configuration.template_code),
        serviceTemplateDisplayName: String(configuration.template_display_name),
        rateCardVersionId,
        configuredSubsidiaryId,
        rateCardCode: String(configuration.rate_card_code),
        rateCardDisplayName: String(configuration.rate_display_name),
        binTypeId,
        binTypeCode: String(configuration.bin_type_code),
        binTypeDisplayName: String(configuration.bin_type_display_name),
        rentalCalendarDays: Number(configuration.default_rental_calendar_days),
        billingOwnership: String(configuration.billing_ownership)
      };
      for (const [index, distance] of distanceEvidence.entries()) {
        const rate = requiredArrayEntry(physicalRates, index, "Physical-bin rate evidence");
        await query(
          `INSERT INTO mbt_distance_snapshots (
             distance_snapshot_id, subject_type, subject_id,
             rate_card_version_id, rate_distance_band_id,
             provider, provider_metres, route_hash,
             origin_snapshot, destination_snapshot, route_snapshot,
             calculated_amount_minor, currency
           ) VALUES (
             $1::uuid, 'quote', $2::uuid, $3::uuid, $4::uuid,
             $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12
           )`,
          [
            distance.distanceSnapshotId,
            quoteId,
            rate.distanceRateCardVersionId,
            rate.rateDistanceBandId,
            distance.provider,
            distance.providerMetres,
            distance.routeHash,
            JSON.stringify(distance.originSnapshot),
            JSON.stringify(distance.destinationSnapshot),
            JSON.stringify({ ...distance.routeSnapshot, physicalBinLineNumber: index + 1 }),
            rate.lines.find((/** @type {any} */ line) => line.rateDistanceBandId)?.amountMinor || 0,
            currency
          ]
        );
      }
      const inserted = await query(
        `INSERT INTO mbt_quotes (
           quote_id, quote_number, customer_netsuite_id,
           customer_site_profile_id, service_template_version_id,
           rate_card_version_id, bin_type_id, distance_snapshot_id,
           deposit_rule_id, status, proposed_delivery_at,
           proposed_return_at, customer_snapshot, site_snapshot,
           pricing_snapshot, deposit_required_minor, currency,
           created_by, updated_by
         ) VALUES (
           $1::uuid, $2, $3::bigint, $4::uuid, $5::uuid,
           $6::uuid, $7::uuid, $8::uuid, $9::uuid, 'draft',
           $10::timestamptz, $11::timestamptz, $12::jsonb,
           $13::jsonb, $14::jsonb, $15, $16, $17, $17
         )
         RETURNING *`,
        [
          quoteId,
          quoteNumber,
          customerNetsuiteId,
          primarySite.siteProfileId,
          serviceTemplateVersionId,
          rateCardVersionId,
          binTypeId,
          primaryDistance.distanceSnapshotId,
          depositRuleId,
          iso(proposedDeliveryAt),
          iso(proposedReturnAt),
          JSON.stringify(canonicalCustomer),
          JSON.stringify(primarySite.siteSnapshot),
          JSON.stringify(pricingSnapshot),
          depositRequiredMinor,
          currency,
          String(actor.operatorId)
        ]
      );
      const quote = publicQuote({ ...inserted.rows[0], bin_type_code: configuration.bin_type_code });
      return {
        status: 201,
        body: { schemaVersion: "mbt-frontdesk-quote-v1", quote },
        audit: {
          action: "mbt.frontdesk.quote.created",
          entityType: "mbt_quote",
          entityId: quoteId,
          beforeState: { quoteId, exists: false },
          afterState: quote,
          reason,
          revisionBefore: 1,
          revisionAfter: 1,
          source: "frontdesk_local"
        }
      };
    }
  });
}

/**
 * @param {Record<string, unknown>} input
 */
export async function issueFrontdeskQuote(input) {
  const actor = /** @type {any} */ (input.actor);
  assertFrontdeskActor(actor);
  const quoteId = requiredUuid(input.quoteId, "Quote ID");
  const expectedRevision = positiveRevision(input.expectedRevision);
  const validUntil = timestamp(input.validUntil, "Quote validity end");
  const reason = requiredText(input.reason, "Audit reason");
  const payload = { quoteId, expectedRevision, validUntil: iso(validUntil), reason };
  return executeMbtCommand({
    actor,
    commandName: "mbt.frontdesk.quote.issue",
    idempotencyKey: requiredText(input.idempotencyKey, "Idempotency key"),
    payload,
    correlationId: requiredText(input.correlationId, "Correlation ID"),
    requestId: requiredText(input.requestId, "Request ID"),
    mutation: async () => {
      const beforeRow = await selectedQuote(quoteId);
      const before = publicQuote(beforeRow);
      if (before.status !== "draft") {
        throw failure(409, "MBT_FRONTDESK_QUOTE_STATE_CONFLICT", "Only a draft quote can be issued.");
      }
      if (before.revision !== expectedRevision) {
        throw failure(409, "MBT_STALE_REVISION", "The quote changed. Refresh and try again.");
      }
      if (validUntil <= new Date()) {
        throw failure(400, "MBT_FRONTDESK_INPUT_INVALID", "Quote validity must end in the future.");
      }
      const updated = await query(
        `UPDATE mbt_quotes
            SET status = 'issued', valid_until = $2::timestamptz,
                issued_at = now(), revision = revision + 1,
                updated_by = $3, updated_at = now()
          WHERE quote_id = $1::uuid
          RETURNING *`,
        [quoteId, iso(validUntil), String(actor.operatorId)]
      );
      const after = publicQuote({ ...updated.rows[0], bin_type_code: before.binTypeCode });
      return {
        status: 200,
        body: { schemaVersion: "mbt-frontdesk-quote-v1", quote: after },
        audit: {
          action: "mbt.frontdesk.quote.issued",
          entityType: "mbt_quote",
          entityId: quoteId,
          beforeState: before,
          afterState: after,
          reason,
          revisionBefore: before.revision,
          revisionAfter: after.revision,
          source: "frontdesk_local"
        }
      };
    }
  });
}

/**
 * @param {Record<string, unknown>} input
 */
export async function acceptFrontdeskQuote(input) {
  const actor = /** @type {any} */ (input.actor);
  assertFrontdeskActor(actor);
  const quoteId = requiredUuid(input.quoteId, "Quote ID");
  const expectedRevision = positiveRevision(input.expectedRevision);
  const acceptedAt = timestamp(input.acceptedAt, "Quote acceptance time");
  const reason = requiredText(input.reason, "Audit reason");
  const payload = { quoteId, expectedRevision, acceptedAt: iso(acceptedAt), reason };
  return executeMbtCommand({
    actor,
    commandName: "mbt.frontdesk.quote.accept",
    idempotencyKey: requiredText(input.idempotencyKey, "Idempotency key"),
    payload,
    correlationId: requiredText(input.correlationId, "Correlation ID"),
    requestId: requiredText(input.requestId, "Request ID"),
    mutation: async () => {
      const beforeRow = await selectedQuote(quoteId);
      const before = publicQuote(beforeRow);
      if (before.status !== "issued") {
        throw failure(409, "MBT_FRONTDESK_QUOTE_STATE_CONFLICT", "Only an issued quote can be accepted.");
      }
      if (before.revision !== expectedRevision) {
        throw failure(409, "MBT_STALE_REVISION", "The quote changed. Refresh and try again.");
      }
      if (beforeRow.valid_until && acceptedAt >= new Date(beforeRow.valid_until)) {
        throw failure(409, "MBT_FRONTDESK_QUOTE_EXPIRED", "The quote acceptance is after its validity window.");
      }
      const updated = await query(
        `UPDATE mbt_quotes
            SET status = 'accepted', accepted_at = $2::timestamptz,
                revision = revision + 1, updated_by = $3, updated_at = now()
          WHERE quote_id = $1::uuid
          RETURNING *`,
        [quoteId, iso(acceptedAt), String(actor.operatorId)]
      );
      const after = publicQuote({ ...updated.rows[0], bin_type_code: before.binTypeCode });
      return {
        status: 200,
        body: { schemaVersion: "mbt-frontdesk-quote-v1", quote: after },
        audit: {
          action: "mbt.frontdesk.quote.accepted",
          entityType: "mbt_quote",
          entityId: quoteId,
          beforeState: before,
          afterState: after,
          reason,
          revisionBefore: before.revision,
          revisionAfter: after.revision,
          source: "frontdesk_local"
        }
      };
    }
  });
}

/**
 * @param {object} input
 * @param {string} input.visitId
 * @param {string} input.contractId
 * @param {number} input.visitNumber
 * @param {string} input.visitReference
 * @param {string} input.templateVersionId
 * @param {string} input.serviceAction
 * @param {string} input.status
 * @param {string} input.siteProfileId
 * @param {string} input.binTypeId
 * @param {string | null} [input.materialId]
 * @param {string | null} [input.serviceLineId]
 * @param {string | null} input.predecessorVisitId
 * @param {Date} input.scheduledStartAt
 * @param {Date} input.scheduledEndAt
 * @param {Record<string, unknown>} input.customer
 * @param {Record<string, unknown>} input.site
 * @param {Record<string, unknown>} input.service
 * @param {string} input.billingOwnership
 * @param {string} input.actorId
 */
async function insertServiceVisit(input) {
  const inserted = await query(
    `INSERT INTO mbt_service_visits (
       service_visit_id, contract_id, visit_number, visit_reference,
       service_template_version_id, service_action, status,
       customer_site_profile_id, bin_type_id, material_id, service_line_id, predecessor_visit_id,
       scheduled_start_at, scheduled_end_at,
       customer_snapshot, site_snapshot, service_snapshot,
       billing_ownership, created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, $3, $4, $5::uuid, $6, $7,
       $8::uuid, $9::uuid, $10::uuid, $11::uuid, $12::uuid, $13::timestamptz,
       $14::timestamptz, $15::jsonb, $16::jsonb, $17::jsonb,
       $18, $19, $19
     )
     RETURNING *`,
    [
      input.visitId,
      input.contractId,
      input.visitNumber,
      input.visitReference,
      input.templateVersionId,
      input.serviceAction,
      input.status,
      input.siteProfileId,
      input.binTypeId,
      input.materialId || null,
      input.serviceLineId || null,
      input.predecessorVisitId,
      iso(input.scheduledStartAt),
      iso(input.scheduledEndAt),
      JSON.stringify(input.customer),
      JSON.stringify(input.site),
      JSON.stringify(input.service),
      input.billingOwnership,
      input.actorId
    ]
  );
  return inserted.rows[0];
}

/** @param {unknown} value @param {string} actionCode */
function dispatchStopKind(value, actionCode) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["pickup", "drop", "travel"].includes(normalized)) {return normalized;}
  if (/^(collect|pickup)/.test(actionCode)) {return "pickup";}
  if (/^(deliver|drop|return)/.test(actionCode)) {return "drop";}
  return "travel";
}

/**
 * Read the immutable route inputs referenced by the accepted quote. Conversion
 * deliberately fails closed if its origin is no longer an active shared yard
 * or its accepted template version cannot be materialized.
 * @param {Record<string, any>} quoteRow
 */
async function conversionRouteInputs(quoteRow) {
  const template = await query(
    `SELECT template_version_id::text, revision::int
       FROM mbt_service_template_versions
      WHERE template_version_id = $1 AND status = 'active'`,
    [quoteRow.service_template_version_id]
  );
  const templateSteps = await query(
    `SELECT template_step_id::text, sequence_number::int, action_code,
            display_name, stop_kind, location_role, required,
            required_asset_status_before, required_asset_status_after,
            completion_blocking
       FROM mbt_service_template_steps
      WHERE template_version_id = $1
      ORDER BY sequence_number, template_step_id`,
    [quoteRow.service_template_version_id]
  );
  const templateEvidence = await query(
    `SELECT evidence_requirement_id::text, template_step_id::text,
            evidence_code, evidence_type, minimum_count::int, required
       FROM mbt_service_template_evidence_requirements
      WHERE template_version_id = $1
      ORDER BY template_step_id NULLS FIRST, evidence_code,
               evidence_requirement_id`,
    [quoteRow.service_template_version_id]
  );
  const distance = await query(
    `SELECT *
       FROM mbt_distance_snapshots
      WHERE distance_snapshot_id = $1 AND subject_type = 'quote'`,
    [quoteRow.distance_snapshot_id]
  );
  if (!template.rowCount || !distance.rowCount) {
    throw failure(422, "MBT_FRONTDESK_CONFIGURATION_INVALID", "The accepted quote route configuration is unavailable.");
  }
  const origin = jsonObject(distance.rows[0].origin_snapshot, "Quote distance origin snapshot");
  if (String(origin.kind || "") !== "yard") {
    throw failure(422, "MBT_FRONTDESK_CONFIGURATION_INVALID", "The accepted delivery route must start at a shared yard.");
  }
  const yardCode = requiredText(origin.yardCode, "Quote origin yard code");
  const yard = await query(
    `SELECT yard_id::text, yard_code, dispatch_location_id::int
       FROM mbt_yards
      WHERE yard_code = $1 AND active`,
    [yardCode]
  );
  if (!yard.rowCount) {
    throw failure(422, "MBT_FRONTDESK_CONFIGURATION_INVALID", "The accepted quote origin yard is unavailable.");
  }
  return {
    templateVersionId: String(template.rows[0].template_version_id),
    templateRevision: Number(template.rows[0].revision),
    templateSteps: /** @type {Array<Record<string, any>>} */ (templateSteps.rows),
    templateEvidence: /** @type {Array<Record<string, any>>} */ (templateEvidence.rows),
    distance: /** @type {Record<string, any>} */ (distance.rows[0]),
    yard: {
      yardId: String(yard.rows[0].yard_id),
      yardCode: String(yard.rows[0].yard_code),
      dispatchLocationId: Number(yard.rows[0].dispatch_location_id)
    }
  };
}

/**
 * @param {object} input
 * @param {string} input.visitReference
 * @param {string} input.siteProfileId
 * @param {{yardId: string, yardCode: string}} input.yard
 * @param {Array<Record<string, any>>} input.templateSteps
 */
function deliveryRoute(input) {
  const implicit = {
    stopId: `${input.visitReference}-S1`,
    sequence: 1,
    actionCode: "collect_empty_bin",
    stopKind: "pickup",
    locationRole: "origin_yard",
    yardId: input.yard.yardId,
    yardCode: input.yard.yardCode,
    siteProfileId: null,
    assetId: null
  };
  const configured = input.templateSteps.map((step, index) => {
    const locationRole = String(step.location_role);
    const yardLocated = locationRole.includes("yard");
    return {
      stopId: `${input.visitReference}-S${index + 2}`,
      sequence: index + 2,
      actionCode: String(step.action_code),
      stopKind: dispatchStopKind(step.stop_kind, String(step.action_code)),
      locationRole,
      yardId: yardLocated ? input.yard.yardId : null,
      yardCode: yardLocated ? input.yard.yardCode : null,
      siteProfileId: yardLocated ? null : input.siteProfileId,
      assetId: null
    };
  });
  return [implicit, ...configured];
}

/**
 * Freeze visit-owned steps and evidence so later template edits cannot change
 * execution. Synthetic route-boundary steps intentionally have no template
 * lineage; configured delivery steps retain exact template IDs.
 * @param {object} input
 * @param {string} input.visitId
 * @param {Array<Record<string, any>>} input.steps
 * @param {Array<Record<string, any>>} [input.evidence]
 */
async function insertVisitSteps(input) {
  const visitStepByTemplate = new Map();
  for (const step of input.steps) {
    const visitStepId = crypto.randomUUID();
    await query(
      `INSERT INTO mbt_visit_steps (
         visit_step_id, service_visit_id, template_step_id,
         sequence_number, action_code, display_name, location_role,
         required, completion_blocking
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        visitStepId, input.visitId, step.templateStepId || null,
        step.sequence, step.actionCode, step.displayName, step.locationRole,
        step.required !== false, step.completionBlocking !== false
      ]
    );
    if (step.templateStepId) {visitStepByTemplate.set(String(step.templateStepId), visitStepId);}
  }
  for (const requirement of input.evidence || []) {
    const visitStepId = requirement.template_step_id
      ? visitStepByTemplate.get(String(requirement.template_step_id)) || null
      : null;
    if (requirement.template_step_id && !visitStepId) {
      throw failure(422, "MBT_FRONTDESK_CONFIGURATION_INVALID", "Template evidence references an unavailable delivery step.");
    }
    await query(
      `INSERT INTO mbt_visit_evidence_requirements (
         visit_evidence_requirement_id, service_visit_id, visit_step_id,
         template_evidence_requirement_id, evidence_code, evidence_type,
         minimum_count, required
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        crypto.randomUUID(), input.visitId, visitStepId,
        requirement.evidence_requirement_id, requirement.evidence_code,
        requirement.evidence_type, requirement.minimum_count,
        requirement.required !== false
      ]
    );
  }
}

/** @param {Record<string, any>} quoteDistance @param {string} visitId */
async function copyQuoteDistanceToVisit(quoteDistance, visitId) {
  const visitDistanceId = crypto.randomUUID();
  await query(
    `INSERT INTO mbt_distance_snapshots (
       distance_snapshot_id, subject_type, subject_id,
       rate_card_version_id, rate_distance_band_id,
       provider, provider_metres, route_hash,
       origin_snapshot, destination_snapshot, route_snapshot,
       calculated_amount_minor, currency, override_metres,
       override_amount_minor, override_reason, overridden_by,
       overridden_at, calculated_at
     ) VALUES (
       $1, 'visit', $2, $3, $4, $5, $6, $7,
       $8::jsonb, $9::jsonb, $10::jsonb, $11, $12, $13,
       $14, $15, $16, $17, $18
     )`,
    [
      visitDistanceId, visitId, quoteDistance.rate_card_version_id,
      quoteDistance.rate_distance_band_id, quoteDistance.provider,
      quoteDistance.provider_metres, quoteDistance.route_hash,
      JSON.stringify(quoteDistance.origin_snapshot),
      JSON.stringify(quoteDistance.destination_snapshot),
      JSON.stringify({
        ...jsonObject(quoteDistance.route_snapshot, "Quote route snapshot"),
        sourceQuoteDistanceSnapshotId: String(quoteDistance.distance_snapshot_id)
      }),
      quoteDistance.calculated_amount_minor, quoteDistance.currency,
      quoteDistance.override_metres, quoteDistance.override_amount_minor,
      quoteDistance.override_reason, quoteDistance.overridden_by,
      quoteDistance.overridden_at, quoteDistance.calculated_at
    ]
  );
  return visitDistanceId;
}

/** @param {Record<string, any>} quoteDistance @param {Record<string, unknown> | null} distance */
function physicalLineRouteEvidence(quoteDistance, distance) {
  if (!distance) {
    return {
      provider: quoteDistance.provider,
      providerMetres: quoteDistance.provider_metres,
      routeHash: quoteDistance.route_hash,
      originSnapshot: quoteDistance.origin_snapshot,
      destinationSnapshot: quoteDistance.destination_snapshot,
      routeSnapshot: quoteDistance.route_snapshot
    };
  }
  return {
    provider: requiredText(distance.provider, "Physical-bin distance provider"),
    providerMetres: safeNonnegativeInteger(distance.providerMetres, "Physical-bin provider metres"),
    routeHash: requiredText(distance.routeHash, "Physical-bin route hash"),
    originSnapshot: jsonObject(distance.originSnapshot, "Physical-bin distance origin"),
    destinationSnapshot: jsonObject(distance.destinationSnapshot, "Physical-bin distance destination"),
    routeSnapshot: jsonObject(distance.routeSnapshot || {}, "Physical-bin distance route")
  };
}

/**
 * A quote retains one route proof, while every physical-bin delivery gets the
 * exact site, route, rate-band, and transport amount that priced that line.
 *
 * @param {Record<string, any>} quoteDistance
 * @param {Record<string, any>} linePricing
 */
function lineDistanceEvidence(quoteDistance, linePricing) {
  const rateCardVersionId = requiredUuid(
    linePricing.rateCardVersionId ?? quoteDistance.rate_card_version_id,
    "Physical-bin rate card version ID"
  );
  const rateDistanceBandId = requiredUuid(
    linePricing.rateDistanceBandId ?? quoteDistance.rate_distance_band_id,
    "Physical-bin distance rate band ID"
  );
  const transport = Array.isArray(linePricing.lines)
    ? linePricing.lines.find((/** @type {any} */ line) => line.rateDistanceBandId)
    : null;
  const distance = linePricing.distance && typeof linePricing.distance === "object"
    ? jsonObject(linePricing.distance, "Physical-bin distance evidence")
    : null;
  const route = physicalLineRouteEvidence(quoteDistance, distance);
  return {
    ...quoteDistance,
    rate_card_version_id: rateCardVersionId,
    distance_snapshot_id: linePricing.distanceSnapshotId || quoteDistance.distance_snapshot_id,
    rate_distance_band_id: rateDistanceBandId,
    provider: route.provider,
    provider_metres: route.providerMetres,
    route_hash: route.routeHash,
    origin_snapshot: route.originSnapshot,
    destination_snapshot: route.destinationSnapshot,
    calculated_amount_minor: transport
      ? safeNonnegativeInteger(transport.amountMinor, "Physical-bin transport amount")
      : safeNonnegativeInteger(quoteDistance.calculated_amount_minor, "Quote transport amount"),
    route_snapshot: {
      ...jsonObject(route.routeSnapshot, "Quote route snapshot"),
      physicalBinLineNumber: positiveRevision(linePricing.lineNumber, "Physical-bin line number"),
      physicalBinTypeId: requiredUuid(linePricing.binTypeId, "Physical-bin type ID"),
      rateDistanceBandId
    }
  };
}

/** @param {unknown} value @param {number} index @param {Record<string, any>} quoteRow */
// eslint-disable-next-line complexity -- Conversion validates both legacy single-line and current item-owned evidence.
function storedQuoteServiceLine(value, index, quoteRow) {
    const line = jsonObject(value, `Quote service line ${index + 1}`);
    const proposedDeliveryAt = timestamp(line.proposedDeliveryAt, `Quote service line ${index + 1} delivery time`);
    const proposedReturnAt = timestamp(line.proposedReturnAt, `Quote service line ${index + 1} return time`);
    if (proposedReturnAt <= proposedDeliveryAt) {
      throw failure(422, "MBT_FRONTDESK_QUOTE_INCOMPLETE", "A quoted service line has an invalid return schedule.");
    }
    const fixedPriceLine = line.pricingModel === "fixed_bin_customer_charge";
    const hasItemEstimate = !fixedPriceLine && [line.binItemCode, line.dumpItemCode, line.materialId, line.estimatedWeightKg]
      .some((entry) => entry !== null && entry !== undefined && entry !== "");
    const binItemCode = fixedPriceLine
      ? localItemCode(line.binItemCode, `Quote service line ${index + 1} bin item`)
      : hasItemEstimate
      ? localItemCode(line.binItemCode, `Quote service line ${index + 1} bin item`)
      : null;
    const dumpItemCode = fixedPriceLine
      ? null
      : hasItemEstimate
      ? localItemCode(line.dumpItemCode, `Quote service line ${index + 1} dump item`)
      : null;
    const materialId = fixedPriceLine
      ? null
      : hasItemEstimate
      ? requiredUuid(line.materialId, `Quote service line ${index + 1} material ID`)
      : null;
    const estimatedWeightKg = fixedPriceLine
      ? null
      : hasItemEstimate
      ? safeNonnegativeInteger(line.estimatedWeightKg, `Quote service line ${index + 1} estimated weight`)
      : null;
    if (hasItemEstimate && (!estimatedWeightKg || estimatedWeightKg > 100_000)) {
      throw failure(422, "MBT_FRONTDESK_QUOTE_INCOMPLETE", "A quoted service line has invalid dump estimate evidence.");
    }
    return {
      lineNumber: positiveRevision(line.lineNumber ?? index + 1, "Quote service line number"),
      binItemCode,
      binTypeId: requiredUuid(line.binTypeId, `Quote service line ${index + 1} bin type ID`),
      dumpItemCode,
      materialId,
      estimatedWeightKg,
      siteProfileId: requiredUuid(
        line.siteProfileId ?? quoteRow.customer_site_profile_id,
        `Quote service line ${index + 1} site profile ID`
      ),
      siteSnapshot: jsonObject(
        line.siteSnapshot ?? quoteRow.site_snapshot,
        `Quote service line ${index + 1} site snapshot`
      ),
      binTypeCode: optionalText(line.binTypeCode),
      proposedDeliveryAt,
      proposedReturnAt,
      pricing: {
        schemaVersion: "mbt-frontdesk-service-line-pricing-v1",
        ...line,
        lineNumber: positiveRevision(line.lineNumber ?? index + 1, "Quote service line number"),
        binItemCode,
        dumpItemCode,
        materialId,
        estimatedWeightKg,
        estimatedTonnes: estimatedWeightKg === null ? null : (estimatedWeightKg / 1000).toFixed(3),
        proposedDeliveryAt: iso(proposedDeliveryAt),
        proposedReturnAt: iso(proposedReturnAt)
      }
    };
}

/** @param {Record<string, any>} quoteRow @param {Record<string, any>} pricing */
function storedQuoteServiceLines(quoteRow, pricing) {
  const stored = Array.isArray(pricing.serviceLines) && pricing.serviceLines.length
    ? pricing.serviceLines
    : [{
      lineNumber: 1,
      binTypeId: String(quoteRow.bin_type_id),
      siteProfileId: String(quoteRow.customer_site_profile_id),
      siteSnapshot: quoteRow.site_snapshot,
      binTypeCode: String(quoteRow.bin_type_code || ""),
      proposedDeliveryAt: databaseIso(quoteRow.proposed_delivery_at),
      proposedReturnAt: databaseIso(quoteRow.proposed_return_at),
      subtotalMinor: pricing.subtotalMinor,
      taxableSubtotalMinor: pricing.taxableSubtotalMinor,
      taxMinor: pricing.taxMinor,
      totalMinor: pricing.totalMinor,
      lines: Array.isArray(pricing.lines) ? pricing.lines : []
    }];
  return stored.map((value, index) => storedQuoteServiceLine(value, index, quoteRow));
}

/** @param {Array<Record<string, any>>} serviceLines */
function firstQuotedServiceLine(serviceLines) {
  const serviceLine = serviceLines[0];
  if (!serviceLine) {
    throw failure(422, "MBT_FRONTDESK_QUOTE_INCOMPLETE", "The accepted quote has no physical-bin service lines.");
  }
  return serviceLine;
}

/** @param {boolean} multiLine @param {string} contractNumber @param {number} lineNumber */
function physicalBinReferencePrefix(multiLine, contractNumber, lineNumber) {
  return multiLine ? `${contractNumber}-L${lineNumber}` : contractNumber;
}

/**
 * Materialize one physical-bin line without changing its contract siblings.
 * Every line owns a delivery and dependent collection chain, making the ready
 * delivery leg safe for the existing Dispatch read model to consume.
 *
 * @param {object} input
 * @param {string} input.contractId
 * @param {string} input.contractNumber
 * @param {string | null} input.quoteId
 * @param {string | null} [input.sourceChargeRequestId]
 * @param {Record<string, any>} input.quoteRow
 * @param {Record<string, any>} input.line
 * @param {number} input.visitNumberStart
 * @param {boolean} input.multiLine
 * @param {Record<string, any>} input.routeInputs
 * @param {Record<string, any>} input.customer
 * @param {Record<string, any>} input.site
 * @param {string} input.billingOwnership
 * @param {string} input.actorId
 */
async function materializeContractServiceLine(input) {
  const serviceLineId = crypto.randomUUID();
  const deliveryVisitId = crypto.randomUUID();
  const returnVisitId = crypto.randomUUID();
  const referencePrefix = physicalBinReferencePrefix(
    input.multiLine,
    input.contractNumber,
    input.line.lineNumber
  );
  const deliveryVisitReference = `${referencePrefix}-V1`;
  const returnVisitReference = `${referencePrefix}-V2`;
  const deliveryAt = input.line.proposedDeliveryAt;
  const returnAt = input.line.proposedReturnAt;
  const linePricing = jsonObject(input.line.pricing, "Quote service line pricing");
  const binItemCode = input.line.binItemCode || null;
  const dumpItemCode = input.line.dumpItemCode || null;
  const materialId = input.line.materialId || null;
  const estimatedWeightKg = input.line.estimatedWeightKg || null;
  const binType = await query(
    `SELECT type_code FROM mbt_bin_types WHERE bin_type_id = $1::uuid AND active`,
    [input.line.binTypeId]
  );
  if (!binType.rowCount) {
    throw failure(409, "MBT_FRONTDESK_BIN_TYPE_NOT_ACTIVE", "A quoted bin type is no longer active.");
  }
  const binTypeCode = String(binType.rows[0].type_code);
  const insertedLine = await query(
    `INSERT INTO mbt_contract_service_lines (
       service_line_id, contract_id, source_quote_id, source_charge_request_id,
       line_number, bin_type_id,
       bin_item_code, dump_item_code, material_id, estimated_weight_kg,
       customer_site_profile_id, site_snapshot, status,
       planned_delivery_at, planned_return_at, pricing_snapshot,
       customer_confirmation_status, waiver_snapshot, created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::uuid,
       $7, $8, $9::uuid, $10, $11::uuid, $12::jsonb,
       'scheduled', $13::timestamptz, $14::timestamptz, $15::jsonb,
       'not_required', '{}'::jsonb, $16, $16
     ) RETURNING *`,
    [
      serviceLineId, input.contractId, input.quoteId, input.sourceChargeRequestId || null,
      input.line.lineNumber, input.line.binTypeId, binItemCode, dumpItemCode, materialId, estimatedWeightKg,
      input.line.siteProfileId, JSON.stringify(input.line.siteSnapshot),
      iso(deliveryAt), iso(returnAt), JSON.stringify(linePricing), input.actorId
    ]
  );
  const deliveryService = {
    schemaVersion: "mbt-bin-service-snapshot-v1",
    displayName: "Initial delivery",
    serviceAction: "delivery",
    serviceCode: linePricing.serviceCode || "delivery",
    serviceLineId,
    lineNumber: input.line.lineNumber,
    serviceTemplateVersionId: String(input.quoteRow.service_template_version_id),
    templateVersionId: input.routeInputs.templateVersionId,
    templateRevision: input.routeInputs.templateRevision,
    rateCardVersionId: String(input.quoteRow.rate_card_version_id),
    binItemCode,
    binTypeId: input.line.binTypeId,
    dumpItemCode,
    materialId,
    estimatedWeightKg,
    estimatedTonnes: estimatedWeightKg ? (estimatedWeightKg / 1000).toFixed(3) : null,
    ...(linePricing.chargeRequestId ? { chargeRequestId: String(linePricing.chargeRequestId) } : {}),
    ...(linePricing.attachedAggregate ? { attachedAggregate: linePricing.attachedAggregate } : {}),
    predecessorVisitId: null,
    dependencyKind: "none",
    dependentReturnVisitId: returnVisitId,
    dependentReturnVisitRevision: 1,
    mandatoryStops: deliveryRoute({
      visitReference: deliveryVisitReference,
      siteProfileId: input.line.siteProfileId,
      yard: input.routeInputs.yard,
      templateSteps: input.routeInputs.templateSteps
    })
  };
  const returnService = {
    schemaVersion: "mbt-bin-service-snapshot-v1",
    displayName: "Return bin",
    serviceAction: "return_bin",
    serviceLineId,
    lineNumber: input.line.lineNumber,
    serviceTemplateVersionId: String(input.quoteRow.service_template_version_id),
    templateVersionId: input.routeInputs.templateVersionId,
    templateRevision: input.routeInputs.templateRevision,
    rateCardVersionId: String(input.quoteRow.rate_card_version_id),
    binItemCode,
    binTypeId: input.line.binTypeId,
    dumpItemCode,
    materialId,
    estimatedWeightKg,
    estimatedTonnes: estimatedWeightKg ? (estimatedWeightKg / 1000).toFixed(3) : null,
    predecessorVisitId: deliveryVisitId,
    dependencyKind: "predecessor_completed",
    mandatoryStops: [
      {
        stopId: `${returnVisitReference}-S1`, sequence: 1,
        actionCode: "pickup_bin", stopKind: "pickup", locationRole: "customer_site",
        yardId: null, yardCode: null,
        siteProfileId: input.line.siteProfileId, assetId: null
      },
      {
        stopId: `${returnVisitReference}-S2`, sequence: 2,
        actionCode: "return_bin", stopKind: "drop", locationRole: "return_yard",
        yardId: input.routeInputs.yard.yardId, yardCode: input.routeInputs.yard.yardCode,
        siteProfileId: null, assetId: null
      }
    ]
  };
  const deliveryRow = await insertServiceVisit({
    visitId: deliveryVisitId, contractId: input.contractId,
    visitNumber: input.visitNumberStart, visitReference: deliveryVisitReference,
    templateVersionId: String(input.quoteRow.service_template_version_id),
    serviceAction: "delivery", status: "ready",
    siteProfileId: input.line.siteProfileId,
    binTypeId: input.line.binTypeId, materialId: null, serviceLineId, predecessorVisitId: null,
    scheduledStartAt: deliveryAt, scheduledEndAt: new Date(deliveryAt.getTime() + FOUR_HOURS_MS),
    customer: input.customer, site: input.line.siteSnapshot, service: deliveryService,
    billingOwnership: input.billingOwnership, actorId: input.actorId
  });
  const returnRow = await insertServiceVisit({
    visitId: returnVisitId, contractId: input.contractId,
    visitNumber: input.visitNumberStart + 1, visitReference: returnVisitReference,
    templateVersionId: String(input.quoteRow.service_template_version_id),
    serviceAction: "return_bin", status: "tentative",
    siteProfileId: input.line.siteProfileId,
    binTypeId: input.line.binTypeId, materialId, serviceLineId, predecessorVisitId: deliveryVisitId,
    scheduledStartAt: returnAt, scheduledEndAt: new Date(returnAt.getTime() + FOUR_HOURS_MS),
    customer: input.customer, site: input.line.siteSnapshot, service: returnService,
    billingOwnership: input.billingOwnership, actorId: input.actorId
  });
  await insertVisitSteps({
    visitId: deliveryVisitId,
    steps: [
      {
        sequence: 0, actionCode: "collect_empty_bin",
        displayName: `Collect empty ${binTypeCode} bin`, locationRole: "origin_yard",
        required: true, completionBlocking: true, templateStepId: null
      },
      ...input.routeInputs.templateSteps.map((/** @type {any} */ step, /** @type {number} */ index) => ({
        sequence: index + 1, actionCode: String(step.action_code),
        displayName: String(step.display_name), locationRole: String(step.location_role),
        required: Boolean(step.required), completionBlocking: Boolean(step.completion_blocking),
        templateStepId: String(step.template_step_id)
      }))
    ],
    evidence: input.routeInputs.templateEvidence
  });
  await insertVisitSteps({
    visitId: returnVisitId,
    steps: [
      {
        sequence: 0, actionCode: "pickup_bin", displayName: `Pickup ${binTypeCode} bin`,
        locationRole: "customer_site", required: true, completionBlocking: true, templateStepId: null
      },
      {
        sequence: 1, actionCode: "return_bin", displayName: `Return ${binTypeCode} bin`,
        locationRole: "return_yard", required: true, completionBlocking: true, templateStepId: null
      }
    ]
  });
  await copyQuoteDistanceToVisit(lineDistanceEvidence(input.routeInputs.distance, linePricing), deliveryVisitId);
  return {
    serviceLine: publicServiceLine({ ...insertedLine.rows[0], bin_type_code: binTypeCode }),
    visits: [publicVisit(deliveryRow), publicVisit(returnRow)]
  };
}

/**
 * Materialize the operational side of one already-priced add-bin request.
 * This is intentionally an internal transaction participant: the immutable
 * customer-charge command owns confirmation, audit, and idempotency.
 *
 * @param {object} input
 * @param {string} input.chargeRequestId
 * @param {string} input.contractId
 * @param {number} input.expectedContractRevision
 * @param {Record<string, any>} input.calculation
 * @param {Record<string, any>} input.binRate
 * @param {Record<string, any> | null} input.attachedAggregate
 * @param {string} input.actorId
 */
/** @param {Record<string, any>} result @param {number} expectedRevision */
function pricedAddBinContract(result, expectedRevision) {
  if (!result.rowCount) {
    throw failure(404, "MBT_FRONTDESK_CONTRACT_NOT_FOUND", "The Front Desk contract was not found.");
  }
  const row = result.rows[0];
  if (Number(row.revision) !== expectedRevision
      || !["confirmed", "active", "return_due"].includes(String(row.status))) {
    throw failure(409, "MBT_FRONTDESK_PRICE_STALE", "The contract changed after this request was priced.");
  }
  if (!row.quote_id) {
    throw failure(422, "MBT_FRONTDESK_CONTRACT_INCOMPLETE", "The contract has no accepted route evidence for a new bin.");
  }
  return row;
}

/** @param {Record<string, any>} result */
function pricedAddBinSite(result) {
  if (!result.rowCount || !result.rows[0].customer_site_profile_id) {
    throw failure(422, "MBT_FRONTDESK_CONTRACT_INCOMPLETE", "The contract has no service site for the new bin.");
  }
  return result.rows[0];
}

/** @param {Array<Record<string, any>>} visits */
function pricedAddBinDeliveryVisit(visits) {
  const deliveryVisit = visits.find((visit) => visit.serviceAction === "delivery");
  if (!deliveryVisit) {
    throw failure(422, "MBT_FRONTDESK_CONTRACT_INCOMPLETE", "The new bin has no delivery visit.");
  }
  return deliveryVisit;
}

/** @param {Record<string, any>} input */
function pricedAddBinLinePricing(input) {
  return {
    schemaVersion: "mbt-frontdesk-priced-add-bin-v1",
    chargeRequestId: input.chargeRequestId,
    lineNumber: input.lineNumber,
    binItemCode: input.binItemCode,
    binTypeId: input.binTypeId,
    contentCode: String(input.calculator.incomingContentCode || ""),
    proposedDeliveryAt: iso(input.deliveryAt),
    proposedReturnAt: iso(input.returnAt),
    serviceCode: "delivery",
    rateCardVersionId: String(input.contractRow.rate_card_version_id),
    rateDistanceBandId: requiredUuid(input.itemEvidence.deliveryRateDistanceBandId, "Delivery distance rate ID"),
    distance: {
      provider: input.routeInputs.distance.provider,
      providerMetres: Number(input.calculation.distanceMetres ?? input.routeInputs.distance.provider_metres),
      routeHash: input.routeInputs.distance.route_hash,
      originSnapshot: input.routeInputs.distance.origin_snapshot,
      destinationSnapshot: input.routeInputs.distance.destination_snapshot,
      routeSnapshot: input.routeInputs.distance.route_snapshot
    },
    currency: String(input.calculation.currency || "CAD"),
    subtotalMinor: Number(input.calculation.preTaxRevenueMinor),
    taxMinor: Number(input.calculation.addedHstMinor || 0),
    totalMinor: Number(input.calculation.newRequestChargeableMinor),
    lines: Array.isArray(input.calculation.lines) ? input.calculation.lines : [],
    ...(input.attachedAggregate ? { attachedAggregate: input.attachedAggregate } : {})
  };
}

/** @param {Record<string, any>} input */
export async function materializeFrontdeskPricedAddBin(input) {
  const chargeRequestId = requiredUuid(input.chargeRequestId, "Charge request ID");
  const contractId = requiredUuid(input.contractId, "Contract ID");
  const expectedContractRevision = positiveRevision(input.expectedContractRevision, "Expected contract revision");
  const actorId = requiredText(input.actorId, "Actor operator ID");
  const calculation = jsonObject(input.calculation, "Customer charge calculation");
  const binRate = jsonObject(input.binRate, "Customer charge bin evidence");
  const calculator = jsonObject(binRate.calculator, "Customer charge bin calculator evidence");
  const schedule = jsonObject(binRate.schedule, "Customer charge schedule");
  const itemEvidence = jsonObject(binRate.itemEvidence, "Customer charge item evidence");
  const deliveryAt = timestamp(schedule.proposedDeliveryAt, "Proposed delivery time");
  const returnAt = timestamp(schedule.proposedReturnAt, "Proposed return time");
  if (returnAt <= deliveryAt) {
    throw failure(400, "MBT_FRONTDESK_INPUT_INVALID", "The return time must follow delivery.");
  }
  const contractResult = await query(
    "SELECT * FROM mbt_contracts WHERE contract_id = $1::uuid FOR UPDATE",
    [contractId]
  );
  const contractRow = pricedAddBinContract(contractResult, expectedContractRevision);
  const siteResult = await query(
    `SELECT line.customer_site_profile_id::text, line.site_snapshot,
            visit.billing_ownership
       FROM mbt_contract_service_lines line
       JOIN mbt_service_visits visit
         ON visit.service_line_id = line.service_line_id
        AND visit.service_action = 'delivery'
      WHERE line.contract_id = $1::uuid
      ORDER BY line.line_number, line.service_line_id
      LIMIT 1`,
    [contractId]
  );
  const siteRow = pricedAddBinSite(siteResult);
  const sequenceResult = await query(
    `SELECT COALESCE(max(line_number), 0)::int + 1 AS next_line_number,
            COALESCE((SELECT max(visit_number) FROM mbt_service_visits WHERE contract_id = $1::uuid), 0)::int + 1 AS next_visit_number
       FROM mbt_contract_service_lines
      WHERE contract_id = $1::uuid`,
    [contractId]
  );
  const quoteRow = await selectedQuote(String(contractRow.quote_id));
  const routeInputs = await conversionRouteInputs(quoteRow);
  const lineNumber = Number(sequenceResult.rows[0].next_line_number);
  const visitNumberStart = Number(sequenceResult.rows[0].next_visit_number);
  const binTypeId = requiredUuid(itemEvidence.incomingBinTypeId, "Incoming bin type ID");
  const binItemCode = localItemCode(itemEvidence.binItemCode, "Incoming bin item");
  const linePricing = pricedAddBinLinePricing({
    chargeRequestId, lineNumber, binItemCode, binTypeId, calculator,
    deliveryAt, returnAt, contractRow, itemEvidence, routeInputs,
    calculation, attachedAggregate: input.attachedAggregate
  });
  const materialized = await materializeContractServiceLine({
    contractId,
    contractNumber: String(contractRow.contract_number),
    quoteId: null,
    sourceChargeRequestId: chargeRequestId,
    quoteRow,
    line: {
      lineNumber,
      binItemCode,
      binTypeId,
      dumpItemCode: null,
      materialId: null,
      estimatedWeightKg: null,
      siteProfileId: String(siteRow.customer_site_profile_id),
      siteSnapshot: jsonObject(siteRow.site_snapshot, "Contract service site"),
      proposedDeliveryAt: deliveryAt,
      proposedReturnAt: returnAt,
      pricing: linePricing
    },
    visitNumberStart,
    multiLine: true,
    routeInputs,
    customer: jsonObject(contractRow.customer_snapshot, "Contract customer snapshot"),
    site: jsonObject(siteRow.site_snapshot, "Contract service site"),
    billingOwnership: requiredText(siteRow.billing_ownership, "Billing ownership"),
    actorId
  });
  const deliveryVisit = pricedAddBinDeliveryVisit(materialized.visits);
  const billingCaseId = crypto.randomUUID();
  const billing = await query(
    `INSERT INTO mbt_billing_cases (
       billing_case_id, case_type, contract_id, service_visit_id,
       customer_netsuite_id, status, currency, created_by, updated_by
     ) VALUES ($1::uuid, 'mbt_contract', $2::uuid, $3::uuid, $4::bigint,
       'open', $5, $6, $6) RETURNING *`,
    [billingCaseId, contractId, deliveryVisit.visitId, contractRow.customer_netsuite_id,
      calculation.currency || "CAD", actorId]
  );
  const updatedContract = await updateContractLineScheduleRollup(contractId, actorId);
  return {
    schemaVersion: "mbt-frontdesk-priced-add-bin-operation-v1",
    contract: publicContract(updatedContract.rows[0]),
    serviceLine: materialized.serviceLine,
    visits: materialized.visits,
    billingCase: {
      billingCaseId: String(billing.rows[0].billing_case_id),
      serviceVisitId: String(deliveryVisit.visitId),
      serviceLineId: String(materialized.serviceLine.serviceLineId),
      status: String(billing.rows[0].status),
      revision: Number(billing.rows[0].revision)
    }
  };
}

/** @param {number} physicalBinCount */
function conversionSchemaVersion(physicalBinCount) {
  return physicalBinCount > 1
    ? "mbt-frontdesk-conversion-v2"
    : "mbt-frontdesk-conversion-v1";
}

/** @param {Record<string, unknown>} pricing */
function quoteUsesLineOwnedSites(pricing) {
  return Array.isArray(pricing.serviceLines) && pricing.serviceLines.length > 0;
}

/** @param {Record<string, any>} pricing @param {string} quoteId @param {string} contractId @param {string} actorId */
async function confirmConvertedInitialCharge(pricing, quoteId, contractId, actorId) {
  if (pricing.pricingModel !== "fixed_bin_customer_charge" || !pricing.chargeRequestId) {
    return null;
  }
  const result = await query(
    `UPDATE mbt_frontdesk_charge_requests
        SET contract_id = $3::uuid, status = 'confirmed', confirmed_at = now(),
            confirmed_by = $4, revision = revision + 1,
            updated_by = $4, updated_at = now()
      WHERE charge_request_id = $1::uuid
        AND source_quote_id = $2::uuid
        AND request_kind = 'initial_bin'
        AND status = 'draft'
      RETURNING charge_request_id::text, request_number, status,
                contract_id::text, request_total_minor, due_now_minor,
                required_deposit_minor, currency, revision::int`,
    [pricing.chargeRequestId, quoteId, contractId, actorId]
  );
  if (result.rowCount !== 1) {
    throw failure(409, "MBT_FRONTDESK_PRICE_STALE", "The initial customer charge is missing or no longer draft.");
  }
  const row = result.rows[0];
  return {
    chargeRequestId: String(row.charge_request_id),
    requestNumber: String(row.request_number),
    status: String(row.status),
    contractId: String(row.contract_id),
    newRequestChargeableMinor: Number(row.request_total_minor),
    dueNowMinor: Number(row.due_now_minor),
    requiredDepositMinor: Number(row.required_deposit_minor),
    currency: String(row.currency),
    revision: Number(row.revision)
  };
}

/** @param {Function | undefined} hook @param {Record<string, unknown>} payload */
async function runFrontdeskConversionHook(hook, payload) {
  if (typeof hook === "function") {
    await hook(payload);
  }
}

/** @param {Record<string, any> | null} chargeRequest */
function convertedChargeRequestBody(chargeRequest) {
  return chargeRequest ? { chargeRequest } : {};
}

/** @param {Record<string, any> | null} chargeRequest */
function convertedChargeRequestAudit(chargeRequest) {
  return chargeRequest ? { chargeRequestId: chargeRequest.chargeRequestId } : {};
}

/**
 * @param {object} input
 * @param {Record<string, any>} input.quoteRow
 * @param {Record<string, any>} input.before
 * @param {string} input.quoteId
 * @param {Record<string, any>} input.pricing
 * @param {Record<string, any>} input.customer
 * @param {Record<string, any>} input.site
 * @param {Record<string, any>} input.tax
 * @param {number} input.rentalCalendarDays
 * @param {string} input.billingOwnership
 * @param {string} input.actorId
 * @param {string} input.reason
 * @param {{afterContractInsert?: Function, afterVisitsInsert?: Function}} input.hooks
 */
async function convertMultiLineFrontdeskQuote(input) {
  const lines = storedQuoteServiceLines(input.quoteRow, input.pricing);
  const firstLine = firstQuotedServiceLine(lines);
  const contractId = crypto.randomUUID();
  const contractNumber = publicNumber("MBT-C", contractId);
  const routeInputs = await conversionRouteInputs(input.quoteRow);
  const terms = {
    rentalCalendarDays: input.rentalCalendarDays,
    customerTerms: input.customer.terms ?? null,
    acceptedAt: input.quoteRow.accepted_at ? databaseIso(input.quoteRow.accepted_at) : null,
    physicalBinCount: lines.length
  };
  const firstDeliveryAt = new Date(Math.min(...lines.map((line) => line.proposedDeliveryAt.getTime())));
  const lastReturnAt = new Date(Math.max(...lines.map((line) => line.proposedReturnAt.getTime())));
  const insertedContract = await query(
    `INSERT INTO mbt_contracts (
       contract_id, contract_number, quote_id, customer_netsuite_id,
       customer_site_profile_id, service_template_version_id,
       rate_card_version_id, bin_type_id, deposit_rule_id,
       status, planned_delivery_at, planned_return_at,
       rental_calendar_days, customer_snapshot, site_snapshot,
       terms_snapshot, tax_snapshot, pricing_snapshot,
       deposit_required_minor, currency, confirmed_at,
       created_by, updated_by
     ) VALUES (
       $1::uuid, $2, $3::uuid, $4::bigint, $5::uuid, $6::uuid,
       $7::uuid, $8::uuid, $9::uuid, 'confirmed', $10::timestamptz,
       $11::timestamptz, $12, $13::jsonb, $14::jsonb, $15::jsonb,
       $16::jsonb, $17::jsonb, $18, $19, now(), $20, $20
     ) RETURNING *`,
    [
      contractId, contractNumber, input.quoteId,
      input.quoteRow.customer_netsuite_id, null,
      input.quoteRow.service_template_version_id, input.quoteRow.rate_card_version_id,
      firstLine.binTypeId, input.quoteRow.deposit_rule_id,
      iso(firstDeliveryAt), iso(lastReturnAt), input.rentalCalendarDays,
      JSON.stringify(input.customer), JSON.stringify({}), JSON.stringify(terms),
      JSON.stringify(input.tax), JSON.stringify(input.pricing),
      input.quoteRow.deposit_required_minor, input.quoteRow.currency, input.actorId
    ]
  );
  await runFrontdeskConversionHook(input.hooks.afterContractInsert, { contractId, quoteId: input.quoteId });
  const materialized = [];
  for (const line of lines) {
    const linePricing = /** @type {Record<string, any>} */ (line.pricing);
    materialized.push(await materializeContractServiceLine({
      contractId, contractNumber, quoteId: input.quoteId, quoteRow: input.quoteRow,
      sourceChargeRequestId: linePricing.chargeRequestId || null,
      line, visitNumberStart: ((line.lineNumber - 1) * 2) + 1, multiLine: true,
      routeInputs, customer: input.customer, site: input.site,
      billingOwnership: input.billingOwnership, actorId: input.actorId
    }));
  }
  const visits = materialized.flatMap((/** @type {any} */ entry) => entry.visits);
  const serviceLines = materialized.map((entry) => entry.serviceLine);
  const chargeRequest = await confirmConvertedInitialCharge(
    input.pricing, input.quoteId, contractId, input.actorId
  );
  const firstVisit = visits[0];
  if (!firstVisit) {
    throw failure(422, "MBT_FRONTDESK_CONTRACT_INCOMPLETE", "The local contract did not materialize a first service visit.");
  }
  await runFrontdeskConversionHook(input.hooks.afterVisitsInsert, {
    contractId,
    visits: visits.map(({ visitId }) => visitId)
  });
  const billingCases = [];
  for (const entry of materialized) {
    const deliveryVisit = entry.visits.find(({ serviceAction }) => serviceAction === "delivery");
    if (!deliveryVisit) {
      throw failure(422, "MBT_FRONTDESK_CONTRACT_INCOMPLETE", "A physical-bin line has no billing delivery visit.");
    }
    const billingCaseId = crypto.randomUUID();
    const billingCase = await query(
      `INSERT INTO mbt_billing_cases (
         billing_case_id, case_type, contract_id, service_visit_id,
         customer_netsuite_id, status, currency, created_by, updated_by
       ) VALUES ($1::uuid, 'mbt_contract', $2::uuid, $3::uuid, $4::bigint,
         'open', $5, $6, $6) RETURNING *`,
      [billingCaseId, contractId, deliveryVisit.visitId, input.quoteRow.customer_netsuite_id,
        input.quoteRow.currency, input.actorId]
    );
    billingCases.push({
      billingCaseId: String(billingCase.rows[0].billing_case_id),
      serviceVisitId: String(deliveryVisit.visitId),
      serviceLineId: String(entry.serviceLine.serviceLineId),
      caseType: String(billingCase.rows[0].case_type),
      status: String(billingCase.rows[0].status),
      revision: Number(billingCase.rows[0].revision)
    });
  }
  await query(
    `UPDATE mbt_quotes SET status = 'converted', terminal_at = now(),
       revision = revision + 1, updated_by = $2, updated_at = now()
     WHERE quote_id = $1::uuid`,
    [input.quoteId, input.actorId]
  );
  const contract = publicContract(insertedContract.rows[0]);
  const primaryBillingCase = billingCases[0];
  const body = {
    schemaVersion: conversionSchemaVersion(lines.length),
    contract, serviceLines, visits,
    billingCase: primaryBillingCase,
    billingCases,
    ...convertedChargeRequestBody(chargeRequest)
  };
  return {
    status: 201,
    body,
    audit: {
      action: "mbt.frontdesk.quote.converted",
      entityType: "mbt_quote",
      entityId: input.quoteId,
      beforeState: input.before,
      afterState: {
        quoteId: input.quoteId, status: "converted", revision: input.before.revision + 1,
        contractId, serviceLineIds: serviceLines.map(({ serviceLineId }) => serviceLineId),
        ...convertedChargeRequestAudit(chargeRequest),
        visitIds: visits.map(({ visitId }) => visitId),
        billingCaseId: primaryBillingCase?.billingCaseId || null,
        billingCaseIds: billingCases.map(({ billingCaseId }) => billingCaseId)
      },
      reason: input.reason, revisionBefore: input.before.revision,
      revisionAfter: input.before.revision + 1, source: "frontdesk_local"
    }
  };
}

/**
 * Convert an accepted quote into a local contract, ready delivery front leg,
 * predecessor-blocked return leg, and an unposted local billing case.
 *
 * @param {Record<string, unknown>} input
 * @param {{afterContractInsert?: Function, afterVisitsInsert?: Function}} [hooks]
 */
export async function convertFrontdeskQuote(input, hooks = {}) {
  const actor = /** @type {any} */ (input.actor);
  assertFrontdeskActor(actor);
  const quoteId = requiredUuid(input.quoteId, "Quote ID");
  const expectedRevision = positiveRevision(input.expectedRevision);
  const reason = requiredText(input.reason, "Audit reason");
  const payload = { quoteId, expectedRevision, reason };
  return executeMbtCommand({
    actor,
    commandName: "mbt.frontdesk.quote.convert",
    idempotencyKey: requiredText(input.idempotencyKey, "Idempotency key"),
    payload,
    correlationId: requiredText(input.correlationId, "Correlation ID"),
    requestId: requiredText(input.requestId, "Request ID"),
    mutation: async () => {
      const quoteRow = await selectedQuote(quoteId);
      const before = publicQuote(quoteRow);
      if (before.status !== "accepted") {
        throw failure(409, "MBT_FRONTDESK_QUOTE_STATE_CONFLICT", "Only an accepted quote can be converted.");
      }
      if (before.revision !== expectedRevision) {
        throw failure(409, "MBT_STALE_REVISION", "The quote changed. Refresh and try again.");
      }
      if (!quoteRow.proposed_delivery_at || !quoteRow.proposed_return_at) {
        throw failure(422, "MBT_FRONTDESK_QUOTE_INCOMPLETE", "The accepted quote has no delivery and return schedule.");
      }
      const pricing = jsonObject(quoteRow.pricing_snapshot, "Quote pricing snapshot");
      const customer = jsonObject(quoteRow.customer_snapshot, "Quote customer snapshot");
      const site = jsonObject(quoteRow.site_snapshot, "Quote site snapshot");
      const tax = jsonObject(pricing.tax, "Quote tax snapshot");
      const rentalCalendarDays = positiveRevision(pricing.rentalCalendarDays, "Rental calendar days");
      const billingOwnership = requiredText(pricing.billingOwnership, "Billing ownership");
      const quotedServiceLines = storedQuoteServiceLines(quoteRow, pricing);
      const quotedPrimaryLine = firstQuotedServiceLine(quotedServiceLines);
      if (quoteUsesLineOwnedSites(pricing)) {
        return convertMultiLineFrontdeskQuote({
          quoteRow,
          before,
          quoteId,
          pricing,
          customer,
          site,
          tax,
          rentalCalendarDays,
          billingOwnership,
          actorId: String(actor.operatorId),
          reason,
          hooks
        });
      }
      const deliveryAt = new Date(quoteRow.proposed_delivery_at);
      const returnAt = new Date(quoteRow.proposed_return_at);
      const contractId = crypto.randomUUID();
      const deliveryVisitId = crypto.randomUUID();
      const returnVisitId = crypto.randomUUID();
      const billingCaseId = crypto.randomUUID();
      const contractNumber = publicNumber("MBT-C", contractId);
      const deliveryVisitReference = `${contractNumber}-V1`;
      const returnVisitReference = `${contractNumber}-V2`;
      const routeInputs = await conversionRouteInputs(quoteRow);
      const terms = {
        rentalCalendarDays,
        customerTerms: customer.terms ?? null,
        acceptedAt: quoteRow.accepted_at ? databaseIso(quoteRow.accepted_at) : null
      };
      const insertedContract = await query(
        `INSERT INTO mbt_contracts (
           contract_id, contract_number, quote_id, customer_netsuite_id,
           customer_site_profile_id, service_template_version_id,
           rate_card_version_id, bin_type_id, deposit_rule_id,
           status, planned_delivery_at, planned_return_at,
           rental_calendar_days, customer_snapshot, site_snapshot,
           terms_snapshot, tax_snapshot, pricing_snapshot,
           deposit_required_minor, currency, confirmed_at,
           created_by, updated_by
         ) VALUES (
           $1::uuid, $2, $3::uuid, $4::bigint, $5::uuid, $6::uuid,
           $7::uuid, $8::uuid, $9::uuid, 'confirmed', $10::timestamptz,
           $11::timestamptz, $12, $13::jsonb, $14::jsonb, $15::jsonb,
           $16::jsonb, $17::jsonb, $18, $19, now(), $20, $20
         )
         RETURNING *`,
        [
          contractId,
          contractNumber,
          quoteId,
          quoteRow.customer_netsuite_id,
          quoteRow.customer_site_profile_id,
          quoteRow.service_template_version_id,
          quoteRow.rate_card_version_id,
          quoteRow.bin_type_id,
          quoteRow.deposit_rule_id,
          databaseIso(deliveryAt),
          databaseIso(returnAt),
          rentalCalendarDays,
          JSON.stringify(customer),
          JSON.stringify(site),
          JSON.stringify(terms),
          JSON.stringify(tax),
          JSON.stringify(pricing),
          quoteRow.deposit_required_minor,
          quoteRow.currency,
          String(actor.operatorId)
        ]
      );
      const serviceLineId = crypto.randomUUID();
      const insertedServiceLine = await query(
        `INSERT INTO mbt_contract_service_lines (
           service_line_id, contract_id, source_quote_id, line_number, bin_type_id,
           customer_site_profile_id, site_snapshot, status,
           planned_delivery_at, planned_return_at, pricing_snapshot,
           customer_confirmation_status, waiver_snapshot, created_by, updated_by
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, 1, $4::uuid, $5::uuid, $6::jsonb,
           'scheduled', $7::timestamptz, $8::timestamptz, $9::jsonb,
           'not_required', '{}'::jsonb, $10, $10
         ) RETURNING *`,
        [
          serviceLineId, contractId, quoteId, quotedPrimaryLine.binTypeId,
          quoteRow.customer_site_profile_id, JSON.stringify(site),
          databaseIso(deliveryAt), databaseIso(returnAt),
          JSON.stringify(quotedPrimaryLine.pricing), String(actor.operatorId)
        ]
      );
      if (typeof hooks.afterContractInsert === "function") {
        await hooks.afterContractInsert({ contractId, quoteId });
      }
      const deliveryService = {
        schemaVersion: "mbt-bin-service-snapshot-v1",
        displayName: "Initial delivery",
        serviceAction: "delivery",
        serviceCode: pricing.serviceCode || "delivery",
        serviceLineId,
        lineNumber: 1,
        serviceTemplateVersionId: String(quoteRow.service_template_version_id),
        templateVersionId: routeInputs.templateVersionId,
        templateRevision: routeInputs.templateRevision,
        rateCardVersionId: String(quoteRow.rate_card_version_id),
        binTypeId: String(quoteRow.bin_type_id),
        predecessorVisitId: null,
        dependencyKind: "none",
        dependentReturnVisitId: returnVisitId,
        dependentReturnVisitRevision: 1,
        mandatoryStops: deliveryRoute({
          visitReference: deliveryVisitReference,
          siteProfileId: String(quoteRow.customer_site_profile_id),
          yard: routeInputs.yard,
          templateSteps: routeInputs.templateSteps
        })
      };
      const returnService = {
        schemaVersion: "mbt-bin-service-snapshot-v1",
        displayName: "Return bin",
        serviceAction: "return_bin",
        serviceLineId,
        lineNumber: 1,
        serviceCode: "return_bin",
        serviceTemplateVersionId: String(quoteRow.service_template_version_id),
        templateVersionId: routeInputs.templateVersionId,
        templateRevision: routeInputs.templateRevision,
        rateCardVersionId: String(quoteRow.rate_card_version_id),
        binTypeId: String(quoteRow.bin_type_id),
        predecessorVisitId: deliveryVisitId,
        dependencyKind: "predecessor_completed",
        mandatoryStops: [
          {
            stopId: `${returnVisitReference}-S1`,
            sequence: 1,
            actionCode: "pickup_bin",
            stopKind: "pickup",
            locationRole: "customer_site",
            yardId: null,
            yardCode: null,
            siteProfileId: String(quoteRow.customer_site_profile_id),
            assetId: null
          },
          {
            stopId: `${returnVisitReference}-S2`,
            sequence: 2,
            actionCode: "return_bin",
            stopKind: "drop",
            locationRole: "return_yard",
            yardId: routeInputs.yard.yardId,
            yardCode: routeInputs.yard.yardCode,
            siteProfileId: null,
            assetId: null
          }
        ]
      };
      const deliveryRow = await insertServiceVisit({
        visitId: deliveryVisitId,
        contractId,
        visitNumber: 1,
        visitReference: deliveryVisitReference,
        templateVersionId: String(quoteRow.service_template_version_id),
        serviceAction: "delivery",
        status: "ready",
        siteProfileId: String(quoteRow.customer_site_profile_id),
        binTypeId: String(quoteRow.bin_type_id),
        serviceLineId,
        predecessorVisitId: null,
        scheduledStartAt: deliveryAt,
        scheduledEndAt: new Date(deliveryAt.getTime() + FOUR_HOURS_MS),
        customer,
        site,
        service: deliveryService,
        billingOwnership,
        actorId: String(actor.operatorId)
      });
      const returnRow = await insertServiceVisit({
        visitId: returnVisitId,
        contractId,
        visitNumber: 2,
        visitReference: returnVisitReference,
        templateVersionId: String(quoteRow.service_template_version_id),
        serviceAction: "return_bin",
        status: "tentative",
        siteProfileId: String(quoteRow.customer_site_profile_id),
        binTypeId: String(quoteRow.bin_type_id),
        serviceLineId,
        predecessorVisitId: deliveryVisitId,
        scheduledStartAt: returnAt,
        scheduledEndAt: new Date(returnAt.getTime() + FOUR_HOURS_MS),
        customer,
        site,
        service: returnService,
        billingOwnership,
        actorId: String(actor.operatorId)
      });
      await insertVisitSteps({
        visitId: deliveryVisitId,
        steps: [
          {
            sequence: 0,
            actionCode: "collect_empty_bin",
            displayName: `Collect empty ${String(quoteRow.bin_type_code)} bin`,
            locationRole: "origin_yard",
            required: true,
            completionBlocking: true,
            templateStepId: null
          },
          ...routeInputs.templateSteps.map((step, index) => ({
            sequence: index + 1,
            actionCode: String(step.action_code),
            displayName: String(step.display_name),
            locationRole: String(step.location_role),
            required: Boolean(step.required),
            completionBlocking: Boolean(step.completion_blocking),
            templateStepId: String(step.template_step_id)
          }))
        ],
        evidence: routeInputs.templateEvidence
      });
      await insertVisitSteps({
        visitId: returnVisitId,
        steps: [
          {
            sequence: 0,
            actionCode: "pickup_bin",
            displayName: `Pickup ${String(quoteRow.bin_type_code)} bin`,
            locationRole: "customer_site",
            required: true,
            completionBlocking: true,
            templateStepId: null
          },
          {
            sequence: 1,
            actionCode: "return_bin",
            displayName: `Return ${String(quoteRow.bin_type_code)} bin`,
            locationRole: "return_yard",
            required: true,
            completionBlocking: true,
            templateStepId: null
          }
        ]
      });
      await copyQuoteDistanceToVisit(routeInputs.distance, deliveryVisitId);
      if (typeof hooks.afterVisitsInsert === "function") {
        await hooks.afterVisitsInsert({ contractId, visits: [deliveryVisitId, returnVisitId] });
      }
      const billingCase = await query(
        `INSERT INTO mbt_billing_cases (
           billing_case_id, case_type, contract_id, service_visit_id,
           customer_netsuite_id, status, currency, created_by, updated_by
         ) VALUES (
           $1::uuid, 'mbt_contract', $2::uuid, $3::uuid, $4::bigint,
           'open', $5, $6, $6
         )
         RETURNING *`,
        [
          billingCaseId,
          contractId,
          deliveryVisitId,
          quoteRow.customer_netsuite_id,
          quoteRow.currency,
          String(actor.operatorId)
        ]
      );
      await query(
        `UPDATE mbt_quotes
            SET status = 'converted', terminal_at = now(),
                revision = revision + 1, updated_by = $2, updated_at = now()
          WHERE quote_id = $1::uuid`,
        [quoteId, String(actor.operatorId)]
      );
      const contract = publicContract(insertedContract.rows[0]);
      const visits = [publicVisit(deliveryRow), publicVisit(returnRow)];
      const serviceLines = [publicServiceLine({
        ...insertedServiceLine.rows[0],
        bin_type_code: String(quoteRow.bin_type_code || "")
      })];
      const body = {
        schemaVersion: "mbt-frontdesk-conversion-v1",
        contract,
        serviceLines,
        visits,
        billingCase: {
          billingCaseId: String(billingCase.rows[0].billing_case_id),
          caseType: String(billingCase.rows[0].case_type),
          status: String(billingCase.rows[0].status),
          revision: Number(billingCase.rows[0].revision)
        }
      };
      return {
        status: 201,
        body,
        audit: {
          action: "mbt.frontdesk.quote.converted",
          entityType: "mbt_quote",
          entityId: quoteId,
          beforeState: before,
          afterState: {
            quoteId,
            status: "converted",
            revision: before.revision + 1,
            contractId,
            serviceLineIds: serviceLines.map(({ serviceLineId: lineId }) => lineId),
            visitIds: visits.map(({ visitId }) => visitId),
            billingCaseId
          },
          reason,
          revisionBefore: before.revision,
          revisionAfter: before.revision + 1,
          source: "frontdesk_local"
        }
      };
    }
  });
}

/**
 * Read a contract timeline exclusively from immutable accepted snapshots and
 * the append-only amendment history. Later canonical edits therefore cannot
 * alter what Front Desk accepted.
 *
 * @param {{actor: {operatorId?: unknown, roles?: readonly unknown[]}, contractId: unknown}} input
 */
export async function getFrontdeskContractTimeline(input) {
  assertFrontdeskActor(input.actor);
  const contractId = requiredUuid(input.contractId, "Contract ID");
  const contractResult = await query(
    "SELECT * FROM mbt_contracts WHERE contract_id = $1::uuid",
    [contractId]
  );
  if (!contractResult.rowCount) {
    throw failure(404, "MBT_FRONTDESK_CONTRACT_NOT_FOUND", "The Front Desk contract was not found.");
  }
  const [visitResult, amendmentResult, billingResult, serviceLineResult, lineEventResult] = await Promise.all([
    query(
      `SELECT * FROM mbt_service_visits
        WHERE contract_id = $1::uuid
        ORDER BY visit_number, service_visit_id`,
      [contractId]
    ),
    query(
      `SELECT * FROM mbt_contract_amendments
        WHERE contract_id = $1::uuid
        ORDER BY amendment_number, amendment_id`,
      [contractId]
    ),
    query(
      `SELECT billing_case_id::text, case_type, status, revision::int
         FROM mbt_billing_cases
        WHERE contract_id = $1::uuid
          AND case_type = 'mbt_contract'
          AND status <> 'voided'
        ORDER BY created_at, billing_case_id`,
      [contractId]
    ),
    query(
      `SELECT line.*, bin.type_code AS bin_type_code
         FROM mbt_contract_service_lines line
         JOIN mbt_bin_types bin ON bin.bin_type_id = line.bin_type_id
        WHERE line.contract_id = $1::uuid
        ORDER BY line.line_number, line.service_line_id`,
      [contractId]
    ),
    query(
      `SELECT event.*
         FROM mbt_contract_service_line_events event
        WHERE event.contract_id = $1::uuid
        ORDER BY event.created_at, event.service_line_event_id`,
      [contractId]
    )
  ]);
  return {
    schemaVersion: "mbt-frontdesk-contract-v1",
    contract: publicContract(contractResult.rows[0]),
    serviceLines: serviceLineResult.rows.map(publicServiceLine),
    visits: visitResult.rows.map(publicVisit),
    amendments: amendmentResult.rows.map(publicAmendment),
    serviceLineEvents: lineEventResult.rows.map((/** @type {any} */ row) => ({
      serviceLineEventId: String(row.service_line_event_id),
      serviceLineId: String(row.service_line_id),
      visitId: row.service_visit_id ? String(row.service_visit_id) : null,
      eventType: String(row.event_type),
      before: row.before_snapshot,
      after: row.after_snapshot,
      reason: String(row.reason),
      actorOperatorId: String(row.actor_operator_id),
      createdAt: databaseIso(row.created_at)
    })),
    billingCases: billingResult.rows.map((/** @type {any} */ row) => ({
      billingCaseId: String(row.billing_case_id),
      caseType: String(row.case_type),
      status: String(row.status),
      revision: Number(row.revision)
    }))
  };
}

/** @param {Record<string, any>} contract */
function assertLegacyContractExtendable(contract) {
  if (!["confirmed", "active", "return_due"].includes(contract.status)) {
    throw failure(409, "MBT_FRONTDESK_CONTRACT_STATE_CONFLICT", "This contract cannot be extended in its current state.");
  }
}

/**
 * Append an approved extension amendment and move only the unstarted,
 * tentative return visit. The delivery visit and every accepted snapshot are
 * intentionally left byte-for-byte unchanged.
 *
 * @param {Record<string, unknown>} input
 */
export async function extendFrontdeskContract(input) {
  const actor = /** @type {any} */ (input.actor);
  assertFrontdeskActor(actor);
  const contractId = requiredUuid(input.contractId, "Contract ID");
  const expectedRevision = positiveRevision(input.expectedRevision);
  const returnWindow = jsonObject(input.returnWindow, "Return window");
  const startAt = timestamp(returnWindow.startAt, "Return window start");
  const endAt = timestamp(returnWindow.endAt, "Return window end");
  if (endAt <= startAt) {
    throw failure(400, "MBT_FRONTDESK_INPUT_INVALID", "Return window end must follow its start.");
  }
  const reason = requiredText(input.reason, "Audit reason");
  const payload = {
    contractId,
    expectedRevision,
    returnWindow: { startAt: iso(startAt), endAt: iso(endAt) },
    reason
  };
  return executeMbtCommand({
    actor,
    commandName: "mbt.frontdesk.contract.extend",
    idempotencyKey: requiredText(input.idempotencyKey, "Idempotency key"),
    payload,
    correlationId: requiredText(input.correlationId, "Correlation ID"),
    requestId: requiredText(input.requestId, "Request ID"),
    mutation: async () => {
      const contractResult = await query(
        "SELECT * FROM mbt_contracts WHERE contract_id = $1::uuid FOR UPDATE",
        [contractId]
      );
      if (!contractResult.rowCount) {
        throw failure(404, "MBT_FRONTDESK_CONTRACT_NOT_FOUND", "The Front Desk contract was not found.");
      }
      const contractRow = contractResult.rows[0];
      const beforeContract = publicContract(contractRow);
      if (beforeContract.revision !== expectedRevision) {
        throw failure(409, "MBT_STALE_REVISION", "The contract changed. Refresh and try again.");
      }
      assertLegacyContractExtendable(beforeContract);
      const defaultLineResult = await query(
        `SELECT service_line_id::text
           FROM mbt_contract_service_lines
          WHERE contract_id = $1::uuid
          ORDER BY line_number, service_line_id
          LIMIT 1
          FOR UPDATE`,
        [contractId]
      );
      if (!defaultLineResult.rowCount) {
        throw failure(422, "MBT_FRONTDESK_CONTRACT_INCOMPLETE", "The contract has no physical service line.");
      }
      const defaultServiceLineId = String(defaultLineResult.rows[0].service_line_id);
      const visitsResult = await query(
        `SELECT * FROM mbt_service_visits
          WHERE contract_id = $1::uuid AND service_line_id = $2::uuid
          ORDER BY visit_number, service_visit_id
          FOR UPDATE`,
        [contractId, defaultServiceLineId]
      );
      const deliveryRow = visitsResult.rows.find((/** @type {any} */ row) => row.service_action === "delivery");
      const returnRow = [...visitsResult.rows].reverse().find((/** @type {any} */ row) => row.service_action === "return_bin");
      if (!deliveryRow || !returnRow) {
        throw failure(422, "MBT_FRONTDESK_CONTRACT_INCOMPLETE", "The contract delivery and return visit chain is incomplete.");
      }
      if (returnRow.status !== "tentative" || returnRow.actual_started_at) {
        throw failure(409, "MBT_FRONTDESK_RETURN_STARTED", "A return visit that has started cannot be extended.");
      }
      if (deliveryRow.scheduled_start_at && startAt <= new Date(deliveryRow.scheduled_start_at)) {
        throw failure(400, "MBT_FRONTDESK_INPUT_INVALID", "The return window must follow the delivery visit.");
      }
      const amendmentNumberResult = await query(
        `SELECT COALESCE(max(amendment_number), 0)::int + 1 AS next_number
           FROM mbt_contract_amendments
          WHERE contract_id = $1::uuid`,
        [contractId]
      );
      const amendmentNumber = Number(amendmentNumberResult.rows[0].next_number);
      const amendmentId = crypto.randomUUID();
      const beforeSnapshot = {
        contractId,
        contractRevision: beforeContract.revision,
        returnVisitId: String(returnRow.service_visit_id),
        returnVisitRevision: Number(returnRow.revision),
        returnWindow: {
          startAt: returnRow.scheduled_start_at ? databaseIso(returnRow.scheduled_start_at) : null,
          endAt: returnRow.scheduled_end_at ? databaseIso(returnRow.scheduled_end_at) : null
        }
      };
      const afterSnapshot = {
        contractId,
        contractRevision: beforeContract.revision + 1,
        returnVisitId: String(returnRow.service_visit_id),
        returnVisitRevision: Number(returnRow.revision) + 1,
        returnWindow: { startAt: iso(startAt), endAt: iso(endAt) }
      };
      const amendmentResult = await query(
        `INSERT INTO mbt_contract_amendments (
           amendment_id, contract_id, amendment_number,
           amendment_type, status, rate_card_version_id, reason,
           before_snapshot, after_snapshot, requested_effective_at,
           approved_at, approved_by, created_by, updated_by
         ) VALUES (
           $1::uuid, $2::uuid, $3, 'extension', 'approved', $4::uuid,
           $5, $6::jsonb, $7::jsonb, $8::timestamptz,
           now(), $9, $9, $9
         )
         RETURNING *`,
        [
          amendmentId,
          contractId,
          amendmentNumber,
          contractRow.rate_card_version_id,
          reason,
          JSON.stringify(beforeSnapshot),
          JSON.stringify(afterSnapshot),
          iso(startAt),
          String(actor.operatorId)
        ]
      );
      const updatedReturn = await query(
        `UPDATE mbt_service_visits
            SET scheduled_start_at = $2::timestamptz,
                scheduled_end_at = $3::timestamptz,
                amendment_id = $4::uuid,
                revision = revision + 1,
                updated_by = $5, updated_at = now()
          WHERE service_visit_id = $1::uuid
          RETURNING *`,
        [
          returnRow.service_visit_id,
          iso(startAt),
          iso(endAt),
          amendmentId,
          String(actor.operatorId)
        ]
      );
      const updatedContract = await query(
        `UPDATE mbt_contracts
            SET planned_return_at = $2::timestamptz,
                revision = revision + 1,
                updated_by = $3, updated_at = now()
          WHERE contract_id = $1::uuid
          RETURNING *`,
        [contractId, iso(startAt), String(actor.operatorId)]
      );
      await query(
        `UPDATE mbt_contract_service_lines
            SET planned_return_at = $2::timestamptz,
                revision = revision + 1, updated_by = $3, updated_at = now()
          WHERE service_line_id = $1::uuid`,
        [defaultServiceLineId, iso(startAt), String(actor.operatorId)]
      );
      const afterContract = publicContract(updatedContract.rows[0]);
      const amendment = publicAmendment(amendmentResult.rows[0]);
      const returnVisit = publicVisit(updatedReturn.rows[0]);
      return {
        status: 200,
        body: {
          schemaVersion: "mbt-frontdesk-extension-v1",
          contract: afterContract,
          amendment,
          returnVisit
        },
        audit: {
          action: "mbt.frontdesk.contract.extended",
          entityType: "mbt_contract",
          entityId: contractId,
          beforeState: {
            contract: beforeContract,
            returnVisit: publicVisit(returnRow)
          },
          afterState: {
            contract: afterContract,
            returnVisit,
            amendment
          },
          reason,
          revisionBefore: beforeContract.revision,
          revisionAfter: afterContract.revision,
          source: "frontdesk_local"
        }
      };
    }
  });
}

/** @param {{operatorId?: unknown, roles?: readonly unknown[]}} actor */
function assertDispatcherOrAdminActor(actor) {
  requiredText(actor?.operatorId, "Actor operator ID");
  const roles = Array.isArray(actor?.roles) ? actor.roles.map((role) => String(role).toLowerCase()) : [];
  if (!roles.some((role) => role === "admin" || role === "dispatcher")) {
    throw failure(403, "MBT_FRONTDESK_FORBIDDEN", "Dispatcher or Admin access is required.");
  }
}

/** @param {string} contractId @param {string} serviceLineId @param {number} expectedRevision */
async function lockContractServiceLine(contractId, serviceLineId, expectedRevision) {
  const contractResult = await query(
    "SELECT * FROM mbt_contracts WHERE contract_id = $1::uuid FOR UPDATE",
    [contractId]
  );
  if (!contractResult.rowCount) {
    throw failure(404, "MBT_FRONTDESK_CONTRACT_NOT_FOUND", "The Front Desk contract was not found.");
  }
  const lineResult = await query(
    `SELECT line.*, bin.type_code AS bin_type_code
       FROM mbt_contract_service_lines line
       JOIN mbt_bin_types bin ON bin.bin_type_id = line.bin_type_id
      WHERE line.service_line_id = $1::uuid AND line.contract_id = $2::uuid
      FOR UPDATE OF line`,
    [serviceLineId, contractId]
  );
  if (!lineResult.rowCount) {
    throw failure(404, "MBT_FRONTDESK_SERVICE_LINE_NOT_FOUND", "The requested physical-bin service line was not found.");
  }
  const serviceLine = publicServiceLine(lineResult.rows[0]);
  if (serviceLine.revision !== expectedRevision) {
    throw failure(409, "MBT_STALE_REVISION", "This physical-bin line changed. Refresh and try again.");
  }
  if (["closed", "cancelled"].includes(serviceLine.status)) {
    throw failure(409, "MBT_FRONTDESK_SERVICE_LINE_CLOSED", "A closed physical-bin line cannot be changed.");
  }
  return { contractRow: contractResult.rows[0], lineRow: lineResult.rows[0], serviceLine };
}

/** @param {string} serviceLineId */
async function lockReturnVisitForLine(serviceLineId) {
  const result = await query(
    `SELECT * FROM mbt_service_visits
      WHERE service_line_id = $1::uuid AND service_action = 'return_bin'
      ORDER BY visit_number DESC, service_visit_id DESC
      LIMIT 1
      FOR UPDATE`,
    [serviceLineId]
  );
  if (!result.rowCount) {
    throw failure(422, "MBT_FRONTDESK_CONTRACT_INCOMPLETE", "The physical-bin line has no pending collection visit.");
  }
  if (result.rows[0].status !== "tentative" || result.rows[0].actual_started_at) {
    throw failure(409, "MBT_FRONTDESK_RETURN_STARTED", "A collection visit that has started cannot be changed.");
  }
  return result.rows[0];
}

/** @param {string} contractId */
async function nextContractAmendmentNumber(contractId) {
  const result = await query(
    `SELECT COALESCE(max(amendment_number), 0)::int + 1 AS next_number
       FROM mbt_contract_amendments WHERE contract_id = $1::uuid`,
    [contractId]
  );
  return Number(result.rows[0].next_number);
}

/** @param {{serviceLineId: string, contractId: string, visitId?: string | null, eventType: string, before: Record<string, unknown>, after: Record<string, unknown>, reason: string, actorId: string}} input */
async function insertServiceLineEvent(input) {
  await query(
    `INSERT INTO mbt_contract_service_line_events (
       service_line_event_id, service_line_id, contract_id, service_visit_id,
       event_type, before_snapshot, after_snapshot, reason, actor_operator_id
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5,
       $6::jsonb, $7::jsonb, $8, $9)`,
    [
      crypto.randomUUID(), input.serviceLineId, input.contractId, input.visitId || null,
      input.eventType, JSON.stringify(input.before), JSON.stringify(input.after),
      input.reason, input.actorId
    ]
  );
}

/** @param {string} contractId @param {string} actorId */
async function updateContractLineScheduleRollup(contractId, actorId) {
  const bounds = await query(
    `SELECT min(planned_delivery_at) AS planned_delivery_at,
            max(planned_return_at) AS planned_return_at
       FROM mbt_contract_service_lines WHERE contract_id = $1::uuid`,
    [contractId]
  );
  return query(
    `UPDATE mbt_contracts
        SET planned_delivery_at = $2::timestamptz, planned_return_at = $3::timestamptz,
            revision = revision + 1, updated_by = $4, updated_at = now()
      WHERE contract_id = $1::uuid
      RETURNING *`,
    [
      contractId, bounds.rows[0].planned_delivery_at, bounds.rows[0].planned_return_at,
      actorId
    ]
  );
}

/**
 * Extend exactly one physical bin's future collection; sibling lines and their
 * ready Dispatch legs remain untouched.
 * @param {Record<string, unknown>} input
 */
export async function extendFrontdeskServiceLine(input) {
  const actor = /** @type {any} */ (input.actor);
  assertFrontdeskActor(actor);
  const contractId = requiredUuid(input.contractId, "Contract ID");
  const serviceLineId = requiredUuid(input.serviceLineId, "Service line ID");
  const expectedRevision = positiveRevision(input.expectedRevision, "Expected service line revision");
  const returnWindow = jsonObject(input.returnWindow, "Return window");
  const startAt = timestamp(returnWindow.startAt, "Return window start");
  const endAt = timestamp(returnWindow.endAt, "Return window end");
  if (endAt <= startAt) {
    throw failure(400, "MBT_FRONTDESK_INPUT_INVALID", "Return window end must follow its start.");
  }
  const reason = requiredText(input.reason, "Audit reason");
  const payload = { contractId, serviceLineId, expectedRevision, returnWindow: { startAt: iso(startAt), endAt: iso(endAt) }, reason };
  return executeMbtCommand({
    actor, commandName: "mbt.frontdesk.service_line.extend",
    idempotencyKey: requiredText(input.idempotencyKey, "Idempotency key"), payload,
    correlationId: requiredText(input.correlationId, "Correlation ID"),
    requestId: requiredText(input.requestId, "Request ID"),
    mutation: async () => {
      const locked = await lockContractServiceLine(contractId, serviceLineId, expectedRevision);
      const returnVisit = await lockReturnVisitForLine(serviceLineId);
      if (locked.lineRow.planned_delivery_at && startAt <= new Date(locked.lineRow.planned_delivery_at)) {
        throw failure(400, "MBT_FRONTDESK_INPUT_INVALID", "The collection window must follow the delivery date.");
      }
      const amendmentId = crypto.randomUUID();
      const amendmentNumber = await nextContractAmendmentNumber(contractId);
      const before = {
        serviceLine: locked.serviceLine,
        returnVisit: publicVisit(returnVisit)
      };
      const afterWindow = { startAt: iso(startAt), endAt: iso(endAt) };
      const amendmentResult = await query(
        `INSERT INTO mbt_contract_amendments (
           amendment_id, contract_id, amendment_number, amendment_type, status,
           rate_card_version_id, reason, before_snapshot, after_snapshot,
           requested_effective_at, approved_at, approved_by, created_by, updated_by
         ) VALUES ($1::uuid, $2::uuid, $3, 'extension', 'approved', $4::uuid,
           $5, $6::jsonb, $7::jsonb, $8::timestamptz, now(), $9, $9, $9)
         RETURNING *`,
        [
          amendmentId, contractId, amendmentNumber, locked.contractRow.rate_card_version_id,
          reason, JSON.stringify(before), JSON.stringify({ returnWindow: afterWindow }),
          iso(startAt), String(actor.operatorId)
        ]
      );
      const updatedVisit = await query(
        `UPDATE mbt_service_visits
            SET scheduled_start_at = $2::timestamptz, scheduled_end_at = $3::timestamptz,
                amendment_id = $4::uuid, revision = revision + 1,
                updated_by = $5, updated_at = now()
          WHERE service_visit_id = $1::uuid RETURNING *`,
        [returnVisit.service_visit_id, iso(startAt), iso(endAt), amendmentId, String(actor.operatorId)]
      );
      const updatedLine = await query(
        `UPDATE mbt_contract_service_lines
            SET planned_return_at = $2::timestamptz, revision = revision + 1,
                updated_by = $3, updated_at = now()
          WHERE service_line_id = $1::uuid RETURNING *`,
        [serviceLineId, iso(startAt), String(actor.operatorId)]
      );
      const updatedContract = await updateContractLineScheduleRollup(contractId, String(actor.operatorId));
      const serviceLine = publicServiceLine({ ...updatedLine.rows[0], bin_type_code: locked.lineRow.bin_type_code });
      const result = {
        contract: publicContract(updatedContract.rows[0]), serviceLine,
        amendment: publicAmendment(amendmentResult.rows[0]), returnVisit: publicVisit(updatedVisit.rows[0])
      };
      await insertServiceLineEvent({
        serviceLineId, contractId, visitId: String(returnVisit.service_visit_id), eventType: "extension",
        before, after: result, reason, actorId: String(actor.operatorId)
      });
      return {
        status: 200,
        body: { schemaVersion: "mbt-frontdesk-service-line-extension-v1", ...result },
        audit: {
          action: "mbt.frontdesk.service_line.extended", entityType: "mbt_contract_service_line",
          entityId: serviceLineId, beforeState: before, afterState: result, reason,
          revisionBefore: locked.serviceLine.revision, revisionAfter: serviceLine.revision,
          source: "frontdesk_local"
        }
      };
    }
  });
}

/** @param {Record<string, any>} visit */
function exchangeRouteFromDelivery(visit) {
  const snapshot = jsonObject(visit.service_snapshot, "Delivery service snapshot");
  const stops = Array.isArray(snapshot.mandatoryStops) ? snapshot.mandatoryStops : [];
  const origin = stops.find((stop) => stop?.locationRole === "origin_yard") || {};
  const site = stops.find((stop) => stop?.locationRole === "customer_site") || {};
  if (!origin.yardId || !site.siteProfileId) {
    throw failure(422, "MBT_FRONTDESK_CONTRACT_INCOMPLETE", "The delivery route cannot create a safe exchange visit.");
  }
  return [
    {
      sequence: 1, actionCode: "collect_replacement_bin", stopKind: "pickup",
      locationRole: "origin_yard", yardId: String(origin.yardId), yardCode: origin.yardCode || null,
      siteProfileId: null, assetId: null
    },
    {
      sequence: 2, actionCode: "exchange_bin", stopKind: "drop",
      locationRole: "customer_site", yardId: null, yardCode: null,
      siteProfileId: String(site.siteProfileId), assetId: null
    },
    {
      sequence: 3, actionCode: "return_replaced_bin", stopKind: "drop",
      locationRole: "return_yard", yardId: String(origin.yardId), yardCode: origin.yardCode || null,
      siteProfileId: null, assetId: null
    }
  ];
}

/** @param {string} chargeMode @param {string | null} waiverReason @param {unknown} operatorId */
function exchangeWaiverEvidence(chargeMode, waiverReason, operatorId) {
  if (chargeMode !== "free_internal") {
    return {};
  }
  return {
    mode: "free_internal",
    reason: waiverReason,
    approvedBy: String(operatorId),
    approvedAt: new Date().toISOString()
  };
}

/** @param {string | null} sourceChargeRequestId @param {string | null} incomingContentCode @param {Record<string, unknown> | null} attachedAggregate */
function exchangeChargeSnapshot(sourceChargeRequestId, incomingContentCode, attachedAggregate) {
  return {
    ...(sourceChargeRequestId ? { chargeRequestId: sourceChargeRequestId } : {}),
    ...(incomingContentCode ? { contentCode: incomingContentCode } : {}),
    ...(attachedAggregate ? { attachedAggregate } : {})
  };
}

/** @param {boolean} sizeChanged @param {Record<string, any>} lineRow */
function exchangeCustomerConfirmation(sizeChanged, lineRow) {
  if (!sizeChanged) {
    return {
      status: String(lineRow.customer_confirmation_status),
      reason: lineRow.customer_confirmation_reason
    };
  }
  return {
    status: "required",
    reason: "Customer confirmation is required for the planned bin size change."
  };
}

/** @param {Record<string, any>} input */
async function recordFreeExchangeWaiver(input) {
  if (input.chargeMode !== "free_internal") {
    return;
  }
  await insertServiceLineEvent({
    serviceLineId: input.serviceLineId,
    contractId: input.contractId,
    visitId: input.exchangeVisitId,
    eventType: "charge_waiver",
    before: {},
    after: input.waiver,
    reason: input.waiverReason || input.reason,
    actorId: String(input.actorId)
  });
}

/**
 * Insert an exchange between a physical delivery and its future collection.
 * A size change is intentionally customer-confirmation-required until Front
 * Desk records the decision; a free internal upgrade carries its own waiver
 * evidence instead of hiding an uncharged change in an audit note.
 *
 * @param {Record<string, unknown>} input
 */
export async function exchangeFrontdeskServiceLine(input) {
  const actor = /** @type {any} */ (input.actor);
  assertFrontdeskActor(actor);
  const contractId = requiredUuid(input.contractId, "Contract ID");
  const serviceLineId = requiredUuid(input.serviceLineId, "Service line ID");
  const expectedRevision = positiveRevision(input.expectedRevision, "Expected service line revision");
  const exchangeWindow = jsonObject(input.exchangeWindow, "Exchange window");
  const startAt = timestamp(exchangeWindow.startAt, "Exchange window start");
  const endAt = timestamp(exchangeWindow.endAt, "Exchange window end");
  if (endAt <= startAt) {
    throw failure(400, "MBT_FRONTDESK_INPUT_INVALID", "Exchange window end must follow its start.");
  }
  const incomingBinTypeId = requiredUuid(input.incomingBinTypeId, "Incoming bin type ID");
  const sourceChargeRequestId = input.sourceChargeRequestId
    ? requiredUuid(input.sourceChargeRequestId, "Charge request ID")
    : null;
  const incomingContentCode = input.incomingContentCode
    ? requiredText(input.incomingContentCode, "Incoming bin content").toLowerCase()
    : null;
  if (incomingContentCode && !["garbage", "soil", "asphalt", "concrete"].includes(incomingContentCode)) {
    throw failure(400, "MBT_FRONTDESK_INPUT_INVALID", "Incoming bin content is not supported.");
  }
  const attachedAggregate = input.attachedAggregate
    ? jsonObject(input.attachedAggregate, "Attached aggregate evidence")
    : null;
  const chargeMode = requiredText(input.chargeMode ?? "charged", "Exchange charge mode");
  if (!["charged", "free_internal"].includes(chargeMode)) {
    throw failure(400, "MBT_FRONTDESK_INPUT_INVALID", "Exchange charge mode must be charged or free_internal.");
  }
  const waiverReason = chargeMode === "free_internal"
    ? requiredText(input.waiverReason, "Free upgrade waiver reason")
    : null;
  const reason = requiredText(input.reason, "Audit reason");
  const payload = {
    contractId, serviceLineId, expectedRevision,
    exchangeWindow: { startAt: iso(startAt), endAt: iso(endAt) }, incomingBinTypeId,
    chargeMode, waiverReason, sourceChargeRequestId, incomingContentCode,
    attachedAggregate, reason
  };
  return executeMbtCommand({
    actor, commandName: "mbt.frontdesk.service_line.exchange",
    idempotencyKey: requiredText(input.idempotencyKey, "Idempotency key"), payload,
    correlationId: requiredText(input.correlationId, "Correlation ID"),
    requestId: requiredText(input.requestId, "Request ID"),
    mutation: async () => {
      const locked = await lockContractServiceLine(contractId, serviceLineId, expectedRevision);
      const incomingType = await query(
        `SELECT type.bin_type_id::text, type.type_code, type.display_name,
                item.item_code AS local_item_code
           FROM mbt_bin_types type
           JOIN mbt_local_item_settings item
             ON item.item_code = type.local_item_code
            AND item.item_type = 'bin'
            AND item.active
          WHERE type.bin_type_id = $1::uuid AND type.active`,
        [incomingBinTypeId]
      );
      if (!incomingType.rowCount) {
        throw failure(409, "MBT_FRONTDESK_BIN_TYPE_NOT_ACTIVE", "The incoming bin type is not active.");
      }
      const deliveryResult = await query(
        `SELECT * FROM mbt_service_visits
          WHERE service_line_id = $1::uuid AND service_action = 'delivery'
          ORDER BY visit_number, service_visit_id LIMIT 1 FOR UPDATE`,
        [serviceLineId]
      );
      if (!deliveryResult.rowCount) {
        throw failure(422, "MBT_FRONTDESK_CONTRACT_INCOMPLETE", "The physical-bin line has no delivery visit.");
      }
      const deliveryVisit = deliveryResult.rows[0];
      const returnVisit = await lockReturnVisitForLine(serviceLineId);
      if (returnVisit.scheduled_start_at && new Date(returnVisit.scheduled_start_at) <= endAt) {
        throw failure(409, "MBT_FRONTDESK_RETURN_CONFLICT", "The pending collection must follow the exchange window.");
      }
      const maxVisitNumber = await query(
        `SELECT COALESCE(max(visit_number), 0)::int AS max_number
           FROM mbt_service_visits WHERE contract_id = $1::uuid`,
        [contractId]
      );
      const exchangeVisitId = crypto.randomUUID();
      const exchangeVisitNumber = Number(maxVisitNumber.rows[0].max_number) + 1;
      const exchangeReference = `${String(locked.contractRow.contract_number)}-L${locked.serviceLine.lineNumber}-X${exchangeVisitNumber}`;
      const route = exchangeRouteFromDelivery(deliveryVisit);
      const oldReturnSnapshot = jsonObject(returnVisit.service_snapshot, "Return service snapshot");
      const before = {
        serviceLine: locked.serviceLine,
        deliveryVisit: publicVisit(deliveryVisit),
        returnVisit: publicVisit(returnVisit)
      };
      const amendmentId = crypto.randomUUID();
      const amendmentNumber = await nextContractAmendmentNumber(contractId);
      const sizeChanged = String(locked.lineRow.bin_type_id) !== incomingBinTypeId;
      const waiver = exchangeWaiverEvidence(chargeMode, waiverReason, actor.operatorId);
      const chargeSnapshot = exchangeChargeSnapshot(
        sourceChargeRequestId,
        incomingContentCode,
        attachedAggregate
      );
      const customerConfirmation = exchangeCustomerConfirmation(sizeChanged, locked.lineRow);
      const amendmentResult = await query(
        `INSERT INTO mbt_contract_amendments (
           amendment_id, contract_id, amendment_number, amendment_type, status,
           rate_card_version_id, reason, before_snapshot, after_snapshot,
           requested_effective_at, approved_at, approved_by, created_by, updated_by
         ) VALUES ($1::uuid, $2::uuid, $3, 'swap_exchange', 'approved', $4::uuid,
           $5, $6::jsonb, $7::jsonb, $8::timestamptz, now(), $9, $9, $9)
         RETURNING *`,
        [
          amendmentId, contractId, amendmentNumber, locked.contractRow.rate_card_version_id,
          reason, JSON.stringify(before), JSON.stringify({ incomingBinTypeId, exchangeVisitId, chargeMode, waiver }),
          iso(startAt), String(actor.operatorId)
        ]
      );
      await query(
        `UPDATE mbt_service_visits
            SET predecessor_visit_id = NULL, visit_number = $2,
                revision = revision + 1, updated_by = $3, updated_at = now()
          WHERE service_visit_id = $1::uuid`,
        [returnVisit.service_visit_id, exchangeVisitNumber + 1, String(actor.operatorId)]
      );
      const exchangeSnapshot = {
        schemaVersion: "mbt-bin-service-snapshot-v1",
        displayName: sizeChanged ? "Bin size exchange" : "Bin exchange",
        serviceAction: "exchange_bin", serviceLineId, lineNumber: locked.serviceLine.lineNumber,
        predecessorVisitId: String(deliveryVisit.service_visit_id), dependencyKind: "predecessor_completed",
        binItemCode: String(incomingType.rows[0].local_item_code),
        binTypeId: incomingBinTypeId, mandatoryStops: route,
        customerConfirmationRequired: sizeChanged, chargeMode, waiver,
        ...chargeSnapshot
      };
      const exchangeVisit = await insertServiceVisit({
        visitId: exchangeVisitId, contractId, visitNumber: exchangeVisitNumber,
        visitReference: exchangeReference,
        templateVersionId: String(deliveryVisit.service_template_version_id),
        serviceAction: "exchange_bin", status: "tentative",
        siteProfileId: String(deliveryVisit.customer_site_profile_id), binTypeId: incomingBinTypeId,
        serviceLineId, predecessorVisitId: String(deliveryVisit.service_visit_id),
        scheduledStartAt: startAt, scheduledEndAt: endAt,
        customer: jsonObject(deliveryVisit.customer_snapshot, "Delivery customer snapshot"),
        site: jsonObject(deliveryVisit.site_snapshot, "Delivery site snapshot"),
        service: exchangeSnapshot, billingOwnership: String(deliveryVisit.billing_ownership),
        actorId: String(actor.operatorId)
      });
      await insertVisitSteps({
        visitId: exchangeVisitId,
        steps: [
          { sequence: 0, actionCode: "collect_replacement_bin", displayName: "Collect replacement bin", locationRole: "origin_yard", templateStepId: null },
          { sequence: 1, actionCode: "exchange_bin", displayName: "Exchange bin", locationRole: "customer_site", templateStepId: null },
          { sequence: 2, actionCode: "return_replaced_bin", displayName: "Return replaced bin", locationRole: "return_yard", templateStepId: null }
        ]
      });
      const updatedReturn = await query(
        `UPDATE mbt_service_visits
            SET predecessor_visit_id = $2::uuid, bin_type_id = $3::uuid,
                amendment_id = $4::uuid, service_snapshot = $5::jsonb,
                revision = revision + 1, updated_by = $6, updated_at = now()
          WHERE service_visit_id = $1::uuid RETURNING *`,
        [
          returnVisit.service_visit_id, exchangeVisitId, incomingBinTypeId, amendmentId,
          JSON.stringify({
            ...oldReturnSnapshot,
            predecessorVisitId: exchangeVisitId,
            binItemCode: String(incomingType.rows[0].local_item_code),
            binTypeId: incomingBinTypeId
          }),
          String(actor.operatorId)
        ]
      );
      const updatedLine = await query(
        `UPDATE mbt_contract_service_lines
            SET bin_type_id = $2::uuid,
                bin_item_code = CASE WHEN bin_item_code IS NULL THEN NULL ELSE $7 END,
                customer_confirmation_status = $3,
                customer_confirmation_reason = $4,
                customer_confirmation_requested_at = CASE WHEN $3 = 'required' THEN now() ELSE customer_confirmation_requested_at END,
                waiver_snapshot = $5::jsonb,
                pricing_snapshot = pricing_snapshot || $8::jsonb,
                revision = revision + 1,
                updated_by = $6, updated_at = now()
          WHERE service_line_id = $1::uuid RETURNING *`,
        [
          serviceLineId, incomingBinTypeId, customerConfirmation.status,
          customerConfirmation.reason,
          JSON.stringify(waiver), String(actor.operatorId),
          String(incomingType.rows[0].local_item_code),
          JSON.stringify(chargeSnapshot)
        ]
      );
      const updatedContract = await updateContractLineScheduleRollup(contractId, String(actor.operatorId));
      const serviceLine = publicServiceLine({ ...updatedLine.rows[0], bin_type_code: incomingType.rows[0].type_code });
      const result = {
        contract: publicContract(updatedContract.rows[0]), serviceLine,
        amendment: publicAmendment(amendmentResult.rows[0]), exchangeVisit: publicVisit(exchangeVisit),
        returnVisit: publicVisit(updatedReturn.rows[0])
      };
      await insertServiceLineEvent({
        serviceLineId, contractId, visitId: exchangeVisitId, eventType: "exchange",
        before, after: result, reason, actorId: String(actor.operatorId)
      });
      await recordFreeExchangeWaiver({
        chargeMode, serviceLineId, contractId, exchangeVisitId,
        waiver, waiverReason, reason, actorId: actor.operatorId
      });
      return {
        status: 201,
        body: { schemaVersion: "mbt-frontdesk-service-line-exchange-v1", ...result },
        audit: {
          action: "mbt.frontdesk.service_line.exchanged", entityType: "mbt_contract_service_line",
          entityId: serviceLineId, beforeState: before, afterState: result, reason,
          revisionBefore: locked.serviceLine.revision, revisionAfter: serviceLine.revision,
          source: "frontdesk_local"
        }
      };
    }
  });
}

/**
 * Request collection for exactly one physical bin.  Completion is deliberately
 * performed by the existing Driver/visit workflow; migration 123 then closes
 * this line and only closes the parent after every sibling is terminal.
 *
 * @param {Record<string, unknown>} input
 */
export async function collectFrontdeskServiceLine(input) {
  const actor = /** @type {any} */ (input.actor);
  assertFrontdeskActor(actor);
  const contractId = requiredUuid(input.contractId, "Contract ID");
  const serviceLineId = requiredUuid(input.serviceLineId, "Service line ID");
  const expectedRevision = positiveRevision(input.expectedRevision, "Expected service line revision");
  const collectionWindow = jsonObject(input.collectionWindow, "Collection window");
  const startAt = timestamp(collectionWindow.startAt, "Collection window start");
  const endAt = timestamp(collectionWindow.endAt, "Collection window end");
  if (endAt <= startAt) {
    throw failure(400, "MBT_FRONTDESK_INPUT_INVALID", "Collection window end must follow its start.");
  }
  const reason = requiredText(input.reason, "Audit reason");
  const payload = { contractId, serviceLineId, expectedRevision, collectionWindow: { startAt: iso(startAt), endAt: iso(endAt) }, reason };
  return executeMbtCommand({
    actor, commandName: "mbt.frontdesk.service_line.collection",
    idempotencyKey: requiredText(input.idempotencyKey, "Idempotency key"), payload,
    correlationId: requiredText(input.correlationId, "Correlation ID"),
    requestId: requiredText(input.requestId, "Request ID"),
    mutation: async () => {
      const locked = await lockContractServiceLine(contractId, serviceLineId, expectedRevision);
      const returnVisit = await lockReturnVisitForLine(serviceLineId);
      if (locked.lineRow.planned_delivery_at && startAt <= new Date(locked.lineRow.planned_delivery_at)) {
        throw failure(400, "MBT_FRONTDESK_INPUT_INVALID", "The collection window must follow the delivery date.");
      }
      const before = { serviceLine: locked.serviceLine, returnVisit: publicVisit(returnVisit) };
      const updatedVisit = await query(
        `UPDATE mbt_service_visits
            SET scheduled_start_at = $2::timestamptz, scheduled_end_at = $3::timestamptz,
                revision = revision + 1, updated_by = $4, updated_at = now()
          WHERE service_visit_id = $1::uuid RETURNING *`,
        [returnVisit.service_visit_id, iso(startAt), iso(endAt), String(actor.operatorId)]
      );
      const updatedLine = await query(
        `UPDATE mbt_contract_service_lines
            SET status = 'return_due', planned_return_at = $2::timestamptz,
                revision = revision + 1, updated_by = $3, updated_at = now()
          WHERE service_line_id = $1::uuid RETURNING *`,
        [serviceLineId, iso(startAt), String(actor.operatorId)]
      );
      const updatedContract = await updateContractLineScheduleRollup(contractId, String(actor.operatorId));
      const serviceLine = publicServiceLine({ ...updatedLine.rows[0], bin_type_code: locked.lineRow.bin_type_code });
      const result = {
        contract: publicContract(updatedContract.rows[0]), serviceLine,
        collectionVisit: publicVisit(updatedVisit.rows[0])
      };
      await insertServiceLineEvent({
        serviceLineId, contractId, visitId: String(returnVisit.service_visit_id), eventType: "collection",
        before, after: result, reason, actorId: String(actor.operatorId)
      });
      return {
        status: 200,
        body: { schemaVersion: "mbt-frontdesk-service-line-collection-v1", ...result },
        audit: {
          action: "mbt.frontdesk.service_line.collection_requested", entityType: "mbt_contract_service_line",
          entityId: serviceLineId, beforeState: before, afterState: result, reason,
          revisionBefore: locked.serviceLine.revision, revisionAfter: serviceLine.revision,
          source: "frontdesk_local"
        }
      };
    }
  });
}

/** @param {Record<string, unknown>} input */
export async function confirmFrontdeskServiceLineCustomerChange(input) {
  const actor = /** @type {any} */ (input.actor);
  assertFrontdeskActor(actor);
  const contractId = requiredUuid(input.contractId, "Contract ID");
  const serviceLineId = requiredUuid(input.serviceLineId, "Service line ID");
  const expectedRevision = positiveRevision(input.expectedRevision, "Expected service line revision");
  const decision = requiredText(input.decision, "Customer decision");
  if (!["confirmed", "declined"].includes(decision)) {
    throw failure(400, "MBT_FRONTDESK_INPUT_INVALID", "Customer decision must be confirmed or declined.");
  }
  const reason = requiredText(input.reason, "Audit reason");
  const payload = { contractId, serviceLineId, expectedRevision, decision, reason };
  return executeMbtCommand({
    actor, commandName: "mbt.frontdesk.service_line.customer_confirmation",
    idempotencyKey: requiredText(input.idempotencyKey, "Idempotency key"), payload,
    correlationId: requiredText(input.correlationId, "Correlation ID"),
    requestId: requiredText(input.requestId, "Request ID"),
    mutation: async () => {
      const locked = await lockContractServiceLine(contractId, serviceLineId, expectedRevision);
      if (locked.serviceLine.customerConfirmation.status !== "required") {
        throw failure(409, "MBT_FRONTDESK_CONFIRMATION_NOT_REQUIRED", "This physical-bin line does not need customer confirmation.");
      }
      const before = { serviceLine: locked.serviceLine };
      const updatedLine = await query(
        `UPDATE mbt_contract_service_lines
            SET customer_confirmation_status = $2,
                customer_confirmation_confirmed_at = now(),
                customer_confirmation_confirmed_by = $3,
                revision = revision + 1, updated_by = $3, updated_at = now()
          WHERE service_line_id = $1::uuid RETURNING *`,
        [serviceLineId, decision, String(actor.operatorId)]
      );
      const serviceLine = publicServiceLine({ ...updatedLine.rows[0], bin_type_code: locked.lineRow.bin_type_code });
      const result = { serviceLine };
      await insertServiceLineEvent({
        serviceLineId, contractId, eventType: "customer_confirmation",
        before, after: { decision, ...result }, reason, actorId: String(actor.operatorId)
      });
      return {
        status: 200,
        body: { schemaVersion: "mbt-frontdesk-service-line-confirmation-v1", ...result },
        audit: {
          action: "mbt.frontdesk.service_line.customer_confirmation_recorded",
          entityType: "mbt_contract_service_line", entityId: serviceLineId,
          beforeState: before, afterState: result, reason,
          revisionBefore: locked.serviceLine.revision, revisionAfter: serviceLine.revision,
          source: "frontdesk_local"
        }
      };
    }
  });
}

/**
 * Dispatch calls this command after it changes a service-line date/time or
 * bin size.  It intentionally does not re-apply the Dispatch change: it
 * records the before/after evidence and blocks customer-facing execution until
 * Front Desk confirms the change.
 *
 * @param {Record<string, unknown>} input
 */
export async function markFrontdeskServiceLineDispatchChange(input) {
  const actor = /** @type {any} */ (input.actor);
  assertDispatcherOrAdminActor(actor);
  const contractId = requiredUuid(input.contractId, "Contract ID");
  const serviceLineId = requiredUuid(input.serviceLineId, "Service line ID");
  const expectedRevision = positiveRevision(input.expectedRevision, "Expected service line revision");
  const change = jsonObject(input.change, "Dispatch change");
  const kind = requiredText(change.kind, "Dispatch change kind");
  if (!["schedule", "bin_type"].includes(kind)) {
    throw failure(400, "MBT_FRONTDESK_INPUT_INVALID", "Dispatch change kind must be schedule or bin_type.");
  }
  const beforeChange = jsonObject(change.before, "Dispatch change before snapshot");
  const afterChange = jsonObject(change.after, "Dispatch change after snapshot");
  const reason = requiredText(input.reason, "Audit reason");
  const payload = { contractId, serviceLineId, expectedRevision, change: { kind, before: beforeChange, after: afterChange }, reason };
  return executeMbtCommand({
    actor, commandName: "mbt.frontdesk.service_line.dispatch_change",
    idempotencyKey: requiredText(input.idempotencyKey, "Idempotency key"), payload,
    correlationId: requiredText(input.correlationId, "Correlation ID"),
    requestId: requiredText(input.requestId, "Request ID"),
    mutation: async () => {
      const locked = await lockContractServiceLine(contractId, serviceLineId, expectedRevision);
      const before = { serviceLine: locked.serviceLine, change: beforeChange };
      const updatedLine = await query(
        `UPDATE mbt_contract_service_lines
            SET customer_confirmation_status = 'required',
                customer_confirmation_reason = $2,
                customer_confirmation_requested_at = now(),
                revision = revision + 1, updated_by = $3, updated_at = now()
          WHERE service_line_id = $1::uuid RETURNING *`,
        [serviceLineId, `Dispatch changed ${kind}; customer confirmation is required.`, String(actor.operatorId)]
      );
      const serviceLine = publicServiceLine({ ...updatedLine.rows[0], bin_type_code: locked.lineRow.bin_type_code });
      const result = { serviceLine, change: { kind, before: beforeChange, after: afterChange } };
      await insertServiceLineEvent({
        serviceLineId, contractId, eventType: "dispatch_change", before, after: result,
        reason, actorId: String(actor.operatorId)
      });
      return {
        status: 200,
        body: { schemaVersion: "mbt-frontdesk-service-line-dispatch-change-v1", ...result },
        audit: {
          action: "mbt.frontdesk.service_line.dispatch_change_marked",
          entityType: "mbt_contract_service_line", entityId: serviceLineId,
          beforeState: before, afterState: result, reason,
          revisionBefore: locked.serviceLine.revision, revisionAfter: serviceLine.revision,
          source: "dispatch_local"
        }
      };
    }
  });
}
