import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before } from "node:test";

import pg from "pg";

import {
  recordAssetMovement,
  reverseAssetMovement
} from "../../../src/mbt/asset-service.js";
import { createAssetFixture } from "../support/asset-fixtures.js";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const OCCURRED_AT = "2035-02-03T14:15:16.000Z";
let fixture;

async function mustSucceed(operation) {
  let result;
  await assert.doesNotReject(async () => {
    result = await operation();
  });
  return result;
}

before(async () => {
  const client = await pool.connect();
  try {
    fixture = await createAssetFixture(client, { assetCount: 6, visitCount: 2 });
  } finally {
    client.release();
  }
});

after(async () => {
  await pool.end();
});

test("F08: a movement durably records its complete before/after evidence and advances current state", async () => {
  const asset = fixture.assets[0];
  const evidenceReferences = [crypto.randomUUID(), crypto.randomUUID()];
  const movement = await mustSucceed(() => recordAssetMovement(pool, {
    assetId: asset.assetId,
    movementType: "loaded_on_truck",
    afterStatus: "on_truck",
    afterLocation: {
      kind: "truck",
      reference: fixture.truckPlate,
      truckId: fixture.truckId
    },
    contractId: fixture.contractId,
    visitId: fixture.visitIds[0],
    truckId: fixture.truckId,
    driverId: fixture.driverId,
    evidenceReferences,
    source: "driver_pwa",
    actorType: "driver",
    actorId: fixture.driverId,
    occurredAt: OCCURRED_AT,
    overrideReason: "Dispatcher-approved test movement"
  }));

  const persisted = await pool.query(
    `SELECT movement_id, asset_id, asset_sequence::int AS asset_sequence,
            movement_type, before_status, after_status,
            before_location_kind, before_location_reference,
            after_location_kind, after_location_reference,
            from_yard_id, to_yard_id, contract_id, service_visit_id,
            truck_id::text AS truck_id, driver_id::text AS driver_id,
            evidence_references, source, actor_type, actor_id, override_reason,
            occurred_at
       FROM mbt_bin_movements
      WHERE movement_id = $1`,
    [movement.movementId]
  );
  assert.equal(persisted.rowCount, 1);
  assert.deepEqual(persisted.rows[0], {
    movement_id: movement.movementId,
    asset_id: asset.assetId,
    asset_sequence: 2,
    movement_type: "loaded_on_truck",
    before_status: "available",
    after_status: "on_truck",
    before_location_kind: "yard",
    before_location_reference: fixture.yardCode,
    after_location_kind: "truck",
    after_location_reference: fixture.truckPlate,
    from_yard_id: fixture.yardId,
    to_yard_id: null,
    contract_id: fixture.contractId,
    service_visit_id: fixture.visitIds[0],
    truck_id: fixture.truckId,
    driver_id: fixture.driverId,
    evidence_references: evidenceReferences,
    source: "driver_pwa",
    actor_type: "driver",
    actor_id: fixture.driverId,
    override_reason: "Dispatcher-approved test movement",
    occurred_at: new Date(OCCURRED_AT)
  });

  const state = await pool.query(
    `SELECT lifecycle_status, location_kind, location_reference,
            yard_id, truck_id::text AS truck_id, last_movement_id,
            revision::int AS revision
       FROM mbt_bin_asset_state
      WHERE asset_id = $1`,
    [asset.assetId]
  );
  assert.deepEqual(state.rows[0], {
    lifecycle_status: "on_truck",
    location_kind: "truck",
    location_reference: fixture.truckPlate,
    yard_id: null,
    truck_id: fixture.truckId,
    last_movement_id: movement.movementId,
    revision: 2
  });
});

test("F07: an injected failure after ledger insertion rolls back both movement and current state", async () => {
  const asset = fixture.assets[1];
  let hookCalls = 0;
  await assert.rejects(
    () => recordAssetMovement(pool, {
      assetId: asset.assetId,
      movementType: "maintenance_started",
      afterStatus: "maintenance",
      afterLocation: {
        kind: "yard",
        reference: fixture.yardCode,
        yardId: fixture.yardId
      },
      source: "yard_console",
      actorType: "operator",
      actorId: "mbt-test-operator",
      occurredAt: OCCURRED_AT
    }, {
      afterMovementInsert: async () => {
        hookCalls += 1;
        throw new Error("INJECTED_MOVEMENT_FAILURE");
      }
    }),
    (error) => {
      assert.equal(error.message, "INJECTED_MOVEMENT_FAILURE");
      return true;
    }
  );
  assert.equal(hookCalls, 1);

  const evidence = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM mbt_bin_movements WHERE asset_id = $1) AS movement_count,
       s.lifecycle_status,
       s.location_kind,
       s.last_movement_id,
       s.revision::int AS revision
       FROM mbt_bin_asset_state s
      WHERE s.asset_id = $1`,
    [asset.assetId]
  );
  assert.deepEqual(evidence.rows[0], {
    movement_count: 1,
    lifecycle_status: "available",
    location_kind: "yard",
    last_movement_id: asset.initialMovementId,
    revision: 1
  });
});

test("F08: PostgreSQL rejects UPDATE and DELETE of an appended asset movement", async () => {
  const asset = fixture.assets[2];
  const movement = await mustSucceed(() => recordAssetMovement(pool, {
    assetId: asset.assetId,
    movementType: "condition_reviewed",
    afterStatus: "maintenance",
    afterLocation: {
      kind: "yard",
      reference: fixture.yardCode,
      yardId: fixture.yardId
    },
    source: "yard_console",
    actorType: "operator",
    actorId: "mbt-test-operator",
    occurredAt: OCCURRED_AT
  }));

  await assert.rejects(
    () => pool.query(
      "UPDATE mbt_bin_movements SET movement_type = 'rewritten' WHERE movement_id = $1",
      [movement.movementId]
    ),
    (error) => {
      assert.equal(error.code, "55000");
      return true;
    }
  );
  await assert.rejects(
    () => pool.query("DELETE FROM mbt_bin_movements WHERE movement_id = $1", [movement.movementId]),
    (error) => {
      assert.equal(error.code, "55000");
      return true;
    }
  );
  const retained = await pool.query(
    "SELECT movement_type FROM mbt_bin_movements WHERE movement_id = $1",
    [movement.movementId]
  );
  assert.deepEqual(retained.rows, [{ movement_type: "condition_reviewed" }]);
});

test("F08: correcting the latest movement appends a linked reversal and never rewrites history", async () => {
  const asset = fixture.assets[3];
  const original = await mustSucceed(() => recordAssetMovement(pool, {
    assetId: asset.assetId,
    movementType: "maintenance_started",
    afterStatus: "maintenance",
    afterLocation: {
      kind: "yard",
      reference: fixture.yardCode,
      yardId: fixture.yardId
    },
    source: "yard_console",
    actorType: "operator",
    actorId: "mbt-test-operator",
    occurredAt: OCCURRED_AT
  }));
  const reversal = await mustSucceed(() => reverseAssetMovement(pool, {
    assetId: asset.assetId,
    correctionOfMovementId: original.movementId,
    source: "yard_console",
    actorType: "operator",
    actorId: "mbt-test-supervisor",
    occurredAt: "2035-02-03T14:20:00.000Z",
    overrideReason: "Corrected mistaken maintenance scan"
  }));

  const timeline = await pool.query(
    `SELECT asset_sequence::int AS asset_sequence, movement_type,
            before_status, after_status, correction_of_movement_id
       FROM mbt_bin_movements
      WHERE asset_id = $1
      ORDER BY asset_sequence`,
    [asset.assetId]
  );
  assert.deepEqual(timeline.rows, [
    {
      asset_sequence: 1,
      movement_type: "asset_registered",
      before_status: null,
      after_status: "available",
      correction_of_movement_id: null
    },
    {
      asset_sequence: 2,
      movement_type: "maintenance_started",
      before_status: "available",
      after_status: "maintenance",
      correction_of_movement_id: null
    },
    {
      asset_sequence: 3,
      movement_type: "correction_reversal",
      before_status: "maintenance",
      after_status: "available",
      correction_of_movement_id: original.movementId
    }
  ]);
  const state = await pool.query(
    `SELECT lifecycle_status, location_kind, yard_id, last_movement_id,
            revision::int AS revision
       FROM mbt_bin_asset_state
      WHERE asset_id = $1`,
    [asset.assetId]
  );
  assert.deepEqual(state.rows[0], {
    lifecycle_status: "available",
    location_kind: "yard",
    yard_id: fixture.yardId,
    last_movement_id: reversal.movementId,
    revision: 3
  });
});

test("F07: the composite state foreign key rejects another asset's movement as current state", async () => {
  const asset = fixture.assets[4];
  const otherAsset = fixture.assets[5];
  await assert.rejects(
    () => pool.query(
      `UPDATE mbt_bin_asset_state
          SET last_movement_id = $2,
              revision = revision + 1
        WHERE asset_id = $1`,
      [asset.assetId, otherAsset.initialMovementId]
    ),
    (error) => {
      assert.equal(error.code, "23503");
      assert.equal(error.constraint, "mbt_bin_asset_state_last_movement_fk");
      return true;
    }
  );
  const state = await pool.query(
    "SELECT last_movement_id, revision::int AS revision FROM mbt_bin_asset_state WHERE asset_id = $1",
    [asset.assetId]
  );
  assert.deepEqual(state.rows[0], {
    last_movement_id: asset.initialMovementId,
    revision: 1
  });
});

test("F07: database triggers reject state drift from the latest movement", async (t) => {
  await t.test("after-state drift", async () => {
    const local = await createHardeningFixture(1, 1);
    await assert.rejects(
      () => pool.query(
        `UPDATE mbt_bin_asset_state
            SET lifecycle_status = 'maintenance'
          WHERE asset_id = $1`,
        [local.assets[0].assetId]
      ),
      (error) => error?.code === "55000"
    );
  });

  await t.test("revision drift", async () => {
    const local = await createHardeningFixture(1, 1);
    await assert.rejects(
      () => pool.query(
        `UPDATE mbt_bin_asset_state
            SET revision = revision + 1
          WHERE asset_id = $1`,
        [local.assets[0].assetId]
      ),
      (error) => error?.code === "55000"
    );
  });

  await t.test("stale movement reference", async () => {
    const local = await createHardeningFixture(1, 1);
    await mustSucceed(() => recordAssetMovement(pool, {
      assetId: local.assets[0].assetId,
      movementType: "maintenance_started",
      afterStatus: "maintenance",
      afterLocation: {
        kind: "yard",
        reference: local.yardCode,
        yardId: local.yardId
      },
      source: "state-drift-test",
      actorType: "operator",
      occurredAt: OCCURRED_AT
    }));
    await assert.rejects(
      () => pool.query(
        `UPDATE mbt_bin_asset_state
            SET lifecycle_status = 'available', location_kind = 'yard',
                location_reference = $2, yard_id = $3,
                customer_site_profile_id = NULL, dump_site_id = NULL,
                truck_id = NULL, last_movement_id = $4, revision = 1
          WHERE asset_id = $1`,
        [
          local.assets[0].assetId,
          local.yardCode,
          local.yardId,
          local.assets[0].initialMovementId
        ]
      ),
      (error) => error?.code === "55000"
    );
  });

  await t.test("unmaterialized direct movement", async () => {
    const local = await createHardeningFixture(1, 1);
    await assert.rejects(
      () => pool.query(
        `INSERT INTO mbt_bin_movements (
           movement_id, asset_id, asset_sequence, movement_type,
           before_status, after_status, before_location_kind,
           before_location_reference, after_location_kind,
           after_location_reference, from_yard_id, to_yard_id,
           source, actor_type, occurred_at
         ) VALUES (
           $1, $2, 2, 'direct_state_bypass', 'available', 'available',
           'yard', $3, 'yard', $3, $4, $4,
           'state-drift-test', 'operator', now()
         )`,
        [crypto.randomUUID(), local.assets[0].assetId, local.yardCode, local.yardId]
      ),
      (error) => error?.code === "55000"
    );
  });
});

// Post-GREEN hardening block. The eight frozen packet assertions above remain
// unchanged; these cases exercise defensive boundaries and mutation targets.

async function createHardeningFixture(assetCount, visitCount) {
  const client = await pool.connect();
  try {
    return await createAssetFixture(client, { assetCount, visitCount });
  } finally {
    client.release();
  }
}

async function assertMbtFailure(operation, code, status) {
  await assert.rejects(operation, (error) => {
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    return true;
  });
}

test("F07/F08 hardening: malformed movement commands fail before changing durable evidence", async () => {
  const local = await createHardeningFixture(5, 1);
  const asset = local.assets[0];
  const base = {
    assetId: asset.assetId,
    movementType: "hardening_check",
    afterStatus: "maintenance",
    afterLocation: {
      kind: "yard",
      reference: local.yardCode,
      yardId: local.yardId
    },
    source: "hardening_test",
    actorType: "operator",
    actorId: "hardening-operator",
    occurredAt: OCCURRED_AT
  };
  const cases = [
    [null, "MBT_ASSET_INPUT_INVALID"],
    [{ ...base, assetId: "" }, "MBT_ASSET_INPUT_INVALID"],
    [{ ...base, afterStatus: "flying" }, "MBT_ASSET_STATUS_INVALID"],
    [{ ...base, afterLocation: null }, "MBT_ASSET_LOCATION_INVALID"],
    [{ ...base, afterLocation: { kind: "moon" } }, "MBT_ASSET_LOCATION_INVALID"],
    [{ ...base, afterLocation: { kind: "yard" } }, "MBT_ASSET_LOCATION_INVALID"],
    [{ ...base, afterLocation: { kind: "customer_site" } }, "MBT_ASSET_LOCATION_INVALID"],
    [{ ...base, afterLocation: { kind: "dump_site" } }, "MBT_ASSET_LOCATION_INVALID"],
    [{ ...base, afterLocation: { kind: "truck" } }, "MBT_ASSET_LOCATION_INVALID"],
    [{ ...base, evidenceReferences: "not-an-array" }, "MBT_ASSET_EVIDENCE_INVALID"],
    [{ ...base, occurredAt: "not-a-time" }, "MBT_ASSET_TIMESTAMP_INVALID"]
  ];
  for (const [command, code] of cases) {
    await assertMbtFailure(() => recordAssetMovement(pool, command), code, 400);
  }
  await assertMbtFailure(
    () => recordAssetMovement(pool, { ...base, assetId: crypto.randomUUID() }),
    "MBT_ASSET_NOT_FOUND",
    404
  );
  const unchanged = await pool.query(
    `SELECT count(*)::int AS movement_count
       FROM mbt_bin_movements
      WHERE asset_id = $1`,
    [asset.assetId]
  );
  assert.deepEqual(unchanged.rows[0], { movement_count: 1 });

  const loaded = await mustSucceed(() => recordAssetMovement(pool, {
    ...base,
    movementType: "loaded_without_duplicate_truck_field",
    afterStatus: "on_truck",
    afterLocation: {
      kind: "truck",
      reference: local.truckPlate,
      truckId: local.truckId
    },
    occurredAt: new Date(OCCURRED_AT)
  }));
  const lost = await mustSucceed(() => recordAssetMovement(pool, {
    ...base,
    movementType: "truck_asset_reported_lost",
    afterStatus: "lost",
    afterLocation: { kind: "unknown", reference: "last seen on assigned truck" },
    occurredAt: "2035-02-03T14:30:00.000Z"
  }));
  const restored = await mustSucceed(() => reverseAssetMovement(pool, {
    assetId: asset.assetId,
    correctionOfMovementId: lost.movementId,
    source: "hardening_test",
    actorType: "operator",
    occurredAt: "2035-02-03T14:35:00.000Z",
    overrideReason: "False lost report"
  }));
  assert.equal(loaded.assetSequence, 2);
  assert.equal(restored.assetSequence, 4);

  await mustSucceed(() => recordAssetMovement(pool, {
    ...base,
    assetId: local.assets[1].assetId,
    movementType: "delivered_to_customer",
    afterStatus: "at_customer",
    afterLocation: {
      kind: "customer_site",
      reference: "hardening customer site",
      customerSiteProfileId: local.customerSiteProfileId
    }
  }));
  const dumpSiteId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO mbt_dump_sites (dump_site_id, dump_site_code, display_name)
     VALUES ($1, $2, $3)`,
    [dumpSiteId, `P1-D-${local.fixtureId}`, `Hardening dump ${local.fixtureId}`]
  );
  await mustSucceed(() => recordAssetMovement(pool, {
    ...base,
    assetId: local.assets[2].assetId,
    movementType: "arrived_at_dump",
    afterStatus: "at_dump",
    afterLocation: {
      kind: "dump_site",
      reference: `P1-D-${local.fixtureId}`,
      dumpSiteId
    }
  }));
});

test("F08 hardening: invalid, cross-asset, and stale correction targets are rejected", async () => {
  const local = await createHardeningFixture(3, 1);
  const correction = (assetId, correctionOfMovementId) => ({
    assetId,
    correctionOfMovementId,
    source: "hardening_test",
    actorType: "operator",
    actorId: "hardening-supervisor",
    occurredAt: "2035-03-01T10:00:00.000Z",
    overrideReason: "Hardening correction check"
  });
  await assertMbtFailure(
    () => reverseAssetMovement(pool, correction(local.assets[0].assetId, crypto.randomUUID())),
    "MBT_MOVEMENT_NOT_FOUND",
    404
  );
  await assertMbtFailure(
    () => reverseAssetMovement(
      pool,
      correction(local.assets[0].assetId, local.assets[1].initialMovementId)
    ),
    "MBT_MOVEMENT_ASSET_MISMATCH",
    409
  );
  await assertMbtFailure(
    () => reverseAssetMovement(
      pool,
      correction(local.assets[0].assetId, local.assets[0].initialMovementId)
    ),
    "MBT_MOVEMENT_NOT_REVERSIBLE",
    409
  );
  await assertMbtFailure(
    () => reverseAssetMovement(pool, {}),
    "MBT_ASSET_INPUT_INVALID",
    400
  );

  const first = await mustSucceed(() => recordAssetMovement(pool, {
    assetId: local.assets[2].assetId,
    movementType: "maintenance_started",
    afterStatus: "maintenance",
    afterLocation: { kind: "yard", reference: local.yardCode, yardId: local.yardId },
    source: "hardening_test",
    actorType: "operator",
    occurredAt: "2035-03-01T10:05:00.000Z"
  }));
  await mustSucceed(() => recordAssetMovement(pool, {
    assetId: local.assets[2].assetId,
    movementType: "maintenance_finished",
    afterStatus: "available",
    afterLocation: { kind: "yard", reference: local.yardCode, yardId: local.yardId },
    source: "hardening_test",
    actorType: "operator",
    occurredAt: "2035-03-01T10:10:00.000Z"
  }));
  await assertMbtFailure(
    () => reverseAssetMovement(pool, correction(local.assets[2].assetId, first.movementId)),
    "MBT_MOVEMENT_CORRECTION_CONFLICT",
    409
  );
});
