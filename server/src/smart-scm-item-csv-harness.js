import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { closeDb, query, withTransaction } from "./db.js";
import {
  buildSmartScmItemMasterCsvTemplate,
  importSmartScmItemMasterCsv,
  listSmartScmItems,
  updateSmartScmItem
} from "./smart-scm-item-repository.js";

const capacityNullMigration = await fs.readFile(
  new URL("../migrations/068_smart_scm_ineligible_capacity_null.sql", import.meta.url),
  "utf8"
);
const lowerStockPolicyMigration = await fs.readFile(
  new URL("../migrations/070_smart_scm_lower_stock_policy.sql", import.meta.url),
  "utf8"
);
const returnMigration = await fs.readFile(
  new URL("../migrations/071_returns.sql", import.meta.url),
  "utf8"
);

const YARDS = [
  { locationId: 1, code: "3445" },
  { locationId: 28, code: "2967" },
  { locationId: 15, code: "12441" },
  { locationId: 26, code: "150" }
];

const CSV_HEADERS = [
  "item_id",
  "item_name",
  "vendor",
  "policy_revision",
  "return_policy",
  "planning_enabled",
  "vendor_yard_id",
  "vendor_yard",
  "lead_time_days",
  ...YARDS.flatMap(({ code }) => [
    `eligible_${code}`,
    `lower_stock_policy_enabled_${code}`,
    `capacity_pallets_${code}`,
    `service_quantile_${code}`,
    `minimum_safety_pallets_${code}`
  ])
];

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csvBuffer(rows, { bom = false } = {}) {
  const lines = [
    CSV_HEADERS.join(","),
    ...rows.map((values) => CSV_HEADERS.map((header) => csvCell(values[header])).join(","))
  ];
  return Buffer.from(`${bom ? "\ufeff" : ""}${lines.join("\r\n")}\r\n`, "utf8");
}

function csvBufferWithExtraCell(values, extraValue) {
  const row = CSV_HEADERS.map((header) => csvCell(values[header])).join(",");
  return Buffer.from(`${CSV_HEADERS.join(",")}\r\n${row},${csvCell(extraValue)}\r\n`, "utf8");
}

function parseCsv(textValue) {
  const text = String(textValue || "").replace(/^\ufeff/, "");
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        cell += character;
      }
      continue;
    }
    if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(cell);
      cell = "";
    } else if (character === "\n") {
      row.push(cell.replace(/\r$/, ""));
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }
  if (quoted) throw new Error("Harness received malformed CSV.");
  if (cell || row.length) {
    row.push(cell.replace(/\r$/, ""));
    if (row.some((value) => value !== "")) rows.push(row);
  }
  return rows;
}

function templateText(result) {
  if (Buffer.isBuffer(result)) return result.toString("utf8");
  if (Buffer.isBuffer(result?.buffer)) return result.buffer.toString("utf8");
  if (typeof result?.csv === "string") return result.csv;
  if (typeof result === "string") return result;
  throw new Error("Item Master CSV template did not return CSV content.");
}

async function templateValuesFor(itemId) {
  const matrix = parseCsv(templateText(await buildSmartScmItemMasterCsvTemplate()));
  const headers = matrix[0] || [];
  const itemIdIndex = headers.indexOf("item_id");
  assert(itemIdIndex >= 0, "The template must include item_id.");
  const row = matrix.find((candidate, index) => index > 0 && Number(candidate[itemIdIndex]) === itemId);
  assert(row, `The template must include Item Master item ${itemId}.`);
  return Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ""]));
}

async function itemPolicy(itemId) {
  const result = await query(
    `SELECT i.item_name AS canonical_item_name,
            i.vendor AS canonical_vendor,
            i.to_plt AS canonical_to_plt,
            i.item_weight AS canonical_item_weight,
            p.item_name AS policy_item_name,
            p.vendor AS policy_vendor,
            p.to_plt AS policy_to_plt,
            p.planning_enabled,
            p.vendor_yard_id,
            p.vendor_yard,
            p.lead_time_days,
            p.updated_by,
            p.updated_at AS policy_updated_at
       FROM inventory_items i
       JOIN scm_smart_item_policies p ON p.item_id = i.item_id
      WHERE i.item_id = $1`,
    [itemId]
  );
  assert.equal(result.rowCount, 1);
  return result.rows[0];
}

async function yardPolicies(itemId) {
  const result = await query(
    `SELECT location_id, yard_code, eligible, lower_stock_policy_enabled, capacity_pallets,
            service_quantile, minimum_safety_pallets,
            manually_overridden, capacity_manually_overridden,
            capacity_source, capacity_source_input_file_id,
            capacity_source_sheet, capacity_source_row, capacity_match_method
       FROM scm_smart_item_yard_policies
      WHERE item_id = $1
      ORDER BY location_id`,
    [itemId]
  );
  return new Map(result.rows.map((row) => [String(row.yard_code), row]));
}

try {
  await withTransaction(async () => {
    await query("SELECT pg_advisory_xact_lock(hashtext('smart-scm-item-csv-harness'))");
    // Keep the harness runnable before and after deployment without changing
    // the live schema: the surrounding transaction always rolls this back.
    await query(capacityNullMigration);
    await query(lowerStockPolicyMigration);
    await query(returnMigration);
    const idResult = await query(
      "SELECT GREATEST(COALESCE(MAX(item_id), 0), 9000000) + 1000 AS item_id FROM inventory_items"
    );
    const itemId = Number(idResult.rows[0].item_id);
    const missingPolicyItemId = itemId + 1;
    const notFoundItemId = itemId + 999;
    const suffix = String(itemId);
    const itemName = `=HARNESS ITEM, "CSV" ${suffix}`;
    const vendor = `+Harness Vendor ${suffix}`;
    const vendorYard = `@Harness Yard, "North" ${suffix}`;
    const missingPolicyItemName = `HARNESS MISSING POLICY ${suffix}`;
    const missingPolicyVendor = `Harness Missing Policy Vendor ${suffix}`;

    const vendorYardResult = await query(
      `INSERT INTO dispatch_vendor_yards (
         vendor, yard, aliases, day_label, window_start, window_end,
         instructions, address, active
       ) VALUES ($1, $2, '', 'Mon-Fri', '08:00', '17:00', '', '', true)
       RETURNING id`,
      [vendor, vendorYard]
    );
    const vendorYardId = Number(vendorYardResult.rows[0].id);

    await query(
      `INSERT INTO inventory_items (
         item_id, item_name, display_name, item_description, item_type,
         item_type_text, stock_unit, product_type, brand, series,
         to_plt, to_lyr, to_sec, to_pcs, item_weight,
         vendor_id, vendor, netsuite_lead_time_days,
         netsuite_safety_stock_level, netsuite_seasonal_demand
       ) VALUES (
         $1, $2, $2, 'CSV rollback fixture', 'InvtPart',
         'Inventory Item', 'EA', 'Harness product', 'Harness brand', 'HARNESS-SERIES',
         100, 10, 5, 1, 5,
         $3, $4, 42, 8, false
       )`,
      [itemId, itemName, itemId + 100000, vendor]
    );
    await query(
      `INSERT INTO inventory_items (
         item_id, item_name, display_name, item_description, item_type,
         item_type_text, stock_unit, product_type, brand, series,
         to_plt, to_lyr, to_sec, to_pcs, item_weight,
         vendor_id, vendor, netsuite_lead_time_days,
         netsuite_safety_stock_level, netsuite_seasonal_demand
       ) VALUES (
         $1, $2, $2, 'Missing policy CSV rollback fixture', 'InvtPart',
         'Inventory Item', 'EA', 'Harness product', 'Harness brand', 'HARNESS-SERIES',
         80, 8, 4, 1, 4,
         $3, $4, 0, 6, false
       )`,
      [missingPolicyItemId, missingPolicyItemName, missingPolicyItemId + 100000, missingPolicyVendor]
    );
    await query(
      `INSERT INTO scm_smart_item_policies (
         item_id, item_name, item_description, vendor, vendor_code, series,
         stock_unit, to_plt, to_lyr, to_sec, to_pcs, lead_time_days,
         pallet_weight_lbs, inactive, discontinued, planning_enabled,
         vendor_yard_id, vendor_yard, updated_by, updated_at
       ) VALUES (
         $1, $2, 'CSV rollback fixture', $3, $4, 'HARNESS-SERIES',
         'EA', 100, 10, 5, 1, 14,
         500, false, false, false,
         $5, $6, 'harness:fixture', now() - interval '1 day'
       )`,
      [itemId, itemName, vendor, String(itemId + 100000), vendorYardId, vendorYard]
    );

    const initialYardValues = new Map([
      ["3445", { eligible: false, lowerStock: false, capacity: null, quantile: 0.9, safety: 1 }],
      ["2967", { eligible: true, lowerStock: true, capacity: 21, quantile: 0.91, safety: 2 }],
      ["12441", { eligible: false, lowerStock: false, capacity: null, quantile: 0.95, safety: 3 }],
      ["150", { eligible: true, lowerStock: false, capacity: 23, quantile: 0.93, safety: 4 }]
    ]);
    for (const yard of YARDS) {
      const values = initialYardValues.get(yard.code);
      await query(
        `INSERT INTO scm_smart_item_yard_policies (
           item_id, location_id, yard_code, eligible, lower_stock_policy_enabled, capacity_pallets,
           service_quantile, minimum_safety_pallets,
           manually_overridden, capacity_manually_overridden, capacity_source,
           capacity_source_sheet, capacity_source_row, capacity_match_method,
           updated_by
         ) VALUES (
           $1, $2, $3, $4, $5, $6,
           $7, $8,
           false, false, $9,
           $10, $11, $12,
           'harness:fixture'
         )`,
        [
          itemId,
          yard.locationId,
          yard.code,
          values.eligible,
          values.lowerStock,
          values.capacity,
          values.quantile,
          values.safety,
          values.eligible ? "decision_workbook" : "default",
          values.eligible ? "Harness_Cal" : null,
          values.eligible ? 2 : null,
          values.eligible ? "item_id" : null
        ]
      );
    }

    const template = parseCsv(templateText(await buildSmartScmItemMasterCsvTemplate()));
    assert(template.length >= 2, "The Item Master CSV template must contain current item rows.");
    assert.deepEqual(template[0], CSV_HEADERS, "The template must expose only reference and locally maintained policy fields.");
    assert(!template[0].includes("to_plt"), "NetSuite-owned conversion fields must not be editable through the CSV.");
    assert(!template[0].includes("item_weight"), "NetSuite-owned weight must not be editable through the CSV.");
    const templateIndex = new Map(template[0].map((header, index) => [header, index]));
    const fixtureTemplateRow = template.find((row) => Number(row[templateIndex.get("item_id")]) === itemId);
    assert(fixtureTemplateRow, "The prefilled template must include the NetSuite Item Master fixture.");
    const fixtureTemplateValues = Object.fromEntries(
      template[0].map((header, index) => [header, fixtureTemplateRow[index] ?? ""])
    );
    assert.equal(
      fixtureTemplateValues.item_name,
      `'${itemName}`,
      "Formula-leading item names must be spreadsheet-escaped while preserving commas and quotes."
    );
    assert.equal(fixtureTemplateValues.vendor, `'${vendor}`, "Formula-leading NetSuite vendor text must be spreadsheet-escaped.");
    assert.equal(fixtureTemplateRow[templateIndex.get("planning_enabled")].toLowerCase(), "false");
    assert.equal(Number(fixtureTemplateRow[templateIndex.get("vendor_yard_id")]), vendorYardId);
    assert.equal(
      fixtureTemplateValues.vendor_yard,
      `'${vendorYard}`,
      "Formula-leading vendor-yard text must be spreadsheet-escaped."
    );
    assert.equal(Number(fixtureTemplateRow[templateIndex.get("lead_time_days")]), 14);
    assert.equal(fixtureTemplateRow[templateIndex.get("eligible_2967")].toLowerCase(), "true");
    assert.equal(fixtureTemplateRow[templateIndex.get("lower_stock_policy_enabled_2967")].toLowerCase(), "true");
    assert.equal(fixtureTemplateRow[templateIndex.get("lower_stock_policy_enabled_3445")].toLowerCase(), "false");
    assert.equal(Number(fixtureTemplateRow[templateIndex.get("capacity_pallets_2967")]), 21);
    assert.equal(
      fixtureTemplateValues.capacity_pallets_3445,
      "",
      "An ineligible yard must have a blank capacity in the downloadable CSV."
    );
    assert.equal(
      fixtureTemplateValues.capacity_pallets_12441,
      "",
      "Every ineligible yard must remain distinguishable from a zero-capacity eligible yard."
    );
    assert.match(fixtureTemplateValues.policy_revision, /^[a-f0-9]{64}$/);
    const initialRevision = fixtureTemplateValues.policy_revision;

    const missingPolicyTemplateRow = template.find(
      (row) => Number(row[templateIndex.get("item_id")]) === missingPolicyItemId
    );
    assert(missingPolicyTemplateRow, "An inventory item without a Smart SCM policy must still be downloadable.");
    const missingPolicyTemplateValues = Object.fromEntries(
      template[0].map((header, index) => [header, missingPolicyTemplateRow[index] ?? ""])
    );
    assert.match(missingPolicyTemplateValues.policy_revision, /^[a-f0-9]{64}$/);
    assert.equal(missingPolicyTemplateValues.planning_enabled, "false");
    assert.equal(Number(missingPolicyTemplateValues.lead_time_days), 0);
    assert.equal(
      missingPolicyTemplateValues.capacity_pallets_3445,
      "",
      "A newly synchronized ineligible yard must not expose the former 25-pallet default."
    );
    assert.equal(missingPolicyTemplateValues.eligible_3445, "false");
    const missingPolicyBefore = await query(
      "SELECT COUNT(*)::int AS policies FROM scm_smart_item_policies WHERE item_id = $1",
      [missingPolicyItemId]
    );
    assert.equal(Number(missingPolicyBefore.rows[0].policies), 0);

    const unchangedPolicyBefore = await itemPolicy(itemId);
    const formulaRoundTripSummary = await importSmartScmItemMasterCsv({
      buffer: csvBuffer([fixtureTemplateValues]),
      filename: "smart-scm-item-master-formula-round-trip.csv",
      operatorId: null
    });
    assert.equal(Number(formulaRoundTripSummary.itemsUpdated), 0);
    assert.equal(Number(formulaRoundTripSummary.unchangedRows), 1);
    let policy = await itemPolicy(itemId);
    assert.equal(policy.canonical_item_name, itemName);
    assert.equal(policy.canonical_vendor, vendor);
    assert.equal(policy.vendor_yard, vendorYard, "Spreadsheet protection must round-trip without storing the leading apostrophe.");
    assert.equal(policy.updated_by, "harness:fixture", "An unchanged CSV row must not rewrite Item Master audit metadata.");
    assert.equal(
      new Date(policy.policy_updated_at).toISOString(),
      new Date(unchangedPolicyBefore.policy_updated_at).toISOString(),
      "An unchanged CSV row must not touch the Item Master updated timestamp."
    );

    const missingPolicySummary = await importSmartScmItemMasterCsv({
      buffer: csvBuffer([missingPolicyTemplateValues]),
      filename: "smart-scm-item-master-missing-policy-round-trip.csv",
      operatorId: null
    });
    assert.equal(Number(missingPolicySummary.itemsUpdated), 0);
    assert.equal(Number(missingPolicySummary.unchangedRows), 1);
    const createdMissingPolicy = await itemPolicy(missingPolicyItemId);
    assert.equal(createdMissingPolicy.planning_enabled, false);
    assert.equal(Number(createdMissingPolicy.lead_time_days), 0);
    const createdMissingYards = await yardPolicies(missingPolicyItemId);
    assert.equal(createdMissingYards.size, 4);
    assert.equal(
      createdMissingYards.get("3445").capacity_pallets,
      null,
      "Synchronizing a new ineligible yard must persist a null capacity."
    );
    assert.equal(Number(createdMissingYards.get("12441").service_quantile), 0.95);

    const validSummary = await importSmartScmItemMasterCsv({
      buffer: csvBuffer([{
        item_id: itemId,
        item_name: 'ATTACKED ITEM, "NOT NETSUITE"',
        vendor: "ATTACKED VENDOR",
        policy_revision: initialRevision,
        planning_enabled: "yes",
        vendor_yard_id: vendorYardId,
        lead_time_days: 21,
        eligible_3445: "1",
        lower_stock_policy_enabled_3445: "true",
        capacity_pallets_3445: 31.5,
        service_quantile_3445: 0.96,
        minimum_safety_pallets_3445: 4.5
      }], { bom: true }),
      filename: "smart-scm-item-master-valid.csv",
      operatorId: null
    });
    assert.equal(Number(validSummary.rowsRead), 1);
    assert.equal(Number(validSummary.itemsUpdated), 1);
    assert.equal(Number(validSummary.unchangedRows), 0);
    assert.equal(Number(validSummary.yardPoliciesUpdated), 1);

    policy = await itemPolicy(itemId);
    assert.equal(policy.canonical_item_name, itemName);
    assert.equal(policy.canonical_vendor, vendor);
    assert.equal(Number(policy.canonical_to_plt), 100);
    assert.equal(Number(policy.canonical_item_weight), 5);
    assert.equal(policy.policy_item_name, itemName, "The reference item_name column must not overwrite NetSuite-owned data.");
    assert.equal(policy.policy_vendor, vendor, "The reference vendor column must not overwrite NetSuite-owned data.");
    assert.equal(Number(policy.policy_to_plt), 100);
    assert.equal(policy.planning_enabled, true);
    assert.equal(Number(policy.vendor_yard_id), vendorYardId);
    assert.equal(policy.vendor_yard, vendorYard);
    assert.equal(Number(policy.lead_time_days), 21);
    let currentRevision = (await templateValuesFor(itemId)).policy_revision;
    assert.notEqual(currentRevision, initialRevision, "A successful local policy update must change policy_revision.");

    let yards = await yardPolicies(itemId);
    const changedYard = yards.get("3445");
    assert.equal(changedYard.eligible, true);
    assert.equal(changedYard.lower_stock_policy_enabled, true);
    assert.equal(Number(changedYard.capacity_pallets), 31.5);
    assert.equal(Number(changedYard.service_quantile), 0.96);
    assert.equal(Number(changedYard.minimum_safety_pallets), 4.5);
    assert.equal(changedYard.manually_overridden, true);
    assert.equal(changedYard.capacity_manually_overridden, true);
    assert.equal(changedYard.capacity_source, "manual");
    assert.equal(changedYard.capacity_source_input_file_id, null);
    assert.equal(changedYard.capacity_source_sheet, null);
    assert.equal(changedYard.capacity_source_row, null);
    assert.equal(changedYard.capacity_match_method, null);
    const untouchedYard = yards.get("2967");
    assert.equal(untouchedYard.eligible, true, "Blank yard cells must leave existing values unchanged.");
    assert.equal(untouchedYard.lower_stock_policy_enabled, true);
    assert.equal(Number(untouchedYard.capacity_pallets), 21);
    assert.equal(Number(untouchedYard.service_quantile), 0.91);
    assert.equal(Number(untouchedYard.minimum_safety_pallets), 2);
    assert.equal(untouchedYard.manually_overridden, false);
    assert.equal(untouchedYard.capacity_manually_overridden, false);
    assert.equal(untouchedYard.capacity_source, "decision_workbook");
    assert.equal(untouchedYard.capacity_source_sheet, "Harness_Cal");
    assert.equal(Number(untouchedYard.capacity_source_row), 2);
    assert.equal(untouchedYard.capacity_match_method, "item_id");

    const lowerPolicyOnlySummary = await importSmartScmItemMasterCsv({
      buffer: csvBuffer([{
        item_id: itemId,
        policy_revision: currentRevision,
        lower_stock_policy_enabled_12441: "true"
      }]),
      filename: "smart-scm-item-master-lower-policy-only.csv",
      operatorId: null
    });
    assert.equal(Number(lowerPolicyOnlySummary.itemsUpdated), 1);
    assert.equal(Number(lowerPolicyOnlySummary.yardPoliciesUpdated), 1);
    assert.equal(Number(lowerPolicyOnlySummary.fieldCounts.lower_stock_policy_enabled_12441), 1);
    yards = await yardPolicies(itemId);
    const lowerPolicyOnlyYard = yards.get("12441");
    assert.equal(lowerPolicyOnlyYard.lower_stock_policy_enabled, true);
    assert.equal(
      lowerPolicyOnlyYard.manually_overridden,
      false,
      "The optional lower-stock flag must not set the coarse manually_overridden marker."
    );
    assert.equal(Number(lowerPolicyOnlyYard.minimum_safety_pallets), 3);
    assert.equal(
      yards.get("150").lower_stock_policy_enabled,
      false,
      "Changing one yard's lower-stock flag must not affect another yard."
    );
    currentRevision = (await templateValuesFor(itemId)).policy_revision;

    const disableYardSummary = await importSmartScmItemMasterCsv({
      buffer: csvBuffer([{
        item_id: itemId,
        policy_revision: currentRevision,
        eligible_3445: "false"
      }]),
      filename: "smart-scm-item-master-disable-yard.csv",
      operatorId: null
    });
    assert.equal(Number(disableYardSummary.itemsUpdated), 1);
    assert.equal(Number(disableYardSummary.yardPoliciesUpdated), 1);
    yards = await yardPolicies(itemId);
    const disabledYard = yards.get("3445");
    assert.equal(disabledYard.eligible, false);
    assert.equal(
      disabledYard.capacity_pallets,
      null,
      "Changing an eligible yard to false must clear its prior capacity even when the capacity CSV cell is blank."
    );
    assert.equal(disabledYard.capacity_manually_overridden, false);
    assert.equal(disabledYard.capacity_source, "default");
    assert.equal(disabledYard.capacity_source_input_file_id, null);
    assert.equal(disabledYard.capacity_source_sheet, null);
    assert.equal(disabledYard.capacity_source_row, null);
    assert.equal(disabledYard.capacity_match_method, null);
    currentRevision = (await templateValuesFor(itemId)).policy_revision;
    assert.equal(
      (await templateValuesFor(itemId)).capacity_pallets_3445,
      "",
      "A disabled yard must round-trip through the template as a blank capacity."
    );

    await assert.rejects(
      importSmartScmItemMasterCsv({
        buffer: csvBuffer([{
          item_id: itemId,
          policy_revision: currentRevision,
          eligible_3445: "true"
        }]),
        filename: "smart-scm-item-master-enable-yard-missing-capacity.csv",
        operatorId: null
      }),
      /capacity.*required|enter.*capacity|eligible.*capacity/i
    );
    yards = await yardPolicies(itemId);
    assert.equal(yards.get("3445").eligible, false);
    assert.equal(
      yards.get("3445").capacity_pallets,
      null,
      "A rejected enable operation must leave the yard disabled with no capacity."
    );

    const enableZeroCapacitySummary = await importSmartScmItemMasterCsv({
      buffer: csvBuffer([{
        item_id: itemId,
        policy_revision: currentRevision,
        eligible_3445: "true",
        capacity_pallets_3445: "0"
      }]),
      filename: "smart-scm-item-master-enable-yard-zero-capacity.csv",
      operatorId: null
    });
    assert.equal(Number(enableZeroCapacitySummary.itemsUpdated), 1);
    assert.equal(Number(enableZeroCapacitySummary.yardPoliciesUpdated), 1);
    yards = await yardPolicies(itemId);
    assert.equal(yards.get("3445").eligible, true);
    assert.equal(
      Number(yards.get("3445").capacity_pallets),
      0,
      "Zero must remain a valid explicit capacity for an eligible yard."
    );
    currentRevision = (await templateValuesFor(itemId)).policy_revision;

    const unchangedSummary = await importSmartScmItemMasterCsv({
      buffer: csvBuffer([{
        item_id: itemId,
        item_name: itemName,
        vendor,
        policy_revision: currentRevision
      }]),
      filename: "smart-scm-item-master-no-change.csv",
      operatorId: null
    });
    assert.equal(Number(unchangedSummary.rowsRead), 1);
    assert.equal(Number(unchangedSummary.itemsUpdated), 0);
    assert.equal(Number(unchangedSummary.unchangedRows), 1);
    assert.equal(Number(unchangedSummary.yardPoliciesUpdated), 0);

    const clearSummary = await importSmartScmItemMasterCsv({
      buffer: csvBuffer([{
        item_id: itemId,
        policy_revision: currentRevision,
        planning_enabled: "0",
        vendor_yard_id: "CLEAR"
      }]),
      filename: "smart-scm-item-master-clear.csv",
      operatorId: null
    });
    assert.equal(Number(clearSummary.itemsUpdated), 1);
    policy = await itemPolicy(itemId);
    assert.equal(policy.planning_enabled, false);
    assert.equal(policy.vendor_yard_id, null);
    assert.equal(policy.vendor_yard, null, "CLEAR must remove both the vendor yard ID and label.");
    assert.equal(Number(policy.lead_time_days), 21, "A blank local field must retain its current value.");
    currentRevision = (await templateValuesFor(itemId)).policy_revision;

    await assert.rejects(
      importSmartScmItemMasterCsv({
        buffer: csvBuffer([
          {
            item_id: itemId,
            policy_revision: currentRevision,
            planning_enabled: "true",
            lead_time_days: 28
          },
          {
            item_id: notFoundItemId,
            policy_revision: "0".repeat(64),
            planning_enabled: "true"
          }
        ]),
        filename: "smart-scm-item-master-atomic-invalid.csv",
        operatorId: null
      }),
      /item.*not found|NetSuite item/i
    );
    policy = await itemPolicy(itemId);
    assert.equal(policy.planning_enabled, false, "A later invalid CSV row must roll back an earlier valid row.");
    assert.equal(Number(policy.lead_time_days), 21, "CSV validation and updates must be atomic.");

    await assert.rejects(
      importSmartScmItemMasterCsv({
        buffer: csvBuffer([
          { item_id: itemId, policy_revision: currentRevision, planning_enabled: "true" },
          { item_id: itemId, policy_revision: currentRevision, planning_enabled: "false" }
        ]),
        filename: "smart-scm-item-master-duplicate.csv",
        operatorId: null
      }),
      /duplicate/i
    );

    await assert.rejects(
      importSmartScmItemMasterCsv({
        buffer: csvBuffer([{
          item_id: itemId,
          policy_revision: currentRevision,
          service_quantile_12441: 1.2
        }]),
        filename: "smart-scm-item-master-invalid-quantile.csv",
        operatorId: null
      }),
      /service quantile|between 0\\.50 and 1\\.00/i
    );
    yards = await yardPolicies(itemId);
    assert.equal(Number(yards.get("12441").service_quantile), 0.95);

    await assert.rejects(
      importSmartScmItemMasterCsv({
        buffer: csvBuffer([{
          item_id: itemId,
          policy_revision: currentRevision,
          planning_enabled: "sometimes"
        }]),
        filename: "smart-scm-item-master-invalid-boolean.csv",
        operatorId: null
      }),
      /planning_enabled|boolean|true|false/i
    );

    const clearLeadTimeSummary = await importSmartScmItemMasterCsv({
      buffer: csvBuffer([{
        item_id: itemId,
        policy_revision: currentRevision,
        lead_time_days: "CLEAR"
      }]),
      filename: "smart-scm-item-master-clear-lead-time.csv",
      operatorId: null
    });
    assert.equal(Number(clearLeadTimeSummary.itemsUpdated), 1);
    policy = await itemPolicy(itemId);
    assert.equal(policy.lead_time_days, null, "CLEAR must remove the local lead-time override.");
    currentRevision = (await templateValuesFor(itemId)).policy_revision;

    const missingPolicyCurrentRevision = (await templateValuesFor(missingPolicyItemId)).policy_revision;
    const newerPolicy = await itemPolicy(itemId);
    const newerYards = await yardPolicies(itemId);
    await assert.rejects(
      importSmartScmItemMasterCsv({
        buffer: csvBuffer([
          {
            item_id: missingPolicyItemId,
            policy_revision: missingPolicyCurrentRevision,
            planning_enabled: "true"
          },
          {
            item_id: itemId,
            policy_revision: initialRevision,
            planning_enabled: "true",
            lead_time_days: 77
          }
        ]),
        filename: "smart-scm-item-master-stale-revision.csv",
        operatorId: null
      }),
      /changed after the CSV template was downloaded|fresh template|policy_revision/i
    );
    const preservedPolicy = await itemPolicy(itemId);
    assert.equal(preservedPolicy.planning_enabled, newerPolicy.planning_enabled);
    assert.equal(preservedPolicy.vendor_yard_id, newerPolicy.vendor_yard_id);
    assert.equal(preservedPolicy.vendor_yard, newerPolicy.vendor_yard);
    assert.equal(preservedPolicy.lead_time_days, newerPolicy.lead_time_days);
    const preservedYards = await yardPolicies(itemId);
    assert.equal(
      Number(preservedYards.get("3445").capacity_pallets),
      Number(newerYards.get("3445").capacity_pallets),
      "A stale CSV must preserve the newer yard policy."
    );
    const missingPolicyAfterStale = await itemPolicy(missingPolicyItemId);
    assert.equal(
      missingPolicyAfterStale.planning_enabled,
      false,
      "A valid row staged before a stale row must also be rejected atomically."
    );

    await assert.rejects(
      importSmartScmItemMasterCsv({
        buffer: csvBufferWithExtraCell({
          item_id: itemId,
          policy_revision: currentRevision,
          planning_enabled: "true"
        }, "unexpected"),
        filename: "smart-scm-item-master-extra-cell.csv",
        operatorId: null
      }),
      /beyond the final CSV column|extra comma/i
    );
    policy = await itemPolicy(itemId);
    assert.equal(policy.planning_enabled, false, "A row with a nonblank extra cell must not be applied.");

    const listedBeforeReturnPolicyChange = await listSmartScmItems({
      search: String(itemId),
      limit: 10
    });
    const returnPolicyItem = listedBeforeReturnPolicyChange.items.find(
      (item) => Number(item.itemId) === itemId
    );
    assert(returnPolicyItem, "The Smart Item Master list must include the return-policy fixture.");
    assert.match(returnPolicyItem.returnPolicyRevision, /^[a-f0-9]{64}$/);
    await assert.rejects(
      updateSmartScmItem(itemId, {
        returnPolicyOverride: "ALLOWED",
        expectedReturnPolicyRevision: returnPolicyItem.returnPolicyRevision
      }, null),
      (error) => error?.status === 403
    );
    await assert.rejects(
      updateSmartScmItem(itemId, {
        returnPolicyOverride: "ALLOWED"
      }, null, { allowReturnPolicyChange: true }),
      (error) => error?.status === 400 && error?.code === "RETURN_POLICY_REVISION_REQUIRED"
    );
    await updateSmartScmItem(itemId, {
      returnPolicyOverride: "ALLOWED",
      expectedReturnPolicyRevision: returnPolicyItem.returnPolicyRevision
    }, null, { allowReturnPolicyChange: true });
    let listedAfterReturnPolicyChange = await listSmartScmItems({
      search: String(itemId),
      limit: 10
    });
    let changedReturnPolicyItem = listedAfterReturnPolicyChange.items.find(
      (item) => Number(item.itemId) === itemId
    );
    assert.equal(changedReturnPolicyItem.returnPolicyOverride, "ALLOWED");
    assert.notEqual(
      changedReturnPolicyItem.returnPolicyRevision,
      returnPolicyItem.returnPolicyRevision,
      "An explicit Return Policy update must issue a new row revision."
    );

    const staleReturnPolicyRevision = changedReturnPolicyItem.returnPolicyRevision;
    await query(
      "UPDATE inventory_items SET product_type = 'Natural Stone' WHERE item_id = $1",
      [itemId]
    );
    await assert.rejects(
      updateSmartScmItem(itemId, {
        returnPolicyOverride: "NOT_RETURNABLE",
        expectedReturnPolicyRevision: staleReturnPolicyRevision
      }, null, { allowReturnPolicyChange: true }),
      (error) => error?.status === 409 && error?.code === "RETURN_POLICY_CONFLICT"
    );
    const preservedReturnPolicy = await query(
      "SELECT return_policy_override FROM inventory_items WHERE item_id = $1",
      [itemId]
    );
    assert.equal(
      preservedReturnPolicy.rows[0].return_policy_override,
      "ALLOWED",
      "A stale policy edit must not overwrite a newer Product Type or Return Policy."
    );

    listedAfterReturnPolicyChange = await listSmartScmItems({
      search: String(itemId),
      limit: 10
    });
    changedReturnPolicyItem = listedAfterReturnPolicyChange.items.find(
      (item) => Number(item.itemId) === itemId
    );
    assert.notEqual(
      changedReturnPolicyItem.returnPolicyRevision,
      staleReturnPolicyRevision,
      "A Product Type change must invalidate an already-rendered Return Policy revision."
    );
    await updateSmartScmItem(itemId, {
      planningEnabled: true
    }, null);
    const unchangedReturnPolicy = await query(
      "SELECT return_policy_override FROM inventory_items WHERE item_id = $1",
      [itemId]
    );
    assert.equal(
      unchangedReturnPolicy.rows[0].return_policy_override,
      "ALLOWED",
      "An ordinary Item Master save without a Return Policy field must preserve the policy."
    );

    console.log(JSON.stringify({
      ok: true,
      templatePrefilled: true,
      netSuiteFieldsProtected: true,
      partialUpdates: true,
      optionalLowerStockPolicyRoundTrip: true,
      lowerStockPolicyYardIsolation: true,
      clearVendorYard: true,
      clearLeadTime: true,
      ineligibleCapacityBlank: true,
      disableClearsCapacity: true,
      enableRequiresCapacity: true,
      eligibleZeroCapacity: true,
      atomicValidation: true,
      staleRevisionRejected: true,
      missingPolicyRoundTrip: true,
      spreadsheetFormulaProtection: true,
      extraCellsRejected: true,
      duplicateRowsRejected: true,
      returnPolicyAdminOnly: true,
      returnPolicyCasProtected: true,
      ordinarySavePreservesReturnPolicy: true,
      rolledBack: true
    }));
  }, { rollback: true });
} finally {
  await closeDb();
}
