import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { closeDb, query, withTransaction } from "./db.js";
import { calculateSmartScmOrderRequirement } from "./smart-scm-policy-calculation.js";
import { searchSmartScmVendorAlternatives } from "./smart-scm-vendor-repository.js";

const repositorySource = await fs.readFile(new URL("./smart-scm-vendor-repository.js", import.meta.url), "utf8");
const searchStart = repositorySource.indexOf("export async function searchSmartScmVendorAlternatives");
const searchEnd = repositorySource.indexOf("export async function addSmartScmVendorAlternativeLine", searchStart);
assert(searchStart >= 0 && searchEnd > searchStart, "Vendor alternative search source must be available for the static guard.");
assert.doesNotMatch(
  repositorySource.slice(searchStart, searchEnd),
  /\bLIMIT\s+250\b/i,
  "Eligible candidates must not be truncated before inventory-need ranking."
);

const robustRequirement = calculateSmartScmOrderRequirement({
  positionPallets: 0,
  reorderPointPallets: 1,
  preferredPallets: 1,
  capacityPallets: 20,
  minimumOrderPallets: 7
});
assert.equal(robustRequirement.requiredPallets, 7, "A robust 7-PLT minimum order must override a 1-PLT preferred gap.");
const blockedRequirement = calculateSmartScmOrderRequirement({
  positionPallets: 0,
  reorderPointPallets: 1,
  preferredPallets: 1,
  capacityPallets: 5,
  minimumOrderPallets: 7
});
assert.equal(blockedRequirement.capacityBelowMinimum, true, "Capacity below the minimum order must be identified.");
assert.equal(blockedRequirement.requiredPallets, 0, "Capacity below the minimum order must suppress the recommendation.");

try {
  await withTransaction(async () => {
    await query("SELECT pg_advisory_xact_lock(hashtext('smart-scm-vendor-alternative-harness'))");
    await query("LOCK TABLE scm_smart_forecast_runs IN SHARE ROW EXCLUSIVE MODE");
    const idResult = await query("SELECT GREATEST(COALESCE(MAX(item_id), 0), 9000000) + 1000 AS first_id FROM inventory_items");
    const baseItemId = Number(idResult.rows[0].first_id);
    const robustItemId = baseItemId + 251;
    const blockedItemId = baseItemId + 252;
    const vendorId = baseItemId + 10000;

    await query(
      `INSERT INTO inventory_items (
         item_id, item_name, display_name, item_description, stock_unit,
         product_type, brand, series, to_plt, to_lyr, to_sec, to_pcs,
         item_weight, vendor_id, vendor, netsuite_lead_time_days
       )
       SELECT $1 + candidate_index,
              CASE candidate_index
                WHEN 0 THEN 'HARNESS BASE ITEM'
                WHEN 251 THEN 'ZZZ robust need'
                WHEN 252 THEN 'ZZZ capacity blocked'
                ELSE 'AAA filler ' || LPAD(candidate_index::text, 3, '0')
              END,
              CASE candidate_index
                WHEN 0 THEN 'HARNESS BASE ITEM'
                WHEN 251 THEN 'ZZZ robust need'
                WHEN 252 THEN 'ZZZ capacity blocked'
                ELSE 'AAA filler ' || LPAD(candidate_index::text, 3, '0')
              END,
              'Vendor alternative ranking rollback fixture', 'EA',
              'Harness product', 'Harness brand', 'HARNESS-SERIES',
              1, 1, 1, 1, 100, $2, 'Harness Vendor', 7
         FROM generate_series(0, 252) AS candidate_index`,
      [baseItemId, vendorId]
    );
    await query(
      `INSERT INTO scm_smart_item_policies (
         item_id, item_name, item_description, vendor, series, stock_unit,
         to_plt, to_lyr, to_sec, to_pcs, lead_time_days, pallet_weight_lbs,
         inactive, discontinued, planning_enabled
       )
       SELECT item_id, item_name, item_description, vendor, series, stock_unit,
              to_plt, to_lyr, to_sec, to_pcs, 7, 100, false, false, true
         FROM inventory_items
        WHERE item_id BETWEEN $1 AND $1 + 252`,
      [baseItemId]
    );
    await query(
      `INSERT INTO scm_smart_item_yard_policies (
         item_id, location_id, yard_code, eligible, capacity_pallets,
         service_quantile, minimum_safety_pallets
       )
       SELECT item_id, 26, '150', true,
              CASE item_id WHEN $2 THEN 20 WHEN $3 THEN 5 ELSE 100 END,
              0.90, 1
         FROM inventory_items
        WHERE item_id BETWEEN $1 AND $1 + 252`,
      [baseItemId, robustItemId, blockedItemId]
    );
    await query(
      `INSERT INTO inventory_balances (
         item_id, location_id, location, quantity_on_hand, quantity_available
       )
       SELECT item_id, 26, '150',
              CASE WHEN item_id IN ($2, $3) THEN 0 ELSE 100 END,
              CASE WHEN item_id IN ($2, $3) THEN 0 ELSE 100 END
         FROM inventory_items
        WHERE item_id BETWEEN $1 AND $1 + 252`,
      [baseItemId, robustItemId, blockedItemId]
    );

    const forecastRunResult = await query(
      `INSERT INTO scm_smart_forecast_runs (
         status, trigger_source, model_version, metrics, completed_at
       ) VALUES ('completed', 'harness', 'vendor-alternative-ranking-v1', '{}'::jsonb, now())
       RETURNING id`
    );
    const forecastRunId = Number(forecastRunResult.rows[0].id);
    await query(
      `INSERT INTO scm_smart_forecasts (
         run_id, item_id, location_id, yard_code, selected_model,
         authoritative_model, formula_weekly_demand, formula_weekly_sd
       )
       SELECT $2, item_id, 26, '150', 'formula', 'formula', 0, 0
         FROM inventory_items
        WHERE item_id BETWEEN $1 AND $1 + 252`,
      [baseItemId, forecastRunId]
    );

    const sourceResult = await query(
      `SELECT CASE
         WHEN EXISTS (SELECT 1 FROM scm_smart_sales_facts WHERE source = 'csv') THEN 'csv'
         WHEN EXISTS (SELECT 1 FROM scm_smart_sales_facts WHERE source = 'netsuite') THEN 'netsuite'
         ELSE 'workbook'
       END AS source`
    );
    const salesSource = sourceResult.rows[0].source;
    await query(
      `WITH samples(quantity, sample_no) AS (
         VALUES (2::numeric, 1), (4, 2), (6, 3), (8, 4)
       ), target_items(item_id, label) AS (
         VALUES ($2::bigint, 'robust'), ($3::bigint, 'blocked')
       )
       INSERT INTO scm_smart_sales_facts (
         source, source_key, transaction_date, document_ref, item_id,
         item_name, quantity, delivery_method, location_id, yard_code
       )
       SELECT $1,
              'harness-vendor-alternative-' || $4::text || '-' || target_items.label || '-' || samples.sample_no,
              CURRENT_DATE,
              'HARNESS-' || target_items.label || '-' || samples.sample_no,
              target_items.item_id,
              'Harness ' || target_items.label,
              samples.quantity,
              'Pickup', 26, '150'
         FROM target_items CROSS JOIN samples`,
      [salesSource, robustItemId, blockedItemId, baseItemId]
    );

    const planningRunResult = await query(
      `INSERT INTO scm_smart_planning_runs (
         status, trigger_source, forecast_run_id, settings_snapshot, totals, completed_at
       ) VALUES ('ready', 'harness', $1, '{}'::jsonb, '{}'::jsonb, now())
       RETURNING id`,
      [forecastRunId]
    );
    const planningRunId = Number(planningRunResult.rows[0].id);
    const proposalResult = await query(
      `INSERT INTO scm_smart_proposals (
         run_id, proposal_key, proposal_type, phase, source_kind, source_name,
         destination_location_id, destination_name, vendor, status,
         order_requested_at, route_stops
       ) VALUES (
         $1, 'vendor-alternative-ranking', 'PO', 'direct_vendor', 'vendor', 'Harness Vendor',
         26, '150', 'Harness Vendor', 'order_requested', now(),
         '[{"locationId":26,"name":"150","sequence":1}]'::jsonb
       ) RETURNING id`,
      [planningRunId]
    );
    const proposalId = Number(proposalResult.rows[0].id);
    const lineResult = await query(
      `INSERT INTO scm_smart_proposal_lines (
         proposal_id, item_id, item_name, item_description, unit,
         required_pallets, proposed_pallets, confirmed_pallets, residual_pallets,
         sales_quantity, pallet_weight_lbs, line_weight_lbs, to_plt,
         destination_location_id, destination_name
       ) VALUES (
         $1, $2, 'HARNESS BASE ITEM', 'Vendor alternative ranking rollback fixture', 'EA',
         1, 1, 0, 1, 1, 100, 100, 1, 26, '150'
       ) RETURNING id`,
      [proposalId, baseItemId]
    );
    const lineId = Number(lineResult.rows[0].id);

    const robustResults = await searchSmartScmVendorAlternatives(proposalId, {
      search: String(robustItemId),
      lineId,
      limit: 12
    });
    const robust = robustResults.find((item) => item.itemId === robustItemId);
    assert(robust, "The robust-minimum candidate must be searchable.");
    assert.equal(robust.minimumOrderPallets, 7);
    assert.equal(robust.requiredPallets, 7);
    assert.equal(robust.capacityBelowMinimum, false);

    const blockedResults = await searchSmartScmVendorAlternatives(proposalId, {
      search: String(blockedItemId),
      lineId,
      limit: 12
    });
    const blocked = blockedResults.find((item) => item.itemId === blockedItemId);
    assert(blocked, "The capacity-blocked candidate must be searchable.");
    assert.equal(blocked.minimumOrderPallets, 7);
    assert.equal(blocked.capacityPallets, 5);
    assert.equal(blocked.capacityBelowMinimum, true);
    assert.equal(blocked.requiredPallets, 0);

    const ranked = await searchSmartScmVendorAlternatives(proposalId, { lineId, limit: 1 });
    assert.equal(ranked.length, 1);
    assert.equal(ranked[0].itemId, robustItemId, "Need ranking must consider the candidate beyond the former 250-row pre-limit.");
    assert.equal(ranked[0].requiredPallets, 7);
    assert.equal(ranked[0].suggested, true);

    console.log(JSON.stringify({
      candidateCount: 252,
      robustMinimumPallets: robust.minimumOrderPallets,
      robustRequiredPallets: robust.requiredPallets,
      blockedByCapacity: blocked.capacityBelowMinimum,
      topRankedItemId: ranked[0].itemId,
      rolledBack: true
    }, null, 2));
  }, { rollback: true });
} finally {
  await closeDb();
}
