import crypto from "node:crypto";
import { config } from "./config.js";
import { query, withTransaction } from "./db.js";
import {
  fetchActiveReturnCustomerDirectoryFromNetSuite,
  fetchReturnCustomersFromNetSuite
} from "./return-netsuite.js";

export const RETURN_CUSTOMER_DIRECTORY_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const RETURN_CUSTOMER_DIRECTORY_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

const RETURN_CUSTOMER_DIRECTORY_LEASE_MS = 30 * 60 * 1000;
const RETURN_CUSTOMER_DIRECTORY_RETRY_MS = 5 * 60 * 1000;
const RETURN_CUSTOMER_UPSERT_CHUNK_SIZE = 500;

function directoryError(status, message, fields = {}) {
  return Object.assign(new Error(message), { status, ...fields });
}

function cleanDirectoryText(value, maxLength = 1000) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function customerInternalId(customer) {
  const id = Number(customer?.internalId ?? customer?.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error("NetSuite returned an invalid customer internal ID.");
  }
  return id;
}

export function normalizeReturnCustomerDirectoryEntry(customer = {}) {
  const id = customerInternalId(customer);
  const entityCode = cleanDirectoryText(
    customer.entityId ?? customer.code,
    240
  );
  const companyName = cleanDirectoryText(
    customer.companyName ?? customer.company_name,
    500
  );
  const displayName = cleanDirectoryText(
    customer.name ?? customer.displayName ?? companyName ?? entityCode,
    500
  ) || companyName || entityCode || String(id);
  return {
    id,
    internalId: id,
    code: entityCode,
    entityId: entityCode,
    name: displayName,
    companyName,
    phone: cleanDirectoryText(customer.phone, 120),
    address: cleanDirectoryText(customer.address, 1000)
  };
}

export function validateReturnCustomerDirectorySnapshot(customers) {
  if (!Array.isArray(customers) || !customers.length) {
    throw new Error(
      "NetSuite returned no active customers; the existing Return customer directory was preserved."
    );
  }
  const byId = new Map();
  for (const customer of customers) {
    const normalized = normalizeReturnCustomerDirectoryEntry(customer);
    byId.set(normalized.id, normalized);
  }
  if (!byId.size) {
    throw new Error(
      "NetSuite returned no valid active customers; the existing Return customer directory was preserved."
    );
  }
  return [...byId.values()];
}

function directoryRow(row) {
  const id = Number(row.netsuite_customer_id);
  return {
    id,
    internalId: id,
    code: row.entity_code || "",
    entityId: row.entity_code || "",
    name: row.display_name || row.company_name || row.entity_code || "",
    companyName: row.company_name || "",
    phone: row.phone || "",
    address: row.address || ""
  };
}

function directorySearchInput(search, limit) {
  const term = cleanDirectoryText(search, 100);
  const internalId = /^[1-9]\d*$/.test(term) && Number.isSafeInteger(Number(term))
    ? Number(term)
    : null;
  if (term.length < 2 && internalId === null) {
    throw directoryError(400, "Enter at least two characters to search customers.");
  }
  const normalizedTerm = term.toLocaleLowerCase("en-CA");
  const escapedPrefix = `${normalizedTerm.replace(/[\\%_]/g, "\\$&")}%`;
  const phoneDigits = term.replace(/\D/g, "");
  return {
    term,
    normalizedTerm,
    escapedPrefix,
    internalId,
    phoneDigits: phoneDigits.length >= 3 ? phoneDigits : "",
    limit: Math.min(50, Math.max(1, Number(limit) || 25))
  };
}

export async function searchLocalReturnCustomerDirectory(search, { limit = 25 } = {}) {
  const input = directorySearchInput(search, limit);
  if (input.internalId !== null) {
    const exact = await getLocalReturnCustomerById(input.internalId);
    if (exact) return [exact];
  }
  const result = await query(
    `SELECT netsuite_customer_id, entity_code, company_name, display_name,
            phone, phone_digits, address, synced_at
       FROM return_customer_directory
      WHERE ($2::bigint IS NOT NULL AND netsuite_customer_id = $2::bigint)
         OR lower(entity_code) = $1
         OR lower(entity_code) LIKE $3 ESCAPE '\\'
         OR strpos(lower(company_name), $1) > 0
         OR strpos(lower(display_name), $1) > 0
         OR ($4 <> '' AND strpos(phone_digits, $4) > 0)
      ORDER BY
        CASE
          WHEN $2::bigint IS NOT NULL AND netsuite_customer_id = $2::bigint THEN 0
          WHEN lower(entity_code) = $1 THEN 1
          WHEN lower(company_name) = $1 OR lower(display_name) = $1 THEN 2
          WHEN lower(entity_code) LIKE $3 ESCAPE '\\' THEN 3
          WHEN lower(company_name) LIKE $3 ESCAPE '\\'
            OR lower(display_name) LIKE $3 ESCAPE '\\' THEN 4
          WHEN $4 <> '' AND phone_digits = $4 THEN 5
          ELSE 6
        END,
        entity_code,
        netsuite_customer_id
      LIMIT $5`,
    [
      input.normalizedTerm,
      input.internalId,
      input.escapedPrefix,
      input.phoneDigits,
      input.limit
    ]
  );
  return result.rows.map(directoryRow);
}

export async function getLocalReturnCustomerById(customerId) {
  const id = customerInternalId({ id: customerId });
  const result = await query(
    `SELECT netsuite_customer_id, entity_code, company_name, display_name,
            phone, phone_digits, address, synced_at
       FROM return_customer_directory
      WHERE netsuite_customer_id = $1`,
    [id]
  );
  return result.rows[0] ? directoryRow(result.rows[0]) : null;
}

export async function getReturnCustomerDirectoryStatus() {
  const result = await query(
    `SELECT s.status, s.last_started_at, s.last_completed_at,
            s.last_successful_at, s.last_error, s.customer_count,
            EXISTS (SELECT 1 FROM return_customer_directory) AS has_customers
       FROM return_customer_directory_sync s
      WHERE s.singleton_id = 1`
  );
  const row = result.rows[0] || {};
  return {
    status: row.status || "idle",
    lastStartedAt: row.last_started_at || null,
    lastCompletedAt: row.last_completed_at || null,
    lastSuccessfulAt: row.last_successful_at || null,
    lastError: row.last_error || "",
    customerCount: Number(row.customer_count) || 0,
    hasCustomers: row.has_customers === true
  };
}

function isHealthyDirectory(status, now = Date.now()) {
  if (!status?.hasCustomers || !status.lastSuccessfulAt) return false;
  const lastSuccessfulAt = new Date(status.lastSuccessfulAt).getTime();
  return Number.isFinite(lastSuccessfulAt)
    && now - lastSuccessfulAt <= RETURN_CUSTOMER_DIRECTORY_STALE_AFTER_MS;
}

export async function upsertReturnCustomerDirectoryEntries(customers, {
  syncGeneration = null
} = {}) {
  const normalized = [...new Map(
    (Array.isArray(customers) ? customers : [])
      .map(normalizeReturnCustomerDirectoryEntry)
      .map((customer) => [customer.id, customer])
  ).values()];
  if (!normalized.length) return 0;

  for (let offset = 0; offset < normalized.length; offset += RETURN_CUSTOMER_UPSERT_CHUNK_SIZE) {
    const chunk = normalized.slice(offset, offset + RETURN_CUSTOMER_UPSERT_CHUNK_SIZE);
    const params = [];
    const values = chunk.map((customer, index) => {
      const base = index * 8;
      params.push(
        customer.id,
        customer.entityCode || customer.code,
        customer.companyName,
        customer.name,
        customer.phone,
        customer.phone.replace(/\D/g, ""),
        customer.address,
        syncGeneration
      );
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4},
               $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}::uuid, now())`;
    });
    await query(
      `INSERT INTO return_customer_directory (
         netsuite_customer_id, entity_code, company_name, display_name,
         phone, phone_digits, address, sync_generation, synced_at
       ) VALUES ${values.join(", ")}
       ON CONFLICT (netsuite_customer_id) DO UPDATE
       SET entity_code = EXCLUDED.entity_code,
           company_name = EXCLUDED.company_name,
           display_name = EXCLUDED.display_name,
           phone = EXCLUDED.phone,
           phone_digits = EXCLUDED.phone_digits,
           address = EXCLUDED.address,
           sync_generation = COALESCE(
             EXCLUDED.sync_generation,
             return_customer_directory.sync_generation
           ),
           synced_at = now()`,
      params
    );
  }
  return normalized.length;
}

async function claimReturnCustomerDirectorySync({ force = false } = {}) {
  const runToken = crypto.randomUUID();
  const result = await query(
    `UPDATE return_customer_directory_sync
        SET status = 'running',
            current_run_token = $1::uuid,
            last_started_at = now(),
            last_error = NULL,
            updated_at = now()
      WHERE singleton_id = 1
        AND (
          status <> 'running'
          OR last_started_at < now() - ($2::bigint * interval '1 millisecond')
        )
        AND (
          $3::boolean
          OR last_successful_at IS NULL
          OR last_successful_at < now() - ($4::bigint * interval '1 millisecond')
          OR (
            status = 'failed'
            AND last_started_at < now() - ($5::bigint * interval '1 millisecond')
          )
        )
      RETURNING current_run_token, last_started_at`,
    [
      runToken,
      RETURN_CUSTOMER_DIRECTORY_LEASE_MS,
      force === true,
      RETURN_CUSTOMER_DIRECTORY_REFRESH_INTERVAL_MS,
      RETURN_CUSTOMER_DIRECTORY_RETRY_MS
    ]
  );
  return result.rows[0] || null;
}

async function markReturnCustomerDirectorySyncFailed(runToken, error) {
  await query(
    `UPDATE return_customer_directory_sync
        SET status = 'failed',
            current_run_token = NULL,
            last_completed_at = now(),
            last_error = $2,
            updated_at = now()
      WHERE singleton_id = 1
        AND current_run_token = $1::uuid`,
    [runToken, cleanDirectoryText(error?.message || error, 2000)]
  );
}

export async function syncReturnCustomerDirectory({
  force = false,
  fetchCustomers = fetchActiveReturnCustomerDirectoryFromNetSuite,
  directAccessEnabled = config.netsuite.directAccessEnabled
} = {}) {
  if (!directAccessEnabled) {
    return { skipped: true, reason: "netsuite_direct_access_disabled" };
  }
  const claim = await claimReturnCustomerDirectorySync({ force });
  if (!claim) return { skipped: true, reason: "not_due_or_already_running" };
  const runToken = String(claim.current_run_token);

  try {
    const customers = validateReturnCustomerDirectorySnapshot(await fetchCustomers());
    await withTransaction(async () => {
      const lease = await query(
        `SELECT 1
           FROM return_customer_directory_sync
          WHERE singleton_id = 1
            AND status = 'running'
            AND current_run_token = $1::uuid
          FOR UPDATE`,
        [runToken]
      );
      if (!lease.rowCount) {
        throw new Error("Return customer directory refresh lease was lost.");
      }
      await upsertReturnCustomerDirectoryEntries(customers, {
        syncGeneration: runToken
      });
      await query(
        `DELETE FROM return_customer_directory
          WHERE sync_generation IS DISTINCT FROM $1::uuid`,
        [runToken]
      );
      const completed = await query(
        `UPDATE return_customer_directory_sync
            SET status = 'succeeded',
                current_run_token = NULL,
                last_completed_at = now(),
                last_successful_at = now(),
                last_error = NULL,
                customer_count = $2,
                updated_at = now()
          WHERE singleton_id = 1
            AND current_run_token = $1::uuid`,
        [runToken, customers.length]
      );
      if (!completed.rowCount) {
        throw new Error("Return customer directory refresh lease was lost before completion.");
      }
    });
    return {
      skipped: false,
      refreshed: customers.length,
      completedAt: new Date().toISOString()
    };
  } catch (error) {
    await markReturnCustomerDirectorySyncFailed(runToken, error).catch(() => null);
    throw error;
  }
}

function kickReturnCustomerDirectoryRefresh() {
  void syncReturnCustomerDirectory().catch((error) => {
    console.error("Return customer directory refresh failed:", error.message);
  });
}

export async function searchReturnCustomerDirectory(search, options = {}) {
  // Validate before the database/fallback branch so bad input stays a 400 even
  // when a mirror consumer has no local snapshot.
  directorySearchInput(search, options.limit);
  let localRows = [];
  let status = null;
  let localError = null;
  try {
    [localRows, status] = await Promise.all([
      searchLocalReturnCustomerDirectory(search, options),
      getReturnCustomerDirectoryStatus()
    ]);
  } catch (error) {
    localError = error;
  }

  const healthy = status ? isHealthyDirectory(status) : false;
  if (localRows.length) {
    if (!healthy) kickReturnCustomerDirectoryRefresh();
    return localRows;
  }
  if (healthy) return [];

  if (!config.netsuite.directAccessEnabled) {
    if (status?.hasCustomers) return [];
    throw directoryError(
      503,
      "The Return customer directory is not available on this server.",
      { code: "RETURN_CUSTOMER_DIRECTORY_UNAVAILABLE", cause: localError }
    );
  }

  // An empty directory or a miss against a stale directory is verified live.
  // This preserves availability during the first sync without putting every
  // healthy customer search back on NetSuite.
  const liveCustomers = await fetchReturnCustomersFromNetSuite(search, options);
  if (liveCustomers.length) {
    await upsertReturnCustomerDirectoryEntries(liveCustomers).catch((error) => {
      console.error("Return customer directory targeted cache failed:", error.message);
    });
  }
  kickReturnCustomerDirectoryRefresh();
  return liveCustomers;
}
