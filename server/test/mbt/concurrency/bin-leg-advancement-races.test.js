import assert from "node:assert/strict";
import test, { after } from "node:test";

import { closeDb, query } from "../../../src/db.js";
import { MbtError } from "../../../src/mbt/errors.js";
import {
  binAssignmentCommand,
  binDispatchPlanDate,
  createBinDispatchFixture,
  durableBinDispatchState,
  enabledBinDispatchBoundary
} from "../support/bin-dispatch-fixtures.js";

const ADVANCE_CLIENTS = 25;

const binDispatch = /** @type {Record<string, Function>} */ (await import(
  "../../../src/mbt/bin-dispatch-service.js"
).catch((error) => {
  if (error?.code !== "ERR_MODULE_NOT_FOUND") {
    throw error;
  }
  return {};
}));

/** @param {string} name */
function requiredOperation(name) {
  const operation = binDispatch[name];
  assert.equal(
    typeof operation,
    "function",
    `P3.8 requires the ${name} safe leg lifecycle operation.`
  );
  return operation;
}

/** @param {Array<() => Promise<unknown>>} operations */
async function releaseTogether(operations) {
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const attempts = operations.map(async (operation) => {
    await gate;
    return operation();
  });
  release();
  return Promise.allSettled(attempts);
}

/** @param {Awaited<ReturnType<typeof createBinDispatchFixture>>} fixture @param {string} label */
function advanceCommand(fixture, label) {
  return {
    actor: { operatorId: `p3-bin-dispatcher-${fixture.suffix}`, roles: ["dispatcher"] },
    contractId: fixture.contractId,
    completedVisitId: fixture.frontVisitId,
    expectedCompletedVisitRevision: 3,
    nextVisitId: fixture.successorVisitId,
    expectedNextVisitRevision: 1,
    planId: fixture.planId,
    expectedPlanRevision: 2,
    reason: `Synthetic BIN leg advancement ${label}`,
    idempotencyKey: `p3-bin-advance-${fixture.suffix}-${label}`,
    correlationId: `p3-bin-advance-corr-${fixture.suffix}-${label}`,
    requestId: `p3-bin-advance-req-${fixture.suffix}-${label}`
  };
}

/** @param {string} date @param {number} days */
function plusCalendarDays(date, days) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/**
 * @param {Awaited<ReturnType<typeof createBinDispatchFixture>>} fixture
 * @param {Function} assignMbtBinFrontLeg
 * @param {string} label
 */
async function assignThenComplete(fixture, assignMbtBinFrontLeg, label) {
  await assignMbtBinFrontLeg(binAssignmentCommand(fixture, label), {
    capability: enabledBinDispatchBoundary
  });
  const completed = await query(
    `UPDATE mbt_service_visits
        SET status = 'completed',
            actual_started_at = $2::timestamptz,
            actual_completed_at = $3::timestamptz,
            revision = revision + 1,
            updated_at = now()
      WHERE service_visit_id = $1
        AND status = 'planned'
      RETURNING revision::int`,
    [
      fixture.frontVisitId,
      `${fixture.planDate}T12:05:00.000Z`,
      `${fixture.planDate}T12:35:00.000Z`
    ]
  );
  assert.equal(completed.rowCount, 1);
  assert.equal(completed.rows[0].revision, 3);
}

/** @param {Record<string, unknown>} state @param {string} visitId */
function assignedVisitStops(state, visitId) {
  return (Array.isArray(state.trucks) ? state.trucks : [])
    .flatMap((truck) => Array.isArray(truck.loads) ? truck.loads : [])
    .flatMap((load) => (Array.isArray(load.stops) ? load.stops : []).map((stop) => ({
      loadId: load.id,
      stop
    })))
    .filter(({ stop }) => stop?.mbt?.visitId === visitId);
}

after(async () => {
  await closeDb();
});

test("P3-F17: twenty-five advancement commands promote the next front leg exactly once and never expose both legs", {
  timeout: 120_000
}, async () => {
  const assignMbtBinFrontLeg = requiredOperation("assignMbtBinFrontLeg");
  const advanceMbtBinContractLeg = requiredOperation("advanceMbtBinContractLeg");
  const listMbtBinFrontLegs = requiredOperation("listMbtBinFrontLegs");
  const fixture = await createBinDispatchFixture({
    label: "advance-race",
    planDate: binDispatchPlanDate(300)
  });
  await assignThenComplete(fixture, assignMbtBinFrontLeg, "advance-race-assignment");

  const outcomes = await releaseTogether(Array.from(
    { length: ADVANCE_CLIENTS },
    (_, index) => () => advanceMbtBinContractLeg(
      advanceCommand(fixture, `competitor-${index}`),
      { capability: enabledBinDispatchBoundary }
    )
  ));
  const winners = outcomes.filter(({ status }) => status === "fulfilled");
  const losers = outcomes.filter(({ status }) => status === "rejected");
  assert.equal(winners.length, 1, JSON.stringify(outcomes));
  assert.equal(losers.length, ADVANCE_CLIENTS - 1, JSON.stringify(outcomes));
  assert.deepEqual([...new Set(losers.map(({ reason }) => reason?.status))], [409]);
  assert.deepEqual([...new Set(losers.map(({ reason }) => reason?.code))], [
    "MBT_BIN_LEG_ADVANCEMENT_CONFLICT"
  ]);
  assert.deepEqual({
    schemaVersion: winners[0].value.body.schemaVersion,
    completedVisitId: winners[0].value.body.completedVisitId,
    nextVisitId: winners[0].value.body.nextVisitId,
    nextStatus: winners[0].value.body.nextStatus,
    refreshCount: winners[0].value.body.poolRefresh.count
  }, {
    schemaVersion: "mbt-bin-contract-advancement-v1",
    completedVisitId: fixture.frontVisitId,
    nextVisitId: fixture.successorVisitId,
    nextStatus: "ready",
    refreshCount: 1
  });

  const visits = await query(
    `SELECT service_visit_id::text, status, revision::int,
            scheduled_start_at, scheduled_end_at
       FROM mbt_service_visits
      WHERE contract_id = $1
      ORDER BY visit_number`,
    [fixture.contractId]
  );
  assert.deepEqual(visits.rows.map((row) => ({
    serviceVisitId: row.service_visit_id,
    status: row.status,
    revision: row.revision,
    scheduledStartAt: row.scheduled_start_at?.toISOString(),
    scheduledEndAt: row.scheduled_end_at?.toISOString()
  })), [
    {
      serviceVisitId: fixture.frontVisitId,
      status: "completed",
      revision: 3,
      scheduledStartAt: `${fixture.planDate}T12:00:00.000Z`,
      scheduledEndAt: `${fixture.planDate}T16:00:00.000Z`
    },
    {
      serviceVisitId: fixture.successorVisitId,
      status: "ready",
      revision: 2,
      scheduledStartAt: `${plusCalendarDays(fixture.planDate, 14)}T12:35:00.000Z`,
      scheduledEndAt: `${plusCalendarDays(fixture.planDate, 14)}T15:35:00.000Z`
    }
  ]);
  const feed = await listMbtBinFrontLegs({
    planDate: plusCalendarDays(fixture.planDate, 14),
    search: fixture.contractNumber,
    limit: 20
  }, { capability: enabledBinDispatchBoundary });
  assert.deepEqual(feed.items.map(({ mbt }) => mbt.visitId), [fixture.successorVisitId]);
  assert.equal(feed.items.some(({ mbt }) => mbt.visitId === fixture.frontVisitId), false);
  const state = await durableBinDispatchState(fixture);
  assert.equal(state.reservations, 0);
  assert.deepEqual(assignedVisitStops(state, fixture.frontVisitId), []);
});

test("P3-F17: simultaneous exact advancement retries replay one refresh and one successor transition", {
  timeout: 120_000
}, async () => {
  const assignMbtBinFrontLeg = requiredOperation("assignMbtBinFrontLeg");
  const advanceMbtBinContractLeg = requiredOperation("advanceMbtBinContractLeg");
  const fixture = await createBinDispatchFixture({
    label: "advance-exact-retry",
    planDate: binDispatchPlanDate(310)
  });
  await assignThenComplete(fixture, assignMbtBinFrontLeg, "advance-exact-assignment");
  const command = advanceCommand(fixture, "shared-exact-retry");
  const outcomes = await releaseTogether(Array.from(
    { length: ADVANCE_CLIENTS },
    () => () => advanceMbtBinContractLeg(structuredClone(command), {
      capability: enabledBinDispatchBoundary
    })
  ));
  assert.equal(outcomes.every(({ status }) => status === "fulfilled"), true, JSON.stringify(outcomes));
  const results = outcomes.map(({ value }) => value);
  assert.equal(results.filter(({ replayed }) => replayed === false).length, 1);
  assert.equal(results.filter(({ replayed }) => replayed === true).length, ADVANCE_CLIENTS - 1);
  for (const result of results.slice(1)) {
    assert.deepEqual(result.body, results[0].body);
  }
  assert.equal(results[0].body.poolRefresh.count, 1);
  const evidence = await query(
    `SELECT
       (SELECT count(*)::int FROM mbt_command_receipts
         WHERE command_name = 'mbt.bin_dispatch.advance'
           AND response_body ->> 'completedVisitId' = $1) AS receipts,
       (SELECT count(*)::int FROM mbt_audit_events
         WHERE action = 'mbt.bin_dispatch.front_leg_advanced'
           AND entity_id = $1) AS audits,
       (SELECT count(*)::int FROM mbt_service_visits
         WHERE contract_id = $2 AND status = 'ready') AS ready_visits`,
    [fixture.frontVisitId, fixture.contractId]
  );
  assert.deepEqual(evidence.rows[0], { receipts: 1, audits: 1, ready_visits: 1 });
});

test("P3-F17: concurrent unstarted moves have one revision winner and never split mandatory stops", {
  timeout: 120_000
}, async () => {
  const assignMbtBinFrontLeg = requiredOperation("assignMbtBinFrontLeg");
  const moveMbtBinFrontLegAssignment = requiredOperation("moveMbtBinFrontLegAssignment");
  const fixture = await createBinDispatchFixture({
    label: "move-race",
    planDate: binDispatchPlanDate(320)
  });
  const assigned = await assignMbtBinFrontLeg(
    binAssignmentCommand(fixture, "move-race-assignment"),
    { capability: enabledBinDispatchBoundary }
  );
  const outcomes = await releaseTogether(fixture.binLoadIds.slice(1, 3).map(
    (toLoadId, index) => () => moveMbtBinFrontLegAssignment({
      actor: { operatorId: `p3-bin-dispatcher-${fixture.suffix}`, roles: ["dispatcher"] },
      planId: fixture.planId,
      planDate: fixture.planDate,
      visitId: fixture.frontVisitId,
      fromLoadId: fixture.binLoadIds[0],
      toLoadId,
      expectedVisitRevision: assigned.body.visitRevision,
      expectedPlanRevision: assigned.body.planRevision,
      reason: `Synthetic concurrent whole-leg move ${index}`,
      idempotencyKey: `p3-bin-move-race-${fixture.suffix}-${index}`,
      correlationId: `p3-bin-move-race-corr-${fixture.suffix}-${index}`,
      requestId: `p3-bin-move-race-req-${fixture.suffix}-${index}`
    }, { capability: enabledBinDispatchBoundary })
  ));
  assert.equal(outcomes.filter(({ status }) => status === "fulfilled").length, 1, JSON.stringify(outcomes));
  const loser = outcomes.find(({ status }) => status === "rejected");
  assert.equal(loser.reason?.status, 409);
  assert.equal(loser.reason?.code, "MBT_BIN_DISPATCH_STALE_REVISION");

  const state = await durableBinDispatchState(fixture);
  const stops = assignedVisitStops(state, fixture.frontVisitId);
  assert.deepEqual(stops.map(({ stop }) => stop.id), fixture.frontStops.map(({ stopId }) => stopId));
  assert.equal(new Set(stops.map(({ loadId }) => loadId)).size, 1);
  assert.equal(state.reservations, 1);
});

test("P3-F17: started work rejects ordinary transfer; audited recovery preserves its prior assignment snapshot", async () => {
  const assignMbtBinFrontLeg = requiredOperation("assignMbtBinFrontLeg");
  const moveMbtBinFrontLegAssignment = requiredOperation("moveMbtBinFrontLegAssignment");
  const recoverMbtBinFrontLegAssignment = requiredOperation("recoverMbtBinFrontLegAssignment");
  const fixture = await createBinDispatchFixture({
    label: "started-recovery",
    planDate: binDispatchPlanDate(330)
  });
  const assigned = await assignMbtBinFrontLeg(
    binAssignmentCommand(fixture, "started-recovery-assignment"),
    { capability: enabledBinDispatchBoundary }
  );
  await query(
    `UPDATE mbt_service_visits
        SET status = 'in_progress', actual_started_at = $2::timestamptz,
            revision = revision + 1, updated_at = now()
      WHERE service_visit_id = $1`,
    [fixture.frontVisitId, `${fixture.planDate}T12:05:00.000Z`]
  );
  const base = {
    actor: { operatorId: `p3-bin-dispatcher-${fixture.suffix}`, roles: ["dispatcher"] },
    planId: fixture.planId,
    planDate: fixture.planDate,
    visitId: fixture.frontVisitId,
    fromLoadId: fixture.binLoadIds[0],
    toLoadId: fixture.binLoadIds[1],
    expectedVisitRevision: 3,
    expectedPlanRevision: assigned.body.planRevision,
    correlationId: `p3-bin-recovery-corr-${fixture.suffix}`,
    requestId: `p3-bin-recovery-req-${fixture.suffix}`
  };
  await assert.rejects(
    () => moveMbtBinFrontLegAssignment({
      ...base,
      reason: "Prohibited ordinary move after start",
      idempotencyKey: `p3-bin-started-move-${fixture.suffix}`
    }, { capability: enabledBinDispatchBoundary }),
    (error) => error instanceof MbtError
      && error.status === 409
      && error.code === "MBT_BIN_LEG_STARTED"
  );
  await assert.rejects(
    () => recoverMbtBinFrontLegAssignment({
      ...base,
      reason: "",
      idempotencyKey: `p3-bin-recovery-no-note-${fixture.suffix}`
    }, { capability: enabledBinDispatchBoundary }),
    (error) => error instanceof MbtError
      && error.status === 400
      && error.code === "MBT_AUDIT_REASON_REQUIRED"
  );

  const recovered = await recoverMbtBinFrontLegAssignment({
    ...base,
    reason: "Dispatcher-approved recovery after physical truck failure",
    idempotencyKey: `p3-bin-recovery-${fixture.suffix}`
  }, { capability: enabledBinDispatchBoundary });
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body.schemaVersion, "mbt-bin-dispatch-recovery-v1");
  assert.deepEqual({
    priorLoadId: recovered.body.priorAssignment.loadId,
    priorVisitRevision: recovered.body.priorAssignment.visitRevision,
    priorStopIds: recovered.body.priorAssignment.stops.map(({ id }) => id),
    currentLoadId: recovered.body.assignment.loadId,
    currentStopIds: recovered.body.assignment.stops.map(({ id }) => id)
  }, {
    priorLoadId: fixture.binLoadIds[0],
    priorVisitRevision: 2,
    priorStopIds: fixture.frontStops.map(({ stopId }) => stopId),
    currentLoadId: fixture.binLoadIds[1],
    currentStopIds: fixture.frontStops.map(({ stopId }) => stopId)
  });
  const storedReceipt = await query(
    `SELECT response_body
       FROM mbt_command_receipts
      WHERE command_name = 'mbt.bin_dispatch.recover'
        AND idempotency_key = $1`,
    [`p3-bin-recovery-${fixture.suffix}`]
  );
  assert.equal(storedReceipt.rowCount, 1);
  assert.deepEqual(storedReceipt.rows[0].response_body, recovered.body);
  const state = await durableBinDispatchState(fixture);
  const stops = assignedVisitStops(state, fixture.frontVisitId);
  assert.equal(new Set(stops.map(({ loadId }) => loadId)).size, 1);
  assert.deepEqual(stops.map(({ stop }) => stop.id), fixture.frontStops.map(({ stopId }) => stopId));
  assert.equal(state.reservations, 1);
});
