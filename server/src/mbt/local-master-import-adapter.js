// @ts-check

import crypto from "node:crypto";

import { parseBoundedCsv } from "./bounded-csv.js";
import { canonicalSha256 } from "./canonical-json.js";
import { MbtError } from "./errors.js";
import { normalizeLocalMasterDataRow } from "./local-master-data-service.js";

const DEFINITIONS = Object.freeze({
  local_items: Object.freeze({
    resource: "local_items",
    schemaVersion: "mbt-local-items-csv-v3",
    headers: Object.freeze([
      "item_code", "display_name", "description", "item_type", "rental_period_days",
      "category", "pricing_mode",
      "applicable_service_types", "applicable_legacy_source_types", "bin_type_code",
      "bin_capacity_yards",
      "netsuite_mapping_local_key", "active", "expected_revision"
    ]),
    templateHeaders: Object.freeze([
      "item_code", "display_name", "description", "item_type",
      "rental_period_days", "bin_capacity_yards", "active", "expected_revision"
    ]),
    requiredHeaders: Object.freeze(["item_code", "display_name", "active"])
  }),
  materials: Object.freeze({
    resource: "materials",
    schemaVersion: "mbt-materials-csv-v1",
    headers: Object.freeze([
      "material_code", "display_name", "description", "active", "expected_revision"
    ]),
    requiredHeaders: Object.freeze(["material_code", "display_name", "active"])
  }),
  dump_sites: Object.freeze({
    resource: "dump_sites",
    schemaVersion: "mbt-dump-sites-csv-v2",
    headers: Object.freeze([
      "dump_site_code", "display_name", "address_line_1", "address_line_2", "city",
      "region", "postal_code", "country_code", "phone", "latitude", "longitude",
      "item_code", "material_code", "accepted", "scale_ticket_required", "notes", "active",
      "expected_revision"
    ]),
    templateHeaders: Object.freeze([
      "dump_site_code", "display_name", "address_line_1", "address_line_2", "city",
      "region", "postal_code", "country_code", "phone", "latitude", "longitude",
      "item_code", "accepted", "scale_ticket_required", "notes", "active",
      "expected_revision"
    ]),
    requiredHeaders: Object.freeze([
      "dump_site_code", "display_name", "country_code", "accepted",
      "scale_ticket_required", "active"
    ])
  })
});

/** @param {string} code @param {string} message @param {Record<string, unknown>} [details] */
function importFailure(code, message, details = {}) {
  return new MbtError({ status: 400, code, message, details });
}

/** @param {unknown} value */
function normalizedResource(value) {
  return String(value ?? "").trim().toLowerCase().replaceAll("-", "_");
}

/** @param {unknown} value */
function strictBoolean(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  throw importFailure("MBT_IMPORT_ROW_INVALID", "An import boolean must be true or false.");
}

/** @param {unknown} value */
function optionalRevision(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return undefined;
  }
  const revision = Number(normalized);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw importFailure("MBT_IMPORT_ROW_INVALID", "An import revision must be a positive integer.");
  }
  return revision;
}

/** @param {unknown} value */
function optionalPositiveInteger(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return undefined;
  }
  const number = Number(normalized);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw importFailure("MBT_IMPORT_ROW_INVALID", "An import rental period must be a positive integer.");
  }
  return number;
}

/** @param {unknown} value */
function list(value) {
  const normalized = String(value ?? "").trim();
  return normalized
    ? normalized.split("|").map((entry) => entry.trim()).filter(Boolean)
    : [];
}

/** @param {unknown} value */
function nullable(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

/** @param {unknown} value */
function plain(value) {
  return String(value ?? "").trim();
}

/** @param {Record<string, string>} values */
function localItemInput(values) {
  const expectedRevision = optionalRevision(values.expected_revision);
  const itemType = plain(values.item_type).toLowerCase();
  const rentalPeriodDays = optionalPositiveInteger(values.rental_period_days);
  const binCapacityYards = optionalPositiveInteger(values.bin_capacity_yards);
  const defaultServices = {
    bin: ["delivery", "final_pickup", "loaded_pickup", "dump_return", "exchange"],
    dump: ["dump_return"],
    delivery_fee: ["delivery", "final_pickup", "loaded_pickup", "dump_return", "exchange"],
    surcharge: []
  }[itemType] || [];
  if (itemType) {
    return {
      itemCode: plain(values.item_code),
      displayName: plain(values.display_name),
      description: plain(values.description),
      itemType,
      rentalPeriodDays: itemType === "bin" ? (rentalPeriodDays ?? 14) : null,
      applicableServiceTypes: list(values.applicable_service_types).length
        ? list(values.applicable_service_types) : defaultServices,
      applicableLegacySourceTypes: list(values.applicable_legacy_source_types),
      binTypeCode: nullable(values.bin_type_code),
      ...(binCapacityYards === undefined ? {} : { binCapacityYards }),
      netSuiteMappingLocalKey: nullable(values.netsuite_mapping_local_key),
      active: strictBoolean(values.active),
      ...(expectedRevision === undefined ? {} : { expectedRevision })
    };
  }
  return {
    itemCode: plain(values.item_code),
    displayName: plain(values.display_name),
    description: plain(values.description),
    category: plain(values.category),
    pricingMode: plain(values.pricing_mode),
    applicableServiceTypes: list(values.applicable_service_types),
    applicableLegacySourceTypes: list(values.applicable_legacy_source_types),
    binTypeCode: nullable(values.bin_type_code),
    netSuiteMappingLocalKey: nullable(values.netsuite_mapping_local_key),
    active: strictBoolean(values.active),
    ...(expectedRevision === undefined ? {} : { expectedRevision })
  };
}

/** @param {Record<string, string>} values */
function materialInput(values) {
  const expectedRevision = optionalRevision(values.expected_revision);
  return {
    materialCode: plain(values.material_code),
    displayName: plain(values.display_name),
    description: plain(values.description),
    active: strictBoolean(values.active),
    ...(expectedRevision === undefined ? {} : { expectedRevision })
  };
}

/** @param {Record<string, string>} values */
function dumpSiteInput(values) {
  const expectedRevision = optionalRevision(values.expected_revision);
  const itemCode = plain(values.item_code);
  return {
    dumpSiteCode: plain(values.dump_site_code),
    displayName: plain(values.display_name),
    addressLine1: plain(values.address_line_1),
    addressLine2: plain(values.address_line_2),
    city: plain(values.city),
    region: plain(values.region),
    postalCode: plain(values.postal_code),
    countryCode: plain(values.country_code),
    phone: plain(values.phone),
    latitude: nullable(values.latitude),
    longitude: nullable(values.longitude),
    ...(itemCode ? { itemCode } : { materialCode: plain(values.material_code) }),
    accepted: strictBoolean(values.accepted),
    scaleTicketRequired: strictBoolean(values.scale_ticket_required),
    notes: plain(values.notes),
    active: strictBoolean(values.active),
    ...(expectedRevision === undefined ? {} : { expectedRevision })
  };
}

/** @param {string} resource @param {Record<string, string>} values */
function rowInput(resource, values) {
  if (resource === "local_items") {
    return localItemInput(values);
  }
  if (resource === "materials") {
    return materialInput(values);
  }
  return dumpSiteInput(values);
}

/** @param {string} resource @param {Record<string, unknown>} row */
function naturalKey(resource, row) {
  if (resource === "local_items") {
    return String(row.itemCode);
  }
  if (resource === "materials") {
    return String(row.materialCode);
  }
  return String(row.dumpSiteCode);
}

/** @param {unknown} content */
function contentBytes(content) {
  if (typeof content === "string") {
    return Buffer.from(content, "utf8");
  }
  if (Buffer.isBuffer(content) || content instanceof Uint8Array) {
    return Buffer.from(content);
  }
  throw importFailure("MBT_IMPORT_CONTENT_REQUIRED", "An import file is required.");
}

/** @param {unknown} resource */
export function getLocalMasterImportDefinition(resource) {
  const normalized = normalizedResource(resource);
  const definition = DEFINITIONS[/** @type {keyof typeof DEFINITIONS} */ (normalized)];
  if (!definition) {
    throw importFailure("MBT_IMPORT_RESOURCE_INVALID", "This import resource is not supported.");
  }
  return definition;
}

/**
 * Parse one bounded local-resource CSV into the exact shape accepted by the
 * manual command validator. No domain rows are written by this adapter.
 *
 * @param {{resource: unknown, content: unknown}} input
 */
export async function parseLocalMasterCsv({ resource: rawResource, content }) {
  const definition = getLocalMasterImportDefinition(rawResource);
  const bytes = contentBytes(content);
  const optionalHeaders = definition.headers.filter(
    (header) => !definition.requiredHeaders.includes(header)
  );
  const parsed = await parseBoundedCsv(bytes, {
    requiredHeaders: definition.requiredHeaders,
    optionalHeaders
  });
  const rows = parsed.rows.map(({ rowNumber, values }) => {
    try {
      const normalized = /** @type {Record<string, unknown>} */ (
        normalizeLocalMasterDataRow(definition.resource, rowInput(definition.resource, values))
      );
      const key = naturalKey(definition.resource, normalized);
      return {
        rowNumber,
        naturalKey: key,
        ...normalized,
        payloadHash: canonicalSha256({ resource: definition.resource, row: normalized })
      };
    } catch (error) {
      if (error instanceof MbtError && error.code === "MBT_IMPORT_ROW_INVALID") {
        throw error;
      }
      throw importFailure(
        "MBT_IMPORT_ROW_INVALID",
        "An import row failed local master-data validation.",
        { rowNumber }
      );
    }
  });
  const keys = rows.map(({ naturalKey: key }) => key);
  if (new Set(keys).size !== keys.length) {
    throw importFailure(
      "MBT_IMPORT_DUPLICATE_IDENTITY",
      "An import contains a duplicate local identity."
    );
  }
  return {
    resource: definition.resource,
    schemaVersion: definition.schemaVersion,
    fileHash: crypto.createHash("sha256").update(bytes).digest("hex"),
    normalizedHash: canonicalSha256({
      resource: definition.resource,
      schemaVersion: definition.schemaVersion,
      rows: rows.map(({ rowNumber: _rowNumber, ...row }) => row)
    }),
    headers: parsed.headers,
    rows,
    summary: { totalRows: rows.length, validRows: rows.length, invalidRows: 0, skippedRows: 0 },
    warnings: []
  };
}
