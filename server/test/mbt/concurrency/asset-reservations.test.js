import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before } from "node:test";

import pg from "pg";

import {
  recordAssetMovement,
  releaseAssetReservation,
  reserveAsset
} from "../../../src/mbt/asset-service.js";
import { createAssetFixture } from "../support/asset-fixtures.js";

const { Pool } = pg;
const RACE_CLIENTS = 50;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 60 });
let fixture;

async function mustSucceed(operation) {
  let result;
  await assert.doesNotReject(async () => {
    result = await operation();
  });
  return result;
}

function reservationInput(assetId, visitId, reservationSlot, reservedBy) {
  return {
    assetId,
    contractId: fixture.contractId,
    visitId,
    reservationSlot,
    reservedFrom: "2035-01-01T08:00:00.000Z",
    reservedUntil: "2035-01-01T12:00:00.000Z",
    reservedBy,
    source: "frontdesk",
    actorType: "operator",
    actorId: reservedBy,
    occurredAt: "2035-01-01T07:45:00.000Z"
  };
}

before(async () => {
  const client = await pool.connect();
  try {
    fixture = await createAssetFixture(client, { assetCount: 4, visitCount: 4 });
  } finally {
    client.release();
  }
});

after(async () => {
  await pool.end();
});

test("F07: fifty independent clients racing for one asset yield one winner and deterministic conflicts", async () => {
  const clients = await Promise.all(
    Array.from({ length: RACE_CLIENTS }, () => pool.connect())
  );
  try {
    const backendRows = await Promise.all(
      clients.map((client) => client.query("SELECT pg_backend_pid()::int AS pid"))
    );
    const backendPids = backendRows.map(({ rows }) => rows[0].pid);
    assert.equal(new Set(backendPids).size, RACE_CLIENTS, JSON.stringify(backendPids));

    let startRace = () => {};
    const gate = new Promise((resolve) => {
      startRace = resolve;
    });
    const attempts = clients.map(async (client, index) => {
      await gate;
      try {
        const result = await reserveAsset(
          client,
          reservationInput(
            fixture.assets[0].assetId,
            fixture.visitIds[0],
            "delivery_bin",
            `race-operator-${index}`
          )
        );
        return { ok: true, result };
      } catch (error) {
        return { ok: false, code: error.code, status: error.status };
      }
    });
    startRace();
    const outcomes = await Promise.all(attempts);
    const winners = outcomes.filter(({ ok }) => ok);
    const losers = outcomes.filter(({ ok }) => !ok);

    assert.equal(winners.length, 1, JSON.stringify(outcomes));
    assert.equal(losers.length, RACE_CLIENTS - 1);
    assert.deepEqual([...new Set(losers.map(({ code }) => code))], [
      "MBT_ASSET_RESERVATION_CONFLICT"
    ]);
    assert.deepEqual([...new Set(losers.map(({ status }) => status))], [409]);

    const winner = winners[0].result;
    const evidence = await pool.query(
      `SELECT
         (SELECT count(*)::int
            FROM mbt_bin_asset_reservations
           WHERE asset_id = $1 AND released_at IS NULL) AS active_reservations,
         (SELECT count(*)::int
            FROM mbt_bin_movements
           WHERE asset_id = $1) AS movement_count,
         s.lifecycle_status,
         s.last_movement_id,
         s.revision::int AS revision
         FROM mbt_bin_asset_state s
        WHERE s.asset_id = $1`,
      [fixture.assets[0].assetId]
    );
    assert.deepEqual(evidence.rows[0], {
      active_reservations: 1,
      movement_count: 2,
      lifecycle_status: "reserved",
      last_movement_id: winner.movementId,
      revision: 2
    });
  } finally {
    for (const client of clients) {
      client.release();
    }
  }
});

test("F07: an overlapping reservation for the same visit time slot conflicts without changing its asset", async () => {
  const firstAsset = fixture.assets[1];
  const secondAsset = fixture.assets[2];
  await mustSucceed(() => reserveAsset(
    pool,
    reservationInput(firstAsset.assetId, fixture.visitIds[1], "outgoing_bin", "slot-winner")
  ));
  await assert.rejects(
    () => reserveAsset(pool, {
      ...reservationInput(
        secondAsset.assetId,
        fixture.visitIds[1],
        "outgoing_bin",
        "slot-loser"
      ),
      reservedFrom: "2035-01-01T09:00:00.000Z",
      reservedUntil: "2035-01-01T11:00:00.000Z"
    }),
    (error) => {
      assert.equal(error.code, "MBT_VISIT_RESERVATION_CONFLICT");
      assert.equal(error.status, 409);
      return true;
    }
  );

  const unchanged = await pool.query(
    `SELECT
       (SELECT count(*)::int
          FROM mbt_bin_asset_reservations
         WHERE asset_id = $1) AS reservation_count,
       (SELECT count(*)::int
          FROM mbt_bin_movements
         WHERE asset_id = $1) AS movement_count,
       s.lifecycle_status,
       s.last_movement_id,
       s.revision::int AS revision
       FROM mbt_bin_asset_state s
      WHERE s.asset_id = $1`,
    [secondAsset.assetId]
  );
  assert.deepEqual(unchanged.rows[0], {
    reservation_count: 0,
    movement_count: 1,
    lifecycle_status: "available",
    last_movement_id: secondAsset.initialMovementId,
    revision: 1
  });
});

test("F07: releasing a reservation appends state history and permits a later re-reservation", async () => {
  const asset = fixture.assets[3];
  const first = await mustSucceed(() => reserveAsset(
    pool,
    reservationInput(asset.assetId, fixture.visitIds[2], "delivery_bin", "release-operator")
  ));
  const released = await mustSucceed(() => releaseAssetReservation(pool, {
    reservationId: first.reservationId,
    releasedBy: "release-supervisor",
    releaseReason: "Visit rescheduled",
    source: "frontdesk",
    actorType: "operator",
    actorId: "release-supervisor",
    occurredAt: "2035-01-01T07:50:00.000Z"
  }));
  const second = await mustSucceed(() => reserveAsset(
    pool,
    reservationInput(asset.assetId, fixture.visitIds[3], "delivery_bin", "second-operator")
  ));

  assert.notEqual(first.reservationId, second.reservationId);
  assert.equal(released.reservationId, first.reservationId);
  const evidence = await pool.query(
    `SELECT reservation_id, released_at IS NOT NULL AS released,
            revision::int AS revision
       FROM mbt_bin_asset_reservations
      WHERE asset_id = $1
      ORDER BY reserved_at, reservation_id`,
    [asset.assetId]
  );
  assert.deepEqual(evidence.rows, [
    { reservation_id: first.reservationId, released: true, revision: 2 },
    { reservation_id: second.reservationId, released: false, revision: 1 }
  ]);
  const timeline = await pool.query(
    `SELECT asset_sequence::int AS asset_sequence, movement_type,
            before_status, after_status
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
      after_status: "available"
    },
    {
      asset_sequence: 2,
      movement_type: "reservation_created",
      before_status: "available",
      after_status: "reserved"
    },
    {
      asset_sequence: 3,
      movement_type: "reservation_released",
      before_status: "reserved",
      after_status: "available"
    },
    {
      asset_sequence: 4,
      movement_type: "reservation_created",
      before_status: "available",
      after_status: "reserved"
    }
  ]);
  const state = await pool.query(
    `SELECT lifecycle_status, last_movement_id, revision::int AS revision
       FROM mbt_bin_asset_state
      WHERE asset_id = $1`,
    [asset.assetId]
  );
  assert.deepEqual(state.rows[0], {
    lifecycle_status: "reserved",
    last_movement_id: second.movementId,
    revision: 4
  });
});

// Post-GREEN hardening block. The eight frozen packet assertions across both
// files remain unchanged; these cases cover defensive reservation boundaries.

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

test("F07 hardening: invalid windows, visit mismatches, and unavailable assets fail closed", async () => {
  const local = await createHardeningFixture(7, 7);
  const input = (assetIndex, visitIndex, extras = {}) => ({
    assetId: local.assets[assetIndex].assetId,
    contractId: local.contractId,
    visitId: local.visitIds[visitIndex],
    reservationSlot: "delivery_bin",
    reservedFrom: "2035-04-01T08:00:00.000Z",
    reservedUntil: "2035-04-01T12:00:00.000Z",
    reservedBy: "hardening-operator",
    source: "hardening_test",
    actorType: "operator",
    occurredAt: "2035-04-01T07:45:00.000Z",
    ...extras
  });
  await assertMbtFailure(
    () => reserveAsset(pool, null),
    "MBT_ASSET_INPUT_INVALID",
    400
  );
  await assertMbtFailure(
    () => reserveAsset(pool, input(0, 0, {
      reservedFrom: "2035-04-01T12:00:00.000Z",
      reservedUntil: "2035-04-01T08:00:00.000Z"
    })),
    "MBT_RESERVATION_WINDOW_INVALID",
    400
  );
  await assertMbtFailure(
    () => reserveAsset(pool, input(0, 0, { occurredAt: "not-a-time" })),
    "MBT_ASSET_TIMESTAMP_INVALID",
    400
  );
  await assertMbtFailure(
    () => reserveAsset(pool, input(0, 0, { contractId: crypto.randomUUID() })),
    "MBT_RESERVATION_VISIT_INVALID",
    400
  );
  await assertMbtFailure(
    () => reserveAsset(pool, input(0, 0, { visitId: crypto.randomUUID() })),
    "MBT_RESERVATION_VISIT_INVALID",
    400
  );

  await pool.query(
    `UPDATE mbt_service_visits
        SET status = 'cancelled', cancelled_at = now(), cancellation_reason = 'hardening test'
      WHERE service_visit_id = $1`,
    [local.visitIds[1]]
  );
  await assertMbtFailure(
    () => reserveAsset(pool, input(1, 1)),
    "MBT_RESERVATION_VISIT_CANCELLED",
    409
  );
  await pool.query(
    `UPDATE mbt_service_visits
        SET status = 'completed', actual_started_at = now(), actual_completed_at = now()
      WHERE service_visit_id = $1`,
    [local.visitIds[6]]
  );
  await assertMbtFailure(
    () => reserveAsset(pool, input(6, 6)),
    "MBT_RESERVATION_VISIT_COMPLETED",
    409
  );
  await pool.query(
    "UPDATE mbt_service_visits SET bin_type_id = $2 WHERE service_visit_id = $1",
    [local.visitIds[2], "00000000-0000-4000-8000-000000000014"]
  );
  await assertMbtFailure(
    () => reserveAsset(pool, input(2, 2)),
    "MBT_RESERVATION_BIN_TYPE_CONFLICT",
    409
  );
  await pool.query("UPDATE mbt_bin_assets SET active = false WHERE asset_id = $1", [
    local.assets[3].assetId
  ]);
  await assertMbtFailure(
    () => reserveAsset(pool, input(3, 3)),
    "MBT_ASSET_NOT_AVAILABLE",
    409
  );
  await pool.query("UPDATE mbt_bin_assets SET under_maintenance = true WHERE asset_id = $1", [
    local.assets[4].assetId
  ]);
  await assertMbtFailure(
    () => reserveAsset(pool, input(4, 4)),
    "MBT_ASSET_NOT_AVAILABLE",
    409
  );
  await mustSucceed(() => recordAssetMovement(pool, {
    assetId: local.assets[5].assetId,
    movementType: "held_for_assignment",
    afterStatus: "reserved",
    afterLocation: { kind: "yard", reference: local.yardCode, yardId: local.yardId },
    source: "hardening_test",
    actorType: "operator",
    occurredAt: "2035-04-01T07:40:00.000Z"
  }));
  await assertMbtFailure(
    () => reserveAsset(pool, input(5, 5)),
    "MBT_ASSET_NOT_AVAILABLE",
    409
  );
  const openEnded = await mustSucceed(() => reserveAsset(pool, input(6, 5, {
    reservedFrom: null,
    reservedUntil: null
  })));
  assert.equal(typeof openEnded.reservationId, "string");
});

test("F10: direct reservations reject completed and cancelled service visits", async (t) => {
  const local = await createHardeningFixture(2, 2);
  const terminalStates = [
    { status: "completed", visitId: local.visitIds[0], assetId: local.assets[0].assetId },
    { status: "cancelled", visitId: local.visitIds[1], assetId: local.assets[1].assetId }
  ];

  for (const terminal of terminalStates) {
    await t.test(terminal.status, async () => {
      if (terminal.status === "completed") {
        await pool.query(
          `UPDATE mbt_service_visits
              SET status = 'completed', actual_started_at = now(), actual_completed_at = now()
            WHERE service_visit_id = $1`,
          [terminal.visitId]
        );
      } else {
        await pool.query(
          `UPDATE mbt_service_visits
              SET status = 'cancelled', cancelled_at = now(),
                  cancellation_reason = 'direct reservation terminal test'
            WHERE service_visit_id = $1`,
          [terminal.visitId]
        );
      }

      await assert.rejects(
        () => pool.query(
          `INSERT INTO mbt_bin_asset_reservations (
             reservation_id, asset_id, contract_id, visit_id,
             reservation_slot, reserved_by
           ) VALUES ($1, $2, $3, $4, 'delivery_bin', 'direct-test')`,
          [crypto.randomUUID(), terminal.assetId, local.contractId, terminal.visitId]
        ),
        (error) => error?.code === "55000"
      );
      const retained = await pool.query(
        `SELECT count(*)::int AS reservation_count
           FROM mbt_bin_asset_reservations
          WHERE visit_id = $1`,
        [terminal.visitId]
      );
      assert.deepEqual(retained.rows, [{ reservation_count: 0 }]);
    });
  }
});

test("F07 hardening: release commands reject missing, early, repeated, and incompatible state", async () => {
  const local = await createHardeningFixture(2, 2);
  const reserve = (assetIndex, visitIndex) => reserveAsset(pool, {
    assetId: local.assets[assetIndex].assetId,
    contractId: local.contractId,
    visitId: local.visitIds[visitIndex],
    reservationSlot: "delivery_bin",
    reservedBy: "hardening-operator",
    source: "hardening_test",
    actorType: "operator",
    occurredAt: "2035-05-01T08:00:00.000Z"
  });
  const release = (reservationId, occurredAt) => ({
    reservationId,
    releasedBy: "hardening-supervisor",
    releaseReason: "Hardening release check",
    source: "hardening_test",
    actorType: "operator",
    occurredAt
  });
  await assertMbtFailure(
    () => releaseAssetReservation(pool, {}),
    "MBT_ASSET_INPUT_INVALID",
    400
  );
  await assertMbtFailure(
    () => releaseAssetReservation(pool, release(
      crypto.randomUUID(),
      "2035-05-01T09:00:00.000Z"
    )),
    "MBT_RESERVATION_NOT_FOUND",
    404
  );
  const first = await mustSucceed(() => reserve(0, 0));
  await assertMbtFailure(
    () => releaseAssetReservation(pool, release(
      first.reservationId,
      "2020-01-01T00:00:00.000Z"
    )),
    "MBT_RESERVATION_RELEASE_TIME_INVALID",
    400
  );
  await mustSucceed(() => releaseAssetReservation(pool, release(
    first.reservationId,
    "2035-05-01T09:00:00.000Z"
  )));
  await assertMbtFailure(
    () => releaseAssetReservation(pool, release(
      first.reservationId,
      "2035-05-01T09:05:00.000Z"
    )),
    "MBT_RESERVATION_ALREADY_RELEASED",
    409
  );

  const second = await mustSucceed(() => reserve(1, 1));
  await mustSucceed(() => recordAssetMovement(pool, {
    assetId: local.assets[1].assetId,
    movementType: "loaded_while_reserved",
    afterStatus: "on_truck",
    afterLocation: {
      kind: "truck",
      reference: local.truckPlate,
      truckId: local.truckId
    },
    contractId: local.contractId,
    visitId: local.visitIds[1],
    truckId: local.truckId,
    source: "hardening_test",
    actorType: "operator",
    occurredAt: "2035-05-01T08:30:00.000Z"
  }));
  await assertMbtFailure(
    () => releaseAssetReservation(pool, release(
      second.reservationId,
      "2035-05-01T09:00:00.000Z"
    )),
    "MBT_RESERVATION_RELEASE_CONFLICT",
    409
  );
});

test("F07 hardening: two independent assets racing for one visit slot yield one winner", async () => {
  const local = await createHardeningFixture(2, 1);
  const clients = await Promise.all([pool.connect(), pool.connect()]);
  try {
    const backendRows = await Promise.all(
      clients.map((client) => client.query("SELECT pg_backend_pid()::int AS pid"))
    );
    assert.equal(new Set(backendRows.map(({ rows }) => rows[0].pid)).size, 2);
    let startRace = () => {};
    const gate = new Promise((resolve) => {
      startRace = resolve;
    });
    const outcomesPromise = Promise.all(clients.map(async (client, index) => {
      await gate;
      try {
        const result = await reserveAsset(client, {
          assetId: local.assets[index].assetId,
          contractId: local.contractId,
          visitId: local.visitIds[0],
          reservationSlot: "incoming_bin",
          reservedBy: `slot-racer-${index}`,
          source: "hardening_test",
          actorType: "operator",
          occurredAt: "2035-06-01T08:00:00.000Z"
        });
        return { ok: true, result };
      } catch (error) {
        return { ok: false, code: error.code, status: error.status };
      }
    }));
    startRace();
    const outcomes = await outcomesPromise;
    assert.equal(outcomes.filter(({ ok }) => ok).length, 1, JSON.stringify(outcomes));
    assert.deepEqual(
      outcomes.filter(({ ok }) => !ok).map(({ code, status }) => ({ code, status })),
      [{ code: "MBT_VISIT_RESERVATION_CONFLICT", status: 409 }]
    );
  } finally {
    for (const client of clients) {
      client.release();
    }
  }
});
