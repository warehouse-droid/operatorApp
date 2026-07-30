import crypto from "node:crypto";
import { TextDecoder } from "node:util";
import { query, withTransaction } from "./db.js";
import { writeAudit } from "./auth-repository.js";
import {
  defaultReturnPolicy,
  effectiveReturnPolicy,
  normalizeReturnPolicy
} from "./return-policy.js";

export const SMART_SCM_YARDS = Object.freeze([
  { locationId: 1, code: "3445" },
  { locationId: 28, code: "2967" },
  { locationId: 15, code: "12441" },
  { locationId: 26, code: "150" }
]);

const YARD_BY_ID = new Map(SMART_SCM_YARDS.map((yard) => [String(yard.locationId), yard]));
const ITEM_MASTER_CSV_REFERENCE_HEADERS = Object.freeze([
  "item_id",
  "item_name",
  "vendor",
  "policy_revision"
]);
const ITEM_MASTER_CSV_EDITABLE_HEADERS = Object.freeze([
  "return_policy",
  "planning_enabled",
  "vendor_yard_id",
  "vendor_yard",
  "lead_time_days",
  ...SMART_SCM_YARDS.flatMap((yard) => [
    `eligible_${yard.code}`,
    `lower_stock_policy_enabled_${yard.code}`,
    `capacity_pallets_${yard.code}`,
    `service_quantile_${yard.code}`,
    `minimum_safety_pallets_${yard.code}`
  ])
]);
export const SMART_SCM_ITEM_MASTER_CSV_HEADERS = Object.freeze([
  ...ITEM_MASTER_CSV_REFERENCE_HEADERS,
  ...ITEM_MASTER_CSV_EDITABLE_HEADERS
]);
const ITEM_MASTER_CSV_HEADER_SET = new Set(SMART_SCM_ITEM_MASTER_CSV_HEADERS);
const ITEM_MASTER_CSV_EDITABLE_HEADER_SET = new Set(ITEM_MASTER_CSV_EDITABLE_HEADERS);
const ITEM_MASTER_CSV_CLEAR = "CLEAR";
const ITEM_MASTER_CSV_MAX_ROWS = 50000;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function smartItemReturnPolicyRevision(row = {}) {
  const updatedAt = row.return_policy_updated_at;
  const timestamp = updatedAt instanceof Date
    ? updatedAt.toISOString()
    : String(updatedAt || "");
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({
      productType: String(row.product_type || ""),
      override: normalizeReturnPolicy(row.return_policy_override, { nullable: true }),
      updatedAt: timestamp
    }))
    .digest("hex");
}

function publicSyncState(row = {}) {
  return {
    inventoryStatus: row.inventory_status || "never",
    inventoryStartedAt: row.inventory_started_at || null,
    inventorySyncedAt: row.inventory_synced_at || null,
    inventoryItemCount: Number(row.inventory_item_count || 0),
    inventoryBalanceCount: Number(row.inventory_balance_count || 0),
    inventoryError: row.inventory_error || "",
    salesStatus: row.sales_status || "never",
    salesStartedAt: row.sales_started_at || null,
    salesSyncedAt: row.sales_synced_at || null,
    salesCoverageStart: row.sales_coverage_start || null,
    salesSyncedThrough: row.sales_synced_through || null,
    salesFactCount: Number(row.sales_fact_count || 0),
    salesError: row.sales_error || "",
    salesSource: row.sales_source || "workbook",
    salesFilename: row.sales_filename || "",
    salesSha256: row.sales_sha256 || "",
    updatedAt: row.updated_at || null
  };
}

export async function getSmartScmSyncStatus() {
  const [state, counts] = await Promise.all([
    query("SELECT * FROM scm_smart_sync_state WHERE id = 1"),
    query(
      `SELECT
         (SELECT COUNT(*) FROM inventory_items)::int AS canonical_items,
         (SELECT COUNT(*) FROM scm_smart_item_policies)::int AS policy_items,
         (SELECT COUNT(*) FROM scm_smart_item_policies p
           WHERE planning_enabled = true AND inactive = false AND discontinued = false
             AND EXISTS (SELECT 1 FROM scm_smart_item_yard_policies y WHERE y.item_id = p.item_id AND y.eligible = true))::int AS planned_items,
         (SELECT COUNT(*) FROM scm_smart_sales_facts WHERE source = 'netsuite')::bigint AS netsuite_sales_facts,
         (SELECT COUNT(*) FROM scm_smart_sales_facts WHERE source = 'csv')::bigint AS csv_sales_facts`
    )
  ]);
  return {
    ...publicSyncState(state.rows[0]),
    canonicalItems: Number(counts.rows[0]?.canonical_items || 0),
    policyItems: Number(counts.rows[0]?.policy_items || 0),
    plannedItems: Number(counts.rows[0]?.planned_items || 0),
    netSuiteSalesFacts: Number(counts.rows[0]?.netsuite_sales_facts || 0),
    csvSalesFacts: Number(counts.rows[0]?.csv_sales_facts || 0)
  };
}

function normalizedItemIdFilter(itemIds) {
  if (!Array.isArray(itemIds)) return null;
  return [...new Set(itemIds
    .map(Number)
    .filter((value) => Number.isSafeInteger(value) && value > 0))];
}

export async function syncSmartScmPoliciesFromInventoryItems({
  itemIds = null,
  updateExisting = true
} = {}) {
  const targetItemIds = normalizedItemIdFilter(itemIds);
  if (targetItemIds && !targetItemIds.length) return { policiesTouched: 0 };
  const conflictAction = updateExisting
    ? `DO UPDATE SET
       item_name = EXCLUDED.item_name,
       item_description = EXCLUDED.item_description,
       vendor = COALESCE(EXCLUDED.vendor, scm_smart_item_policies.vendor),
       vendor_code = COALESCE(EXCLUDED.vendor_code, scm_smart_item_policies.vendor_code),
       series = COALESCE(EXCLUDED.series, scm_smart_item_policies.series),
       stock_unit = EXCLUDED.stock_unit,
       to_plt = EXCLUDED.to_plt,
       to_lyr = EXCLUDED.to_lyr,
       to_sec = EXCLUDED.to_sec,
       to_pcs = EXCLUDED.to_pcs,
       pallet_weight_lbs = EXCLUDED.pallet_weight_lbs,
       source_input_file_id = NULL,
       updated_at = now()`
    : "DO NOTHING";
  const existingPolicyFilter = updateExisting
    ? ""
    : `AND NOT EXISTS (
         SELECT 1
           FROM scm_smart_item_policies existing
          WHERE existing.item_id = i.item_id
       )`;
  const inserted = await query(
    `INSERT INTO scm_smart_item_policies (
       item_id, item_name, item_description, vendor, vendor_code, series, stock_unit,
       to_plt, to_lyr, to_sec, to_pcs, lead_time_days, pallet_weight_lbs,
       inactive, discontinued, planning_enabled, source_input_file_id, updated_at
     )
     SELECT i.item_id,
            i.item_name,
            i.item_description,
            i.vendor,
            i.vendor_id::text,
            i.series,
            i.stock_unit,
            i.to_plt,
            i.to_lyr,
            i.to_sec,
            i.to_pcs,
            i.netsuite_lead_time_days,
            CASE WHEN COALESCE(i.item_weight, 0) > 0 AND COALESCE(i.to_plt, 0) > 0
                 THEN i.item_weight * i.to_plt ELSE NULL END,
            false,
            false,
            false,
            NULL,
            now()
       FROM inventory_items i
      WHERE ($1::bigint[] IS NULL OR i.item_id = ANY($1::bigint[]))
        ${existingPolicyFilter}
     ON CONFLICT (item_id) ${conflictAction}
     RETURNING item_id`,
    [targetItemIds]
  );
  await query(
    `INSERT INTO scm_smart_item_yard_policies (
       item_id, location_id, yard_code, eligible, capacity_pallets, service_quantile,
       minimum_safety_pallets, source_input_file_id
     )
     SELECT p.item_id, yard.location_id, yard.yard_code, false, NULL::numeric,
            CASE WHEN yard.yard_code = '12441' THEN 0.95 ELSE 0.90 END,
            1, NULL
       FROM scm_smart_item_policies p
       CROSS JOIN (VALUES
         (1::bigint, '3445'::text),
         (28::bigint, '2967'::text),
         (15::bigint, '12441'::text),
         (26::bigint, '150'::text)
       ) AS yard(location_id, yard_code)
      WHERE ($1::bigint[] IS NULL OR p.item_id = ANY($1::bigint[]))
        AND NOT EXISTS (
          SELECT 1
            FROM scm_smart_item_yard_policies existing
           WHERE existing.item_id = p.item_id
             AND existing.location_id = yard.location_id
        )
     ON CONFLICT (item_id, location_id) DO NOTHING`,
    [targetItemIds]
  );
  return { policiesTouched: inserted.rowCount };
}

export async function listSmartScmPlanningItemIds() {
  const result = await query(
    `SELECT item_id
       FROM scm_smart_item_policies
      WHERE planning_enabled = true
        AND inactive = false
        AND discontinued = false
        AND EXISTS (
          SELECT 1 FROM scm_smart_item_yard_policies y
           WHERE y.item_id = scm_smart_item_policies.item_id
             AND y.eligible = true
        )
      ORDER BY item_id`
  );
  return result.rows.map((row) => Number(row.item_id)).filter(Number.isInteger);
}

export async function listSmartScmVendorYards() {
  const result = await query(
    `SELECT DISTINCT ON (LOWER(vendor), LOWER(yard))
            id, vendor, yard, address
       FROM dispatch_vendor_yards
      WHERE active = true
      ORDER BY LOWER(vendor), LOWER(yard), id`
  );
  return result.rows.map((row) => ({
    id: Number(row.id),
    vendor: row.vendor,
    yard: row.yard,
    address: row.address || ""
  }));
}

function publicItem(row) {
  const toPlt = nullableNumber(row.to_plt);
  const itemWeight = nullableNumber(row.item_weight);
  const returnPolicy = effectiveReturnPolicy({
    productType: row.product_type,
    override: row.return_policy_override
  });
  return {
    itemId: Number(row.item_id),
    itemName: row.item_name || String(row.item_id),
    displayName: row.display_name || "",
    description: row.item_description || "",
    itemType: row.item_type_text || row.item_type || "",
    productType: row.product_type || "",
    stockUnit: row.stock_unit || "",
    vendorId: row.vendor_id === null ? null : Number(row.vendor_id),
    vendor: row.vendor || "",
    series: row.series || "",
    toPlt,
    toLyr: nullableNumber(row.to_lyr),
    toSec: nullableNumber(row.to_sec),
    toPcs: nullableNumber(row.to_pcs),
    itemWeight,
    palletWeightLbs: toPlt && itemWeight ? toPlt * itemWeight : nullableNumber(row.policy_pallet_weight_lbs),
    netSuiteLeadTimeDays: nullableNumber(row.netsuite_lead_time_days),
    netSuiteSafetyStockLevel: nullableNumber(row.netsuite_safety_stock_level),
    netSuiteSeasonalDemand: row.netsuite_seasonal_demand,
    leadTimeDays: nullableNumber(row.lead_time_days),
    vendorYardId: row.vendor_yard_id === null ? null : Number(row.vendor_yard_id),
    vendorYard: row.vendor_yard || "",
    planningEnabled: Boolean(row.planning_enabled),
    updatedBy: row.updated_by || "",
    updatedAt: row.policy_updated_at || null,
    netSuiteSyncedAt: row.netsuite_synced_at || null,
    returnPolicyOverride: returnPolicy.override,
    returnPolicyDefault: returnPolicy.default,
    returnPolicyEffective: returnPolicy.effective,
    returnPolicySource: returnPolicy.source,
    returnPolicyRevision: smartItemReturnPolicyRevision(row),
    balances: Array.isArray(row.balances) ? row.balances.map((balance) => ({
      locationId: Number(balance.locationId),
      yardCode: balance.yardCode,
      quantityOnHand: number(balance.quantityOnHand),
      quantityAvailable: number(balance.quantityAvailable),
      syncedAt: balance.syncedAt || null
    })) : [],
    yardPolicies: Array.isArray(row.yard_policies) ? row.yard_policies.map((policy) => ({
      locationId: Number(policy.locationId),
      yardCode: policy.yardCode,
      eligible: Boolean(policy.eligible),
      lowerStockPolicyEnabled: Boolean(policy.lowerStockPolicyEnabled),
      capacityPallets: nullableNumber(policy.capacityPallets),
      capacitySource: policy.capacitySource || "default",
      capacityManuallyOverridden: Boolean(policy.capacityManuallyOverridden),
      capacitySourceInputFileId: policy.capacitySourceInputFileId === null || policy.capacitySourceInputFileId === undefined
        ? null
        : Number(policy.capacitySourceInputFileId),
      capacitySourceSheet: policy.capacitySourceSheet || "",
      capacitySourceRow: policy.capacitySourceRow === null || policy.capacitySourceRow === undefined
        ? null
        : Number(policy.capacitySourceRow),
      capacityMatchMethod: policy.capacityMatchMethod || "",
      serviceQuantile: number(policy.serviceQuantile, policy.yardCode === "12441" ? 0.95 : 0.9),
      minimumSafetyPallets: number(policy.minimumSafetyPallets, 1)
    })) : []
  };
}

export async function listSmartScmItems({
  search = "",
  enabled = "",
  vendorYard = "",
  lowerStockPolicy = "",
  returnPolicy = "",
  returnPolicyOverride = "",
  limit = 150,
  offset = 0
} = {}) {
  const params = [];
  const clauses = ["1 = 1"];
  const term = String(search || "").trim();
  if (term) {
    params.push(`%${term}%`);
    clauses.push(`(i.item_name ILIKE $${params.length} OR i.display_name ILIKE $${params.length} OR i.item_description ILIKE $${params.length} OR i.vendor ILIKE $${params.length} OR i.item_id::text ILIKE $${params.length})`);
  }
  if (String(enabled) === "true" || String(enabled) === "false") {
    params.push(String(enabled) === "true");
    clauses.push(`COALESCE(p.planning_enabled, false) = $${params.length}`);
  }
  const vendorYardFilter = String(vendorYard || "").trim();
  if (vendorYardFilter === "assigned") {
    clauses.push("(p.vendor_yard_id IS NOT NULL OR NULLIF(BTRIM(p.vendor_yard), '') IS NOT NULL)");
  } else if (vendorYardFilter === "none") {
    clauses.push("(p.vendor_yard_id IS NULL AND NULLIF(BTRIM(p.vendor_yard), '') IS NULL)");
  } else if (vendorYardFilter === "unmatched") {
    clauses.push("(p.vendor_yard_id IS NULL AND NULLIF(BTRIM(p.vendor_yard), '') IS NOT NULL)");
  } else if (vendorYardFilter) {
    const match = vendorYardFilter.match(/^(?:id:)?([1-9]\d*)$/);
    if (!match) {
      throw Object.assign(new Error("Select a valid vendor yard override filter."), { status: 400 });
    }
    params.push(Number(match[1]));
    clauses.push("p.vendor_yard_id = $" + params.length);
  }
  const lowerStockPolicyFilter = String(lowerStockPolicy || "").trim().toLowerCase();
  if (lowerStockPolicyFilter === "any") {
    clauses.push(`EXISTS (
      SELECT 1
        FROM scm_smart_item_yard_policies lower_policy
       WHERE lower_policy.item_id = i.item_id
         AND lower_policy.lower_stock_policy_enabled = true
    )`);
  } else if (lowerStockPolicyFilter === "none") {
    clauses.push(`NOT EXISTS (
      SELECT 1
        FROM scm_smart_item_yard_policies lower_policy
       WHERE lower_policy.item_id = i.item_id
         AND lower_policy.lower_stock_policy_enabled = true
    )`);
  } else if (lowerStockPolicyFilter) {
    const match = lowerStockPolicyFilter.match(/^yard:(3445|2967|12441|150)$/);
    if (!match) {
      throw Object.assign(new Error("Select a valid lower-stock policy filter."), { status: 400 });
    }
    const yard = SMART_SCM_YARDS.find((candidate) => candidate.code === match[1]);
    params.push(yard.locationId);
    clauses.push(`EXISTS (
      SELECT 1
        FROM scm_smart_item_yard_policies lower_policy
       WHERE lower_policy.item_id = i.item_id
         AND lower_policy.location_id = $${params.length}
         AND lower_policy.lower_stock_policy_enabled = true
    )`);
  }
  const effectiveReturnPolicyFilter = String(returnPolicy || "").trim().toUpperCase();
  if (effectiveReturnPolicyFilter) {
    const policy = normalizeReturnPolicy(effectiveReturnPolicyFilter);
    params.push(policy);
    clauses.push(`COALESCE(
      i.return_policy_override,
      CASE
        WHEN LOWER(REGEXP_REPLACE(REPLACE(BTRIM(COALESCE(i.product_type, '')), '_', ' '), '[[:space:]]+', ' ', 'g')) = 'interlocking' THEN 'ALLOWED'
        WHEN LOWER(REGEXP_REPLACE(REPLACE(BTRIM(COALESCE(i.product_type, '')), '_', ' '), '[[:space:]]+', ' ', 'g')) = 'natural stone' THEN 'APPROVAL_REQUIRED'
        ELSE 'NOT_RETURNABLE'
      END
    ) = $${params.length}`);
  }
  const overrideFilter = String(returnPolicyOverride || "").trim().toUpperCase();
  if (overrideFilter === "ANY") {
    clauses.push("i.return_policy_override IS NOT NULL");
  } else if (overrideFilter === "NONE") {
    clauses.push("i.return_policy_override IS NULL");
  } else if (overrideFilter) {
    params.push(normalizeReturnPolicy(overrideFilter));
    clauses.push(`i.return_policy_override = $${params.length}`);
  }
  const safeLimit = Math.min(500, Math.max(1, Number(limit) || 150));
  const safeOffset = Math.max(0, Number(offset) || 0);
  const countResult = await query(
    `SELECT COUNT(*)::int AS total
       FROM inventory_items i
       LEFT JOIN scm_smart_item_policies p ON p.item_id = i.item_id
      WHERE ${clauses.join(" AND ")}`,
    params
  );
  params.push(safeLimit, safeOffset);
  const result = await query(
    `SELECT i.item_id, i.item_name, i.display_name, i.item_description, i.item_type, i.item_type_text,
            i.product_type, i.return_policy_override, i.return_policy_updated_at,
            i.stock_unit, i.vendor_id, i.vendor, i.series, i.to_plt, i.to_lyr, i.to_sec, i.to_pcs,
            i.item_weight, i.netsuite_lead_time_days, i.netsuite_safety_stock_level,
            i.netsuite_seasonal_demand, i.synced_at AS netsuite_synced_at,
            p.lead_time_days, p.vendor_yard_id, p.vendor_yard, p.planning_enabled,
            p.pallet_weight_lbs AS policy_pallet_weight_lbs, p.updated_by, p.updated_at AS policy_updated_at,
            COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'locationId', yard.location_id,
                'yardCode', yard.yard_code,
                'quantityOnHand', COALESCE(b.quantity_on_hand, 0),
                'quantityAvailable', COALESCE(b.quantity_available, 0),
                'syncedAt', b.synced_at
              ) ORDER BY yard.sort_order)
                FROM (VALUES (1::bigint, '3445'::text, 1), (28, '2967', 2), (15, '12441', 3), (26, '150', 4)) yard(location_id, yard_code, sort_order)
                LEFT JOIN inventory_balances b ON b.item_id = i.item_id AND b.location_id = yard.location_id
            ), '[]'::jsonb) AS balances,
            COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'locationId', y.location_id,
                'yardCode', y.yard_code,
                'eligible', y.eligible,
                'lowerStockPolicyEnabled', y.lower_stock_policy_enabled,
                'capacityPallets', y.capacity_pallets,
                'capacitySource', y.capacity_source,
                'capacityManuallyOverridden', y.capacity_manually_overridden,
                'capacitySourceInputFileId', y.capacity_source_input_file_id,
                'capacitySourceSheet', y.capacity_source_sheet,
                'capacitySourceRow', y.capacity_source_row,
                'capacityMatchMethod', y.capacity_match_method,
                'serviceQuantile', y.service_quantile,
                'minimumSafetyPallets', y.minimum_safety_pallets
              ) ORDER BY CASE y.yard_code WHEN '3445' THEN 1 WHEN '2967' THEN 2 WHEN '12441' THEN 3 ELSE 4 END)
                FROM scm_smart_item_yard_policies y WHERE y.item_id = i.item_id
            ), '[]'::jsonb) AS yard_policies
       FROM inventory_items i
       LEFT JOIN scm_smart_item_policies p ON p.item_id = i.item_id
      WHERE ${clauses.join(" AND ")}
      ORDER BY COALESCE(p.planning_enabled, false) DESC, i.item_name, i.item_id
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return {
    items: result.rows.map(publicItem),
    total: Number(countResult.rows[0]?.total || 0),
    limit: safeLimit,
    offset: safeOffset,
    vendorYards: await listSmartScmVendorYards()
  };
}

function itemMasterCsvError(message, { row = null, column = "" } = {}) {
  const location = row ? `Row ${row}${column ? ` (${column})` : ""}: ` : "";
  return Object.assign(new Error(`${location}${message}`), {
    status: 400,
    csvRow: row,
    csvColumn: column || null
  });
}

function normalizeItemMasterCsvHeader(value) {
  return String(value || "")
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function parseItemMasterCsvMatrix(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw itemMasterCsvError("Select a non-empty Item Master CSV.");
  }
  let source;
  try {
    source = UTF8_DECODER.decode(buffer).replace(/^\uFEFF/, "");
  } catch {
    throw itemMasterCsvError("The Item Master CSV must be saved as UTF-8.");
  }
  if (source.includes("\0")) throw itemMasterCsvError("The Item Master CSV contains invalid binary data.");

  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;
  let closedQuote = false;
  const pushValue = () => {
    row.push(value);
    value = "";
    closedQuote = false;
  };
  const pushRow = () => {
    pushValue();
    rows.push(row);
    row = [];
  };

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
        closedQuote = true;
      } else {
        value += character;
      }
      continue;
    }
    if (closedQuote) {
      if (character === ",") {
        pushValue();
      } else if (character === "\n" || character === "\r") {
        if (character === "\r" && source[index + 1] === "\n") index += 1;
        pushRow();
      } else if (character !== " " && character !== "\t") {
        throw itemMasterCsvError("Unexpected text after a closing quote.");
      }
      continue;
    }
    if (character === '"') {
      if (value) throw itemMasterCsvError("A quoted value must start at the beginning of a CSV cell.");
      quoted = true;
    } else if (character === ",") {
      pushValue();
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && source[index + 1] === "\n") index += 1;
      pushRow();
    } else {
      value += character;
    }
  }
  if (quoted) throw itemMasterCsvError("The Item Master CSV has an unterminated quoted value.");
  if (closedQuote || value || row.length) pushRow();
  return rows;
}

function parseSmartScmItemMasterCsv(buffer) {
  const matrix = parseItemMasterCsvMatrix(buffer);
  const headerRowIndex = matrix.findIndex((row) => row.some((value) => String(value || "").trim()));
  if (headerRowIndex < 0) throw itemMasterCsvError("The Item Master CSV is empty.");
  const headerRow = matrix[headerRowIndex];
  const headers = [];
  const headerIndexes = new Map();
  headerRow.forEach((sourceHeader, index) => {
    const header = normalizeItemMasterCsvHeader(sourceHeader);
    if (!header) throw itemMasterCsvError(`Column ${index + 1} has no header.`);
    if (!ITEM_MASTER_CSV_HEADER_SET.has(header)) {
      throw itemMasterCsvError(`Unsupported column "${String(sourceHeader || "").trim()}". Download a new Item Master CSV template and try again.`);
    }
    if (headerIndexes.has(header)) throw itemMasterCsvError(`Duplicate column "${header}".`);
    headers.push(header);
    headerIndexes.set(header, index);
  });
  if (!headerIndexes.has("item_id")) throw itemMasterCsvError('Required column "item_id" was not found.');
  if (!headerIndexes.has("policy_revision")) {
    throw itemMasterCsvError('Required read-only column "policy_revision" was not found. Download a fresh Item Master CSV template.');
  }
  if (!headers.some((header) => ITEM_MASTER_CSV_EDITABLE_HEADER_SET.has(header))) {
    throw itemMasterCsvError("The CSV has no editable Smart SCM policy columns.");
  }

  const records = [];
  const seenItemIds = new Map();
  for (let index = headerRowIndex + 1; index < matrix.length; index += 1) {
    const sourceRow = matrix[index];
    if (!sourceRow.some((value) => String(value || "").trim())) continue;
    if (sourceRow.length > headerRow.length
      && sourceRow.slice(headerRow.length).some((value) => String(value || "").trim())) {
      throw itemMasterCsvError("This row contains values beyond the final CSV column. Check for an extra comma.", {
        row: index + 1
      });
    }
    if (records.length >= ITEM_MASTER_CSV_MAX_ROWS) {
      throw itemMasterCsvError(`The Item Master CSV cannot contain more than ${ITEM_MASTER_CSV_MAX_ROWS.toLocaleString()} item rows.`);
    }
    const values = Object.fromEntries(headers.map((header) => [
      header,
      sourceRow[headerIndexes.get(header)] ?? ""
    ]));
    const itemIdText = String(values.item_id || "").trim();
    if (!/^[1-9]\d*$/.test(itemIdText)) {
      throw itemMasterCsvError("item_id must be a positive NetSuite item ID.", { row: index + 1, column: "item_id" });
    }
    const itemId = Number(itemIdText);
    if (!Number.isSafeInteger(itemId)) {
      throw itemMasterCsvError("item_id is outside the supported numeric range.", { row: index + 1, column: "item_id" });
    }
    if (seenItemIds.has(itemId)) {
      throw itemMasterCsvError(`Duplicate item_id ${itemId}; it was already provided on row ${seenItemIds.get(itemId)}.`, {
        row: index + 1,
        column: "item_id"
      });
    }
    seenItemIds.set(itemId, index + 1);
    records.push({ rowNumber: index + 1, itemId, values });
  }
  if (!records.length) throw itemMasterCsvError("The Item Master CSV has no item rows.");
  return { records, headers: new Set(headers) };
}

function protectItemMasterSpreadsheetText(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /^'|^[\t\r ]*[=+\-@]/.test(text) ? `'${text}` : text;
}

function itemMasterCsvCell(value, { protectSpreadsheetText = false } = {}) {
  const text = protectSpreadsheetText
    ? protectItemMasterSpreadsheetText(value)
    : value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function itemMasterCsvValue(record, header) {
  if (!Object.hasOwn(record.values, header)) return { supplied: false, value: "" };
  const value = String(record.values[header] ?? "").trim();
  return { supplied: Boolean(value), value };
}

function itemMasterCsvTextValue(record, header) {
  const cell = itemMasterCsvValue(record, header);
  if (!cell.supplied) return cell;
  if (cell.value.startsWith("''")) {
    return { supplied: true, value: cell.value.slice(1) };
  }
  if (/^'[\t\r ]*[=+\-@]/.test(cell.value)) {
    return { supplied: true, value: cell.value.slice(1).trim() };
  }
  return cell;
}

function isItemMasterCsvClear(value) {
  return String(value || "").trim().toUpperCase() === ITEM_MASTER_CSV_CLEAR;
}

function parseItemMasterCsvBoolean(record, header) {
  const cell = itemMasterCsvValue(record, header);
  if (!cell.supplied) return { supplied: false, value: null };
  const normalized = cell.value.toLowerCase();
  if (["true", "yes", "1"].includes(normalized)) return { supplied: true, value: true };
  if (["false", "no", "0"].includes(normalized)) return { supplied: true, value: false };
  throw itemMasterCsvError(`${header} must be true/false, yes/no, or 1/0.`, {
    row: record.rowNumber,
    column: header
  });
}

function parseItemMasterCsvNumber(record, header, options = {}) {
  const {
    minimum,
    maximum,
    exclusiveMinimum = false,
    exclusiveMaximum = false,
    clearable = false,
    description = header
  } = options;
  const cell = itemMasterCsvValue(record, header);
  if (!cell.supplied) return { supplied: false, value: null };
  if (isItemMasterCsvClear(cell.value)) {
    if (clearable) return { supplied: true, value: null };
    throw itemMasterCsvError(`${description} cannot be cleared.`, { row: record.rowNumber, column: header });
  }
  const parsed = Number(cell.value);
  if (!Number.isFinite(parsed)) {
    throw itemMasterCsvError(`${description} must be a number.`, { row: record.rowNumber, column: header });
  }
  const below = minimum !== undefined && (exclusiveMinimum ? parsed <= minimum : parsed < minimum);
  const above = maximum !== undefined && (exclusiveMaximum ? parsed >= maximum : parsed > maximum);
  const matchesExistingValue = Object.hasOwn(options, "existingValue")
    && parsed === options.existingValue;
  if ((below || above) && !matchesExistingValue) {
    const range = exclusiveMinimum || exclusiveMaximum
      ? `between ${Number(minimum).toFixed(2)} and ${Number(maximum).toFixed(2)}`
      : `between ${Number(minimum).toLocaleString()} and ${Number(maximum).toLocaleString()}`;
    throw itemMasterCsvError(`${description} must be ${range}.`, { row: record.rowNumber, column: header });
  }
  return { supplied: true, value: parsed };
}

function normalizedText(value) {
  return String(value || "").trim().toLowerCase();
}

function itemMasterPolicyRevision(item, yardPolicyFor) {
  const vendorYardId = item.vendor_yard_id ?? item.vendorYardId;
  const snapshot = {
    returnPolicyOverride: normalizeReturnPolicy(
      item.return_policy_override ?? item.returnPolicyOverride,
      { nullable: true }
    ),
    returnPolicyDefault: defaultReturnPolicy(
      item.product_type ?? item.productType
    ),
    planningEnabled: Boolean(item.planning_enabled ?? item.planningEnabled),
    vendorYardId: vendorYardId === null || vendorYardId === undefined ? null : Number(vendorYardId),
    vendorYard: String(item.vendor_yard ?? item.vendorYard ?? "").trim() || null,
    leadTimeDays: nullableNumber(item.lead_time_days ?? item.leadTimeDays),
    yards: SMART_SCM_YARDS.map((yard) => {
      const policy = yardPolicyFor(yard) || {};
      const capacity = Object.hasOwn(policy, "capacity_pallets")
        ? policy.capacity_pallets
        : policy.capacityPallets;
      return {
        locationId: yard.locationId,
        eligible: Boolean(policy.eligible),
        lowerStockPolicyEnabled: Boolean(
          policy.lower_stock_policy_enabled ?? policy.lowerStockPolicyEnabled
        ),
        capacityPallets: Boolean(policy.eligible) ? nullableNumber(capacity) : null,
        serviceQuantile: number(
          policy.service_quantile ?? policy.serviceQuantile,
          yard.code === "12441" ? 0.95 : 0.9
        ),
        minimumSafetyPallets: number(
          policy.minimum_safety_pallets ?? policy.minimumSafetyPallets,
          1
        )
      };
    })
  };
  return crypto.createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

function cleanItemMasterCsvFilename(value) {
  const basename = String(value || "smart-scm-item-master.csv")
    .split(/[\\/]/)
    .pop()
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 180) || "smart-scm-item-master.csv";
  if (!basename.toLowerCase().endsWith(".csv")) {
    throw itemMasterCsvError("Item Master bulk updates require a .csv file.");
  }
  return basename;
}

function itemMasterCsvVendorNames(item, mappings = []) {
  const names = new Set();
  const canonicalVendor = normalizedText(item.vendor);
  if (canonicalVendor) names.add(canonicalVendor);
  const vendorId = String(item.vendor_id || "").trim();
  for (const mapping of mappings) {
    const matchesId = vendorId && String(mapping.netsuite_vendor_id || "").trim() === vendorId;
    const matchesName = canonicalVendor
      && normalizedText(mapping.netsuite_vendor_name) === canonicalVendor;
    if ((matchesId || matchesName) && normalizedText(mapping.local_vendor)) {
      names.add(normalizedText(mapping.local_vendor));
    }
  }
  return names;
}

function resolveItemMasterCsvVendorYard(record, item, {
  activeYardsById,
  canonicalActiveYards,
  vendorMappings
}) {
  const idCell = itemMasterCsvValue(record, "vendor_yard_id");
  const nameCell = itemMasterCsvTextValue(record, "vendor_yard");
  if (!idCell.supplied && !nameCell.supplied) return { supplied: false };
  if (isItemMasterCsvClear(idCell.value) || isItemMasterCsvClear(nameCell.value)) {
    return { supplied: true, vendorYardId: null, vendorYard: null };
  }

  const currentId = item.vendor_yard_id === null ? null : Number(item.vendor_yard_id);
  const currentName = String(item.vendor_yard || "").trim() || null;
  let requestedId = null;
  if (idCell.supplied) {
    if (!/^[1-9]\d*$/.test(idCell.value)) {
      throw itemMasterCsvError("vendor_yard_id must be a positive active vendor-yard ID or CLEAR.", {
        row: record.rowNumber,
        column: "vendor_yard_id"
      });
    }
    requestedId = Number(idCell.value);
    if (!Number.isSafeInteger(requestedId)) {
      throw itemMasterCsvError("vendor_yard_id is outside the supported numeric range.", {
        row: record.rowNumber,
        column: "vendor_yard_id"
      });
    }
  }

  const requestedName = nameCell.supplied ? nameCell.value : null;
  const idMatchesCurrent = !idCell.supplied || requestedId === currentId;
  const nameMatchesCurrent = !nameCell.supplied || normalizedText(requestedName) === normalizedText(currentName);
  if (idMatchesCurrent && nameMatchesCurrent) {
    return { supplied: false };
  }

  if (idCell.supplied && requestedId !== currentId) {
    const selected = activeYardsById.get(requestedId);
    if (!selected) {
      throw itemMasterCsvError(`Vendor yard ID ${requestedId} is not active.`, {
        row: record.rowNumber,
        column: "vendor_yard_id"
      });
    }
    if (nameCell.supplied
      && !nameMatchesCurrent
      && normalizedText(requestedName) !== normalizedText(selected.yard)) {
      throw itemMasterCsvError(`vendor_yard "${requestedName}" does not match vendor_yard_id ${requestedId} (${selected.yard}).`, {
        row: record.rowNumber,
        column: "vendor_yard"
      });
    }
    return {
      supplied: true,
      vendorYardId: requestedId,
      vendorYard: String(selected.yard || "").trim()
    };
  }

  if (nameCell.supplied && !nameMatchesCurrent) {
    if (requestedName.length > 180) {
      throw itemMasterCsvError("vendor_yard is too long.", { row: record.rowNumber, column: "vendor_yard" });
    }
    const requestedKey = normalizedText(requestedName);
    const candidates = canonicalActiveYards.filter((yard) => normalizedText(yard.yard) === requestedKey);
    const matchingVendors = itemMasterCsvVendorNames(item, vendorMappings);
    const vendorCandidates = candidates.filter((yard) => matchingVendors.has(normalizedText(yard.vendor)));
    const selectedCandidates = vendorCandidates.length ? vendorCandidates : candidates;
    if (!selectedCandidates.length) {
      throw itemMasterCsvError(`No active local vendor yard exactly matches "${requestedName}".`, {
        row: record.rowNumber,
        column: "vendor_yard"
      });
    }
    if (selectedCandidates.length > 1) {
      throw itemMasterCsvError(`Vendor yard "${requestedName}" is ambiguous; enter its vendor_yard_id instead.`, {
        row: record.rowNumber,
        column: "vendor_yard"
      });
    }
    const selected = selectedCandidates[0];
    return {
      supplied: true,
      vendorYardId: Number(selected.id),
      vendorYard: String(selected.yard || "").trim()
    };
  }

  if (idCell.supplied && requestedId === currentId) return { supplied: false };
  return { supplied: false };
}

export async function buildSmartScmItemMasterCsvTemplate() {
  const result = await query(
    `SELECT i.item_id, i.item_name, i.vendor, i.product_type, i.return_policy_override,
            CASE WHEN p.item_id IS NULL THEN false ELSE p.planning_enabled END AS planning_enabled,
            p.vendor_yard_id, p.vendor_yard,
            CASE
              WHEN p.item_id IS NULL THEN i.netsuite_lead_time_days
              ELSE p.lead_time_days
            END AS lead_time_days,
            COALESCE(
              jsonb_object_agg(
                y.yard_code,
                jsonb_build_object(
                  'eligible', y.eligible,
                  'lowerStockPolicyEnabled', y.lower_stock_policy_enabled,
                  'capacityPallets', y.capacity_pallets,
                  'serviceQuantile', y.service_quantile,
                  'minimumSafetyPallets', y.minimum_safety_pallets
                )
              ) FILTER (WHERE y.item_id IS NOT NULL),
              '{}'::jsonb
            ) AS yard_policies
       FROM inventory_items i
       LEFT JOIN scm_smart_item_policies p ON p.item_id = i.item_id
       LEFT JOIN scm_smart_item_yard_policies y
         ON y.item_id = i.item_id
        AND y.location_id = ANY($1::bigint[])
      GROUP BY i.item_id, i.item_name, i.vendor, i.product_type, i.return_policy_override,
               i.netsuite_lead_time_days, p.item_id, p.planning_enabled,
               p.vendor_yard_id, p.vendor_yard, p.lead_time_days
      ORDER BY LOWER(i.item_name), i.item_name, i.item_id`,
    [SMART_SCM_YARDS.map((yard) => yard.locationId)]
  );
  const lines = [
    SMART_SCM_ITEM_MASTER_CSV_HEADERS.map(itemMasterCsvCell).join(","),
    ...result.rows.map((row) => {
      const values = {
        item_id: row.item_id,
        item_name: row.item_name,
        vendor: row.vendor,
        return_policy: row.return_policy_override || "DEFAULT",
        planning_enabled: Boolean(row.planning_enabled),
        vendor_yard_id: row.vendor_yard_id,
        vendor_yard: row.vendor_yard,
        lead_time_days: row.lead_time_days
      };
      for (const yard of SMART_SCM_YARDS) {
        const policy = row.yard_policies?.[yard.code] || {};
        values[`eligible_${yard.code}`] = policy.eligible === undefined ? false : Boolean(policy.eligible);
        values[`lower_stock_policy_enabled_${yard.code}`] = Boolean(policy.lowerStockPolicyEnabled);
        values[`capacity_pallets_${yard.code}`] = policy.eligible
          ? policy.capacityPallets ?? null
          : null;
        values[`service_quantile_${yard.code}`] = policy.serviceQuantile ?? (yard.code === "12441" ? 0.95 : 0.9);
        values[`minimum_safety_pallets_${yard.code}`] = policy.minimumSafetyPallets ?? 1;
      }
      values.policy_revision = itemMasterPolicyRevision(
        row,
        (yard) => row.yard_policies?.[yard.code]
      );
      return SMART_SCM_ITEM_MASTER_CSV_HEADERS.map((header) => itemMasterCsvCell(values[header], {
        protectSpreadsheetText: ["item_name", "vendor", "vendor_yard"].includes(header)
      })).join(",");
    })
  ];
  return Buffer.from(`\uFEFF${lines.join("\r\n")}\r\n`, "utf8");
}

export async function importSmartScmItemMasterCsv({
  buffer,
  filename = "smart-scm-item-master.csv",
  operatorId = null,
  allowReturnPolicyChange = false
} = {}) {
  const cleanFilename = cleanItemMasterCsvFilename(filename);
  const parsed = parseSmartScmItemMasterCsv(buffer);
  const itemIds = parsed.records.map((record) => record.itemId);
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");

  return withTransaction(async () => {
    await query("SELECT pg_advisory_xact_lock(hashtext('smart-scm-item-master-csv-import'))");
    await syncSmartScmPoliciesFromInventoryItems({ itemIds, updateExisting: false });
    const itemResult = await query(
      `SELECT i.item_id, i.vendor_id, i.vendor, i.product_type, i.return_policy_override,
              p.planning_enabled, p.vendor_yard_id, p.vendor_yard, p.lead_time_days
         FROM inventory_items i
         JOIN scm_smart_item_policies p ON p.item_id = i.item_id
        WHERE i.item_id = ANY($1::bigint[])
        ORDER BY i.item_id
        FOR UPDATE OF p, i`,
      [itemIds]
    );
    const yardResult = await query(
      `SELECT item_id, location_id, yard_code, eligible, lower_stock_policy_enabled, capacity_pallets,
              service_quantile, minimum_safety_pallets
         FROM scm_smart_item_yard_policies
        WHERE item_id = ANY($1::bigint[])
          AND location_id = ANY($2::bigint[])
        ORDER BY item_id, location_id
        FOR UPDATE`,
      [itemIds, SMART_SCM_YARDS.map((yard) => yard.locationId)]
    );
    const activeYardResult = await query(
      `SELECT id, vendor, yard
         FROM dispatch_vendor_yards
        WHERE active = true
        ORDER BY id
        FOR SHARE`
    );
    const vendorMappingResult = await query(
      `SELECT netsuite_vendor_id, netsuite_vendor_name, local_vendor
         FROM dispatch_vendor_mappings
        WHERE active = true
          AND NULLIF(BTRIM(local_vendor), '') IS NOT NULL`
    );

    const itemsById = new Map(itemResult.rows.map((row) => [Number(row.item_id), row]));
    for (const record of parsed.records) {
      if (!itemsById.has(record.itemId)) {
        throw itemMasterCsvError(`NetSuite item ${record.itemId} was not found in Item Master.`, {
          row: record.rowNumber,
          column: "item_id"
        });
      }
    }
    const yardPoliciesByItem = new Map();
    for (const row of yardResult.rows) {
      const itemId = Number(row.item_id);
      if (!yardPoliciesByItem.has(itemId)) yardPoliciesByItem.set(itemId, new Map());
      yardPoliciesByItem.get(itemId).set(Number(row.location_id), row);
    }
    const activeYardsById = new Map(activeYardResult.rows.map((row) => [Number(row.id), row]));
    const canonicalYardsByKey = new Map();
    for (const row of activeYardResult.rows) {
      const key = `${normalizedText(row.vendor)}\0${normalizedText(row.yard)}`;
      if (!canonicalYardsByKey.has(key)) canonicalYardsByKey.set(key, row);
    }
    const vendorResolution = {
      activeYardsById,
      canonicalActiveYards: [...canonicalYardsByKey.values()],
      vendorMappings: vendorMappingResult.rows
    };
    const itemChanges = [];
    const yardChanges = [];
    const updatedItemIds = new Set();
    const fieldCounts = {};
    const countField = (header) => {
      fieldCounts[header] = Number(fieldCounts[header] || 0) + 1;
    };

    for (const record of parsed.records) {
      const current = itemsById.get(record.itemId);
      const currentYards = yardPoliciesByItem.get(record.itemId) || new Map();
      for (const yard of SMART_SCM_YARDS) {
        if (!currentYards.has(yard.locationId)) {
          throw itemMasterCsvError(`Smart SCM yard policy ${yard.code} is missing for this item.`, {
            row: record.rowNumber,
            column: `eligible_${yard.code}`
          });
        }
      }
      const revision = itemMasterCsvValue(record, "policy_revision");
      if (!revision.supplied || !/^[a-f0-9]{64}$/i.test(revision.value)) {
        throw itemMasterCsvError("policy_revision is missing or invalid. Download a fresh Item Master CSV template.", {
          row: record.rowNumber,
          column: "policy_revision"
        });
      }
      const currentRevision = itemMasterPolicyRevision(
        current,
        (yard) => currentYards.get(yard.locationId)
      );
      if (revision.value.toLowerCase() !== currentRevision) {
        throw itemMasterCsvError("This item changed after the CSV template was downloaded. Download a fresh template and reapply this row.", {
          row: record.rowNumber,
          column: "policy_revision"
        });
      }
      const itemChange = {
        item_id: record.itemId,
        change_return_policy: false,
        return_policy_override: null,
        change_planning_enabled: false,
        planning_enabled: null,
        change_lead_time_days: false,
        lead_time_days: null,
        change_vendor_yard: false,
        vendor_yard_id: null,
        vendor_yard: null
      };

      if (parsed.headers.has("return_policy")) {
        const rawPolicy = String(record.values.return_policy ?? "").trim();
        const requestedPolicy = normalizeReturnPolicy(rawPolicy, { nullable: true });
        const currentPolicy = normalizeReturnPolicy(current.return_policy_override, { nullable: true });
        if (requestedPolicy !== currentPolicy) {
          if (!allowReturnPolicyChange) {
            throw itemMasterCsvError("Only an admin can change the company-wide Return Policy.", {
              row: record.rowNumber,
              column: "return_policy"
            });
          }
          itemChange.change_return_policy = true;
          itemChange.return_policy_override = requestedPolicy;
          countField("return_policy");
        }
      }

      const planning = parseItemMasterCsvBoolean(record, "planning_enabled");
      if (planning.supplied && planning.value !== Boolean(current.planning_enabled)) {
        itemChange.change_planning_enabled = true;
        itemChange.planning_enabled = planning.value;
        countField("planning_enabled");
      }
      const currentLeadTime = nullableNumber(current.lead_time_days);
      const leadTime = parseItemMasterCsvNumber(record, "lead_time_days", {
        minimum: 1,
        maximum: 730,
        clearable: true,
        description: "Lead time",
        existingValue: currentLeadTime
      });
      if (leadTime.supplied && leadTime.value !== currentLeadTime) {
        itemChange.change_lead_time_days = true;
        itemChange.lead_time_days = leadTime.value;
        countField("lead_time_days");
      }
      const vendorYard = resolveItemMasterCsvVendorYard(record, current, vendorResolution);
      if (vendorYard.supplied) {
        const currentVendorYardId = current.vendor_yard_id === null ? null : Number(current.vendor_yard_id);
        const changed = vendorYard.vendorYardId !== currentVendorYardId
          || normalizedText(vendorYard.vendorYard) !== normalizedText(current.vendor_yard);
        if (changed) {
          itemChange.change_vendor_yard = true;
          itemChange.vendor_yard_id = vendorYard.vendorYardId;
          itemChange.vendor_yard = vendorYard.vendorYard;
          countField("vendor_yard");
        }
      }
      if (itemChange.change_return_policy || itemChange.change_planning_enabled || itemChange.change_lead_time_days || itemChange.change_vendor_yard) {
        itemChanges.push(itemChange);
        updatedItemIds.add(record.itemId);
      }

      for (const yard of SMART_SCM_YARDS) {
        const currentYard = currentYards.get(yard.locationId);
        const yardChange = {
          item_id: record.itemId,
          location_id: yard.locationId,
          change_eligible: false,
          eligible: null,
          change_lower_stock_policy_enabled: false,
          lower_stock_policy_enabled: null,
          change_capacity_pallets: false,
          capacity_pallets: null,
          change_service_quantile: false,
          service_quantile: null,
          change_minimum_safety_pallets: false,
          minimum_safety_pallets: null
        };
        const eligibleHeader = `eligible_${yard.code}`;
        const eligible = parseItemMasterCsvBoolean(record, eligibleHeader);
        const currentEligible = Boolean(currentYard.eligible);
        const effectiveEligible = eligible.supplied ? eligible.value : currentEligible;
        if (eligible.supplied && eligible.value !== currentEligible) {
          yardChange.change_eligible = true;
          yardChange.eligible = eligible.value;
          countField(eligibleHeader);
        }
        const lowerStockHeader = `lower_stock_policy_enabled_${yard.code}`;
        const lowerStockPolicy = parseItemMasterCsvBoolean(record, lowerStockHeader);
        const currentLowerStockPolicy = Boolean(currentYard.lower_stock_policy_enabled);
        if (lowerStockPolicy.supplied && lowerStockPolicy.value !== currentLowerStockPolicy) {
          yardChange.change_lower_stock_policy_enabled = true;
          yardChange.lower_stock_policy_enabled = lowerStockPolicy.value;
          countField(lowerStockHeader);
        }
        const capacityHeader = `capacity_pallets_${yard.code}`;
        const currentCapacity = nullableNumber(currentYard.capacity_pallets);
        const capacity = parseItemMasterCsvNumber(record, capacityHeader, {
          minimum: 0,
          maximum: 10000,
          clearable: true,
          description: `Capacity for ${yard.code}`,
          existingValue: currentCapacity
        });
        if (!effectiveEligible) {
          const suppliedExistingCapacity = capacity.supplied
            && capacity.value !== null
            && currentEligible
            && capacity.value === currentCapacity;
          if (capacity.supplied && capacity.value !== null && !suppliedExistingCapacity) {
            throw itemMasterCsvError(`Capacity for ${yard.code} must be blank when the yard is not eligible.`, {
              row: record.rowNumber,
              column: capacityHeader
            });
          }
          if (currentCapacity !== null) {
            yardChange.change_capacity_pallets = true;
            yardChange.capacity_pallets = null;
            countField(capacityHeader);
          }
        } else if (!capacity.supplied && currentCapacity === null) {
          throw itemMasterCsvError(`Capacity for ${yard.code} is required when the yard is eligible.`, {
            row: record.rowNumber,
            column: capacityHeader
          });
        } else if (capacity.supplied && capacity.value === null) {
          throw itemMasterCsvError(`Capacity for ${yard.code} cannot be cleared while the yard is eligible.`, {
            row: record.rowNumber,
            column: capacityHeader
          });
        } else if (capacity.supplied && capacity.value !== currentCapacity) {
          yardChange.change_capacity_pallets = true;
          yardChange.capacity_pallets = capacity.value;
          countField(capacityHeader);
        }
        const quantileHeader = `service_quantile_${yard.code}`;
        const currentQuantile = number(currentYard.service_quantile);
        const quantile = parseItemMasterCsvNumber(record, quantileHeader, {
          minimum: 0.5,
          maximum: 1,
          exclusiveMinimum: true,
          exclusiveMaximum: true,
          description: `Service quantile for ${yard.code}`,
          existingValue: currentQuantile
        });
        if (quantile.supplied && quantile.value !== currentQuantile) {
          yardChange.change_service_quantile = true;
          yardChange.service_quantile = quantile.value;
          countField(quantileHeader);
        }
        const safetyHeader = `minimum_safety_pallets_${yard.code}`;
        const currentSafety = number(currentYard.minimum_safety_pallets);
        const safety = parseItemMasterCsvNumber(record, safetyHeader, {
          minimum: 0,
          maximum: 10000,
          description: `Minimum safety pallets for ${yard.code}`,
          existingValue: currentSafety
        });
        if (safety.supplied && safety.value !== currentSafety) {
          yardChange.change_minimum_safety_pallets = true;
          yardChange.minimum_safety_pallets = safety.value;
          countField(safetyHeader);
        }
        if (yardChange.change_eligible
          || yardChange.change_lower_stock_policy_enabled
          || yardChange.change_capacity_pallets
          || yardChange.change_service_quantile
          || yardChange.change_minimum_safety_pallets) {
          yardChanges.push(yardChange);
          updatedItemIds.add(record.itemId);
        }
      }
    }

    if (itemChanges.length) {
      await query(
        `WITH changes AS (
           SELECT *
             FROM jsonb_to_recordset($1::jsonb) AS change(
               item_id bigint,
               change_return_policy boolean,
               return_policy_override text
             )
         )
         UPDATE inventory_items item
            SET return_policy_override = change.return_policy_override,
                return_policy_updated_by = $2,
                return_policy_updated_at = now()
           FROM changes change
          WHERE item.item_id = change.item_id
            AND change.change_return_policy = true`,
        [JSON.stringify(itemChanges), operatorId]
      );
      await query(
        `WITH changes AS (
           SELECT *
             FROM jsonb_to_recordset($1::jsonb) AS change(
               item_id bigint,
               change_planning_enabled boolean,
               planning_enabled boolean,
               change_lead_time_days boolean,
               lead_time_days numeric,
               change_vendor_yard boolean,
               vendor_yard_id bigint,
               vendor_yard text
             )
         )
         UPDATE scm_smart_item_policies policy
            SET planning_enabled = CASE
                  WHEN change.change_planning_enabled THEN change.planning_enabled
                  ELSE policy.planning_enabled
                END,
                lead_time_days = CASE
                  WHEN change.change_lead_time_days THEN change.lead_time_days
                  ELSE policy.lead_time_days
                END,
                vendor_yard_id = CASE
                  WHEN change.change_vendor_yard THEN change.vendor_yard_id
                  ELSE policy.vendor_yard_id
                END,
                vendor_yard = CASE
                  WHEN change.change_vendor_yard THEN change.vendor_yard
                  ELSE policy.vendor_yard
                END,
                source_input_file_id = NULL,
                updated_by = $2,
                updated_at = now()
           FROM changes change
          WHERE policy.item_id = change.item_id
            AND (
              change.change_planning_enabled
              OR change.change_lead_time_days
              OR change.change_vendor_yard
            )`,
        [JSON.stringify(itemChanges), operatorId]
      );
    }
    if (yardChanges.length) {
      await query(
        `WITH changes AS (
           SELECT *
             FROM jsonb_to_recordset($1::jsonb) AS change(
               item_id bigint,
               location_id bigint,
               change_eligible boolean,
               eligible boolean,
               change_lower_stock_policy_enabled boolean,
               lower_stock_policy_enabled boolean,
               change_capacity_pallets boolean,
               capacity_pallets numeric,
               change_service_quantile boolean,
               service_quantile numeric,
               change_minimum_safety_pallets boolean,
               minimum_safety_pallets numeric
             )
         )
         , resolved_changes AS (
           SELECT change.*,
                  CASE
                    WHEN change.change_eligible THEN change.eligible
                    ELSE policy.eligible
                  END AS final_eligible
             FROM changes change
             JOIN scm_smart_item_yard_policies policy
               ON policy.item_id = change.item_id
              AND policy.location_id = change.location_id
         )
         UPDATE scm_smart_item_yard_policies policy
            SET eligible = change.final_eligible,
                lower_stock_policy_enabled = CASE
                  WHEN change.change_lower_stock_policy_enabled THEN change.lower_stock_policy_enabled
                  ELSE policy.lower_stock_policy_enabled
                END,
                capacity_pallets = CASE
                  WHEN change.final_eligible = false THEN NULL
                  WHEN change.change_capacity_pallets THEN change.capacity_pallets
                  ELSE policy.capacity_pallets
                END,
                service_quantile = CASE
                  WHEN change.change_service_quantile THEN change.service_quantile
                  ELSE policy.service_quantile
                END,
                minimum_safety_pallets = CASE
                  WHEN change.change_minimum_safety_pallets THEN change.minimum_safety_pallets
                  ELSE policy.minimum_safety_pallets
                END,
                manually_overridden = policy.manually_overridden
                  OR change.change_eligible
                  OR change.change_service_quantile
                  OR change.change_minimum_safety_pallets,
                capacity_manually_overridden = CASE
                  WHEN change.final_eligible = false THEN false
                  ELSE policy.capacity_manually_overridden OR change.change_capacity_pallets
                END,
                capacity_source = CASE
                  WHEN change.final_eligible = false THEN 'default'
                  WHEN change.change_capacity_pallets THEN 'manual'
                  ELSE policy.capacity_source
                END,
                capacity_source_input_file_id = CASE
                  WHEN change.final_eligible = false OR change.change_capacity_pallets THEN NULL
                  ELSE policy.capacity_source_input_file_id
                END,
                capacity_source_sheet = CASE
                  WHEN change.final_eligible = false OR change.change_capacity_pallets THEN NULL
                  ELSE policy.capacity_source_sheet
                END,
                capacity_source_row = CASE
                  WHEN change.final_eligible = false OR change.change_capacity_pallets THEN NULL
                  ELSE policy.capacity_source_row
                END,
                capacity_match_method = CASE
                  WHEN change.final_eligible = false OR change.change_capacity_pallets THEN NULL
                  ELSE policy.capacity_match_method
                END,
                source_input_file_id = NULL,
                updated_by = $2,
                updated_at = now()
           FROM resolved_changes change
          WHERE policy.item_id = change.item_id
            AND policy.location_id = change.location_id`,
        [JSON.stringify(yardChanges), operatorId]
      );
    }

    const summary = {
      filename: cleanFilename,
      sha256,
      bytes: buffer.length,
      rowsRead: parsed.records.length,
      itemsUpdated: updatedItemIds.size,
      returnPoliciesUpdated: itemChanges.filter((change) => change.change_return_policy).length,
      itemPoliciesUpdated: itemChanges.filter((change) => (
        change.change_planning_enabled
        || change.change_lead_time_days
        || change.change_vendor_yard
      )).length,
      yardPoliciesUpdated: yardChanges.length,
      unchangedRows: parsed.records.length - updatedItemIds.size,
      fieldCounts
    };
    await writeAudit({
      actorOperatorId: operatorId,
      source: "smart_scm",
      action: "smart_scm.item_master.csv_import",
      details: {
        ...summary,
        updatedItemIds: [...updatedItemIds].slice(0, 100),
        updatedItemIdsTruncated: updatedItemIds.size > 100
      }
    });
    return summary;
  });
}

export async function updateSmartScmItem(itemId, values = {}, operatorId = null, {
  allowReturnPolicyChange = false
} = {}) {
  const id = Number(itemId);
  if (!Number.isInteger(id) || id <= 0) throw Object.assign(new Error("A valid item ID is required."), { status: 400 });
  const hasLeadTimeSource = Object.hasOwn(values, "leadTimeDays");
  const leadTimeDays = nullableNumber(values.leadTimeDays);
  if (leadTimeDays !== null && (leadTimeDays < 1 || leadTimeDays > 730)) {
    throw Object.assign(new Error("Lead time must be between 1 and 730 days."), { status: 400 });
  }
  const hasVendorYardSource = Object.hasOwn(values, "vendorYard") || Object.hasOwn(values, "vendorYardId");
  let vendorYard = hasVendorYardSource ? String(values.vendorYard || "").trim() || null : null;
  if (vendorYard && vendorYard.length > 180) throw Object.assign(new Error("Vendor yard is too long."), { status: 400 });
  let vendorYardId = nullableNumber(values.vendorYardId);
  if (vendorYardId !== null) {
    vendorYardId = Math.trunc(vendorYardId);
    const yardResult = await query(
      "SELECT id, yard FROM dispatch_vendor_yards WHERE id = $1 AND active = true",
      [vendorYardId]
    );
    if (!yardResult.rowCount) throw Object.assign(new Error("Select an active local vendor yard."), { status: 400 });
    vendorYard = yardResult.rows[0].yard;
  }
  const planningEnabled = values.planningEnabled === undefined ? null : Boolean(values.planningEnabled);
  const hasReturnPolicy = Object.hasOwn(values, "returnPolicyOverride");
  if (hasReturnPolicy && !allowReturnPolicyChange) {
    throw Object.assign(new Error("Only an admin can change the company-wide Return Policy."), { status: 403 });
  }
  const returnPolicyOverride = hasReturnPolicy
    ? normalizeReturnPolicy(values.returnPolicyOverride, { nullable: true })
    : null;
  const expectedReturnPolicyRevision = hasReturnPolicy
    ? String(values.expectedReturnPolicyRevision || "").trim().toLowerCase()
    : "";
  if (hasReturnPolicy && !/^[a-f0-9]{64}$/.test(expectedReturnPolicyRevision)) {
    throw Object.assign(
      new Error("Refresh Item Master before changing Return Policy, then try again."),
      { status: 400, code: "RETURN_POLICY_REVISION_REQUIRED" }
    );
  }
  const yardPolicies = Array.isArray(values.yardPolicies) ? values.yardPolicies : [];
  const hasSmartPolicyChange = hasLeadTimeSource
    || hasVendorYardSource
    || planningEnabled !== null;
  let returnPolicyChanged = false;
  const result = await withTransaction(async () => {
    await syncSmartScmPoliciesFromInventoryItems({
      itemIds: [id],
      updateExisting: hasSmartPolicyChange
    });
    if (hasReturnPolicy) {
      const currentPolicy = await query(
        `SELECT item_id, product_type, return_policy_override, return_policy_updated_at
           FROM inventory_items
          WHERE item_id = $1
          FOR UPDATE`,
        [id]
      );
      if (!currentPolicy.rowCount) {
        throw Object.assign(new Error("NetSuite item was not found in Item Master."), { status: 404 });
      }
      if (smartItemReturnPolicyRevision(currentPolicy.rows[0]) !== expectedReturnPolicyRevision) {
        throw Object.assign(
          new Error("Return Policy changed after this Item Master row was loaded. Refresh and review the current policy before saving."),
          { status: 409, code: "RETURN_POLICY_CONFLICT" }
        );
      }
      const policyUpdated = await query(
        `UPDATE inventory_items
            SET return_policy_override = $2,
                return_policy_updated_by = $3,
                return_policy_updated_at = now()
          WHERE item_id = $1
            AND return_policy_override IS DISTINCT FROM $2::text
          RETURNING item_id`,
        [id, returnPolicyOverride, operatorId]
      );
      if (!policyUpdated.rowCount) {
        const exists = await query("SELECT 1 FROM inventory_items WHERE item_id = $1", [id]);
        if (!exists.rowCount) {
          throw Object.assign(new Error("NetSuite item was not found in Item Master."), { status: 404 });
        }
      } else {
        returnPolicyChanged = true;
      }
    }
    const updated = hasSmartPolicyChange
      ? await query(
        `UPDATE scm_smart_item_policies
          SET lead_time_days = CASE WHEN $7::boolean THEN $2 ELSE lead_time_days END,
              vendor_yard_id = CASE WHEN $8::boolean THEN $3 ELSE vendor_yard_id END,
              vendor_yard = CASE WHEN $8::boolean THEN $4 ELSE vendor_yard END,
              planning_enabled = COALESCE($5, planning_enabled),
              source_input_file_id = NULL,
              updated_by = $6,
              updated_at = now()
        WHERE item_id = $1
        RETURNING item_id`,
        [id, leadTimeDays, vendorYardId, vendorYard, planningEnabled, operatorId, hasLeadTimeSource, hasVendorYardSource]
      )
      : await query(
        "SELECT item_id FROM scm_smart_item_policies WHERE item_id = $1",
        [id]
      );
    if (!updated.rowCount) throw Object.assign(new Error("NetSuite item was not found in Item Master."), { status: 404 });
    for (const policy of yardPolicies) {
      const yard = YARD_BY_ID.get(String(policy.locationId));
      if (!yard) continue;
      if (typeof policy.eligible !== "boolean") {
        throw Object.assign(new Error(`Eligibility for ${yard.code} must be true or false.`), { status: 400 });
      }
      const eligible = policy.eligible;
      const hasLowerStockPolicy = Object.hasOwn(policy, "lowerStockPolicyEnabled");
      if (hasLowerStockPolicy && typeof policy.lowerStockPolicyEnabled !== "boolean") {
        throw Object.assign(new Error(`Lower-stock policy for ${yard.code} must be true or false.`), { status: 400 });
      }
      const lowerStockPolicyEnabled = hasLowerStockPolicy ? policy.lowerStockPolicyEnabled : null;
      const capacity = eligible ? nullableNumber(policy.capacityPallets) : null;
      const quantile = number(policy.serviceQuantile, yard.code === "12441" ? 0.95 : 0.9);
      const hasSafetyInput = Object.hasOwn(policy, "minimumSafetyPallets");
      const safetyInput = policy.minimumSafetyPallets;
      const safetyInputIsNumeric = (typeof safetyInput === "number" && Number.isFinite(safetyInput))
        || (typeof safetyInput === "string"
          && safetyInput.trim() !== ""
          && Number.isFinite(Number(safetyInput)));
      const safety = safetyInputIsNumeric ? Number(safetyInput) : null;
      if (eligible && capacity === null) {
        throw Object.assign(new Error(`Capacity for ${yard.code} is required when the yard is eligible.`), { status: 400 });
      }
      if (capacity < 0 || capacity > 10000) throw Object.assign(new Error(`Capacity for ${yard.code} must be between 0 and 10,000 pallets.`), { status: 400 });
      if (quantile <= 0.5 || quantile >= 1) throw Object.assign(new Error(`Service quantile for ${yard.code} must be between 0.50 and 1.00.`), { status: 400 });
      if (hasSafetyInput && (safety === null || safety < 0 || safety > 10000)) {
        throw Object.assign(new Error(`Safety floor for ${yard.code} must be between 0 and 10,000 pallets.`), { status: 400 });
      }
      await query(
        `UPDATE scm_smart_item_yard_policies
            SET eligible = $3,
                lower_stock_policy_enabled = CASE WHEN $7::boolean THEN $8 ELSE lower_stock_policy_enabled END,
                manually_overridden = manually_overridden
                  OR eligible IS DISTINCT FROM $3::boolean
                  OR service_quantile IS DISTINCT FROM $5::numeric
                  OR ($9::boolean AND minimum_safety_pallets IS DISTINCT FROM $6::numeric),
                capacity_manually_overridden = CASE
                  WHEN $3::boolean = false THEN false
                  ELSE capacity_manually_overridden
                    OR capacity_pallets IS DISTINCT FROM $4::numeric
                END,
                capacity_source = CASE
                  WHEN $3::boolean = false THEN 'default'
                  WHEN capacity_pallets IS DISTINCT FROM $4::numeric THEN 'manual'
                  ELSE capacity_source
                END,
                capacity_source_input_file_id = CASE
                  WHEN $3::boolean = false
                    OR capacity_pallets IS DISTINCT FROM $4::numeric THEN NULL
                  ELSE capacity_source_input_file_id
                END,
                capacity_source_sheet = CASE
                  WHEN $3::boolean = false
                    OR capacity_pallets IS DISTINCT FROM $4::numeric THEN NULL
                  ELSE capacity_source_sheet
                END,
                capacity_source_row = CASE
                  WHEN $3::boolean = false
                    OR capacity_pallets IS DISTINCT FROM $4::numeric THEN NULL
                  ELSE capacity_source_row
                END,
                capacity_match_method = CASE
                  WHEN $3::boolean = false
                    OR capacity_pallets IS DISTINCT FROM $4::numeric THEN NULL
                  ELSE capacity_match_method
                END,
                capacity_pallets = $4,
                service_quantile = $5,
                minimum_safety_pallets = CASE WHEN $9::boolean THEN $6 ELSE minimum_safety_pallets END,
                source_input_file_id = NULL,
                updated_by = $10,
                updated_at = now()
          WHERE item_id = $1
            AND location_id = $2
            AND (
              eligible IS DISTINCT FROM $3::boolean
              OR capacity_pallets IS DISTINCT FROM $4::numeric
              OR service_quantile IS DISTINCT FROM $5::numeric
              OR ($7::boolean AND lower_stock_policy_enabled IS DISTINCT FROM $8::boolean)
              OR ($9::boolean AND minimum_safety_pallets IS DISTINCT FROM $6::numeric)
            )`,
        [
          id,
          yard.locationId,
          eligible,
          capacity,
          quantile,
          safety,
          hasLowerStockPolicy,
          lowerStockPolicyEnabled,
          hasSafetyInput,
          operatorId
        ]
      );
    }
    return updated.rows[0];
  });
  await writeAudit({
    actorOperatorId: operatorId,
    source: "smart_scm",
    action: "smart_scm.item_master.update",
    details: {
      itemId: id,
      leadTimeDays,
      vendorYardId,
      vendorYard,
      planningEnabled,
      returnPolicyOverride: hasReturnPolicy ? returnPolicyOverride : undefined,
      returnPolicyChanged,
      yardPolicies
    }
  });
  return result;
}
