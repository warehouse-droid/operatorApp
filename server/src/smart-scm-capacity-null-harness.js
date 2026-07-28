import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { closeDb, query, withTransaction } from "./db.js";
import { listSmartScmItems, updateSmartScmItem } from "./smart-scm-item-repository.js";

const migrationSource = await fs.readFile(
  new URL("../migrations/068_smart_scm_ineligible_capacity_null.sql", import.meta.url),
  "utf8"
);
const lowerStockPolicyMigration = await fs.readFile(
  new URL("../migrations/070_smart_scm_lower_stock_policy.sql", import.meta.url),
  "utf8"
);

assert.match(
  migrationSource,
  /ALTER\s+COLUMN\s+capacity_pallets\s+DROP\s+NOT\s+NULL/i,
  "The migration must permit null capacities."
);
assert.match(
  lowerStockPolicyMigration,
  /ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+lower_stock_policy_enabled\s+boolean\s+NOT\s+NULL\s+DEFAULT\s+false/i,
  "The lower-stock policy migration must add an optional per-yard boolean that defaults off."
);
assert.match(
  migrationSource,
  /SET\s+capacity_pallets\s*=\s*NULL[\s\S]*WHERE\s+eligible\s*=\s*false/i,
  "The migration must perform the requested one-time cleanup for ineligible yards."
);
assert.match(
  migrationSource,
  /eligible\s*=\s*false\s+AND\s+capacity_pallets\s+IS\s+NULL[\s\S]*eligible\s*=\s*true\s+AND\s+capacity_pallets\s+IS\s+NOT\s+NULL/i,
  "The migration must enforce both sides of the eligibility/capacity invariant."
);

async function yardPolicy(itemId, locationId) {
  const result = await query(
    `SELECT eligible, lower_stock_policy_enabled, capacity_pallets, service_quantile,
            minimum_safety_pallets, manually_overridden,
            capacity_manually_overridden, capacity_source,
            capacity_source_input_file_id, capacity_source_sheet,
            capacity_source_row, capacity_match_method,
            source_input_file_id, updated_by, updated_at
       FROM scm_smart_item_yard_policies
      WHERE item_id = $1
        AND location_id = $2`,
    [itemId, locationId]
  );
  assert.equal(result.rowCount, 1);
  return result.rows[0];
}

async function expectConstraintViolation(action, message) {
  await assert.rejects(
    withTransaction(action),
    /scm_smart_item_yard_capacity_eligibility|check constraint/i,
    message
  );
}

try {
  await withTransaction(async () => {
    await query("SELECT pg_advisory_xact_lock(hashtext('smart-scm-capacity-null-harness'))");

    // Recreate a pre-migration dirty row even when this harness runs after
    // deployment. Every DDL/DML statement remains inside the rollback scope.
    await query(
      `ALTER TABLE scm_smart_item_yard_policies
         DROP CONSTRAINT IF EXISTS scm_smart_item_yard_capacity_eligibility`
    );

    const idResult = await query(
      "SELECT GREATEST(COALESCE(MAX(item_id), 0), 9200000) + 2000 AS item_id FROM inventory_items"
    );
    const itemId = Number(idResult.rows[0].item_id);
    const itemName = `HARNESS NULLABLE CAPACITY ${itemId}`;

    await query(
      `INSERT INTO inventory_items (
         item_id, item_name, display_name, item_description, item_type,
         item_type_text, stock_unit, product_type, brand, series,
         to_plt, to_lyr, to_sec, to_pcs, item_weight,
         vendor_id, vendor, netsuite_lead_time_days,
         netsuite_safety_stock_level, netsuite_seasonal_demand
       ) VALUES (
         $1, $2, $2, 'Nullable capacity rollback fixture', 'InvtPart',
         'Inventory Item', 'EA', 'Harness product', 'Harness brand', 'HARNESS-NULL-CAPACITY',
         100, 10, 5, 1, 5,
         $3, 'Harness Capacity Vendor', 14, 1, false
       )`,
      [itemId, itemName, itemId + 100000]
    );
    await query(
      `INSERT INTO scm_smart_item_policies (
         item_id, item_name, item_description, vendor, vendor_code, series,
         stock_unit, to_plt, to_lyr, to_sec, to_pcs, lead_time_days,
         pallet_weight_lbs, inactive, discontinued, planning_enabled,
         updated_by
       ) VALUES (
         $1, $2, 'Nullable capacity rollback fixture', 'Harness Capacity Vendor',
         $3, 'HARNESS-NULL-CAPACITY', 'EA', 100, 10, 5, 1, 14,
         500, false, false, true, 'harness:fixture'
       )`,
      [itemId, itemName, String(itemId + 100000)]
    );
    await query(
      `INSERT INTO scm_smart_item_yard_policies (
         item_id, location_id, yard_code, eligible, capacity_pallets,
         service_quantile, minimum_safety_pallets,
         manually_overridden, capacity_manually_overridden, capacity_source,
         capacity_source_sheet, capacity_source_row, capacity_match_method,
         updated_by
       ) VALUES
         ($1, 1, '3445', false, 37, 0.90, 1, true, true, 'manual', 'Dirty_Cal', 7, 'item_id', 'harness:fixture'),
         ($1, 28, '2967', true, 12, 0.91, 2, false, false, 'decision_workbook', 'Clean_Cal', 8, 'item_id', 'harness:fixture'),
         ($1, 15, '12441', false, 25, 0.95, 3, false, false, 'legacy_import', 'Legacy_Cal', 9, 'signature', 'harness:fixture'),
         ($1, 26, '150', true, 8, 0.93, 4, false, false, 'decision_workbook', 'Clean_Cal', 10, 'item_id', 'harness:fixture')`,
      [itemId]
    );

    // Running the production migration here proves its data cleanup and schema
    // constraint while the outer transaction guarantees no live mutation.
    await query(migrationSource);
    await query(lowerStockPolicyMigration);

    const columnResult = await query(
      `SELECT attribute.attnotnull,
              pg_get_expr(default_value.adbin, default_value.adrelid) AS column_default
         FROM pg_attribute attribute
         LEFT JOIN pg_attrdef default_value
           ON default_value.adrelid = attribute.attrelid
          AND default_value.adnum = attribute.attnum
        WHERE attribute.attrelid = 'scm_smart_item_yard_policies'::regclass
          AND attribute.attname = 'capacity_pallets'
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped`
    );
    assert.equal(columnResult.rowCount, 1);
    assert.equal(columnResult.rows[0].attnotnull, false);
    assert.equal(columnResult.rows[0].column_default, null);

    const constraintResult = await query(
      `SELECT convalidated, pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conrelid = 'scm_smart_item_yard_policies'::regclass
          AND conname = 'scm_smart_item_yard_capacity_eligibility'`
    );
    assert.equal(constraintResult.rowCount, 1);
    assert.equal(constraintResult.rows[0].convalidated, true);
    assert.match(constraintResult.rows[0].definition, /capacity_pallets IS NULL/i);
    assert.match(constraintResult.rows[0].definition, /capacity_pallets IS NOT NULL/i);

    for (const locationId of [1, 15]) {
      const cleaned = await yardPolicy(itemId, locationId);
      assert.equal(cleaned.eligible, false);
      assert.equal(cleaned.capacity_pallets, null, "The migration must clear every legacy ineligible capacity.");
      assert.equal(cleaned.capacity_manually_overridden, false);
      assert.equal(cleaned.capacity_source, "default");
      assert.equal(cleaned.capacity_source_input_file_id, null);
      assert.equal(cleaned.capacity_source_sheet, null);
      assert.equal(cleaned.capacity_source_row, null);
      assert.equal(cleaned.capacity_match_method, null);
    }

    await updateSmartScmItem(itemId, {
      planningEnabled: true,
      leadTimeDays: 14,
      yardPolicies: [{
        locationId: 28,
        eligible: false,
        // A stale client may still submit the previously displayed capacity.
        // Eligibility is authoritative and must clear it.
        capacityPallets: 12,
        serviceQuantile: 0.91,
        minimumSafetyPallets: 2
      }]
    }, null);
    let updated = await yardPolicy(itemId, 28);
    assert.equal(updated.eligible, false);
    assert.equal(updated.capacity_pallets, null, "A direct Item Master save must clear capacity when eligibility is disabled.");
    assert.equal(updated.capacity_manually_overridden, false);
    assert.equal(updated.capacity_source, "default");
    assert.equal(updated.lower_stock_policy_enabled, false);

    const lowerPolicyYardBefore = await yardPolicy(itemId, 15);
    const safetyBeforeLowerPolicy = Number(lowerPolicyYardBefore.minimum_safety_pallets);
    const unrelatedBeforeLowerPolicy = await yardPolicy(itemId, 26);
    await updateSmartScmItem(itemId, {
      planningEnabled: true,
      leadTimeDays: 14,
      yardPolicies: [{
        locationId: 15,
        eligible: false,
        capacityPallets: null,
        serviceQuantile: 0.95,
        lowerStockPolicyEnabled: true
      }]
    }, null);
    updated = await yardPolicy(itemId, 15);
    assert.equal(updated.lower_stock_policy_enabled, true);
    assert.equal(
      Number(updated.minimum_safety_pallets),
      safetyBeforeLowerPolicy,
      "Omitting minimumSafetyPallets must preserve the existing floor."
    );
    assert.equal(
      updated.manually_overridden,
      lowerPolicyYardBefore.manually_overridden,
      "The optional lower-stock flag must not set the coarse manually_overridden marker."
    );
    assert.deepEqual(
      await yardPolicy(itemId, 26),
      unrelatedBeforeLowerPolicy,
      "Changing the lower-stock flag for one yard must not rewrite another yard."
    );
    const lowerPolicyAny = await listSmartScmItems({
      search: itemName,
      enabled: "",
      lowerStockPolicy: "any",
      limit: 10
    });
    assert.equal(lowerPolicyAny.total, 1, "The any-yard filter must find an item with one selected lower-stock policy.");
    const lowerPolicy12441 = await listSmartScmItems({
      search: itemName,
      enabled: "",
      lowerStockPolicy: "yard:12441",
      limit: 10
    });
    assert.equal(lowerPolicy12441.total, 1, "The yard filter must match the selected yard.");
    const lowerPolicy2967 = await listSmartScmItems({
      search: itemName,
      enabled: "",
      lowerStockPolicy: "yard:2967",
      limit: 10
    });
    assert.equal(lowerPolicy2967.total, 0, "The yard filter must not match another yard.");
    const lowerPolicyNone = await listSmartScmItems({
      search: itemName,
      enabled: "",
      lowerStockPolicy: "none",
      limit: 10
    });
    assert.equal(lowerPolicyNone.total, 0, "The no-yard filter must exclude an item with a selected policy.");
    await assert.rejects(
      listSmartScmItems({ search: itemName, lowerStockPolicy: "yard:unknown", limit: 10 }),
      /valid lower-stock policy filter/i,
      "The repository must reject unsupported lower-stock filters."
    );

    await assert.rejects(
      updateSmartScmItem(itemId, {
        planningEnabled: true,
        leadTimeDays: 14,
        yardPolicies: [{
          locationId: 15,
          eligible: false,
          capacityPallets: null,
          serviceQuantile: 0.95,
          lowerStockPolicyEnabled: "true"
        }]
      }, null),
      /lower-stock policy.*true or false/i,
      "The API must reject a non-boolean lower-stock policy value."
    );
    updated = await yardPolicy(itemId, 15);
    assert.equal(updated.lower_stock_policy_enabled, true);

    await assert.rejects(
      updateSmartScmItem(itemId, {
        planningEnabled: true,
        leadTimeDays: 14,
        yardPolicies: [{
          locationId: 28,
          eligible: "false",
          capacityPallets: 12,
          serviceQuantile: 0.91,
          minimumSafetyPallets: 2
        }]
      }, null),
      /eligibility.*true or false/i,
      "A non-boolean API value must not be coerced into the opposite eligibility state."
    );

    await assert.rejects(
      updateSmartScmItem(itemId, {
        planningEnabled: true,
        leadTimeDays: 14,
        yardPolicies: [{
          locationId: 28,
          eligible: true,
          capacityPallets: null,
          serviceQuantile: 0.91,
          minimumSafetyPallets: 2
        }]
      }, null),
      /capacity.*required|enter.*capacity|eligible.*capacity/i,
      "Re-enabling a yard without a capacity must fail before writing."
    );
    updated = await yardPolicy(itemId, 28);
    assert.equal(updated.eligible, false);
    assert.equal(updated.capacity_pallets, null);

    await updateSmartScmItem(itemId, {
      planningEnabled: true,
      leadTimeDays: 14,
      yardPolicies: [{
        locationId: 28,
        eligible: true,
        capacityPallets: 0,
        serviceQuantile: 0.91,
        minimumSafetyPallets: 2
      }]
    }, null);
    updated = await yardPolicy(itemId, 28);
    assert.equal(updated.eligible, true);
    assert.equal(Number(updated.capacity_pallets), 0, "Zero remains a valid explicit eligible-yard capacity.");

    const unchangedYardSnapshots = new Map();
    for (const locationId of [1, 15, 26]) {
      unchangedYardSnapshots.set(locationId, await yardPolicy(itemId, locationId));
    }
    await updateSmartScmItem(itemId, {
      planningEnabled: true,
      leadTimeDays: 14,
      yardPolicies: [
        {
          locationId: 1,
          eligible: false,
          capacityPallets: null,
          serviceQuantile: 0.90,
          minimumSafetyPallets: 1
        },
        {
          locationId: 28,
          eligible: true,
          capacityPallets: 0,
          serviceQuantile: 0.91,
          minimumSafetyPallets: 0.5
        },
        {
          locationId: 15,
          eligible: false,
          capacityPallets: null,
          serviceQuantile: 0.95,
          minimumSafetyPallets: 3
        },
        {
          locationId: 26,
          eligible: true,
          capacityPallets: 8,
          serviceQuantile: 0.93,
          minimumSafetyPallets: 4
        }
      ]
    }, null);
    updated = await yardPolicy(itemId, 28);
    assert.equal(Number(updated.minimum_safety_pallets), 0.5, "A fractional floor must persist for the selected yard.");
    assert.equal(updated.manually_overridden, true, "Changing a floor must mark that yard policy as manually overridden.");
    const listedItems = await listSmartScmItems({ search: itemName, enabled: "", limit: 10 });
    const listedItem = listedItems.items.find((item) => Number(item.itemId) === itemId);
    const listedFloor = listedItem?.yardPolicies.find((policy) => Number(policy.locationId) === 28)?.minimumSafetyPallets;
    assert.equal(listedFloor, 0.5, "The Item Master read model must return the saved per-yard floor.");
    for (const locationId of [1, 15, 26]) {
      assert.deepEqual(
        await yardPolicy(itemId, locationId),
        unchangedYardSnapshots.get(locationId),
        `Changing the 2967 floor must not rewrite yard ${locationId}.`
      );
    }

    for (const invalidSafety of [null, "", "not-a-number", -0.01, 10000.01]) {
      await assert.rejects(
        updateSmartScmItem(itemId, {
          planningEnabled: true,
          leadTimeDays: 14,
          yardPolicies: [{
            locationId: 28,
            eligible: true,
            capacityPallets: 0,
            serviceQuantile: 0.91,
            minimumSafetyPallets: invalidSafety
          }]
        }, null),
        /safety floor.*between 0 and 10,000/i,
        `The API must reject invalid safety floor ${JSON.stringify(invalidSafety)}.`
      );
      updated = await yardPolicy(itemId, 28);
      assert.equal(Number(updated.minimum_safety_pallets), 0.5, "An invalid floor must roll back without changing the saved value.");
    }

    for (const validSafety of [0, 10000]) {
      await updateSmartScmItem(itemId, {
        planningEnabled: true,
        leadTimeDays: 14,
        yardPolicies: [{
          locationId: 28,
          eligible: true,
          capacityPallets: 0,
          serviceQuantile: 0.91,
          minimumSafetyPallets: validSafety
        }]
      }, null);
      updated = await yardPolicy(itemId, 28);
      assert.equal(
        Number(updated.minimum_safety_pallets),
        validSafety,
        `Boundary floor ${validSafety} must round-trip without fallback coercion.`
      );
    }

    await expectConstraintViolation(
      () => query(
        `UPDATE scm_smart_item_yard_policies
            SET capacity_pallets = 1
          WHERE item_id = $1
            AND location_id = 1`,
        [itemId]
      ),
      "The database must reject a non-null capacity for an ineligible yard."
    );
    await expectConstraintViolation(
      () => query(
        `UPDATE scm_smart_item_yard_policies
            SET capacity_pallets = NULL
          WHERE item_id = $1
            AND location_id = 28`,
        [itemId]
      ),
      "The database must reject a null capacity for an eligible yard."
    );

    const invalidRows = await query(
      `SELECT COUNT(*)::int AS count
         FROM scm_smart_item_yard_policies
        WHERE (eligible = false AND capacity_pallets IS NOT NULL)
           OR (eligible = true AND capacity_pallets IS NULL)`
    );
    assert.equal(Number(invalidRows.rows[0].count), 0);

    console.log(JSON.stringify({
      ok: true,
      migrationExecutedInRollback: true,
      legacyIneligibleCapacityCleaned: true,
      directDisableClearsCapacity: true,
      optionalLowerStockPolicySaved: true,
      omittedSafetyFloorPreserved: true,
      lowerStockPolicyRequiresBoolean: true,
      lowerStockPolicyYardIsolation: true,
      lowerStockPolicyFilters: true,
      directEnableRequiresCapacity: true,
      eligibleZeroCapacityAccepted: true,
      fractionalSafetyFloorSaved: true,
      boundarySafetyFloorsSaved: true,
      unrelatedYardsUnchanged: true,
      invalidSafetyFloorRejected: true,
      databaseInvariantEnforced: true,
      rolledBack: true
    }));
  }, { rollback: true });
} finally {
  await closeDb();
}
