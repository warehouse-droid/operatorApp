import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { config } from "../../../src/config.js";
import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import {
  deleteLocalMasterDataEntity,
  applyLocalMasterDataRows,
  setLocalMasterDataActive
} from "../../../src/mbt/local-master-data-service.js";
import {
  deleteMbtBinAsset,
  registerMbtBinAsset,
  updateMbtBinAssetAttributes
} from "../../../src/mbt/asset-registry-service.js";
import {
  createFrontdeskDeliveryOrder,
  getFrontdeskConfiguration
} from "../../../src/mbt/frontdesk-service.js";
import {
  applyLocalRateCardDraft,
  deleteLocalRateCard,
  setLocalRateCardActive
} from "../../../src/mbt/rate-card-configuration-service.js";

const RUN_ID = crypto.randomUUID().replaceAll("-", "").toUpperCase();
const ACTOR = Object.freeze({ operatorId: `guarded-delete-${RUN_ID}`, roles: ["admin"] });
let sequence = 0;

after(closeDb);

async function inRollback(operation) {
  const rollback = await beginRollbackContext();
  try {
    return await rollback.run(operation);
  } finally {
    await rollback.rollback();
  }
}

async function enableMasterData() {
  config.mbt.enabled = true;
  config.mbtPhase3.masterDataEnabled = true;
  await query(
    `UPDATE mbt_feature_flags SET enabled = true, updated_by = $1, updated_at = now()
      WHERE flag_key = ANY($2::text[])`,
    [ACTOR.operatorId, ["mbt_enabled", "mbt_master_data"]]
  );
}

function command(resource, rows) {
  sequence += 1;
  return {
    actor: ACTOR,
    resource,
    sourceKind: "manual",
    rows,
    reason: `Guarded delete integration ${sequence}`,
    idempotencyKey: `guarded-delete-apply-${RUN_ID}-${sequence}`,
    correlationId: `guarded-delete-corr-${RUN_ID}-${sequence}`,
    requestId: `guarded-delete-req-${RUN_ID}-${sequence}`
  };
}

function deletion(resource, entityId, expectedRevision = 1) {
  sequence += 1;
  return {
    actor: ACTOR,
    resource,
    entityId,
    expectedRevision,
    idempotencyKey: `guarded-delete-command-${RUN_ID}-${sequence}`,
    correlationId: `guarded-delete-corr-${RUN_ID}-${sequence}`,
    requestId: `guarded-delete-req-${RUN_ID}-${sequence}`
  };
}

function stateChange(resource, entityId, active, expectedRevision) {
  sequence += 1;
  return {
    actor: ACTOR,
    resource,
    entityId,
    active,
    expectedRevision,
    idempotencyKey: `guarded-state-command-${RUN_ID}-${sequence}`,
    correlationId: `guarded-state-corr-${RUN_ID}-${sequence}`,
    requestId: `guarded-state-req-${RUN_ID}-${sequence}`
  };
}

function localItem(itemCode, itemType = "surcharge") {
  return {
    itemCode,
    displayName: `Delete test ${itemCode}`,
    description: "Rollback-only guarded delete evidence",
    itemType,
    applicableServiceTypes: [],
    applicableLegacySourceTypes: [],
    active: true
  };
}

test("an unused custom item deletes, while a linked item fails closed", async () => {
  await inRollback(async () => {
    await enableMasterData();
    const unused = `DEL_UNUSED_${RUN_ID.slice(0, 8)}`;
    const linked = `DEL_LINKED_${RUN_ID.slice(0, 8)}`;
    await applyLocalMasterDataRows(command("local_items", [localItem(unused), localItem(linked)]));
    await query(
      `INSERT INTO dispatch_custom_orders (
         ref_number, pickup_location, dropoff_location, order_details,
         weight_lbs, status, mbt_local_item_code, mbt_source, created_by, updated_by
       ) VALUES ($1, 'A', 'B', 'Linked deletion evidence', 1, 'open', $2, 'frontdesk_delivery', $3, $3)`,
      [`MBT-DEL-${RUN_ID.slice(0, 10)}`, linked, ACTOR.operatorId]
    );

    const inactive = await setLocalMasterDataActive(stateChange("local_items", unused, false, 1));
    assert.deepEqual(
      { active: inactive.body.active, revision: inactive.body.revision },
      { active: false, revision: 2 }
    );
    const active = await setLocalMasterDataActive(stateChange("local_items", unused, true, 2));
    assert.deepEqual(
      { active: active.body.active, revision: active.body.revision },
      { active: true, revision: 3 }
    );
    const deleted = await deleteLocalMasterDataEntity(deletion("local_items", unused, 3));
    assert.equal(deleted.body.deleted, true);
    assert.equal((await query(
      "SELECT count(*)::int AS count FROM mbt_local_item_settings WHERE item_code = $1",
      [unused]
    )).rows[0].count, 0);

    await assert.rejects(
      deleteLocalMasterDataEntity(deletion("local_items", linked)),
      (error) => error?.code === "MBT_ENTITY_IN_USE" && error?.status === 409
    );
  });
});

test("a dump site removes only its owned acceptance graph when no operation links it", async () => {
  await inRollback(async () => {
    await enableMasterData();
    const itemCode = `DUMP_DEL_${RUN_ID.slice(0, 8)}`;
    const siteCode = `SITE_DEL_${RUN_ID.slice(0, 8)}`;
    await applyLocalMasterDataRows(command("local_items", [localItem(itemCode, "dump")]));
    await applyLocalMasterDataRows(command("dump_sites", [{
      dumpSiteCode: siteCode,
      displayName: "Disposable test dump site",
      addressLine1: "1 Test Road",
      addressLine2: "",
      city: "Toronto",
      region: "ON",
      postalCode: "M1M 1M1",
      countryCode: "CA",
      phone: "",
      latitude: null,
      longitude: null,
      itemCode,
      accepted: true,
      scaleTicketRequired: true,
      notes: "",
      active: true
    }]));
    const inactive = await setLocalMasterDataActive(stateChange("dump_sites", siteCode, false, 1));
    assert.equal(inactive.body.active, false);
    const deleted = await deleteLocalMasterDataEntity(deletion("dump_sites", siteCode, 2));
    assert.equal(deleted.body.deleted, true);
    assert.equal((await query(
      "SELECT count(*)::int AS count FROM mbt_dump_sites WHERE dump_site_code = $1",
      [siteCode]
    )).rows[0].count, 0);
  });
});

test("a dump site linked to a pricing tariff cannot be deleted", async () => {
  await inRollback(async () => {
    await enableMasterData();
    const itemCode = `DUMP_USE_${RUN_ID.slice(0, 8)}`;
    const siteCode = `SITE_USE_${RUN_ID.slice(0, 8)}`;
    await applyLocalMasterDataRows(command("local_items", [localItem(itemCode, "dump")]));
    await applyLocalMasterDataRows(command("dump_sites", [{
      dumpSiteCode: siteCode,
      displayName: "Linked test dump site",
      addressLine1: "2 Test Road",
      addressLine2: "",
      city: "Toronto",
      region: "ON",
      postalCode: "M1M 1M2",
      countryCode: "CA",
      phone: "",
      latitude: null,
      longitude: null,
      itemCode,
      accepted: true,
      scaleTicketRequired: true,
      notes: "",
      active: true
    }]));
    sequence += 1;
    await applyLocalRateCardDraft({
      actor: ACTOR,
      sourceKind: "manual",
      graph: {
        rateCard: {
          rateCardCode: `DUMP_USE_${RUN_ID.slice(0, 8)}`,
          displayName: "Linked dump tariff",
          description: "Rollback-only tariff",
          itemCode,
          customerNetSuiteId: null,
          subsidiaryNetSuiteId: null,
          serviceTemplateCode: null,
          currency: "CAD",
          active: true
        },
        version: {
          versionNumber: 1,
          effectiveFrom: "2026-08-05T00:00:00.000Z",
          effectiveTo: null,
          defaultRentalCalendarDays: 14,
          calculationNotes: "Rollback-only"
        },
        distanceBands: [],
        components: [],
        dumpTariffs: [{
          itemCode,
          dumpSiteCode: siteCode,
          materialCode: null,
          tariffCode: `dump_${RUN_ID.slice(0, 8).toLowerCase()}`,
          pricingBasis: "per_weight",
          unitOfMeasure: "TONNE",
          amountMinor: 10000,
          minimumAmountMinor: 0,
          currency: "CAD",
          active: true,
          description: "Linked tariff"
        }],
        depositRules: []
      },
      reason: "Create linked dump tariff",
      idempotencyKey: `guarded-dump-rate-${RUN_ID}-${sequence}`,
      correlationId: `guarded-dump-rate-corr-${RUN_ID}-${sequence}`,
      requestId: `guarded-dump-rate-req-${RUN_ID}-${sequence}`
    });
    await assert.rejects(
      deleteLocalMasterDataEntity(deletion("dump_sites", siteCode)),
      (error) => error?.code === "MBT_ENTITY_IN_USE" && error?.status === 409
    );
  });
});

test("one named rate card can price multiple local items without weakening deletion guards", async () => {
  await inRollback(async () => {
    await enableMasterData();
    const standardItemCode = `RATE_STD_${RUN_ID.slice(0, 8)}`;
    const secondItemCode = `RATE_150_${RUN_ID.slice(0, 8)}`;
    await applyLocalMasterDataRows(command("local_items", [
      localItem(standardItemCode, "delivery_fee"),
      localItem(secondItemCode, "delivery_fee")
    ]));
    sequence += 1;
    const created = await applyLocalRateCardDraft({
      actor: ACTOR,
      sourceKind: "manual",
      graph: {
        rateCard: {
          rateCardCode: `RATE_MULTI_${RUN_ID.slice(0, 8)}`,
          displayName: "Multi-item quoted tariff",
          description: "Rollback-only multi-item rate evidence",
          itemCode: null,
          customerNetSuiteId: null,
          subsidiaryNetSuiteId: null,
          serviceTemplateCode: null,
          currency: "CAD",
          active: true
        },
        version: {
          versionNumber: 1,
          effectiveFrom: "2026-08-05T00:00:00.000Z",
          effectiveTo: null,
          defaultRentalCalendarDays: 14,
          calculationNotes: "One rate card, two independently quoted items"
        },
        distanceBands: [standardItemCode, secondItemCode].map((itemCode, index) => ({
          itemCode,
          serviceCode: "delivery",
          binTypeCode: null,
          sequenceNumber: 0,
          minimumMetres: 0,
          maximumMetres: null,
          amountMinor: 23500 + (index * 5000),
          downtownSurchargeMinor: 0,
          pricingBasis: "flat",
          boundaryRule: "upper_inclusive",
          originYardCodes: index === 0 ? ["2967", "3445"] : ["150"],
          currency: "CAD",
          description: index === 0 ? "Standard yard price" : "150 yard price"
        })),
        components: [],
        dumpTariffs: [],
        depositRules: []
      },
      reason: "Create multi-item guarded-delete evidence",
      idempotencyKey: `guarded-multi-rate-${RUN_ID}-${sequence}`,
      correlationId: `guarded-multi-rate-corr-${RUN_ID}-${sequence}`,
      requestId: `guarded-multi-rate-req-${RUN_ID}-${sequence}`
    });
    const linkedItems = await query(
      `SELECT item_code
         FROM mbt_rate_distance_bands
        WHERE rate_card_version_id = $1
        ORDER BY item_code`,
      [created.body.version.rateCardVersionId]
    );
    assert.deepEqual(
      linkedItems.rows.map((row) => row.item_code),
      [secondItemCode, standardItemCode].sort()
    );
    for (const itemCode of [standardItemCode, secondItemCode]) {
      await assert.rejects(
        deleteLocalMasterDataEntity(deletion("local_items", itemCode)),
        (error) => error?.code === "MBT_ENTITY_IN_USE" && error?.status === 409
      );
    }
  });
});

test("an unused item-owned rate card can be inactivated, reactivated, and deleted", async () => {
  await inRollback(async () => {
    await enableMasterData();
    const itemCode = `RATE_DEL_${RUN_ID.slice(0, 8)}`;
    await applyLocalMasterDataRows(command("local_items", [localItem(itemCode, "delivery_fee")]));
    sequence += 1;
    const created = await applyLocalRateCardDraft({
      actor: ACTOR,
      sourceKind: "manual",
      graph: {
        rateCard: {
          rateCardCode: `RATE_DEL_${RUN_ID.slice(0, 8)}`,
          displayName: "Disposable item rate",
          description: "Rollback-only rate",
          itemCode,
          customerNetSuiteId: null,
          subsidiaryNetSuiteId: null,
          serviceTemplateCode: null,
          currency: "CAD",
          active: true
        },
        version: {
          versionNumber: 1,
          effectiveFrom: "2026-08-05T00:00:00.000Z",
          effectiveTo: null,
          defaultRentalCalendarDays: 14,
          calculationNotes: "Rollback-only"
        },
        distanceBands: [{
          itemCode,
          serviceCode: "delivery",
          binTypeCode: null,
          sequenceNumber: 0,
          minimumMetres: 0,
          maximumMetres: null,
          amountMinor: 10000,
          downtownSurchargeMinor: 0,
          currency: "CAD",
          description: "Open distance band"
        }],
        components: [],
        dumpTariffs: [],
        depositRules: []
      },
      reason: "Create disposable item rate",
      idempotencyKey: `guarded-rate-create-${RUN_ID}-${sequence}`,
      correlationId: `guarded-rate-corr-${RUN_ID}-${sequence}`,
      requestId: `guarded-rate-req-${RUN_ID}-${sequence}`
    });
    const versionId = created.body.version.rateCardVersionId;
    sequence += 1;
    const inactive = await setLocalRateCardActive({
      actor: ACTOR,
      rateCardVersionId: versionId,
      active: false,
      expectedRevision: 1,
      idempotencyKey: `guarded-rate-state-${RUN_ID}-${sequence}`,
      correlationId: `guarded-rate-corr-${RUN_ID}-${sequence}`,
      requestId: `guarded-rate-req-${RUN_ID}-${sequence}`
    });
    assert.equal(inactive.body.version.cardActive, false);
    sequence += 1;
    const active = await setLocalRateCardActive({
      actor: ACTOR,
      rateCardVersionId: versionId,
      active: true,
      expectedRevision: 2,
      idempotencyKey: `guarded-rate-state-${RUN_ID}-${sequence}`,
      correlationId: `guarded-rate-corr-${RUN_ID}-${sequence}`,
      requestId: `guarded-rate-req-${RUN_ID}-${sequence}`
    });
    assert.equal(active.body.version.cardRevision, 3);
    sequence += 1;
    const deleted = await deleteLocalRateCard({
      actor: ACTOR,
      rateCardVersionId: versionId,
      expectedRevision: 3,
      idempotencyKey: `guarded-rate-delete-${RUN_ID}-${sequence}`,
      correlationId: `guarded-rate-corr-${RUN_ID}-${sequence}`,
      requestId: `guarded-rate-req-${RUN_ID}-${sequence}`
    });
    assert.equal(deleted.body.deleted, true);
    assert.equal((await query(
      "SELECT count(*)::int AS count FROM mbt_rate_card_versions WHERE rate_card_version_id = $1",
      [versionId]
    )).rows[0].count, 0);
  });
});

test("a rate card with durable use evidence cannot be deleted", async () => {
  await inRollback(async () => {
    await enableMasterData();
    const itemCode = `RATE_USED_${RUN_ID.slice(0, 8)}`;
    const rateCardId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    await applyLocalMasterDataRows(command("local_items", [localItem(itemCode)]));
    await query(
      `INSERT INTO mbt_rate_cards (
         rate_card_id, rate_card_code, display_name, item_code, created_by, updated_by
       ) VALUES ($1, $2, 'Used rate evidence', $3, $4, $4)`,
      [rateCardId, `RATE_USED_${RUN_ID.slice(0, 8)}`, itemCode, ACTOR.operatorId]
    );
    await query(
      `INSERT INTO mbt_rate_card_versions (
         rate_card_version_id, rate_card_id, version_number, status,
         effective_from, first_used_at, first_used_entity_type,
         first_used_entity_id, created_by, updated_by
       ) VALUES ($1, $2, 1, 'draft', now(), now(), 'synthetic_test', $3, $4, $4)`,
      [versionId, rateCardId, crypto.randomUUID(), ACTOR.operatorId]
    );
    await assert.rejects(
      deleteLocalRateCard({
        actor: ACTOR,
        rateCardVersionId: versionId,
        expectedRevision: 1,
        idempotencyKey: `guarded-rate-used-${RUN_ID}-${sequence}`,
        correlationId: `guarded-rate-used-corr-${RUN_ID}-${sequence}`,
        requestId: `guarded-rate-used-req-${RUN_ID}-${sequence}`
      }),
      (error) => error?.code === "MBT_ENTITY_IN_USE" && error?.status === 409
    );
  });
});

test("a Front Desk Delivery becomes one linked local custom order and replays exactly", async () => {
  await inRollback(async () => {
    await enableMasterData();
    const itemCode = `DELIVERY_${RUN_ID.slice(0, 8)}`;
    const customerId = String(8_000_000_000_000n + BigInt(`0x${RUN_ID.slice(0, 10)}`));
    await applyLocalMasterDataRows(command("local_items", [localItem(itemCode, "delivery_fee")]));
    await query(
      `INSERT INTO netsuite_customers (
         netsuite_id, entity_number, legal_name, display_name, currency,
         source_modified_at, source_version, payload_hash
       ) VALUES ($1::bigint, $2, $3, $3, 'CAD', now(), $4, $5)`,
      [
        customerId,
        `DELIVERY-CUSTOMER-${RUN_ID.slice(0, 8)}`,
        "Guarded delivery customer",
        `guarded-delivery:${RUN_ID}`,
        crypto.createHash("sha256").update(`guarded-delivery:${RUN_ID}`).digest("hex")
      ]
    );
    sequence += 1;
    const input = {
      actor: ACTOR,
      customerNetsuiteId: customerId,
      itemCode,
      pickupLocation: "12441 McCowan Road",
      dropoffLocation: "1 Customer Road",
      orderDetails: "One local A-to-B delivery",
      weightLbs: 1000,
      stopMinutes: 30,
      idempotencyKey: `guarded-delivery-${RUN_ID}-${sequence}`,
      correlationId: `guarded-delivery-corr-${RUN_ID}-${sequence}`,
      requestId: `guarded-delivery-req-${RUN_ID}-${sequence}`
    };
    const created = await createFrontdeskDeliveryOrder(input);
    const replay = await createFrontdeskDeliveryOrder(structuredClone(input));
    assert.equal(created.status, 201);
    assert.equal(created.body.deliveryOrder.itemCode, itemCode);
    assert.equal(replay.replayed, true);
    assert.equal(replay.body.deliveryOrder.id, created.body.deliveryOrder.id);
    const stored = await query(
      `SELECT mbt_local_item_code, mbt_customer_netsuite_id::text, mbt_source,
              pickup_location, dropoff_location, status
         FROM dispatch_custom_orders
        WHERE id = $1`,
      [created.body.deliveryOrder.id]
    );
    assert.deepEqual(stored.rows, [{
      mbt_local_item_code: itemCode,
      mbt_customer_netsuite_id: customerId,
      mbt_source: "frontdesk_delivery",
      pickup_location: "12441 McCowan Road",
      dropoff_location: "1 Customer Road",
      status: "open"
    }]);
    await assert.rejects(
      deleteLocalMasterDataEntity(deletion("local_items", itemCode)),
      (error) => error?.code === "MBT_ENTITY_IN_USE" && error?.status === 409
    );
  });
});

test("Front Desk BIN choices come from active Bin items, including a user-defined 50-yard item", async () => {
  await inRollback(async () => {
    await enableMasterData();
    const binItemCode = `BIN50_${RUN_ID.slice(0, 8)}`;
    const surchargeItemCode = `SURCHARGE_${RUN_ID.slice(0, 8)}`;
    await applyLocalMasterDataRows(command("local_items", [{
      ...localItem(binItemCode, "bin"),
      rentalPeriodDays: 14,
      binCapacityYards: 50
    }, localItem(surchargeItemCode)]));
    const configuration = await getFrontdeskConfiguration({ actor: ACTOR });
    const customBin = configuration.binItems.find((item) => item.itemCode === binItemCode);
    assert.equal(customBin?.nominalYards, 50);
    assert.equal(
      configuration.binItems.some((item) => item.itemCode === surchargeItemCode),
      false
    );
  });
});

test("an unused asset can be deleted atomically while movement history blocks deletion", async () => {
  await inRollback(async () => {
    const yard = await query("SELECT yard_id::text FROM mbt_yards WHERE active ORDER BY yard_code LIMIT 1");
    assert.equal(yard.rowCount, 1);
    sequence += 1;
    const registered = await registerMbtBinAsset({
      actor: ACTOR,
      asset: { assetCode: `DEL-ASSET-${RUN_ID.slice(0, 8)}`, itemCode: "14YD" },
      initialState: {
        lifecycleStatus: "available",
        location: { kind: "yard", yardId: yard.rows[0].yard_id },
        occurredAt: new Date().toISOString()
      },
      idempotencyKey: `guarded-delete-asset-create-${RUN_ID}-${sequence}`,
      correlationId: `guarded-delete-corr-${RUN_ID}-${sequence}`,
      requestId: `guarded-delete-req-${RUN_ID}-${sequence}`
    });
    const asset = registered.body.asset;
    sequence += 1;
    const inactive = await updateMbtBinAssetAttributes({
      actor: ACTOR,
      assetId: asset.assetId,
      attributes: { active: false },
      expectedRevision: asset.revision,
      reason: "Inactivate rollback-only asset",
      idempotencyKey: `guarded-delete-asset-state-${RUN_ID}-${sequence}`,
      correlationId: `guarded-delete-corr-${RUN_ID}-${sequence}`,
      requestId: `guarded-delete-req-${RUN_ID}-${sequence}`
    });
    assert.equal(inactive.body.asset.active, false);
    sequence += 1;
    const deleted = await deleteMbtBinAsset({
      actor: ACTOR,
      assetId: asset.assetId,
      expectedRevision: inactive.body.asset.revision,
      idempotencyKey: `guarded-delete-asset-${RUN_ID}-${sequence}`,
      correlationId: `guarded-delete-corr-${RUN_ID}-${sequence}`,
      requestId: `guarded-delete-req-${RUN_ID}-${sequence}`
    });
    assert.equal(deleted.body.deleted, true);
    assert.deepEqual((await query(
      `SELECT
         (SELECT count(*)::int FROM mbt_bin_assets WHERE asset_id = $1) AS assets,
         (SELECT count(*)::int FROM mbt_bin_movements WHERE asset_id = $1) AS movements,
         (SELECT count(*)::int FROM mbt_bin_asset_state WHERE asset_id = $1) AS states`,
      [asset.assetId]
    )).rows[0], { assets: 0, movements: 0, states: 0 });

    sequence += 1;
    const operated = await registerMbtBinAsset({
      actor: ACTOR,
      asset: { assetCode: `USED-ASSET-${RUN_ID.slice(0, 8)}`, itemCode: "14YD" },
      initialState: {
        lifecycleStatus: "available",
        location: { kind: "yard", yardId: yard.rows[0].yard_id },
        occurredAt: new Date().toISOString()
      },
      idempotencyKey: `guarded-delete-used-asset-create-${RUN_ID}-${sequence}`,
      correlationId: `guarded-delete-corr-${RUN_ID}-${sequence}`,
      requestId: `guarded-delete-req-${RUN_ID}-${sequence}`
    });
    await query(
      `INSERT INTO mbt_bin_movements (
         movement_id, asset_id, asset_sequence, movement_type,
         before_status, after_status, before_location_kind, after_location_kind,
         from_yard_id, to_yard_id, source, actor_type, actor_id, occurred_at
       ) VALUES ($1, $2, 2, 'synthetic_operation', 'available', 'available',
                 'yard', 'yard', $3, $3, 'synthetic_test', 'operator', $4, now())`,
      [crypto.randomUUID(), operated.body.asset.assetId, yard.rows[0].yard_id, ACTOR.operatorId]
    );
    sequence += 1;
    await assert.rejects(
      deleteMbtBinAsset({
        actor: ACTOR,
        assetId: operated.body.asset.assetId,
        expectedRevision: operated.body.asset.revision,
        idempotencyKey: `guarded-delete-used-asset-${RUN_ID}-${sequence}`,
        correlationId: `guarded-delete-corr-${RUN_ID}-${sequence}`,
        requestId: `guarded-delete-req-${RUN_ID}-${sequence}`
      }),
      (error) => error?.code === "MBT_ENTITY_IN_USE" && error?.status === 409
    );
  });
});
