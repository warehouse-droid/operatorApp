import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before } from "node:test";

import { closeDb, query } from "../../../src/db.js";
import { MbtError } from "../../../src/mbt/errors.js";

const RUN_ID = crypto.randomUUID().replaceAll("-", "");
const RACE_REPETITIONS = 25;
const RACE_CLIENTS = 25;
const YARD_ID = "00000000-0000-4000-8000-000000012441";
const YARD_CODE = "12441";
const BIN_TYPE_ID = "00000000-0000-4000-8000-000000000020";
const ACTOR = Object.freeze({
  operatorId: `p3-asset-race-${RUN_ID}`,
  roles: Object.freeze(["admin"])
});
let commandSequence = 0;

const assetRegistry = /** @type {Record<string, Function>} */ (await import(
  "../../../src/mbt/asset-registry-service.js"
).catch((error) => {
  if (error?.code !== "ERR_MODULE_NOT_FOUND") {
    throw error;
  }
  return {};
}));

function registerOperation() {
  const operation = assetRegistry.registerMbtBinAsset;
  assert.equal(
    typeof operation,
    "function",
    "P3.5 requires the registerMbtBinAsset asset-registry operation."
  );
  return operation;
}

/**
 * @param {string} label
 * @param {Record<string, unknown>} [overrides]
 */
function registration(label, overrides = {}) {
  commandSequence += 1;
  const identity = `${RUN_ID}-${commandSequence}`;
  return {
    actor: ACTOR,
    asset: {
      assetCode: `P3-RACE-${identity}-${label}`,
      qrCode: `QR-RACE-${identity}`,
      barcode: `BAR-RACE-${identity}`,
      binTypeId: BIN_TYPE_ID,
      homeYardId: YARD_ID,
      tareWeightKg: null,
      conditionCode: null,
      operationalNotes: `Synthetic race ${label}`,
      active: true,
      underMaintenance: false,
      ...overrides
    },
    initialState: {
      lifecycleStatus: "available",
      location: { kind: "yard", reference: YARD_CODE, yardId: YARD_ID },
      occurredAt: "2036-08-03T13:00:00.000Z"
    },
    reason: `Synthetic asset registration race ${label}`,
    idempotencyKey: `p3-asset-race-idem-${identity}`,
    correlationId: `p3-asset-race-corr-${identity}`,
    requestId: `p3-asset-race-req-${identity}`
  };
}

before(async () => {
  const yard = await query(
    `SELECT yard_code, dispatch_location_id
       FROM mbt_yards
      WHERE yard_id = $1`,
    [YARD_ID]
  );
  assert.deepEqual(yard.rows, [{ yard_code: YARD_CODE, dispatch_location_id: 15 }]);
});

after(async () => {
  await closeDb();
});

test("P3-F11 concurrency: 25 duplicate code/QR/barcode races create one complete winner each", {
  timeout: 120_000
}, async () => {
  const registerMbtBinAsset = registerOperation();
  const beforeEvidence = await query(
    `SELECT
       (SELECT count(*)::int FROM mbt_audit_events
         WHERE actor_operator_id = $1 AND action = 'mbt.asset.registered') AS audits,
       (SELECT count(*)::int FROM mbt_command_receipts
         WHERE actor_operator_id = $1 AND command_name = 'mbt.asset.register') AS receipts`,
    [ACTOR.operatorId]
  );

  for (let iteration = 0; iteration < RACE_REPETITIONS; iteration += 1) {
    const left = registration(`${iteration}-left`);
    const right = registration(`${iteration}-right`);
    const conflictField = ["assetCode", "qrCode", "barcode"][iteration % 3];
    right.asset[conflictField] = left.asset[conflictField];

    let releaseRace = () => {};
    const start = new Promise((resolve) => {
      releaseRace = resolve;
    });
    const outcomesPromise = Promise.allSettled([left, right].map(async (input) => {
      await start;
      return registerMbtBinAsset(input);
    }));
    releaseRace();
    const outcomes = await outcomesPromise;
    const winners = outcomes.filter(({ status }) => status === "fulfilled");
    const losers = outcomes.filter(({ status }) => status === "rejected");
    assert.equal(winners.length, 1, JSON.stringify(outcomes));
    assert.equal(losers.length, 1, JSON.stringify(outcomes));
    assert.ok(
      losers[0].reason instanceof MbtError
        && losers[0].reason.status === 409
        && losers[0].reason.code === "MBT_ASSET_DUPLICATE",
      JSON.stringify(losers[0].reason)
    );

    const durable = await query(
      `SELECT
         count(DISTINCT a.asset_id)::int AS assets,
         count(DISTINCT m.movement_id)::int AS movements,
         count(DISTINCT s.asset_id)::int AS states,
         min(m.asset_sequence)::int AS minimum_sequence,
         max(m.asset_sequence)::int AS maximum_sequence
       FROM mbt_bin_assets a
       LEFT JOIN mbt_bin_movements m ON m.asset_id = a.asset_id
       LEFT JOIN mbt_bin_asset_state s ON s.asset_id = a.asset_id
       WHERE a.asset_code = $1 OR a.qr_code = $2 OR a.barcode = $3`,
      [left.asset.assetCode, left.asset.qrCode, left.asset.barcode]
    );
    assert.deepEqual(durable.rows[0], {
      assets: 1,
      movements: 1,
      states: 1,
      minimum_sequence: 1,
      maximum_sequence: 1
    });
  }

  const evidence = await query(
    `SELECT
       (SELECT count(*)::int FROM mbt_bin_assets
         WHERE created_by = $1) AS assets,
       (SELECT count(*)::int FROM mbt_bin_movements
         WHERE actor_id = $1 AND movement_type = 'asset_registered') AS movements,
       (SELECT count(*)::int FROM mbt_bin_asset_state s
         JOIN mbt_bin_assets a ON a.asset_id = s.asset_id
         WHERE a.created_by = $1) AS states,
       (SELECT count(*)::int FROM mbt_audit_events
         WHERE actor_operator_id = $1 AND action = 'mbt.asset.registered') AS audits,
       (SELECT count(*)::int FROM mbt_command_receipts
         WHERE actor_operator_id = $1 AND command_name = 'mbt.asset.register') AS receipts`,
    [ACTOR.operatorId]
  );
  assert.deepEqual(evidence.rows[0], {
    assets: RACE_REPETITIONS,
    movements: RACE_REPETITIONS,
    states: RACE_REPETITIONS,
    audits: beforeEvidence.rows[0].audits + RACE_REPETITIONS,
    receipts: beforeEvidence.rows[0].receipts + RACE_REPETITIONS
  });
});

test("P3-F11 concurrency: 25 exact simultaneous retries replay one registration and one command evidence pair", {
  timeout: 120_000
}, async () => {
  const registerMbtBinAsset = registerOperation();
  const input = registration("exact-replay");
  let releaseRace = () => {};
  const start = new Promise((resolve) => {
    releaseRace = resolve;
  });
  const attempts = Array.from({ length: RACE_CLIENTS }, async () => {
    await start;
    return registerMbtBinAsset({ ...input });
  });
  releaseRace();
  const outcomes = await Promise.all(attempts);
  assert.equal(outcomes.filter(({ replayed }) => replayed === false).length, 1);
  assert.equal(outcomes.filter(({ replayed }) => replayed === true).length, RACE_CLIENTS - 1);
  assert.ok(outcomes.every(({ status }) => status === 201));
  assert.ok(outcomes.every(({ body }) => (
    body.asset.assetId === outcomes[0].body.asset.assetId
      && body.asset.currentState.lastMovementId
        === outcomes[0].body.asset.currentState.lastMovementId
  )));

  const durable = await query(
    `SELECT
       count(DISTINCT a.asset_id)::int AS assets,
       count(DISTINCT m.movement_id)::int AS movements,
       count(DISTINCT s.asset_id)::int AS states,
       (SELECT count(*)::int FROM mbt_audit_events
         WHERE actor_operator_id = $2
           AND action = 'mbt.asset.registered'
           AND idempotency_key = $3) AS audits,
       (SELECT count(*)::int FROM mbt_command_receipts
         WHERE actor_operator_id = $2
           AND command_name = 'mbt.asset.register'
           AND idempotency_key = $3) AS receipts
     FROM mbt_bin_assets a
     LEFT JOIN mbt_bin_movements m ON m.asset_id = a.asset_id
     LEFT JOIN mbt_bin_asset_state s ON s.asset_id = a.asset_id
     WHERE a.asset_code = $1`,
    [input.asset.assetCode, ACTOR.operatorId, input.idempotencyKey]
  );
  assert.deepEqual(durable.rows[0], {
    assets: 1,
    movements: 1,
    states: 1,
    audits: 1,
    receipts: 1
  });
});
