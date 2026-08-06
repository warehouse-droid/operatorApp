import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before } from "node:test";

import { closeDb, query } from "../../../src/db.js";
import { MbtError } from "../../../src/mbt/errors.js";

const RUN_ID = crypto.randomUUID().replaceAll("-", "");
const ASSET_PREFIX = `P3-A-${RUN_ID}`;
const YARD_ID = "00000000-0000-4000-8000-000000012441";
const YARD_CODE = "12441";
const BIN_TYPE_ID = "00000000-0000-4000-8000-000000000014";
const OCCURRED_AT = "2036-08-03T12:34:56.000Z";
const ACTOR = Object.freeze({
  operatorId: `p3-asset-admin-${RUN_ID}`,
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

/** @param {string} name */
function requiredOperation(name) {
  const operation = assetRegistry[name];
  assert.equal(
    typeof operation,
    "function",
    `P3.5 requires the ${name} asset-registry operation.`
  );
  return operation;
}

/**
 * @param {string} label
 * @param {Record<string, unknown>} [assetOverrides]
 * @param {Record<string, unknown>} [stateOverrides]
 */
function registration(label, assetOverrides = {}, stateOverrides = {}) {
  commandSequence += 1;
  const identity = `${RUN_ID}-${commandSequence}`;
  const assetCode = `${ASSET_PREFIX}-${label}-${commandSequence}`;
  return {
    actor: ACTOR,
    asset: {
      assetCode,
      qrCode: `QR-${identity}`,
      barcode: `BAR-${identity}`,
      binTypeId: BIN_TYPE_ID,
      homeYardId: YARD_ID,
      tareWeightKg: "1450.500",
      conditionCode: null,
      operationalNotes: `Synthetic opening asset ${label}`,
      active: true,
      underMaintenance: false,
      ...assetOverrides
    },
    initialState: {
      lifecycleStatus: "available",
      location: {
        kind: "yard",
        reference: YARD_CODE,
        yardId: YARD_ID
      },
      occurredAt: OCCURRED_AT,
      ...stateOverrides
    },
    reason: `Register synthetic opening asset ${label}`,
    idempotencyKey: `p3-asset-idem-${identity}`,
    correlationId: `p3-asset-corr-${identity}`,
    requestId: `p3-asset-req-${identity}`
  };
}

/** @param {unknown} error @param {string} code @param {number} status */
function isMbtFailure(error, code, status) {
  return error instanceof MbtError && error.code === code && error.status === status;
}

/** @param {string} assetCode */
async function durableAssetEvidence(assetCode) {
  return query(
    `SELECT
       a.asset_id::text AS asset_id,
       a.asset_code,
       a.qr_code,
       a.barcode,
       a.bin_type_id::text AS bin_type_id,
       a.home_yard_id::text AS home_yard_id,
       a.tare_weight_kg::text AS tare_weight_kg,
       a.operational_notes,
       a.active,
       a.under_maintenance,
       a.revision::int AS asset_revision,
       m.movement_id::text AS movement_id,
       m.asset_sequence::int AS asset_sequence,
       m.movement_type,
       m.before_status,
       m.after_status,
       m.before_location_kind,
       m.after_location_kind,
       m.after_location_reference,
       m.to_yard_id::text AS to_yard_id,
       m.source,
       m.actor_type,
       m.actor_id,
       m.occurred_at,
       s.lifecycle_status,
       s.location_kind,
       s.location_reference,
       s.yard_id::text AS state_yard_id,
       s.last_movement_id::text AS last_movement_id,
       s.revision::int AS state_revision
     FROM mbt_bin_assets a
     LEFT JOIN mbt_bin_movements m ON m.asset_id = a.asset_id
     LEFT JOIN mbt_bin_asset_state s ON s.asset_id = a.asset_id
     WHERE a.asset_code = $1
     ORDER BY m.asset_sequence`,
    [assetCode]
  );
}

/** @param {string} idempotencyKey */
async function commandEvidence(idempotencyKey) {
  const result = await query(
    `SELECT
       (SELECT count(*)::int
          FROM mbt_audit_events
         WHERE actor_operator_id = $1
           AND action = 'mbt.asset.registered'
           AND idempotency_key = $2) AS audits,
       (SELECT count(*)::int
          FROM mbt_command_receipts
         WHERE actor_operator_id = $1
           AND command_name = 'mbt.asset.register'
           AND idempotency_key = $2) AS receipts`,
    [ACTOR.operatorId, idempotencyKey]
  );
  return result.rows[0];
}

before(async () => {
  const [binType, yard] = await Promise.all([
    query("SELECT active FROM mbt_bin_types WHERE bin_type_id = $1", [BIN_TYPE_ID]),
    query(
      `SELECT yard_code, dispatch_location_id
         FROM mbt_yards
        WHERE yard_id = $1`,
      [YARD_ID]
    )
  ]);
  assert.deepEqual(binType.rows, [{ active: true }]);
  assert.deepEqual(yard.rows, [{ yard_code: YARD_CODE, dispatch_location_id: 15 }]);
});

after(async () => {
  await closeDb();
});

test("P3-F11: manual registration atomically creates one asset, sequence-1 movement, state, audit, and receipt", async () => {
  const registerMbtBinAsset = requiredOperation("registerMbtBinAsset");
  const input = registration("atomic");
  const first = await registerMbtBinAsset(input);
  const replay = await registerMbtBinAsset({ ...input });

  assert.equal(first.status, 201);
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.body, first.body);
  assert.equal(first.body.schemaVersion, "mbt-asset-v1");
  assert.equal(first.body.asset.assetCode, input.asset.assetCode);
  assert.equal(first.body.asset.revision, 1);
  assert.equal(first.body.asset.currentState.revision, 1);

  const evidence = await durableAssetEvidence(input.asset.assetCode);
  assert.equal(evidence.rowCount, 1);
  const row = evidence.rows[0];
  assert.deepEqual(row, {
    asset_id: first.body.asset.assetId,
    asset_code: input.asset.assetCode,
    qr_code: input.asset.qrCode,
    barcode: input.asset.barcode,
    bin_type_id: BIN_TYPE_ID,
    home_yard_id: YARD_ID,
    tare_weight_kg: "1450.500",
    operational_notes: input.asset.operationalNotes,
    active: true,
    under_maintenance: false,
    asset_revision: 1,
    movement_id: first.body.asset.currentState.lastMovementId,
    asset_sequence: 1,
    movement_type: "asset_registered",
    before_status: null,
    after_status: "available",
    before_location_kind: null,
    after_location_kind: "yard",
    after_location_reference: YARD_CODE,
    to_yard_id: YARD_ID,
    source: "asset_registry",
    actor_type: "operator",
    actor_id: ACTOR.operatorId,
    occurred_at: new Date(OCCURRED_AT),
    lifecycle_status: "available",
    location_kind: "yard",
    location_reference: YARD_CODE,
    state_yard_id: YARD_ID,
    last_movement_id: first.body.asset.currentState.lastMovementId,
    state_revision: 1
  });
  assert.deepEqual(await commandEvidence(input.idempotencyKey), { audits: 1, receipts: 1 });
});

test("P3-F11: blank or unknown yard/bin-type references create no domain or command evidence", async () => {
  const registerMbtBinAsset = requiredOperation("registerMbtBinAsset");
  const cases = [
    {
      input: registration("blank-code", { assetCode: "" }),
      code: "MBT_ASSET_INPUT_INVALID"
    },
    {
      input: registration("blank-bin-type", { binTypeId: "" }),
      code: "MBT_ASSET_INPUT_INVALID"
    },
    {
      input: registration("unknown-bin-type", { binTypeId: crypto.randomUUID() }),
      code: "MBT_ASSET_REFERENCE_INVALID"
    },
    {
      input: registration("blank-yard", { homeYardId: "" }),
      code: "MBT_ASSET_INPUT_INVALID"
    },
    {
      input: registration("unknown-yard", { homeYardId: crypto.randomUUID() }),
      code: "MBT_ASSET_REFERENCE_INVALID"
    }
  ];

  for (const fixture of cases) {
    await assert.rejects(
      () => registerMbtBinAsset(fixture.input),
      (error) => isMbtFailure(error, fixture.code, 400)
    );
    assert.deepEqual(await commandEvidence(fixture.input.idempotencyKey), {
      audits: 0,
      receipts: 0
    });
  }
  const assets = await query(
    "SELECT count(*)::int AS count FROM mbt_bin_assets WHERE asset_code LIKE $1",
    [`${ASSET_PREFIX}-%`]
  );
  assert.deepEqual(assets.rows[0], { count: 1 });
});

test("P3-F11: duplicate asset code, QR, or barcode conflicts and leaves the winner unchanged", async () => {
  const registerMbtBinAsset = requiredOperation("registerMbtBinAsset");
  const winnerInput = registration("duplicate-winner");
  const winner = await registerMbtBinAsset(winnerInput);
  const duplicates = [
    registration("duplicate-code", { assetCode: winnerInput.asset.assetCode }),
    registration("duplicate-qr", { qrCode: winnerInput.asset.qrCode }),
    registration("duplicate-barcode", { barcode: winnerInput.asset.barcode })
  ];

  for (const duplicate of duplicates) {
    await assert.rejects(
      () => registerMbtBinAsset(duplicate),
      (error) => isMbtFailure(error, "MBT_ASSET_DUPLICATE", 409)
    );
    assert.deepEqual(await commandEvidence(duplicate.idempotencyKey), {
      audits: 0,
      receipts: 0
    });
  }

  const winnerRows = await durableAssetEvidence(winnerInput.asset.assetCode);
  assert.equal(winnerRows.rowCount, 1);
  assert.equal(winnerRows.rows[0].asset_id, winner.body.asset.assetId);
  assert.equal(winnerRows.rows[0].asset_sequence, 1);
  assert.equal(winnerRows.rows[0].state_revision, 1);
});

test("P3-F11: failure after the asset insert rolls back asset, movement, state, audit, and receipt", async () => {
  const registerMbtBinAsset = requiredOperation("registerMbtBinAsset");
  const input = registration("rollback");
  let hookCalls = 0;
  await assert.rejects(
    () => registerMbtBinAsset(input, {
      afterAssetInsert: async () => {
        hookCalls += 1;
        throw new Error("INJECTED_ASSET_REGISTRATION_FAILURE");
      }
    }),
    /INJECTED_ASSET_REGISTRATION_FAILURE/
  );
  assert.equal(hookCalls, 1);
  assert.equal((await durableAssetEvidence(input.asset.assetCode)).rowCount, 0);
  assert.deepEqual(await commandEvidence(input.idempotencyKey), { audits: 0, receipts: 0 });
});

test("P3-F11: asset list, timeline, and revisioned attributes retain the sequence-1 opening evidence", async () => {
  const registerMbtBinAsset = requiredOperation("registerMbtBinAsset");
  const listMbtBinAssets = requiredOperation("listMbtBinAssets");
  const getMbtBinAssetTimeline = requiredOperation("getMbtBinAssetTimeline");
  const updateMbtBinAssetAttributes = requiredOperation("updateMbtBinAssetAttributes");
  const input = registration("registry-read");
  const registered = await registerMbtBinAsset(input);
  const assetId = registered.body.asset.assetId;

  const listed = await listMbtBinAssets({ query: input.asset.assetCode, limit: 20 });
  assert.equal(listed.schemaVersion, "mbt-assets-v1");
  assert.deepEqual(listed.items.map((item) => item.assetId), [assetId]);
  assert.equal(listed.items[0].currentState.lifecycleStatus, "available");

  const timelineBefore = await getMbtBinAssetTimeline(assetId);
  assert.equal(timelineBefore.schemaVersion, "mbt-asset-timeline-v1");
  assert.deepEqual(timelineBefore.movements.map((movement) => ({
    sequence: movement.assetSequence,
    type: movement.movementType
  })), [{ sequence: 1, type: "asset_registered" }]);

  const updateIdentity = `${RUN_ID}-update-${++commandSequence}`;
  const updated = await updateMbtBinAssetAttributes({
    actor: ACTOR,
    assetId,
    attributes: {
      qrCode: input.asset.qrCode,
      barcode: input.asset.barcode,
      tareWeightKg: "1500.000",
      conditionCode: null,
      operationalNotes: "Opening inventory verified",
      active: true,
      underMaintenance: false
    },
    expectedRevision: 1,
    reason: "Verify synthetic opening inventory",
    idempotencyKey: `p3-asset-update-idem-${updateIdentity}`,
    correlationId: `p3-asset-update-corr-${updateIdentity}`,
    requestId: `p3-asset-update-req-${updateIdentity}`
  });
  assert.equal(updated.body.asset.revision, 2);
  assert.equal(updated.body.asset.operationalNotes, "Opening inventory verified");
  assert.equal(updated.body.asset.currentState.revision, 1);

  const timelineAfter = await getMbtBinAssetTimeline(assetId);
  assert.deepEqual(timelineAfter.movements, timelineBefore.movements);
  const durable = await durableAssetEvidence(input.asset.assetCode);
  assert.equal(durable.rowCount, 1);
  assert.equal(durable.rows[0].asset_revision, 2);
  assert.equal(durable.rows[0].state_revision, 1);
});

test("P3-F23: opening movement comparison stores immutable snapshots, opens mismatches, and never rewrites the ledger", async () => {
  const registerMbtBinAsset = requiredOperation("registerMbtBinAsset");
  const compareMbtAssetMovements = requiredOperation("compareMbtAssetMovements");
  const getMbtAssetReconciliationBatch = requiredOperation("getMbtAssetReconciliationBatch");
  const resolveMbtAssetMovementVariance = requiredOperation("resolveMbtAssetMovementVariance");
  const matchingInput = registration("comparison-match");
  const mismatchInput = registration("comparison-mismatch");
  await registerMbtBinAsset(matchingInput);
  await registerMbtBinAsset(mismatchInput);

  const comparisonIdentity = `${RUN_ID}-comparison-${++commandSequence}`;
  const compared = await compareMbtAssetMovements({
    actor: ACTOR,
    rows: [
      {
        manualRowId: "manual-match",
        assetCode: matchingInput.asset.assetCode,
        assetSequence: 1,
        beforeStatus: null,
        afterStatus: "available",
        beforeLocationKind: null,
        afterLocationKind: "yard",
        afterLocationReference: YARD_CODE,
        truckId: null,
        driverId: null,
        visitId: null,
        occurredAt: OCCURRED_AT
      },
      {
        manualRowId: "manual-mismatch",
        assetCode: mismatchInput.asset.assetCode,
        assetSequence: 1,
        beforeStatus: null,
        afterStatus: "maintenance",
        beforeLocationKind: null,
        afterLocationKind: "yard",
        afterLocationReference: YARD_CODE,
        truckId: null,
        driverId: null,
        visitId: null,
        occurredAt: OCCURRED_AT
      }
    ],
    reason: "Compare synthetic opening inventory",
    idempotencyKey: `p3-asset-compare-idem-${comparisonIdentity}`,
    correlationId: `p3-asset-compare-corr-${comparisonIdentity}`,
    requestId: `p3-asset-compare-req-${comparisonIdentity}`
  });

  assert.equal(compared.status, 201);
  assert.deepEqual(compared.body.summary, {
    totalRows: 2,
    matched: 1,
    openVariance: 1
  });
  assert.deepEqual(compared.body.rows.map((row) => row.status), [
    "matched",
    "open_variance"
  ]);
  assert.ok(compared.body.rows.every((row) => row.applicationSnapshot && row.manualSnapshot));

  const retained = await getMbtAssetReconciliationBatch(compared.body.batchId);
  assert.deepEqual(retained, compared.body);
  const variance = compared.body.rows.find((row) => row.status === "open_variance");
  assert.ok(variance);
  const resolutionIdentity = `${RUN_ID}-resolution-${++commandSequence}`;
  const resolved = await resolveMbtAssetMovementVariance({
    actor: ACTOR,
    comparisonRowId: variance.comparisonRowId,
    decision: "evidence_only",
    auditNote: "Manual opening record retained as evidence; ledger remains authoritative.",
    idempotencyKey: `p3-asset-resolve-idem-${resolutionIdentity}`,
    correlationId: `p3-asset-resolve-corr-${resolutionIdentity}`,
    requestId: `p3-asset-resolve-req-${resolutionIdentity}`
  });
  assert.equal(resolved.body.status, "evidence_only");

  for (const input of [matchingInput, mismatchInput]) {
    const ledger = await durableAssetEvidence(input.asset.assetCode);
    assert.equal(ledger.rowCount, 1);
    assert.equal(ledger.rows[0].asset_sequence, 1);
    assert.equal(ledger.rows[0].after_status, "available");
    assert.equal(ledger.rows[0].state_revision, 1);
  }
});
