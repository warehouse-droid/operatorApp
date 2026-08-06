// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { config } from "../../../src/config.js";
import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import { getMbtAssetOpeningOptions, registerMbtBinAsset } from "../../../src/mbt/asset-registry-service.js";
import { applyLocalMasterDataRows } from "../../../src/mbt/local-master-data-service.js";
import { listMbtLocalItemSettings } from "../../../src/mbt/local-item-settings-repository.js";

const RUN_ID = crypto.randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase();
const ITEM_CODE = `BIN50_${RUN_ID}`;
const ASSET_CODE = `ASSET50_${RUN_ID}`;
const MANUAL_ADDRESS = "50 Launch Lane, Vaughan, ON L4K 5C3";
const ACTOR = Object.freeze({ operatorId: `custom-bin-${RUN_ID}`, roles: Object.freeze(["admin"]) });

after(async () => closeDb());

test("a 50-yard item creates its Bin binding and registers an asset at a typed customer address without entered reasons", async () => {
  const rollback = await beginRollbackContext();
  const previous = { enabled: config.mbt.enabled, master: config.mbtPhase3.masterDataEnabled };
  try {
    await rollback.run(async () => {
      config.mbt.enabled = true;
      config.mbtPhase3.masterDataEnabled = true;
      await query(
        `UPDATE mbt_feature_flags SET enabled = true, updated_by = $2, updated_at = now()
          WHERE flag_key = ANY($1::text[])`,
        [["mbt_enabled", "mbt_master_data"], ACTOR.operatorId]
      );

      const command = {
        actor: ACTOR,
        resource: "local_items",
        sourceKind: "manual",
        rows: [{
          itemCode: ITEM_CODE,
          displayName: "50 yard Bin",
          description: "User-defined pilot Bin item",
          itemType: "bin",
          binCapacityYards: 50,
          rentalPeriodDays: 14,
          applicableServiceTypes: ["delivery", "final_pickup", "loaded_pickup", "dump_return", "exchange"],
          applicableLegacySourceTypes: [],
          binTypeCode: null,
          netSuiteMappingLocalKey: null,
          active: true
        }],
        reason: "",
        idempotencyKey: `custom-bin-item-${RUN_ID}`,
        correlationId: `custom-bin-item-correlation-${RUN_ID}`,
        requestId: `custom-bin-item-request-${RUN_ID}`
      };
      const created = await applyLocalMasterDataRows(command);
      const replay = await applyLocalMasterDataRows(structuredClone(command));
      assert.equal(created.body.created, 1);
      assert.equal(replay.replayed, true);
      assert.deepEqual(replay.body, created.body);

      const item = (await listMbtLocalItemSettings()).find((candidate) => candidate.itemCode === ITEM_CODE);
      assert.equal(item?.itemType, "bin");
      assert.equal(item?.binCapacityYards, 50);
      assert.equal(item?.binTypeCode, ITEM_CODE);

      const binding = await query(
        `SELECT type.type_code, type.nominal_yards::int, type.local_item_code,
                item.item_code
           FROM mbt_bin_types type
           JOIN mbt_local_item_settings item ON item.bin_type_id = type.bin_type_id
          WHERE item.item_code = $1`,
        [ITEM_CODE]
      );
      assert.deepEqual(binding.rows, [{
        type_code: ITEM_CODE,
        nominal_yards: 50,
        local_item_code: ITEM_CODE,
        item_code: ITEM_CODE
      }]);
      const options = await getMbtAssetOpeningOptions();
      assert.ok(options.binItems.some((candidate) => candidate.itemCode === ITEM_CODE));

      const registered = await registerMbtBinAsset({
        actor: ACTOR,
        asset: { assetCode: ASSET_CODE, itemCode: ITEM_CODE, active: true, underMaintenance: false },
        initialState: {
          lifecycleStatus: "at_customer",
          location: {
            kind: "customer_site",
            reference: MANUAL_ADDRESS,
            customerSiteProfileId: null
          },
          occurredAt: "2036-08-05T12:00:00.000Z"
        },
        reason: "",
        idempotencyKey: `custom-bin-asset-${RUN_ID}`,
        correlationId: `custom-bin-asset-correlation-${RUN_ID}`,
        requestId: `custom-bin-asset-request-${RUN_ID}`
      });
      assert.equal(registered.body.asset.currentState.locationKind, "customer_site");
      assert.equal(registered.body.asset.currentState.customerSiteProfileId, null);
      assert.equal(registered.body.asset.currentState.currentAddress, MANUAL_ADDRESS);

      const evidence = await query(
        `SELECT idempotency_key, reason
           FROM mbt_audit_events
          WHERE idempotency_key = ANY($1::text[])
          ORDER BY idempotency_key`,
        [[command.idempotencyKey, `custom-bin-asset-${RUN_ID}`]]
      );
      assert.equal(evidence.rowCount, 2);
      assert.ok(evidence.rows.every((row) => String(row.reason).trim().length > 0));
    });
  } finally {
    config.mbt.enabled = previous.enabled;
    config.mbtPhase3.masterDataEnabled = previous.master;
    await rollback.rollback();
  }
});
