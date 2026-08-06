// @ts-check

import { canonicalJson, canonicalSha256 } from "./canonical-json.js";
import { MbtError } from "./errors.js";

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

/** @param {unknown} value @param {number} maximum */
function cleanText(value, maximum) {
  return String(value ?? "")
    .replace(CONTROL_CHARACTERS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
}

/** @param {unknown} value */
function customerId(value) {
  const text = typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? String(value)
    : String(value ?? "").trim();
  if (!/^[1-9]\d*$/u.test(text)) {
    throw new TypeError("A positive customer NetSuite internal ID is required.");
  }
  const canonical = BigInt(text).toString();
  if (BigInt(canonical) > 9_223_372_036_854_775_807n) {
    throw new TypeError("Customer NetSuite internal ID exceeds the PostgreSQL bigint range.");
  }
  const numeric = Number(canonical);
  return Number.isSafeInteger(numeric) ? numeric : canonical;
}

/** @param {number | string} value */
function idText(value) {
  return String(value);
}

/** @param {number | string} left @param {number | string} right */
function compareIds(left, right) {
  const leftId = BigInt(idText(left));
  const rightId = BigInt(idText(right));
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

/** @param {unknown} value */
function booleanRank(value) {
  return value === true ? 1 : 0;
}

/** @param {Record<string, unknown>} left @param {Record<string, unknown>} right */
function addressOrder(left, right) {
  const shipping = booleanRank(right.shippingDefault) - booleanRank(left.shippingDefault);
  if (shipping !== 0) {
    return shipping;
  }
  const billing = booleanRank(right.billingDefault) - booleanRank(left.billingDefault);
  if (billing !== 0) {
    return billing;
  }
  return String(left.netsuiteAddressId ?? "").localeCompare(String(right.netsuiteAddressId ?? ""));
}

/** @param {Record<string, unknown>} customer */
function primaryAddress(customer) {
  const addresses = Array.isArray(customer.addresses)
    ? customer.addresses.filter((address) => (
      address && typeof address === "object" && !Array.isArray(address)
        && /** @type {{active?: unknown}} */ (address).active !== false
    ))
    : [];
  return addresses
    .map((address) => /** @type {Record<string, unknown>} */ (address))
    .sort(addressOrder)[0] || null;
}

/** @param {Record<string, unknown> | null} address */
function formattedAddress(address) {
  if (!address) {
    return "";
  }
  const region = cleanText(address.region, 500);
  const postalCode = cleanText(address.postalCode, 500);
  const regionPostal = [region, postalCode].filter(Boolean).join(" ");
  return [
    address.addressLine1,
    address.addressLine2,
    address.addressLine3,
    address.city,
    regionPostal,
    address.countryCode
  ]
    .map((part) => cleanText(part, 500))
    .filter(Boolean)
    .join(", ")
    .slice(0, 1000);
}

/**
 * Project one canonical aggregate to the established Returns response shape.
 * Property insertion order is intentional and compatibility-tested.
 *
 * @param {Record<string, unknown>} customer
 */
export function projectCanonicalCustomerForReturns(customer) {
  if (!customer || typeof customer !== "object" || Array.isArray(customer)) {
    throw new TypeError("A canonical customer aggregate is required.");
  }
  if (customer.active === false) {
    return null;
  }
  const id = customerId(customer.netsuiteId);
  const code = cleanText(customer.entityNumber, 240);
  const companyName = cleanText(customer.legalName, 500);
  const name = cleanText(customer.displayName, 500) || companyName || code || String(id);
  return {
    id,
    internalId: id,
    code,
    entityId: code,
    name,
    companyName,
    phone: cleanText(customer.phone, 120),
    address: formattedAddress(primaryAddress(customer))
  };
}

/** @param {unknown} value */
function normalizedReturnCustomer(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("A Returns customer projection is required.");
  }
  const row = /** @type {Record<string, unknown>} */ (value);
  const id = customerId(row.internalId ?? row.id);
  const code = cleanText(row.entityId ?? row.code, 240);
  const companyName = cleanText(row.companyName, 500);
  const name = cleanText(row.name, 500) || companyName || code || String(id);
  return {
    id,
    internalId: id,
    code,
    entityId: code,
    name,
    companyName,
    phone: cleanText(row.phone, 120),
    address: cleanText(row.address, 1000)
  };
}

/** @param {Array<ReturnType<typeof normalizedReturnCustomer>>} rows */
function sortedRows(rows) {
  return [...rows].sort((left, right) => compareIds(left.internalId, right.internalId));
}

/**
 * @param {{canonicalCustomers?: Record<string, unknown>[], returnCustomers?: Record<string, unknown>[]}} [input]
 */
export function compareReturnProjectionParity(input = {}) {
  const canonicalRows = sortedRows((input.canonicalCustomers || [])
    .map(projectCanonicalCustomerForReturns)
    .filter((row) => row !== null));
  const returnRows = sortedRows((input.returnCustomers || []).map(normalizedReturnCustomer));
  const canonicalById = new Map(canonicalRows.map((row) => [idText(row.internalId), row]));
  const returnById = new Map(returnRows.map((row) => [idText(row.internalId), row]));
  const missingInternalIds = [...canonicalById.keys()]
    .filter((id) => !returnById.has(id))
    .sort((left, right) => compareIds(left, right));
  const extraInternalIds = [...returnById.keys()]
    .filter((id) => !canonicalById.has(id))
    .sort((left, right) => compareIds(left, right));
  const mismatchedInternalIds = [...canonicalById.keys()]
    .filter((id) => {
      const returnRow = returnById.get(id);
      return returnRow !== undefined && canonicalJson(canonicalById.get(id)) !== canonicalJson(returnRow);
    })
    .sort((left, right) => compareIds(left, right));
  const canonicalHash = canonicalSha256(canonicalRows);
  const returnHash = canonicalSha256(returnRows);
  return {
    matches: missingInternalIds.length === 0
      && extraInternalIds.length === 0
      && mismatchedInternalIds.length === 0
      && canonicalRows.length === returnRows.length,
    canonicalActiveCount: canonicalRows.length,
    returnCount: returnRows.length,
    missingInternalIds,
    extraInternalIds,
    mismatchedInternalIds,
    canonicalHash,
    returnHash
  };
}

/** @typedef {{query: (sql: string, params?: unknown[]) => Promise<{rowCount?: number | null, rows: Record<string, unknown>[]}>, release?: () => void}} QueryClient */

/**
 * @param {unknown} database
 * @param {(client: QueryClient) => Promise<unknown>} operation
 */
async function inTransaction(database, operation) {
  if (!database || typeof database !== "object") {
    throw new TypeError("A PostgreSQL pool or transaction client is required.");
  }
  const candidate = /** @type {{connect?: () => Promise<QueryClient>, query?: QueryClient["query"]}} */ (database);
  if (typeof candidate.connect !== "function") {
    if (typeof candidate.query !== "function") {
      throw new TypeError("A PostgreSQL query capability is required.");
    }
    return operation(/** @type {QueryClient} */ (database));
  }
  const client = await candidate.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release?.();
  }
}

/** @param {QueryClient} client @param {ReturnType<typeof normalizedReturnCustomer>} customer @param {string} generationId */
async function upsertProjectionRow(client, customer, generationId) {
  await client.query(
    `INSERT INTO return_customer_directory (
       netsuite_customer_id, entity_code, company_name, display_name,
       phone, phone_digits, address, sync_generation, synced_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::uuid, now())
     ON CONFLICT (netsuite_customer_id) DO UPDATE
     SET entity_code = EXCLUDED.entity_code,
         company_name = EXCLUDED.company_name,
         display_name = EXCLUDED.display_name,
         phone = EXCLUDED.phone,
         phone_digits = EXCLUDED.phone_digits,
         address = EXCLUDED.address,
         sync_generation = EXCLUDED.sync_generation,
         synced_at = now()`,
    [
      customer.internalId,
      customer.entityId,
      customer.companyName,
      customer.name,
      customer.phone,
      customer.phone.replace(/\D/g, ""),
      customer.address,
      generationId
    ]
  );
}

/**
 * Atomically replace the established active Returns projection. When passed a
 * transaction client rather than a pool, this joins the caller's canonical
 * apply transaction instead of opening a second commit boundary.
 *
 * @param {unknown} database
 * @param {{generationId?: unknown, customers?: Record<string, unknown>[]}} [input]
 */
export async function applyCanonicalReturnsProjection(database, input = {}) {
  const generationId = String(input.generationId ?? "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(generationId)) {
    throw new TypeError("A UUID projection generation is required.");
  }
  if (!Array.isArray(input.customers)) {
    throw new TypeError("Canonical projection customers must be an array.");
  }
  const customers = input.customers;
  const rows = sortedRows(customers
    .map(projectCanonicalCustomerForReturns)
    .filter((row) => row !== null));
  if (rows.length === 0) {
    throw new MbtError({
      status: 409,
      code: "MBT_CUSTOMER_SNAPSHOT_EMPTY",
      message: "An empty canonical customer snapshot cannot replace the Returns directory."
    });
  }
  const uniqueRows = [...new Map(rows.map((row) => [row.internalId, row])).values()];
  return inTransaction(database, async (client) => {
    for (const row of uniqueRows) {
      await upsertProjectionRow(client, row, generationId);
    }
    await client.query(
      `DELETE FROM return_customer_directory
        WHERE sync_generation IS DISTINCT FROM $1::uuid`,
      [generationId]
    );
    await client.query(
      `UPDATE return_customer_directory_sync
          SET status = 'succeeded',
              current_run_token = NULL,
              last_completed_at = now(),
              last_successful_at = now(),
              last_error = NULL,
              customer_count = $1,
              updated_at = now()
        WHERE singleton_id = 1`,
      [uniqueRows.length]
    );
    return {
      generationId,
      projected: uniqueRows.length,
      inactive: customers.length - uniqueRows.length
    };
  });
}

/**
 * @param {{mode?: unknown, canonicalFresh?: unknown, parityMatches?: unknown, legacySchedulerEnabled?: unknown}} [input]
 */
export function evaluateReturnsProjectionOwnership(input = {}) {
  const mode = String(input.mode ?? "");
  if (mode === "legacy" || mode === "dual_read" || mode === "rollback") {
    if (input.legacySchedulerEnabled !== true) {
      return { allowed: false, reason: "legacy_writer_not_enabled" };
    }
    return {
      allowed: true,
      activeWriter: "legacy_direct_refresh",
      canonicalProjectionTarget: "shadow",
      legacySchedulerEnabled: true
    };
  }
  if (mode !== "cutover") {
    return { allowed: false, reason: "returns_projection_mode_invalid" };
  }
  if (input.legacySchedulerEnabled === true) {
    return { allowed: false, reason: "legacy_writer_still_enabled" };
  }
  if (input.canonicalFresh !== true) {
    return { allowed: false, reason: "canonical_projection_not_fresh" };
  }
  if (input.parityMatches !== true) {
    return { allowed: false, reason: "returns_parity_not_met" };
  }
  return {
    allowed: true,
    activeWriter: "canonical_projection",
    canonicalProjectionTarget: "return_customer_directory",
    legacySchedulerEnabled: false
  };
}
