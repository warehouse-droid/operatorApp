import { query, withTransaction } from "./db.js";
import { writeAudit } from "./auth-repository.js";

export const SMART_SCM_YARDS = Object.freeze([
  { locationId: 1, code: "3445" },
  { locationId: 28, code: "2967" },
  { locationId: 15, code: "12441" },
  { locationId: 26, code: "150" }
]);

const YARD_BY_ID = new Map(SMART_SCM_YARDS.map((yard) => [String(yard.locationId), yard]));

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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

export async function syncSmartScmPoliciesFromInventoryItems() {
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
     ON CONFLICT (item_id) DO UPDATE SET
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
       updated_at = now()
     RETURNING item_id`
  );
  await query(
    `INSERT INTO scm_smart_item_yard_policies (
       item_id, location_id, yard_code, eligible, capacity_pallets, service_quantile,
       minimum_safety_pallets, source_input_file_id
     )
     SELECT p.item_id, yard.location_id, yard.yard_code, false, 25,
            CASE WHEN yard.yard_code = '12441' THEN 0.95 ELSE 0.90 END,
            1, NULL
       FROM scm_smart_item_policies p
       CROSS JOIN (VALUES
         (1::bigint, '3445'::text),
         (28::bigint, '2967'::text),
         (15::bigint, '12441'::text),
         (26::bigint, '150'::text)
       ) AS yard(location_id, yard_code)
     ON CONFLICT (item_id, location_id) DO NOTHING`
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
  return {
    itemId: Number(row.item_id),
    itemName: row.item_name || String(row.item_id),
    displayName: row.display_name || "",
    description: row.item_description || "",
    itemType: row.item_type_text || row.item_type || "",
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
      capacityPallets: number(policy.capacityPallets, 25),
      serviceQuantile: number(policy.serviceQuantile, policy.yardCode === "12441" ? 0.95 : 0.9),
      minimumSafetyPallets: number(policy.minimumSafetyPallets, 1)
    })) : []
  };
}

export async function listSmartScmItems({ search = "", enabled = "", vendorYard = "", limit = 150, offset = 0 } = {}) {
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
                'capacityPallets', y.capacity_pallets,
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

export async function updateSmartScmItem(itemId, values = {}, operatorId = null) {
  const id = Number(itemId);
  if (!Number.isInteger(id) || id <= 0) throw Object.assign(new Error("A valid item ID is required."), { status: 400 });
  const leadTimeDays = nullableNumber(values.leadTimeDays);
  if (leadTimeDays !== null && (leadTimeDays < 1 || leadTimeDays > 730)) {
    throw Object.assign(new Error("Lead time must be between 1 and 730 days."), { status: 400 });
  }
  const hasVendorYardSource = Object.hasOwn(values, "vendorYard");
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
  const yardPolicies = Array.isArray(values.yardPolicies) ? values.yardPolicies : [];
  const result = await withTransaction(async () => {
    await syncSmartScmPoliciesFromInventoryItems();
    const updated = await query(
      `UPDATE scm_smart_item_policies
          SET lead_time_days = $2,
              vendor_yard_id = $3,
              vendor_yard = $4,
              planning_enabled = COALESCE($5, planning_enabled),
              source_input_file_id = NULL,
              updated_by = $6,
              updated_at = now()
        WHERE item_id = $1
        RETURNING item_id`,
      [id, leadTimeDays, vendorYardId, vendorYard, planningEnabled, operatorId]
    );
    if (!updated.rowCount) throw Object.assign(new Error("NetSuite item was not found in Item Master."), { status: 404 });
    for (const policy of yardPolicies) {
      const yard = YARD_BY_ID.get(String(policy.locationId));
      if (!yard) continue;
      const capacity = number(policy.capacityPallets, 25);
      const quantile = number(policy.serviceQuantile, yard.code === "12441" ? 0.95 : 0.9);
      const safety = number(policy.minimumSafetyPallets, 1);
      if (capacity < 0 || capacity > 10000) throw Object.assign(new Error(`Capacity for ${yard.code} must be between 0 and 10,000 pallets.`), { status: 400 });
      if (quantile <= 0.5 || quantile >= 1) throw Object.assign(new Error(`Service quantile for ${yard.code} must be between 0.50 and 1.00.`), { status: 400 });
      if (safety < 0 || safety > 10000) throw Object.assign(new Error(`Safety stock for ${yard.code} is invalid.`), { status: 400 });
      await query(
        `UPDATE scm_smart_item_yard_policies
            SET eligible = $3,
                capacity_pallets = $4,
                service_quantile = $5,
                minimum_safety_pallets = $6,
                manually_overridden = true,
                source_input_file_id = NULL,
                updated_by = $7,
                updated_at = now()
          WHERE item_id = $1 AND location_id = $2`,
        [id, yard.locationId, Boolean(policy.eligible), capacity, quantile, safety, operatorId]
      );
    }
    return updated.rows[0];
  });
  await writeAudit({
    actorOperatorId: operatorId,
    source: "smart_scm",
    action: "smart_scm.item_master.update",
    details: { itemId: id, leadTimeDays, vendorYardId, vendorYard, planningEnabled, yardPolicies }
  });
  return result;
}
