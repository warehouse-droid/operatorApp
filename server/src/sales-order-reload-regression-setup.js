import { closeDb, query, withTransaction } from "./db.js";

function assertIsolatedTestDatabase() {
  if (process.env.NODE_ENV !== "test" || process.env.MBT_TEST_ISOLATED !== "1") {
    throw new Error("Regression mirror setup is restricted to the isolated test database.");
  }
}

try {
  assertIsolatedTestDatabase();
  const result = await withTransaction(async () => {
    const imported = await query(
      `SELECT COUNT(*)::int AS item_count
         FROM scm_smart_item_policies
        WHERE source_input_file_id IS NOT NULL`
    );
    if (Number(imported.rows[0]?.item_count || 0) === 0) {
      throw new Error("Import the canonical Smart SCM inputs before building the isolated NetSuite mirror fixture.");
    }

    await query(
      `INSERT INTO operators (
         id, username, display_name, password_hash, password_salt,
         role, roles, yard_location_ids, active
       ) VALUES (
         'isolated-regression-operator',
         'isolated-regression-operator',
         'Isolated Regression Operator',
         'not-a-login-hash',
         'not-a-login-salt',
         'operator',
         ARRAY['operator']::text[],
         ARRAY[1, 28, 15, 26]::integer[],
         true
       )
       ON CONFLICT (id) DO UPDATE
         SET active = true,
             roles = EXCLUDED.roles,
             yard_location_ids = EXCLUDED.yard_location_ids,
             updated_at = now()`
    );

    await query(
      `WITH source AS (
         SELECT policy.*,
                100000 + DENSE_RANK() OVER (
                  ORDER BY LOWER(COALESCE(NULLIF(policy.vendor, ''), NULLIF(policy.plant, ''), 'isolated-vendor'))
                ) AS fixture_vendor_id
           FROM scm_smart_item_policies policy
       )
       INSERT INTO inventory_items (
         item_id, item_name, display_name, item_description,
         item_type, item_type_text, stock_unit, series, raw,
         to_plt, to_lyr, to_sec, to_pcs, item_weight,
         vendor_id, vendor, netsuite_lead_time_days,
         last_purchase_price, purchase_unit, synced_at
       )
       SELECT source.item_id,
              source.item_name,
              source.item_name,
              source.item_description,
              'InvtPart',
              'Inventory Item',
              COALESCE(NULLIF(source.stock_unit, ''), 'EACH'),
              source.series,
              '{"isolatedRegressionFixture":true}'::jsonb,
              source.to_plt,
              source.to_lyr,
              source.to_sec,
              source.to_pcs,
              0,
              source.fixture_vendor_id,
              COALESCE(NULLIF(source.vendor, ''), NULLIF(source.plant, ''), 'Isolated Vendor'),
              source.lead_time_days,
              1,
              COALESCE(NULLIF(source.stock_unit, ''), 'EACH'),
              now()
         FROM source
       ON CONFLICT (item_id) DO UPDATE
         SET item_name = EXCLUDED.item_name,
             display_name = EXCLUDED.display_name,
             item_description = EXCLUDED.item_description,
             item_type = EXCLUDED.item_type,
             item_type_text = EXCLUDED.item_type_text,
             stock_unit = EXCLUDED.stock_unit,
             series = EXCLUDED.series,
             raw = EXCLUDED.raw,
             to_plt = EXCLUDED.to_plt,
             to_lyr = EXCLUDED.to_lyr,
             to_sec = EXCLUDED.to_sec,
             to_pcs = EXCLUDED.to_pcs,
             item_weight = EXCLUDED.item_weight,
             vendor_id = EXCLUDED.vendor_id,
             vendor = EXCLUDED.vendor,
             netsuite_lead_time_days = EXCLUDED.netsuite_lead_time_days,
             last_purchase_price = EXCLUDED.last_purchase_price,
             purchase_unit = EXCLUDED.purchase_unit,
             synced_at = EXCLUDED.synced_at`
    );
    await query(
      `INSERT INTO inventory_items (
         item_id, item_name, display_name, item_description,
         item_type, item_type_text, stock_unit, raw,
         item_weight, last_purchase_price, purchase_unit, synced_at
       ) VALUES (
         1784, 'PALLET', 'PALLET', 'Official ancillary pallet item',
         'InvtPart', 'Inventory Item', 'EACH', '{"isolatedRegressionFixture":true}'::jsonb,
         40, 1, 'EACH', now()
       )
       ON CONFLICT (item_id) DO UPDATE
         SET item_name = EXCLUDED.item_name,
             display_name = EXCLUDED.display_name,
             item_description = EXCLUDED.item_description,
             item_type = EXCLUDED.item_type,
             item_type_text = EXCLUDED.item_type_text,
             stock_unit = EXCLUDED.stock_unit,
             raw = EXCLUDED.raw,
             item_weight = EXCLUDED.item_weight,
             last_purchase_price = EXCLUDED.last_purchase_price,
             purchase_unit = EXCLUDED.purchase_unit,
             synced_at = EXCLUDED.synced_at`
    );

    await query(
      `INSERT INTO inventory_balances (
         item_id, location_id, location,
         quantity_on_hand, quantity_available,
         quantity_on_order, quantity_backordered, synced_at
       )
       SELECT yard.item_id,
              yard.location_id,
              yard.yard_code,
              0, 0, 0, 0, now()
         FROM scm_smart_item_yard_policies yard
       ON CONFLICT (item_id, location_id) DO UPDATE
         SET location = EXCLUDED.location,
             quantity_on_hand = 0,
             quantity_available = 0,
             quantity_on_order = 0,
             quantity_backordered = 0,
             synced_at = EXCLUDED.synced_at`
    );

    const surplus = await query(
      `WITH latest_supply AS (
         SELECT DISTINCT ON (item_id) item_id, status
           FROM scm_smart_vendor_supply
          ORDER BY item_id, captured_at DESC, id DESC
       ), destination_demand AS (
         SELECT item_id, COUNT(*) AS order_count, SUM(ABS(quantity)) AS sales_quantity
           FROM scm_smart_sales_facts
          WHERE location_id = 15
          GROUP BY item_id
       ), candidate AS (
         SELECT policy.item_id, policy.to_plt
           FROM scm_smart_item_policies policy
           JOIN latest_supply supply
             ON supply.item_id = policy.item_id
            AND supply.status IN ('out_of_stock', 'credit_hold', 'partial')
           JOIN destination_demand demand
             ON demand.item_id = policy.item_id
           JOIN scm_smart_item_yard_policies source
             ON source.item_id = policy.item_id
            AND source.location_id = 1
            AND source.eligible = true
           JOIN scm_smart_item_yard_policies destination
             ON destination.item_id = policy.item_id
            AND destination.location_id = 15
            AND destination.eligible = true
          WHERE policy.item_id <> 601
            AND policy.planning_enabled = true
            AND policy.inactive = false
            AND policy.discontinued = false
            AND COALESCE(policy.to_plt, 0) > 0
            AND COALESCE(policy.pallet_weight_lbs, 0) > 0
          ORDER BY CASE WHEN policy.item_id = 8472 THEN 0 ELSE 1 END,
                   demand.order_count DESC,
                   demand.sales_quantity DESC,
                   policy.item_id
          LIMIT 1
       )
       UPDATE inventory_balances balance
          SET quantity_on_hand = candidate.to_plt * 100,
              quantity_available = candidate.to_plt * 100,
              synced_at = now()
         FROM candidate
        WHERE balance.item_id = candidate.item_id
          AND balance.location_id = 1
       RETURNING balance.item_id, balance.quantity_available`
    );
    if (surplus.rowCount !== 1) throw new Error("Could not create the isolated internal-transfer source fixture.");

    const counts = await query(
      `SELECT (SELECT COUNT(*) FROM inventory_items) AS item_count,
              (SELECT COUNT(*) FROM inventory_balances) AS balance_count`
    );
    await query(
      `UPDATE scm_smart_sync_state
          SET inventory_status = 'ready',
              inventory_synced_at = now(),
              inventory_item_count = $1,
              inventory_balance_count = $2,
              inventory_error = NULL,
              updated_at = now()
        WHERE id = 1`,
      [counts.rows[0].item_count, counts.rows[0].balance_count]
    );
    return {
      itemCount: Number(counts.rows[0].item_count),
      balanceCount: Number(counts.rows[0].balance_count),
      operatorId: "isolated-regression-operator",
      surplusItemId: Number(surplus.rows[0].item_id),
      surplusSalesQty: Number(surplus.rows[0].quantity_available)
    };
  });
  console.log(JSON.stringify({ ok: true, isolated: true, ...result }));
} finally {
  await closeDb();
}
