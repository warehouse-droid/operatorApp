// @ts-check

import crypto from "node:crypto";

import { config } from "../config.js";
import { query } from "../db.js";
import { executeMbtCommand } from "./command-repository.js";
import { MbtError } from "./errors.js";
import { listMbtLocalItemSettings } from "./local-item-settings-repository.js";
import { evaluateMbtPhase3Capability } from "./phase3-capabilities.js";

/** @typedef {import("./audit-repository.js").MbtActor} MbtActor */

const LOCAL_ITEM_CATEGORIES = new Set([
  "bin_charge", "dump", "service", "surcharge", "discount", "cross_charge", "other"
]);
const PRICING_MODES = new Set(["calculated", "rate_card", "rental_item", "custom_price"]);
const LOCAL_ITEM_TYPES = new Set(["bin", "surcharge", "dump", "delivery_fee"]);
const SERVICE_TYPES = new Set(["delivery", "final_pickup", "loaded_pickup", "dump_return", "exchange"]);
const LEGACY_SOURCE_TYPES = new Set(["SO", "TO", "PO", "VRMA"]);
const PROTECTED_ITEM_CODES = new Set(["DELIVERY_CROSS_CHARGE", "14YD", "20YD", "40YD", "DUMP"]);

/** @returns {never} */
function invalidLocalItem() {
  throw new MbtError({
    status: 400,
    code: "MBT_LOCAL_ITEM_INPUT_INVALID",
    message: "The local item contains an unsupported or invalid field."
  });
}

/** @param {string} message @returns {never} */
function invalidMaster(message) {
  throw new MbtError({
    status: 400,
    code: "MBT_MASTER_INPUT_INVALID",
    message
  });
}

/** @param {unknown} value @param {() => never} invalid */
function inputRecord(value, invalid) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalid();
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {Record<string, unknown>} input @param {readonly string[]} allowed @param {() => never} invalid */
function assertAllowedFields(input, allowed, invalid) {
  const accepted = new Set(allowed);
  if (Object.keys(input).some((key) => !accepted.has(key))) {
    return invalid();
  }
}

/** @param {unknown} value @param {number} maximum @param {boolean} allowBlank @param {() => never} invalid */
function boundedText(value, maximum, allowBlank, invalid) {
  if (typeof value !== "string") {
    return invalid();
  }
  const normalized = value.trim();
  if ((!allowBlank && !normalized) || normalized.length > maximum) {
    return invalid();
  }
  return normalized;
}

/** @param {unknown} value @param {RegExp} pattern @param {() => never} invalid */
function normalizedCode(value, pattern, invalid) {
  const code = boundedText(value, 64, false, invalid).toUpperCase();
  return pattern.test(code) ? code : invalid();
}

/** @param {unknown} value @param {() => never} invalid */
function booleanValue(value, invalid) {
  return value === true || value === false ? value : invalid();
}

/** @param {unknown} value @param {() => never} invalid */
function optionalRevision(value, invalid) {
  if (value === undefined) {
    return undefined;
  }
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : invalid();
}

/** @param {unknown} value @param {Set<string>} allowed @param {(entry: string) => string} map @param {() => never} invalid */
function normalizedArray(value, allowed, map, invalid) {
  if (!Array.isArray(value)) {
    return invalid();
  }
  const normalized = [...new Set(value.map((entry) => map(String(entry ?? "").trim())))];
  if (normalized.some((entry) => !allowed.has(entry))) {
    return invalid();
  }
  return normalized;
}

/** @param {unknown} raw */
// eslint-disable-next-line complexity
function normalizeLocalItem(raw) {
  const input = inputRecord(raw, invalidLocalItem);
  assertAllowedFields(input, [
    "itemCode", "displayName", "description", "itemType", "rentalPeriodDays",
    "category", "pricingMode",
    "applicableServiceTypes", "applicableLegacySourceTypes", "binTypeCode", "binCapacityYards",
    "netSuiteMappingLocalKey", "active", "expectedRevision"
  ], invalidLocalItem);
  const legacyCategory = String(input.category ?? "").trim().toLowerCase();
  const legacyPricingMode = String(input.pricingMode ?? "").trim().toLowerCase();
  const inferredType = legacyCategory === "bin_charge"
    ? "bin"
    : legacyCategory === "dump"
      ? "dump"
      : ["surcharge", "discount"].includes(legacyCategory)
        ? "surcharge"
        : "delivery_fee";
  const itemType = String(input.itemType ?? inferredType).trim().toLowerCase();
  const policy = {
    bin: { category: "bin_charge", pricingMode: "rental_item" },
    surcharge: { category: "surcharge", pricingMode: "custom_price" },
    dump: { category: "dump", pricingMode: "rate_card" },
    delivery_fee: { category: "service", pricingMode: "rate_card" }
  }[itemType];
  const category = input.itemType === undefined ? legacyCategory : policy?.category;
  const pricingMode = input.itemType === undefined ? legacyPricingMode : policy?.pricingMode;
  if (!LOCAL_ITEM_TYPES.has(itemType)
      || !LOCAL_ITEM_CATEGORIES.has(String(category))
      || !PRICING_MODES.has(String(pricingMode))) {
    return invalidLocalItem();
  }
  const binTypeCode = input.binTypeCode === undefined || input.binTypeCode === null
    ? null
    : normalizedCode(input.binTypeCode, /^[A-Z0-9][A-Z0-9_-]{0,31}$/, invalidLocalItem);
  const binCapacityYards = input.binCapacityYards === undefined || input.binCapacityYards === null
    ? null
    : Number(input.binCapacityYards);
  if (binCapacityYards !== null
      && (!Number.isSafeInteger(binCapacityYards) || binCapacityYards < 1)) {
    return invalidLocalItem();
  }
  const mapping = input.netSuiteMappingLocalKey === undefined
    ? undefined
    : input.netSuiteMappingLocalKey === null
      ? null
      : boundedText(input.netSuiteMappingLocalKey, 160, false, invalidLocalItem);
  if (typeof mapping === "string" && !/^[a-z][a-z0-9_.:-]*$/.test(mapping)) {
    return invalidLocalItem();
  }
  const revision = optionalRevision(input.expectedRevision, invalidLocalItem);
  const rentalPeriodDays = itemType === "bin"
    ? input.rentalPeriodDays === undefined
      ? 14
      : Number(input.rentalPeriodDays)
    : null;
  if ((itemType === "bin" && (!Number.isSafeInteger(rentalPeriodDays) || Number(rentalPeriodDays) < 1))
      || (itemType !== "bin" && input.rentalPeriodDays !== undefined && input.rentalPeriodDays !== null)) {
    return invalidLocalItem();
  }
  if (itemType === "bin" && binTypeCode === null && binCapacityYards === null) {
    return invalidLocalItem();
  }
  if (itemType !== "bin" && binCapacityYards !== null) {
    return invalidLocalItem();
  }
  if (input.itemType !== undefined && itemType !== "bin" && binTypeCode !== null) {
    return invalidLocalItem();
  }
  const itemCode = normalizedCode(input.itemCode, /^[A-Z0-9][A-Z0-9_]{0,63}$/, invalidLocalItem);
  return {
    itemCode,
    displayName: boundedText(input.displayName, 160, false, invalidLocalItem),
    description: boundedText(input.description, 2000, true, invalidLocalItem),
    itemType,
    rentalPeriodDays,
    category: String(category),
    pricingMode: String(pricingMode),
    applicableServiceTypes: normalizedArray(
      input.applicableServiceTypes,
      SERVICE_TYPES,
      (entry) => entry.toLowerCase(),
      invalidLocalItem
    ),
    applicableLegacySourceTypes: normalizedArray(
      input.applicableLegacySourceTypes,
      LEGACY_SOURCE_TYPES,
      (entry) => entry.toUpperCase(),
      invalidLocalItem
    ),
    binTypeCode,
    ...(binCapacityYards === null ? {} : { binCapacityYards }),
    ...(mapping === undefined ? {} : { netSuiteMappingLocalKey: mapping }),
    active: booleanValue(input.active, invalidLocalItem),
    ...(revision === undefined ? {} : { expectedRevision: revision })
  };
}

/** @param {unknown} raw */
function normalizeMaterial(raw) {
  const invalid = () => invalidMaster("The material row is invalid.");
  const input = inputRecord(raw, invalid);
  assertAllowedFields(input, ["materialCode", "displayName", "description", "active", "expectedRevision"], invalid);
  const revision = optionalRevision(input.expectedRevision, invalid);
  return {
    materialCode: normalizedCode(input.materialCode, /^[A-Z][A-Z0-9_]{0,63}$/, invalid),
    displayName: boundedText(input.displayName, 160, false, invalid),
    description: boundedText(input.description, 2000, true, invalid),
    active: booleanValue(input.active, invalid),
    ...(revision === undefined ? {} : { expectedRevision: revision })
  };
}

/** @param {unknown} value @param {number} minimum @param {number} maximum @param {() => never} invalid */
function coordinate(value, minimum, maximum, invalid) {
  if (value === null) {
    return null;
  }
  const text = String(value ?? "").trim();
  const number = Number(text);
  if (!text || !Number.isFinite(number) || number < minimum || number > maximum) {
    return invalid();
  }
  return text;
}

/** @param {unknown} value @param {() => never} invalid */
function dumpSiteItemAcceptances(value, invalid) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    return invalid();
  }
  const acceptances = value.map((raw) => {
    const entry = inputRecord(raw, invalid);
    assertAllowedFields(entry, ["itemCode", "accepted", "scaleTicketRequired", "notes", "active"], invalid);
    return {
      itemCode: normalizedCode(entry.itemCode, /^[A-Z][A-Z0-9_]{0,63}$/, invalid),
      accepted: booleanValue(entry.accepted, invalid),
      scaleTicketRequired: booleanValue(entry.scaleTicketRequired, invalid),
      notes: boundedText(entry.notes ?? "", 2000, true, invalid),
      active: entry.active === undefined ? true : booleanValue(entry.active, invalid)
    };
  });
  const codes = acceptances.map(({ itemCode }) => itemCode);
  if (new Set(codes).size !== codes.length
      || !acceptances.some(({ accepted, active }) => accepted && active)) {
    return invalid();
  }
  return acceptances.sort((left, right) => left.itemCode.localeCompare(right.itemCode));
}

/** @param {unknown} value @param {() => never} invalid */
function dumpSiteOpeningHours(value, invalid) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 7) {
    return invalid();
  }
  const hours = value.map((raw) => {
    const entry = inputRecord(raw, invalid);
    assertAllowedFields(entry, ["isoWeekday", "opensAt", "closesAt"], invalid);
    const isoWeekday = Number(entry.isoWeekday);
    const opensAt = String(entry.opensAt ?? "").trim();
    const closesAt = String(entry.closesAt ?? "").trim();
    if (!Number.isSafeInteger(isoWeekday) || isoWeekday < 1 || isoWeekday > 7
        || !/^([01]\d|2[0-3]):[0-5]\d$/u.test(opensAt)
        || !/^([01]\d|2[0-3]):[0-5]\d$/u.test(closesAt)
        || closesAt <= opensAt) {
      return invalid();
    }
    return { isoWeekday, opensAt, closesAt };
  });
  if (new Set(hours.map(({ isoWeekday }) => isoWeekday)).size !== hours.length) {
    return invalid();
  }
  return hours.sort((left, right) => left.isoWeekday - right.isoWeekday);
}

/** @param {unknown} raw */
// eslint-disable-next-line complexity -- The boundary explicitly supports legacy single-item and current multi-item shapes.
function normalizeDumpSite(raw) {
  const invalid = () => invalidMaster("The dump-site row is invalid.");
  const input = inputRecord(raw, invalid);
  assertAllowedFields(input, [
    "dumpSiteCode", "displayName", "addressLine1", "addressLine2", "city",
    "region", "postalCode", "countryCode", "phone", "latitude", "longitude",
    "itemCode", "materialCode", "accepted", "scaleTicketRequired", "itemAcceptances",
    "openingHours", "notes", "active",
    "expectedRevision"
  ], invalid);
  const latitude = coordinate(input.latitude, -90, 90, invalid);
  const longitude = coordinate(input.longitude, -180, 180, invalid);
  if ((latitude === null) !== (longitude === null)) {
    return invalid();
  }
  const countryCode = boundedText(input.countryCode, 2, false, invalid).toUpperCase();
  if (!/^[A-Z]{2}$/.test(countryCode)) {
    return invalid();
  }
  const revision = optionalRevision(input.expectedRevision, invalid);
  const hasAcceptanceList = input.itemAcceptances !== undefined;
  const hasLegacyAcceptance = input.itemCode !== undefined || input.materialCode !== undefined
    || input.accepted !== undefined || input.scaleTicketRequired !== undefined;
  if (hasAcceptanceList && hasLegacyAcceptance) {
    return invalid();
  }
  const itemAcceptances = hasAcceptanceList
    ? dumpSiteItemAcceptances(input.itemAcceptances, invalid)
    : null;
  const rawItemCode = input.itemCode ?? input.materialCode;
  const itemCode = hasAcceptanceList
    ? null
    : normalizedCode(rawItemCode, /^[A-Z][A-Z0-9_]{0,63}$/, invalid);
  const openingHours = input.openingHours === undefined
    ? null
    : dumpSiteOpeningHours(input.openingHours, invalid);
  return {
    dumpSiteCode: normalizedCode(input.dumpSiteCode, /^[A-Z][A-Z0-9_]{0,63}$/, invalid),
    displayName: boundedText(input.displayName, 160, false, invalid),
    addressLine1: boundedText(input.addressLine1, 500, true, invalid),
    addressLine2: boundedText(input.addressLine2, 500, true, invalid),
    city: boundedText(input.city, 160, true, invalid),
    region: boundedText(input.region, 80, true, invalid),
    postalCode: boundedText(input.postalCode, 32, true, invalid),
    countryCode,
    phone: boundedText(input.phone, 80, true, invalid),
    latitude,
    longitude,
    ...(hasAcceptanceList
      ? { itemAcceptances }
      : input.itemCode === undefined
        ? { materialCode: itemCode }
        : { itemCode }),
    ...(hasAcceptanceList ? {} : {
      accepted: booleanValue(input.accepted, invalid),
      scaleTicketRequired: booleanValue(input.scaleTicketRequired, invalid)
    }),
    ...(openingHours === null ? {} : { openingHours }),
    notes: boundedText(input.notes, 2000, true, invalid),
    active: booleanValue(input.active, invalid),
    ...(revision === undefined ? {} : { expectedRevision: revision })
  };
}

/** @param {unknown} value @param {() => never} invalid */
function templateSteps(value, invalid) {
  if (!Array.isArray(value) || value.length === 0) {
    return invalid();
  }
  const steps = value.map((raw) => {
    const step = inputRecord(raw, invalid);
    assertAllowedFields(step, [
      "sequenceNumber", "actionCode", "displayName", "stopKind", "locationRole",
      "requiredAssetStatusBefore", "requiredAssetStatusAfter", "dumpSiteRequired", "required"
    ], invalid);
    const sequenceNumber = Number(step.sequenceNumber);
    if (!Number.isSafeInteger(sequenceNumber) || sequenceNumber < 0) {
      return invalid();
    }
    return {
      sequenceNumber,
      actionCode: boundedText(step.actionCode, 80, false, invalid).toLowerCase(),
      displayName: boundedText(step.displayName, 160, false, invalid),
      stopKind: boundedText(step.stopKind, 80, false, invalid).toLowerCase(),
      locationRole: boundedText(step.locationRole, 80, false, invalid).toLowerCase(),
      requiredAssetStatusBefore: step.requiredAssetStatusBefore === null
        ? null
        : boundedText(step.requiredAssetStatusBefore, 80, false, invalid).toLowerCase(),
      requiredAssetStatusAfter: step.requiredAssetStatusAfter === null
        ? null
        : boundedText(step.requiredAssetStatusAfter, 80, false, invalid).toLowerCase(),
      dumpSiteRequired: step.dumpSiteRequired === undefined
        ? false
        : booleanValue(step.dumpSiteRequired, invalid),
      required: booleanValue(step.required, invalid)
    };
  });
  const sequences = new Set(steps.map(({ sequenceNumber }) => sequenceNumber));
  const actions = new Set(steps.map(({ actionCode }) => actionCode));
  if (sequences.size !== steps.length || actions.size !== steps.length) {
    return invalid();
  }
  return steps.sort((left, right) => left.sequenceNumber - right.sequenceNumber);
}

/** @param {unknown} value @param {Set<string>} actions @param {() => never} invalid */
function templateEvidence(value, actions, invalid) {
  if (!Array.isArray(value) || value.length === 0) {
    return invalid();
  }
  const evidence = value.map((raw) => {
    const requirement = inputRecord(raw, invalid);
    assertAllowedFields(requirement, [
      "stepActionCode", "evidenceCode", "evidenceType", "minimumCount", "required", "description"
    ], invalid);
    const stepActionCode = boundedText(requirement.stepActionCode, 80, false, invalid).toLowerCase();
    const minimumCount = Number(requirement.minimumCount);
    if (!actions.has(stepActionCode) || !Number.isSafeInteger(minimumCount) || minimumCount < 1) {
      return invalid();
    }
    const evidenceType = boundedText(requirement.evidenceType, 40, false, invalid).toLowerCase();
    if (!["photo", "receipt", "bin_scan", "weight", "quantity", "signature", "note"].includes(evidenceType)) {
      return invalid();
    }
    return {
      stepActionCode,
      evidenceCode: boundedText(requirement.evidenceCode, 80, false, invalid).toLowerCase(),
      evidenceType,
      minimumCount,
      required: booleanValue(requirement.required, invalid),
      description: requirement.description === undefined
        ? ""
        : boundedText(requirement.description, 1000, true, invalid)
    };
  });
  if (new Set(evidence.map(({ evidenceCode }) => evidenceCode)).size !== evidence.length) {
    return invalid();
  }
  return evidence;
}

/** @param {unknown} raw */
function normalizeServiceTemplate(raw) {
  const invalid = () => invalidMaster("The service-template row is invalid.");
  const input = inputRecord(raw, invalid);
  assertAllowedFields(input, [
    "templateCode", "displayName", "description", "active", "versionNumber", "status",
    "requiredBinService", "dumpSiteRequired", "steps", "evidenceRequirements",
    "expectedRevision"
  ], invalid);
  const versionNumber = Number(input.versionNumber);
  if (!Number.isSafeInteger(versionNumber) || versionNumber < 1 || input.status !== "draft") {
    return invalid();
  }
  const steps = templateSteps(input.steps, invalid);
  const evidenceRequirements = templateEvidence(
    input.evidenceRequirements,
    new Set(steps.map(({ actionCode }) => actionCode)),
    invalid
  );
  const revision = optionalRevision(input.expectedRevision, invalid);
  return {
    templateCode: normalizedCode(input.templateCode, /^[A-Z][A-Z0-9_]{0,63}$/, invalid),
    displayName: boundedText(input.displayName, 160, false, invalid),
    description: boundedText(input.description, 2000, true, invalid),
    active: booleanValue(input.active, invalid),
    versionNumber,
    status: "draft",
    requiredBinService: booleanValue(input.requiredBinService, invalid),
    dumpSiteRequired: booleanValue(input.dumpSiteRequired, invalid),
    steps,
    evidenceRequirements,
    ...(revision === undefined ? {} : { expectedRevision: revision })
  };
}

/** @param {unknown} resource @param {unknown} row */
export function normalizeLocalMasterDataRow(resource, row) {
  switch (String(resource || "")) {
    case "local_items": return normalizeLocalItem(row);
    case "materials": return normalizeMaterial(row);
    case "dump_sites": return normalizeDumpSite(row);
    case "service_templates": return normalizeServiceTemplate(row);
    default: return invalidMaster("The local master-data resource is unsupported.");
  }
}

/** @param {string} resource */
export async function listLocalMasterData(resource) {
  if (resource === "local_items") {
    return { resource, entities: await listMbtLocalItemSettings() };
  }
  if (resource === "materials") {
    const result = await query(
      `SELECT material_id::text, material_code, display_name, description,
              active, revision::int, created_at, updated_at
         FROM mbt_materials
        ORDER BY material_code`
    );
    return {
      resource,
      entities: result.rows.map((/** @type {Record<string, unknown>} */ row) => ({
        materialId: String(row.material_id),
        materialCode: String(row.material_code),
        displayName: String(row.display_name),
        description: String(row.description || ""),
        active: row.active === true,
        revision: Number(row.revision),
        createdAt: new Date(String(row.created_at)).toISOString(),
        updatedAt: new Date(String(row.updated_at)).toISOString()
      }))
    };
  }
  if (resource === "dump_sites") {
    const result = await query(
      `SELECT site.dump_site_id::text, site.dump_site_code, site.display_name,
              site.address_line_1, site.address_line_2, site.city, site.region,
              site.postal_code, site.country_code, site.phone,
              site.operational_notes, site.latitude::text, site.longitude::text,
              site.active, site.revision::int,
              COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                  'itemCode', item.item_code,
                  'displayName', item.display_name,
                  'accepted', acceptance.accepted,
                  'scaleTicketRequired', acceptance.scale_ticket_required,
                  'active', acceptance.active,
                  'revision', acceptance.revision
                ) ORDER BY item.item_code)
                  FROM mbt_dump_site_items acceptance
                  JOIN mbt_local_item_settings item
                    ON item.item_code = acceptance.item_code
                 WHERE acceptance.dump_site_id = site.dump_site_id
              ), '[]'::jsonb) AS dump_items,
              COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                  'isoWeekday', hours.iso_weekday,
                  'opensAt', to_char(hours.opens_at, 'HH24:MI'),
                  'closesAt', to_char(hours.closes_at, 'HH24:MI'),
                  'revision', hours.revision
                ) ORDER BY hours.iso_weekday)
                  FROM mbt_dump_site_opening_hours hours
                 WHERE hours.dump_site_id = site.dump_site_id
              ), '[]'::jsonb) AS opening_hours
         FROM mbt_dump_sites site
        ORDER BY site.dump_site_code`
    );
    return {
      resource,
      entities: result.rows.map((/** @type {Record<string, unknown>} */ row) => {
        const dumpItems = Array.isArray(row.dump_items) ? row.dump_items : [];
        return {
          dumpSiteId: String(row.dump_site_id),
          dumpSiteCode: String(row.dump_site_code),
          displayName: String(row.display_name),
          addressLine1: String(row.address_line_1 || ""),
          addressLine2: String(row.address_line_2 || ""),
          city: String(row.city || ""),
          region: String(row.region || ""),
          postalCode: String(row.postal_code || ""),
          countryCode: String(row.country_code || ""),
          phone: String(row.phone || ""),
          notes: String(row.operational_notes || ""),
          latitude: row.latitude,
          longitude: row.longitude,
          active: row.active === true,
          revision: Number(row.revision),
          dumpItems,
          openingHours: Array.isArray(row.opening_hours) ? row.opening_hours : [],
          // Cached configuration clients may still read this name. It is a
          // DTO alias only; the user-facing concept is the local dump item.
          materials: dumpItems.map((entry) => ({
            materialCode: entry.itemCode,
            accepted: entry.accepted,
            scaleTicketRequired: entry.scaleTicketRequired,
            active: entry.active,
            revision: entry.revision
          }))
        };
      })
    };
  }
  if (resource === "service_templates") {
    const result = await query(
      `SELECT template.template_id::text, template.template_code,
              template.display_name, template.description, template.active,
              template.revision::int,
              COALESCE(jsonb_agg(jsonb_build_object(
                'templateVersionId', version.template_version_id,
                'versionNumber', version.version_number,
                'status', version.status,
                'requiredBinService', version.required_bin_service,
                'dumpSiteRequired', version.dump_site_required,
                'revision', version.revision
              ) ORDER BY version.version_number)
              FILTER (WHERE version.template_version_id IS NOT NULL), '[]'::jsonb) AS versions
         FROM mbt_service_templates template
         LEFT JOIN mbt_service_template_versions version
           ON version.template_id = template.template_id
        GROUP BY template.template_id
        ORDER BY template.template_code`
    );
    return {
      resource,
      entities: result.rows.map((/** @type {Record<string, unknown>} */ row) => ({
        templateId: String(row.template_id),
        templateCode: String(row.template_code),
        displayName: String(row.display_name),
        description: String(row.description || ""),
        active: row.active === true,
        revision: Number(row.revision),
        versions: Array.isArray(row.versions) ? row.versions : []
      }))
    };
  }
  return invalidMaster("The local master-data resource is unsupported.");
}

/** @param {MbtActor} actor */
async function assertMasterDataEnabled(actor) {
  const flags = await query(
    "SELECT flag_key, enabled FROM mbt_feature_flags WHERE flag_key = ANY($1::text[])",
    [["mbt_enabled", "mbt_master_data"]]
  );
  const databaseFlags = Object.fromEntries(flags.rows.map(
    (/** @type {Record<string, unknown>} */ row) => [String(row.flag_key), row.enabled === true]
  ));
  const decision = evaluateMbtPhase3Capability({
    capability: "masterData",
    environment: {
      enabled: config.mbt.enabled,
      masterDataEnabled: config.mbtPhase3.masterDataEnabled
    },
    databaseFlags,
    pilotAuthorized: actor?.roles?.some((role) => String(role).toLowerCase() === "admin") === true
  });
  if (!decision.enabled) {
    throw new MbtError({
      status: 409,
      code: String(decision.code || "MBT_CAPABILITY_DISABLED"),
      message: "MBT master data is disabled.",
      details: { capability: "master_data", reason: decision.reason }
    });
  }
}

/** @param {unknown} actual @param {unknown} expected */
function assertRevision(actual, expected) {
  if (!Number.isSafeInteger(expected) || Number(expected) < 1) {
    return invalidMaster("A positive expected revision is required for an update.");
  }
  if (Number(actual) !== Number(expected)) {
    throw new MbtError({
      status: 409,
      code: "MBT_STALE_REVISION",
      message: "This local record changed. Refresh it before saving again."
    });
  }
}

/** @returns {never} */
function invalidBinBinding(message = "The local item BIN type is unavailable.") {
  throw new MbtError({ status: 400, code: "MBT_MASTER_REFERENCE_INVALID", message });
}

/** @param {Record<string, unknown>} row @param {Record<string, unknown>} before */
function existingBinTypeId(row, before) {
  if (before.item_type !== "bin") {
    return invalidBinBinding("A local item's operational type cannot be changed after creation.");
  }
  const typeChanged = Boolean(row.binTypeCode)
    && String(row.binTypeCode) !== String(before.bin_type_code);
  const capacityChanged = row.binCapacityYards !== undefined
    && Number(row.binCapacityYards) !== Number(before.bin_capacity_yards);
  const ownerChanged = String(before.bin_local_item_code || "") !== String(row.itemCode);
  if (typeChanged || capacityChanged || ownerChanged) {
    return invalidBinBinding("A local BIN item's capacity and operational binding cannot be changed after creation.");
  }
  return String(before.bin_type_id);
}

/** @param {Record<string, unknown>} stored @param {Record<string, unknown>} row */
function assertClaimableBinType(stored, row) {
  const wrongOwner = stored.local_item_code !== null
    && String(stored.local_item_code) !== String(row.itemCode);
  const wrongCapacity = row.binCapacityYards !== undefined
    && Number(stored.nominal_yards) !== Number(row.binCapacityYards);
  if (stored.active !== true || wrongOwner || wrongCapacity) {
    return invalidBinBinding("The local BIN item conflicts with an existing operational binding or capacity.");
  }
}

/** @param {Record<string, unknown>} stored @param {Record<string, unknown>} row @param {MbtActor} actor */
async function claimBinType(stored, row, actor) {
  assertClaimableBinType(stored, row);
  if (stored.local_item_code === null) {
    await query(
      `UPDATE mbt_bin_types
          SET local_item_code = $2, updated_by = $3, updated_at = now()
        WHERE bin_type_id = $1`,
      [stored.bin_type_id, row.itemCode, actor.operatorId]
    );
  }
  return String(stored.bin_type_id);
}

/** @param {string} typeCode @param {Record<string, unknown>} row @param {MbtActor} actor */
async function createOwnedBinType(typeCode, row, actor) {
  if (row.binCapacityYards === undefined) {
    return invalidBinBinding();
  }
  const binTypeId = crypto.randomUUID();
  await query(
    `INSERT INTO mbt_bin_types (
       bin_type_id, type_code, display_name, nominal_yards, active,
       local_item_code, revision, created_by, updated_by
     ) VALUES ($1, $2, $3, $4, true, $5, 1, $6, $6)`,
    [binTypeId, typeCode, row.displayName, row.binCapacityYards, row.itemCode, actor.operatorId]
  );
  return binTypeId;
}

/**
 * Resolve the internal operational BIN-type binding. New user-facing BIN
 * items own a generated type row; callers never need to create that row in a
 * second screen. Existing items retain an immutable one-to-one binding.
 *
 * @param {Record<string, unknown>} row
 * @param {MbtActor} actor
 * @param {Record<string, unknown> | null} before
 */
async function resolveBinType(row, actor, before = null) {
  if (row.itemType !== "bin") {
    if (before?.item_type === "bin") {
      return invalidBinBinding("A local item's operational type cannot be changed after creation.");
    }
    return null;
  }
  if (before) {
    return existingBinTypeId(row, before);
  }

  const typeCode = String(row.binTypeCode || row.itemCode);
  const selected = await query(
    `SELECT bin_type_id::text AS bin_type_id, type_code, nominal_yards::int,
            local_item_code, active
       FROM mbt_bin_types
      WHERE type_code = $1 OR local_item_code = $2
      ORDER BY type_code
      FOR UPDATE`,
    [typeCode, row.itemCode]
  );
  if (selected.rowCount > 1) {
    return invalidBinBinding("The local BIN item conflicts with an existing operational binding.");
  }
  if (selected.rowCount) {
    return claimBinType(selected.rows[0], row, actor);
  }
  return createOwnedBinType(typeCode, row, actor);
}

/** @param {Record<string, unknown>} row @param {MbtActor} actor @param {unknown} binTypeId */
async function createLocalItem(row, actor, binTypeId) {
  const code = String(row.itemCode);
  await query(
    `INSERT INTO mbt_local_item_settings (
       item_code, display_name, description, item_type, rental_period_days,
       category, bin_type_id, pricing_mode,
       netsuite_mapping_local_key, system_owned, applicable_service_types,
       applicable_legacy_source_types, active, revision, created_by, updated_by
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, false, $10::text[], $11::text[], $12, 1, $13, $13)`,
    [
      code, row.displayName, row.description, row.itemType, row.rentalPeriodDays,
      row.category, binTypeId, row.pricingMode, row.netSuiteMappingLocalKey ?? null,
      row.applicableServiceTypes, row.applicableLegacySourceTypes, row.active,
      actor.operatorId
    ]
  );
  return { entityId: code, action: "created", revisionBefore: 1, revisionAfter: 1, before: { exists: false, revision: 1 } };
}

/**
 * Driver and Dispatch still reference the original material UUID on receipts
 * and planned dump visits. Keep that row as an internal projection of a dump
 * item until those historical references can be retired safely.
 *
 * @param {Record<string, unknown>} row
 * @param {MbtActor} actor
 */
async function mirrorDumpItemToLegacyMaterial(row, actor) {
  if (row.itemType !== "dump") {
    return;
  }
  await query(
    `INSERT INTO mbt_materials (
       material_id, material_code, display_name, description, active,
       revision, created_by, updated_by
     ) VALUES ($1, $2, $3, $4, $5, 1, $6, $6)
     ON CONFLICT (material_code) DO UPDATE
       SET display_name = EXCLUDED.display_name,
           description = EXCLUDED.description,
           active = EXCLUDED.active,
           revision = mbt_materials.revision + 1,
           updated_by = EXCLUDED.updated_by,
           updated_at = now()`,
    [
      crypto.randomUUID(), row.itemCode, row.displayName, row.description,
      row.active, actor.operatorId
    ]
  );
}

/** @param {Record<string, unknown>} row @param {MbtActor} actor */
async function mirrorLegacyMaterialToDumpItem(row, actor) {
  const code = String(row.materialCode);
  const selected = await query(
    "SELECT * FROM mbt_local_item_settings WHERE item_code = $1 FOR UPDATE",
    [code]
  );
  if (selected.rowCount && selected.rows[0].item_type !== "dump") {
    throw new MbtError({
      status: 409,
      code: "MBT_LOCAL_ITEM_TYPE_CONFLICT",
      message: "The legacy material code is already used by a non-dump local item."
    });
  }
  if (!selected.rowCount) {
    await query(
      `INSERT INTO mbt_local_item_settings (
         item_code, display_name, description, item_type, rental_period_days,
         category, bin_type_id, pricing_mode, netsuite_mapping_local_key,
         system_owned, applicable_service_types, applicable_legacy_source_types,
         active, revision, created_by, updated_by
       ) VALUES ($1, $2, $3, 'dump', NULL, 'dump', NULL, 'rate_card', NULL,
                 false, ARRAY['dump_return']::text[], ARRAY[]::text[],
                 $4, 1, $5, $5)`,
      [code, row.displayName, row.description, row.active, actor.operatorId]
    );
    return;
  }
  await query(
    `UPDATE mbt_local_item_settings
        SET display_name = $2,
            description = $3,
            active = $4,
            revision = revision + 1,
            updated_by = $5,
            updated_at = now()
      WHERE item_code = $1`,
    [code, row.displayName, row.description, row.active, actor.operatorId]
  );
}

/** @param {Record<string, unknown>} before @param {Record<string, unknown>} row */
function protectedItemIdentityChanged(before, row) {
  return String(before.item_type) !== row.itemType
    || Number(before.rental_period_days || 0) !== Number(row.rentalPeriodDays || 0)
    || String(before.category) !== row.category
    || String(before.pricing_mode) !== row.pricingMode
    || (before.bin_type_code === null ? null : String(before.bin_type_code)) !== row.binTypeCode
    || JSON.stringify(before.applicable_service_types || []) !== JSON.stringify(row.applicableServiceTypes)
    || JSON.stringify(before.applicable_legacy_source_types || []) !== JSON.stringify(row.applicableLegacySourceTypes);
}

/** @param {Record<string, unknown>} before @param {Record<string, unknown>} row */
function assertProtectedItemIdentity(before, row) {
  const code = String(row.itemCode);
  if (before.system_owned !== true) {
    return;
  }
  if (protectedItemIdentityChanged(before, row) || !PROTECTED_ITEM_CODES.has(code)) {
    throw new MbtError({
      status: 409,
      code: "MBT_PROTECTED_LOCAL_ITEM_IDENTITY",
      message: "A protected local item identity cannot be changed."
    });
  }
}

/** @param {Record<string, unknown>} before @param {Record<string, unknown>} row @param {MbtActor} actor @param {unknown} binTypeId */
async function updateLocalItem(before, row, actor, binTypeId) {
  const code = String(row.itemCode);
  assertRevision(Number(before.revision), row.expectedRevision);
  assertProtectedItemIdentity(before, row);
  const nextRevision = Number(before.revision) + 1;
  await query(
    `UPDATE mbt_local_item_settings
        SET display_name = $2,
            description = $3,
            item_type = $4,
            rental_period_days = $5,
            category = $6,
            bin_type_id = $7,
            pricing_mode = $8,
            netsuite_mapping_local_key = $9,
            applicable_service_types = $10::text[],
            applicable_legacy_source_types = $11::text[],
            active = $12,
            revision = $13,
            updated_by = $14,
            updated_at = now()
      WHERE item_code = $1`,
    [
      code, row.displayName, row.description, row.itemType, row.rentalPeriodDays,
      row.category, binTypeId, row.pricingMode,
      row.netSuiteMappingLocalKey ?? before.netsuite_mapping_local_key,
      row.applicableServiceTypes, row.applicableLegacySourceTypes, row.active,
      nextRevision, actor.operatorId
    ]
  );
  return {
    entityId: code,
    action: "updated",
    revisionBefore: Number(before.revision),
    revisionAfter: nextRevision,
    before: { itemCode: code, revision: Number(before.revision), active: before.active === true }
  };
}

/** @param {Record<string, unknown>} row @param {MbtActor} actor */
async function applyLocalItem(row, actor) {
  const code = String(row.itemCode);
  const selected = await query(
    `SELECT setting.*, bin_type.type_code AS bin_type_code,
            bin_type.nominal_yards::int AS bin_capacity_yards,
            bin_type.local_item_code AS bin_local_item_code
       FROM mbt_local_item_settings setting
       LEFT JOIN mbt_bin_types bin_type ON bin_type.bin_type_id = setting.bin_type_id
      WHERE setting.item_code = $1
      FOR UPDATE OF setting`,
    [code]
  );
  const before = selected.rowCount ? selected.rows[0] : null;
  if (before) {
    // Preserve the explicit protected-identity contract before the generic
    // BIN-binding guard has a chance to classify the same mutation.
    assertProtectedItemIdentity(before, row);
  }
  const binTypeId = await resolveBinType(row, actor, before);
  const change = selected.rowCount
    ? updateLocalItem(selected.rows[0], row, actor, binTypeId)
    : createLocalItem(row, actor, binTypeId);
  const result = await change;
  await mirrorDumpItemToLegacyMaterial(row, actor);
  return result;
}

/** @param {Record<string, unknown>} row @param {MbtActor} actor */
async function applyMaterial(row, actor) {
  const code = String(row.materialCode);
  const selected = await query("SELECT * FROM mbt_materials WHERE material_code = $1 FOR UPDATE", [code]);
  if (!selected.rowCount) {
    await query(
      `INSERT INTO mbt_materials (
         material_id, material_code, display_name, description, active, revision, created_by, updated_by
       ) VALUES ($1, $2, $3, $4, $5, 1, $6, $6)`,
      [crypto.randomUUID(), code, row.displayName, row.description, row.active, actor.operatorId]
    );
    await mirrorLegacyMaterialToDumpItem(row, actor);
    return { entityId: code, action: "created", revisionBefore: 1, revisionAfter: 1, before: { exists: false, revision: 1 } };
  }
  const before = selected.rows[0];
  assertRevision(Number(before.revision), row.expectedRevision);
  const nextRevision = Number(before.revision) + 1;
  await query(
    `UPDATE mbt_materials
        SET display_name = $2, description = $3, active = $4, revision = $5,
            updated_by = $6, updated_at = now()
      WHERE material_code = $1`,
    [code, row.displayName, row.description, row.active, nextRevision, actor.operatorId]
  );
  await mirrorLegacyMaterialToDumpItem(row, actor);
  return {
    entityId: code,
    action: "updated",
    revisionBefore: Number(before.revision),
    revisionAfter: nextRevision,
    before: { materialCode: code, revision: Number(before.revision), active: before.active === true }
  };
}

/** @param {Record<string, unknown>} row @param {MbtActor} actor */
// eslint-disable-next-line complexity -- Site, acceptance projections, and hours must update in one transaction.
async function applyDumpSite(row, actor) {
  const exactAcceptances = Array.isArray(row.itemAcceptances);
  const acceptances = exactAcceptances
    ? /** @type {Array<Record<string, any>>} */ (row.itemAcceptances)
    : [{
      itemCode: String(row.itemCode || row.materialCode || ""),
      accepted: row.accepted,
      scaleTicketRequired: row.scaleTicketRequired,
      notes: row.notes,
      active: true
    }];
  const itemCodes = acceptances.map(({ itemCode }) => String(itemCode));
  const items = await query(
    `SELECT item.item_code, item.display_name, item.description, item.active,
            material.material_id::text AS material_id
       FROM mbt_local_item_settings item
       LEFT JOIN mbt_materials material ON material.material_code = item.item_code
      WHERE item.item_code = ANY($1::text[])
        AND item.item_type = 'dump'
        AND item.active
      FOR UPDATE OF item`,
    [itemCodes]
  );
  if (items.rowCount !== itemCodes.length) {
    throw new MbtError({ status: 400, code: "MBT_MASTER_REFERENCE_INVALID", message: "One or more dump-site items are unavailable." });
  }
  for (const item of items.rows) {
    if (!item.material_id) {
      await mirrorDumpItemToLegacyMaterial({
        itemCode: item.item_code,
        itemType: "dump",
        displayName: item.display_name,
        description: item.description,
        active: item.active
      }, actor);
    }
  }
  const materialRows = await query(
    `SELECT item.item_code, material.material_id::text AS material_id
       FROM mbt_local_item_settings item
       JOIN mbt_materials material ON material.material_code = item.item_code
      WHERE item.item_code = ANY($1::text[])
      FOR UPDATE OF material`,
    [itemCodes]
  );
  if (materialRows.rowCount !== itemCodes.length) {
    throw new MbtError({ status: 422, code: "MBT_MASTER_REFERENCE_INVALID", message: "Dump-item compatibility material creation failed safely." });
  }
  const materialByItem = new Map(materialRows.rows.map(
    (/** @type {Record<string, any>} */ item) => [String(item.item_code), String(item.material_id)]
  ));
  const code = String(row.dumpSiteCode);
  const selected = await query("SELECT * FROM mbt_dump_sites WHERE dump_site_code = $1 FOR UPDATE", [code]);
  let dumpSiteId;
  let revisionBefore = 1;
  let revisionAfter = 1;
  let action = "created";
  /** @type {Record<string, unknown>} */
  let before = { exists: false, revision: 1 };
  if (!selected.rowCount) {
    dumpSiteId = crypto.randomUUID();
    await query(
      `INSERT INTO mbt_dump_sites (
         dump_site_id, dump_site_code, display_name, address_line_1, address_line_2,
         city, region, postal_code, country_code, phone, operational_notes,
         latitude, longitude, active, revision, created_by, updated_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                 $12::numeric, $13::numeric, $14, 1, $15, $15)`,
      [
        dumpSiteId, code, row.displayName, row.addressLine1, row.addressLine2,
        row.city, row.region, row.postalCode, row.countryCode, row.phone, row.notes,
        row.latitude, row.longitude, row.active, actor.operatorId
      ]
    );
  } else {
    const stored = selected.rows[0];
    assertRevision(Number(stored.revision), row.expectedRevision);
    dumpSiteId = stored.dump_site_id;
    revisionBefore = Number(stored.revision);
    revisionAfter = revisionBefore + 1;
    action = "updated";
    before = { dumpSiteCode: code, revision: revisionBefore, active: stored.active === true };
    await query(
      `UPDATE mbt_dump_sites
          SET display_name = $2, address_line_1 = $3, address_line_2 = $4,
              city = $5, region = $6, postal_code = $7, country_code = $8,
              phone = $9, operational_notes = $10, latitude = $11::numeric,
              longitude = $12::numeric, active = $13, revision = $14,
              updated_by = $15, updated_at = now()
        WHERE dump_site_code = $1`,
      [
        code, row.displayName, row.addressLine1, row.addressLine2, row.city, row.region,
        row.postalCode, row.countryCode, row.phone, row.notes, row.latitude,
        row.longitude, row.active, revisionAfter, actor.operatorId
      ]
    );
  }
  for (const acceptance of acceptances) {
    const itemCode = String(acceptance.itemCode);
    const materialId = materialByItem.get(itemCode);
    await query(
      `INSERT INTO mbt_dump_site_items (
         dump_site_item_id, dump_site_id, item_code, accepted,
         scale_ticket_required, operational_notes, active, revision, created_by, updated_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, $8)
       ON CONFLICT (dump_site_id, item_code) DO UPDATE
         SET accepted = EXCLUDED.accepted,
             scale_ticket_required = EXCLUDED.scale_ticket_required,
             operational_notes = EXCLUDED.operational_notes,
             active = EXCLUDED.active,
             revision = mbt_dump_site_items.revision + 1,
             updated_by = EXCLUDED.updated_by,
             updated_at = now()`,
      [
        crypto.randomUUID(), dumpSiteId, itemCode, acceptance.accepted,
        acceptance.scaleTicketRequired, acceptance.notes || "", acceptance.active,
        actor.operatorId
      ]
    );
    await query(
      `INSERT INTO mbt_dump_site_materials (
         dump_site_material_id, dump_site_id, material_id, accepted,
         scale_ticket_required, operational_notes, active, revision, created_by, updated_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, $8)
       ON CONFLICT (dump_site_id, material_id) DO UPDATE
         SET accepted = EXCLUDED.accepted,
             scale_ticket_required = EXCLUDED.scale_ticket_required,
             operational_notes = EXCLUDED.operational_notes,
             active = EXCLUDED.active,
             revision = mbt_dump_site_materials.revision + 1,
             updated_by = EXCLUDED.updated_by,
             updated_at = now()`,
      [
        crypto.randomUUID(), dumpSiteId, materialId, acceptance.accepted,
        acceptance.scaleTicketRequired, acceptance.notes || "", acceptance.active,
        actor.operatorId
      ]
    );
  }
  if (exactAcceptances) {
    const materialIds = itemCodes.map((itemCode) => materialByItem.get(itemCode));
    await query(
      `UPDATE mbt_dump_site_items
          SET accepted = false, active = false, revision = revision + 1,
              updated_by = $3, updated_at = now()
        WHERE dump_site_id = $1
          AND item_code <> ALL($2::text[])
          AND (accepted OR active)`,
      [dumpSiteId, itemCodes, actor.operatorId]
    );
    await query(
      `UPDATE mbt_dump_site_materials
          SET accepted = false, active = false, revision = revision + 1,
              updated_by = $3, updated_at = now()
        WHERE dump_site_id = $1
          AND material_id <> ALL($2::uuid[])
          AND (accepted OR active)`,
      [dumpSiteId, materialIds, actor.operatorId]
    );
  }
  if (Array.isArray(row.openingHours)) {
    const weekdays = row.openingHours.map((hours) => Number(hours.isoWeekday));
    for (const hours of row.openingHours) {
      await query(
        `INSERT INTO mbt_dump_site_opening_hours (
           opening_hour_id, dump_site_id, iso_weekday, opens_at, closes_at,
           revision, created_by, updated_by
         ) VALUES ($1, $2, $3, $4::time, $5::time, 1, $6, $6)
         ON CONFLICT (dump_site_id, iso_weekday) DO UPDATE
           SET opens_at = EXCLUDED.opens_at,
               closes_at = EXCLUDED.closes_at,
               revision = mbt_dump_site_opening_hours.revision + 1,
               updated_by = EXCLUDED.updated_by,
               updated_at = now()`,
        [
          crypto.randomUUID(), dumpSiteId, hours.isoWeekday,
          hours.opensAt, hours.closesAt, actor.operatorId
        ]
      );
    }
    await query(
      `DELETE FROM mbt_dump_site_opening_hours
        WHERE dump_site_id = $1
          AND iso_weekday <> ALL($2::smallint[])`,
      [dumpSiteId, weekdays]
    );
  }
  return { entityId: code, action, revisionBefore, revisionAfter, before };
}

/** @param {Record<string, unknown>} row @param {MbtActor} actor */
async function applyServiceTemplate(row, actor) {
  const code = String(row.templateCode);
  const selected = await query("SELECT * FROM mbt_service_templates WHERE template_code = $1 FOR UPDATE", [code]);
  if (selected.rowCount) {
    const stored = selected.rows[0];
    assertRevision(Number(stored.revision), row.expectedRevision);
    const nextRevision = Number(stored.revision) + 1;
    await query(
      `UPDATE mbt_service_templates
          SET display_name = $2, description = $3, active = $4, revision = $5,
              updated_by = $6, updated_at = now()
        WHERE template_code = $1`,
      [code, row.displayName, row.description, row.active, nextRevision, actor.operatorId]
    );
    return {
      entityId: code,
      action: "updated",
      revisionBefore: Number(stored.revision),
      revisionAfter: nextRevision,
      before: { templateCode: code, revision: Number(stored.revision), active: stored.active === true }
    };
  }
  const templateId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  await query(
    `INSERT INTO mbt_service_templates (
       template_id, template_code, display_name, description, active, revision, created_by, updated_by
     ) VALUES ($1, $2, $3, $4, $5, 1, $6, $6)`,
    [templateId, code, row.displayName, row.description, row.active, actor.operatorId]
  );
  await query(
    `INSERT INTO mbt_service_template_versions (
       template_version_id, template_id, version_number, status, required_bin_service,
       billing_ownership, dump_site_required, revision, created_by, updated_by
     ) VALUES ($1, $2, $3, 'draft', $4, 'customer', $5, 1, $6, $6)`,
    [versionId, templateId, row.versionNumber, row.requiredBinService, row.dumpSiteRequired, actor.operatorId]
  );
  const stepIds = new Map();
  for (const step of /** @type {Record<string, unknown>[]} */ (row.steps)) {
    const stepId = crypto.randomUUID();
    stepIds.set(step.actionCode, stepId);
    await query(
      `INSERT INTO mbt_service_template_steps (
         template_step_id, template_version_id, sequence_number, action_code,
         display_name, stop_kind, location_role, required,
         required_asset_status_before, required_asset_status_after,
         dump_site_required, completion_blocking
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true)`,
      [
        stepId, versionId, step.sequenceNumber, step.actionCode, step.displayName,
        step.stopKind, step.locationRole, step.required, step.requiredAssetStatusBefore,
        step.requiredAssetStatusAfter, step.dumpSiteRequired
      ]
    );
  }
  for (const evidence of /** @type {Record<string, unknown>[]} */ (row.evidenceRequirements)) {
    await query(
      `INSERT INTO mbt_service_template_evidence_requirements (
         evidence_requirement_id, template_version_id, template_step_id,
         evidence_code, evidence_type, minimum_count, required, description
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        crypto.randomUUID(), versionId, stepIds.get(evidence.stepActionCode),
        evidence.evidenceCode, evidence.evidenceType, evidence.minimumCount,
        evidence.required, evidence.description
      ]
    );
  }
  return { entityId: code, action: "created", revisionBefore: 1, revisionAfter: 1, before: { exists: false, revision: 1 } };
}

/** @param {string} resource @param {Record<string, unknown>} row @param {MbtActor} actor */
function applyRow(resource, row, actor) {
  switch (resource) {
    case "local_items": return applyLocalItem(row, actor);
    case "materials": return applyMaterial(row, actor);
    case "dump_sites": return applyDumpSite(row, actor);
    case "service_templates": return applyServiceTemplate(row, actor);
    default: return invalidMaster("The local master-data resource is unsupported.");
  }
}

/** @param {string} resource @param {string} entityId */
async function publicEntity(resource, entityId) {
  if (resource === "local_items") {
    return (await listMbtLocalItemSettings()).find((item) => item.itemCode === entityId) || null;
  }
  if (resource === "dump_sites") {
    return (await listLocalMasterData("dump_sites")).entities.find(
      (/** @type {Record<string, any>} */ site) => site.dumpSiteCode === entityId
    ) || null;
  }
  const table = {
    materials: ["mbt_materials", "material_code"],
    service_templates: ["mbt_service_templates", "template_code"]
  }[resource];
  if (!table) {
    return null;
  }
  const result = await query(`SELECT to_jsonb(row_value) AS entity FROM ${table[0]} row_value WHERE ${table[1]} = $1`, [entityId]);
  return result.rows[0]?.entity || null;
}

/** @param {string} resource @param {Record<string, unknown>} row */
function localMasterNaturalKey(resource, row) {
  const field = {
    local_items: "itemCode",
    materials: "materialCode",
    dump_sites: "dumpSiteCode",
    service_templates: "templateCode"
  }[resource];
  return field ? String(row[field] || "") : "";
}

/**
 * Creation commands receive a stable system-authored audit reason when the
 * operator did not add context. Updates still require an explicit reason.
 * @param {string} resource
 * @param {string} sourceKind
 * @param {Record<string, unknown>[]} rows
 * @param {unknown} reason
 */
function localMasterReason(resource, sourceKind, rows, reason) {
  const entered = String(reason ?? "").trim();
  const supportedCreation = ["local_items", "dump_sites"].includes(resource);
  const creating = rows.every((row) => row.expectedRevision === undefined);
  const automatic = sourceKind === "manual" && supportedCreation && creating
    ? `Created local ${resource === "local_items" ? "item" : "dump site"} from MBT configuration`
    : "";
  return boundedText(
    entered || automatic,
    2000,
    false,
    () => invalidMaster("An audit reason is required for an update.")
  );
}

/**
 * Apply invented/manual or already-normalized CSV rows through the same domain
 * validator and atomic command boundary. Raw CSV parsing remains owned by P3.2.
 *
 * @param {object} input
 * @param {MbtActor} input.actor
 * @param {string} input.resource
 * @param {string} input.sourceKind
 * @param {unknown[]} input.rows
 * @param {string} input.reason
 * @param {string} input.idempotencyKey
 * @param {string} input.correlationId
 * @param {string} input.requestId
 */
export async function applyLocalMasterDataRows({
  actor,
  resource: rawResource,
  sourceKind: rawSourceKind,
  rows: rawRows,
  reason,
  idempotencyKey,
  correlationId,
  requestId
}) {
  const resource = String(rawResource || "");
  const sourceKind = String(rawSourceKind || "");
  if (!Array.isArray(rawRows) || rawRows.length === 0 || !["manual", "csv"].includes(sourceKind)) {
    return invalidMaster("A nonempty manual or CSV local master-data command is required.");
  }
  const rows = /** @type {Record<string, unknown>[]} */ (
    rawRows.map((row) => normalizeLocalMasterDataRow(resource, row))
  );
  const normalizedReason = localMasterReason(resource, sourceKind, rows, reason);
  const naturalKeys = rows.map((row) => localMasterNaturalKey(resource, row));
  if (new Set(naturalKeys).size !== naturalKeys.length) {
    return invalidMaster("A local master-data command contains duplicate identities.");
  }
  await assertMasterDataEnabled(actor);
  const payload = { resource, sourceKind, rows, reason: normalizedReason };
  return executeMbtCommand({
    actor,
    commandName: `mbt.local_master.${resource}.apply`,
    idempotencyKey,
    payload,
    correlationId,
    requestId,
    mutation: async () => {
      const changes = [];
      for (const row of rows) {
        changes.push(await applyRow(resource, row, actor));
      }
      const entities = [];
      for (const change of changes) {
        entities.push(await publicEntity(resource, change.entityId));
      }
      const first = changes[0];
      if (!first) {
        throw new TypeError("A local master-data change is required.");
      }
      const revisionBefore = Math.max(1, ...changes.map((change) => change.revisionBefore));
      const revisionAfter = Math.max(1, ...changes.map((change) => change.revisionAfter));
      const beforeState = { resource, entities: changes.map((change) => change.before) };
      const afterState = { resource, entities };
      return {
        status: 200,
        body: {
          resource,
          entities,
          created: changes.filter(({ action }) => action === "created").length,
          updated: changes.filter(({ action }) => action === "updated").length
        },
        audit: {
          action: `mbt.local_master.${resource}.applied`,
          entityType: `mbt_local_master_${resource}`,
          entityId: changes.length === 1 ? first.entityId : crypto.randomUUID(),
          beforeState,
          afterState,
          reason: normalizedReason,
          revisionBefore,
          revisionAfter,
          source: sourceKind
        }
      };
    }
  });
}

/** @param {unknown} value @param {string} label */
function masterIdentity(value, label) {
  const identity = String(value ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_]{0,63}$/u.test(identity)) {
    return invalidMaster(`${label} is invalid.`);
  }
  return identity;
}

/** @param {unknown} value */
function requiredMasterRevision(value) {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    return invalidMaster("A positive expected revision is required.");
  }
  return revision;
}

/** @param {unknown} error @returns {never} */
function linkedEntityError(error) {
  const code = String(error && typeof error === "object" && "code" in error ? error.code : "");
  const message = String(error && typeof error === "object" && "message" in error ? error.message : "");
  if (["23503", "23514", "55000"].includes(code)
      || /violates (?:RESTRICT setting of )?(?:foreign key|check) constraint/iu.test(message)) {
    throw new MbtError({
      status: 409,
      code: "MBT_ENTITY_IN_USE",
      message: "This record is linked to operational or historical data. Make it inactive instead of deleting it."
    });
  }
  if (error instanceof MbtError) {
    throw error;
  }
  throw error;
}

/**
 * A small state command backs the visible Inactivate/Activate buttons without
 * making the browser resubmit unrelated editable fields.
 *
 * @param {object} input
 * @param {MbtActor} input.actor
 * @param {"local_items" | "dump_sites"} input.resource
 * @param {unknown} input.entityId
 * @param {unknown} input.active
 * @param {unknown} input.expectedRevision
 * @param {string} input.idempotencyKey
 * @param {string} input.correlationId
 * @param {string} input.requestId
 */
export async function setLocalMasterDataActive(input) {
  const resource = String(input.resource || "");
  if (!["local_items", "dump_sites"].includes(resource) || typeof input.active !== "boolean") {
    return invalidMaster("A supported local record and active state are required.");
  }
  const entityId = masterIdentity(
    input.entityId,
    resource === "local_items" ? "Local item code" : "Dump-site code"
  );
  const expectedRevision = requiredMasterRevision(input.expectedRevision);
  const reason = `${input.active ? "Activated" : "Inactivated"} ${resource === "local_items" ? "local item" : "dump site"} from MBT configuration`;
  await assertMasterDataEnabled(input.actor);
  return executeMbtCommand({
    actor: input.actor,
    commandName: `mbt.local_master.${resource}.state`,
    idempotencyKey: input.idempotencyKey,
    payload: { resource, entityId, active: input.active, expectedRevision },
    correlationId: input.correlationId,
    requestId: input.requestId,
    mutation: async () => {
      const table = resource === "local_items" ? "mbt_local_item_settings" : "mbt_dump_sites";
      const column = resource === "local_items" ? "item_code" : "dump_site_code";
      const selected = await query(
        `SELECT * FROM ${table} WHERE ${column} = $1 FOR UPDATE`,
        [entityId]
      );
      if (!selected.rowCount) {
        throw new MbtError({
          status: 404,
          code: "MBT_MASTER_NOT_FOUND",
          message: "The local configuration record was not found."
        });
      }
      const before = selected.rows[0];
      assertRevision(Number(before.revision), expectedRevision);
      const revision = expectedRevision + 1;
      await query(
        `UPDATE ${table}
            SET active = $2, revision = $3, updated_by = $4, updated_at = now()
          WHERE ${column} = $1`,
        [entityId, input.active, revision, input.actor.operatorId]
      );
      if (resource === "local_items" && String(before.item_type) === "dump") {
        await query(
          `UPDATE mbt_materials
              SET active = $2, revision = revision + 1,
                  updated_by = $3, updated_at = now()
            WHERE material_code = $1
              AND active IS DISTINCT FROM $2`,
          [entityId, input.active, input.actor.operatorId]
        );
      }
      return {
        status: 200,
        body: { resource, entityId, active: input.active, revision },
        audit: {
          action: `mbt.local_master.${resource}.${input.active ? "activated" : "inactivated"}`,
          entityType: `mbt_local_master_${resource}`,
          entityId,
          beforeState: { active: before.active === true, revision: expectedRevision },
          afterState: { active: input.active, revision },
          reason,
          revisionBefore: expectedRevision,
          revisionAfter: revision,
          source: "local"
        }
      };
    }
  });
}

/**
 * Delete one exact, unlinked local master record. Database foreign keys and
 * immutable-history triggers remain the final authority. Configuration-owned
 * projections are removed in the same transaction; any operational reference
 * aborts and restores the entire graph.
 *
 * @param {object} input
 * @param {MbtActor} input.actor
 * @param {"local_items" | "dump_sites"} input.resource
 * @param {unknown} input.entityId
 * @param {unknown} input.expectedRevision
 * @param {string} input.idempotencyKey
 * @param {string} input.correlationId
 * @param {string} input.requestId
 */
export async function deleteLocalMasterDataEntity(input) {
  const resource = String(input.resource || "");
  if (!["local_items", "dump_sites"].includes(resource)) {
    return invalidMaster("A deletable local record is required.");
  }
  const entityId = masterIdentity(
    input.entityId,
    resource === "local_items" ? "Local item code" : "Dump-site code"
  );
  const expectedRevision = requiredMasterRevision(input.expectedRevision);
  const reason = `Deleted unused ${resource === "local_items" ? "local item" : "dump site"} from MBT configuration`;
  await assertMasterDataEnabled(input.actor);
  try {
    return await executeMbtCommand({
      actor: input.actor,
      commandName: `mbt.local_master.${resource}.delete`,
      idempotencyKey: input.idempotencyKey,
      payload: { resource, entityId, expectedRevision },
      correlationId: input.correlationId,
      requestId: input.requestId,
      mutation: async () => {
        if (resource === "local_items") {
          const selected = await query(
            "SELECT * FROM mbt_local_item_settings WHERE item_code = $1 FOR UPDATE",
            [entityId]
          );
          if (!selected.rowCount) {
            throw new MbtError({ status: 404, code: "MBT_LOCAL_ITEM_NOT_FOUND", message: "The local item was not found." });
          }
          const before = selected.rows[0];
          assertRevision(Number(before.revision), expectedRevision);
          if (before.system_owned === true) {
            throw new MbtError({
              status: 409,
              code: "MBT_PROTECTED_LOCAL_ITEM",
              message: "A system-owned local item cannot be deleted. Make it inactive if it should not be selected."
            });
          }
          await query("SELECT set_config('mbt.delete_local_item', $1, true)", [entityId]);
          if (before.bin_type_id) {
            await query(
              "UPDATE mbt_bin_types SET local_item_code = NULL WHERE bin_type_id = $1 AND local_item_code = $2",
              [before.bin_type_id, entityId]
            );
          }
          await query("DELETE FROM mbt_local_item_settings WHERE item_code = $1", [entityId]);
          if (String(before.item_type) === "dump") {
            await query("DELETE FROM mbt_materials WHERE material_code = $1", [entityId]);
          }
          if (before.bin_type_id) {
            await query("DELETE FROM mbt_bin_types WHERE bin_type_id = $1", [before.bin_type_id]);
          }
          return {
            status: 200,
            body: { resource, entityId, deleted: true },
            audit: {
              action: "mbt.local_master.local_items.deleted",
              entityType: "mbt_local_master_local_items",
              entityId,
              beforeState: { itemCode: entityId, active: before.active === true, revision: expectedRevision },
              afterState: { exists: false },
              reason,
              revisionBefore: expectedRevision,
              revisionAfter: expectedRevision,
              source: "local"
            }
          };
        }

        const selected = await query(
          "SELECT * FROM mbt_dump_sites WHERE dump_site_code = $1 FOR UPDATE",
          [entityId]
        );
        if (!selected.rowCount) {
          throw new MbtError({ status: 404, code: "MBT_DUMP_SITE_NOT_FOUND", message: "The dump site was not found." });
        }
        const before = selected.rows[0];
        assertRevision(Number(before.revision), expectedRevision);
        await query("DELETE FROM mbt_dump_site_opening_hours WHERE dump_site_id = $1", [before.dump_site_id]);
        await query("DELETE FROM mbt_dump_site_items WHERE dump_site_id = $1", [before.dump_site_id]);
        await query("DELETE FROM mbt_dump_site_materials WHERE dump_site_id = $1", [before.dump_site_id]);
        await query("DELETE FROM mbt_dump_sites WHERE dump_site_id = $1", [before.dump_site_id]);
        return {
          status: 200,
          body: { resource, entityId, deleted: true },
          audit: {
            action: "mbt.local_master.dump_sites.deleted",
            entityType: "mbt_local_master_dump_sites",
            entityId: String(before.dump_site_id),
            beforeState: { dumpSiteCode: entityId, active: before.active === true, revision: expectedRevision },
            afterState: { exists: false },
            reason,
            revisionBefore: expectedRevision,
            revisionAfter: expectedRevision,
            source: "local"
          }
        };
      }
    });
  } catch (error) {
    // Translate only after executeMbtCommand has rolled back its transaction
    // or savepoint. PostgreSQL rejects all further statements while the
    // transaction is aborted, which otherwise leaks the raw FK error.
    return linkedEntityError(error);
  }
}
