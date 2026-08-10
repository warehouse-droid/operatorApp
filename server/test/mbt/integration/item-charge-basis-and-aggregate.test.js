// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { config } from "../../../src/config.js";
import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import { updateMbtLocalItemSetting } from "../../../src/mbt/local-item-settings-repository.js";
import { applyLocalMasterDataRows } from "../../../src/mbt/local-master-data-service.js";
import { getFrontdeskCustomerChargeConfiguration } from "../../../src/mbt/customer-charge-request-service.js";
import {
  activateLocalRateCardVersion,
  applyLocalRateCardDraft,
  validateLocalRateCardVersion
} from "../../../src/mbt/rate-card-configuration-service.js";

const RUN_ID = crypto.randomUUID().replaceAll("-", "").toUpperCase();
const ACTOR = Object.freeze({ operatorId: `item-basis-${RUN_ID}`, roles: Object.freeze(["admin"]) });
let sequence = 0;

after(closeDb);

function identity(label) {
  sequence += 1;
  return {
    idempotencyKey: `${label}-idem-${RUN_ID}-${sequence}`,
    correlationId: `${label}-corr-${RUN_ID}-${sequence}`,
    requestId: `${label}-req-${RUN_ID}-${sequence}`
  };
}

async function inRollback(operation) {
  const rollback = await beginRollbackContext();
  try {
    return await rollback.run(operation);
  } finally {
    await rollback.rollback();
  }
}

async function withMasterDataEnabled(operation) {
  const before = { root: config.mbt.enabled, master: config.mbtPhase3.masterDataEnabled };
  config.mbt.enabled = true;
  config.mbtPhase3.masterDataEnabled = true;
  await query(
    `UPDATE mbt_feature_flags SET enabled = true, updated_by = $2, updated_at = now()
      WHERE flag_key = ANY($1::text[])`,
    [["mbt_enabled", "mbt_master_data"], ACTOR.operatorId]
  );
  try {
    return await operation();
  } finally {
    config.mbt.enabled = before.root;
    config.mbtPhase3.masterDataEnabled = before.master;
  }
}

function localItem({ itemCode, displayName, itemType, chargeBasis, densityLbsPerYard = null }) {
  return {
    itemCode,
    displayName,
    description: `${displayName} regression item`,
    itemType,
    chargeBasis,
    densityLbsPerYard,
    rentalPeriodDays: null,
    applicableServiceTypes: itemType === "aggregate" ? ["delivery", "exchange"] : ["dump_return"],
    applicableLegacySourceTypes: [],
    binTypeCode: null,
    binCapacityYards: null,
    netSuiteMappingLocalKey: null,
    active: true
  };
}

function graph(code, tariffs) {
  return {
    rateCard: {
      rateCardCode: `${code}_${RUN_ID.slice(0, 10)}`,
      displayName: code,
      description: "Item charge-basis regression",
      itemCode: null,
      customerNetSuiteId: null,
      subsidiaryNetSuiteId: null,
      serviceTemplateCode: null,
      currency: "CAD",
      active: true
    },
    version: {
      versionNumber: 1,
      effectiveFrom: "2036-08-10T00:00:00.000Z",
      effectiveTo: null,
      defaultRentalCalendarDays: 14,
      calculationNotes: "Exact cents and immutable UOM"
    },
    distanceBands: [],
    components: [],
    dumpTariffs: tariffs,
    depositRules: []
  };
}

function tariff(itemCode, pricingBasis, unitOfMeasure, amountMinor) {
  return {
    itemCode,
    dumpSiteCode: null,
    materialCode: null,
    tariffCode: `customer_${itemCode.toLowerCase()}`,
    pricingBasis,
    unitOfMeasure,
    amountMinor,
    minimumAmountMinor: 0,
    currency: "CAD",
    active: true,
    description: `${itemCode} customer unit price`
  };
}

test("migration exposes constrained charge basis and aggregate density", async () => {
  const columns = await query(
    `SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'mbt_local_item_settings'
        AND column_name IN ('charge_basis', 'density_lbs_per_yard')
      ORDER BY column_name`
  );
  assert.deepEqual(columns.rows, [
    { column_name: "charge_basis", is_nullable: "NO" },
    { column_name: "density_lbs_per_yard", is_nullable: "YES" }
  ]);
  const migration = await query(
    "SELECT count(*)::int AS count FROM schema_migrations WHERE filename = '143_mbt_item_charge_bases_and_aggregate.sql'"
  );
  assert.equal(migration.rows[0].count, 1);
});

test("legacy local-item inserts receive the safe basis for their declared item type", async () => {
  await inRollback(async () => {
    const itemCode = `SUR_${RUN_ID.slice(0, 12)}`;
    await query(
      `INSERT INTO mbt_local_item_settings (
         item_code, display_name, description, item_type, category,
         pricing_mode, system_owned, applicable_service_types,
         applicable_legacy_source_types, active, revision, created_by, updated_by
       ) VALUES (
         $1, 'Compatibility surcharge', 'Existing insert shape', 'surcharge',
         'surcharge', 'custom_price', false, '{}'::text[], '{}'::text[],
         true, 1, $2, $2
       )`,
      [itemCode, ACTOR.operatorId]
    );
    const selected = await query(
      "SELECT charge_basis FROM mbt_local_item_settings WHERE item_code = $1",
      [itemCode]
    );
    assert.equal(selected.rows[0].charge_basis, "per_event");
  });
});

test("activated per-tonne evidence survives a Dump switch; new cards accept BIN and Aggregate YARD", async () => {
  await inRollback(() => withMasterDataEnabled(async () => {
    const soilCode = `SOIL_${RUN_ID.slice(0, 8)}`;
    const aggregateCode = `AGG_${RUN_ID.slice(0, 8)}`;
    const created = await applyLocalMasterDataRows({
      actor: ACTOR,
      resource: "local_items",
      sourceKind: "manual",
      rows: [
        localItem({ itemCode: soilCode, displayName: "Soil", itemType: "dump", chargeBasis: "per_tonne" }),
        localItem({ itemCode: aggregateCode, displayName: "Clear stone", itemType: "aggregate", chargeBasis: "per_yard", densityLbsPerYard: 2_750 })
      ],
      reason: "Create unit-owned pricing regression items",
      ...identity("create-items")
    });
    const soil = created.body.entities.find((item) => item.itemCode === soilCode);
    const aggregate = created.body.entities.find((item) => item.itemCode === aggregateCode);
    assert.equal(soil.chargeBasis, "per_tonne");
    assert.equal(aggregate.chargeBasis, "per_yard");
    assert.equal(aggregate.densityLbsPerYard, 2_750);

    const oldCard = await applyLocalRateCardDraft({
      actor: ACTOR,
      sourceKind: "manual",
      graph: graph("Historical tonne", [tariff(soilCode, "per_weight", "TONNE", 4_500)]),
      reason: "Create historical per-tonne evidence",
      ...identity("old-card")
    });
    const oldVersionId = oldCard.body.version.rateCardVersionId;
    const validated = await validateLocalRateCardVersion({
      actor: ACTOR,
      rateCardVersionId: oldVersionId,
      expectedRevision: oldCard.body.version.revision,
      reason: "Validate historical tonne card",
      ...identity("validate-old")
    });
    await activateLocalRateCardVersion({
      actor: ACTOR,
      rateCardVersionId: oldVersionId,
      expectedRevision: validated.body.version.revision,
      reason: "Activate historical tonne card",
      ...identity("activate-old")
    });

    const changed = await updateMbtLocalItemSetting({
      actor: ACTOR,
      itemCode: soilCode,
      setting: {
        displayName: soil.displayName,
        description: soil.description,
        active: true,
        chargeBasis: "per_bin"
      },
      expectedRevision: soil.revision,
      reason: "Use fixed customer price for each new soil bin",
      ...identity("soil-per-bin")
    });
    assert.equal(changed.body.item.chargeBasis, "per_bin");

    const historical = await query(
      `SELECT pricing_basis, unit_of_measure, amount_minor::int AS amount_minor
         FROM mbt_dump_tariffs WHERE rate_card_version_id = $1`,
      [oldVersionId]
    );
    assert.deepEqual(historical.rows, [{
      pricing_basis: "per_weight",
      unit_of_measure: "TONNE",
      amount_minor: 4_500
    }]);

    const current = await applyLocalRateCardDraft({
      actor: ACTOR,
      sourceKind: "manual",
      graph: graph("Current item units", [
        tariff(soilCode, "per_quantity", "BIN", 32_500),
        tariff(aggregateCode, "per_quantity", "YARD", 7_250)
      ]),
      reason: "Create current per-bin and per-yard rates",
      ...identity("current-card")
    });
    const currentRows = await query(
      `SELECT item_code, pricing_basis, unit_of_measure, amount_minor::int AS amount_minor, material_id::text
         FROM mbt_dump_tariffs WHERE rate_card_version_id = $1 ORDER BY item_code`,
      [current.body.version.rateCardVersionId]
    );
    assert.deepEqual(currentRows.rows[0], {
      item_code: aggregateCode,
      pricing_basis: "per_quantity",
      unit_of_measure: "YARD",
      amount_minor: 7_250,
      material_id: null
    });
    assert.deepEqual({ ...currentRows.rows[1], material_id: "present" }, {
      item_code: soilCode,
      pricing_basis: "per_quantity",
      unit_of_measure: "BIN",
      amount_minor: 32_500,
      material_id: "present"
    });
    assert.match(String(currentRows.rows[1].material_id), /^[0-9a-f-]{36}$/u);

    const currentValidated = await validateLocalRateCardVersion({
      actor: ACTOR,
      rateCardVersionId: current.body.version.rateCardVersionId,
      expectedRevision: current.body.version.revision,
      reason: "Validate current unit card",
      ...identity("validate-current")
    });
    await activateLocalRateCardVersion({
      actor: ACTOR,
      rateCardVersionId: current.body.version.rateCardVersionId,
      expectedRevision: currentValidated.body.version.revision,
      reason: "Activate current unit card",
      ...identity("activate-current")
    });
    const frontdesk = await getFrontdeskCustomerChargeConfiguration({
      actor: ACTOR,
      rateCardVersionId: current.body.version.rateCardVersionId
    });
    assert.deepEqual(frontdesk.aggregateItems.map((item) => ({
      itemCode: item.itemCode,
      unitOfMeasure: item.unitOfMeasure,
      unitAmountMinor: item.unitAmountMinor,
      densityLbsPerYard: item.densityLbsPerYard
    })), [{
      itemCode: aggregateCode,
      unitOfMeasure: "YARD",
      unitAmountMinor: 7_250,
      densityLbsPerYard: 2_750
    }]);
    assert.deepEqual(frontdesk.fixedDumpItems.map((item) => ({
      itemCode: item.itemCode,
      contentCode: item.contentCode,
      unitOfMeasure: item.unitOfMeasure,
      amountMinor: item.amountMinor
    })), [{
      itemCode: soilCode,
      contentCode: "soil",
      unitOfMeasure: "BIN",
      amountMinor: 32_500
    }]);
  }));
});
