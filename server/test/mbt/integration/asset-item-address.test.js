import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { closeDb, pool, query } from "../../../src/db.js";
import { registerMbtBinAsset } from "../../../src/mbt/asset-registry-service.js";
import { recordAssetMovement } from "../../../src/mbt/asset-service.js";

const RUN_ID = crypto.randomUUID().replaceAll("-", "");
const YARD_12441 = "00000000-0000-4000-8000-000000012441";
const YARD_3445 = "00000000-0000-4000-8000-000000003445";
const ACTOR = { operatorId: `asset-address-${RUN_ID}`, roles: ["admin"] };

after(async () => closeDb());

test("new asset registration derives its BIN type from the item and stores no home yard", async () => {
  const assetCode = `ADDR-${RUN_ID}`;
  const result = await registerMbtBinAsset({
    actor: ACTOR,
    asset: {
      assetCode,
      itemCode: "14YD",
      active: true,
      underMaintenance: false
    },
    initialState: {
      lifecycleStatus: "available",
      location: { kind: "yard", reference: "12441", yardId: YARD_12441 },
      occurredAt: "2036-08-04T12:00:00.000Z"
    },
    reason: "Verify item-bound current-address registration",
    idempotencyKey: `asset-address-register-${RUN_ID}`,
    correlationId: `asset-address-correlation-${RUN_ID}`,
    requestId: `asset-address-request-${RUN_ID}`
  });

  assert.equal(result.body.asset.itemCode, "14YD");
  assert.equal(result.body.asset.currentState.currentAddress, "12441 Woodbine Avenue, Whitchurch-Stouffville, ON");
  const stored = await query(
    `SELECT asset.item_code, asset.home_yard_id::text,
            state.current_address, movement.after_address
       FROM mbt_bin_assets asset
       JOIN mbt_bin_asset_state state USING (asset_id)
       JOIN mbt_bin_movements movement ON movement.movement_id = state.last_movement_id
      WHERE asset.asset_id = $1`,
    [result.body.asset.assetId]
  );
  assert.deepEqual(stored.rows, [{
    item_code: "14YD",
    home_yard_id: null,
    current_address: "12441 Woodbine Avenue, Whitchurch-Stouffville, ON",
    after_address: "12441 Woodbine Avenue, Whitchurch-Stouffville, ON"
  }]);

  await recordAssetMovement(pool, {
    assetId: result.body.asset.assetId,
    movementType: "yard_transfer",
    afterStatus: "available",
    afterLocation: { kind: "yard", reference: "3445", yardId: YARD_3445 },
    source: "asset_address_test",
    actorType: "operator",
    actorId: ACTOR.operatorId,
    occurredAt: "2036-08-04T13:00:00.000Z"
  });

  const moved = await query(
    `SELECT state.current_address, movement.before_address, movement.after_address
       FROM mbt_bin_asset_state state
       JOIN mbt_bin_movements movement ON movement.movement_id = state.last_movement_id
      WHERE state.asset_id = $1`,
    [result.body.asset.assetId]
  );
  assert.deepEqual(moved.rows, [{
    current_address: "3445 Kennedy Road, Toronto, ON",
    before_address: "12441 Woodbine Avenue, Whitchurch-Stouffville, ON",
    after_address: "3445 Kennedy Road, Toronto, ON"
  }]);
});
