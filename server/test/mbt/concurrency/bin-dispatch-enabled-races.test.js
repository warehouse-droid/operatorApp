import assert from "node:assert/strict";
import test, { after } from "node:test";

import { closeDb } from "../../../src/db.js";
import {
  binAssignmentCommand,
  binDispatchPlanDate,
  createBinDispatchFixture,
  durableBinDispatchState,
  enabledBinDispatchBoundary,
  ordinaryDispatchSideEffects
} from "../support/bin-dispatch-fixtures.js";

const RACE_CLIENTS = 50;
const EXACT_RETRY_CLIENTS = 25;

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
    `P3.8 requires the ${name} concurrency-safe BIN Dispatch operation.`
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

after(async () => {
  await closeDb();
});

test("P3-F16: fifty independent assignment commands racing for one front leg and asset yield one complete winner", {
  timeout: 120_000
}, async () => {
  const assignMbtBinFrontLeg = requiredOperation("assignMbtBinFrontLeg");
  const fixture = await createBinDispatchFixture({
    label: "fifty-assignment-race",
    planDate: binDispatchPlanDate(200)
  });
  const ordinaryBefore = await ordinaryDispatchSideEffects();
  const outcomes = await releaseTogether(Array.from(
    { length: RACE_CLIENTS },
    (_, index) => () => assignMbtBinFrontLeg(
      binAssignmentCommand(fixture, `competitor-${index}`, {
        loadId: fixture.binLoadIds[index % fixture.binLoadIds.length]
      }),
      { capability: enabledBinDispatchBoundary }
    )
  ));
  const winners = outcomes.filter(({ status }) => status === "fulfilled");
  const losers = outcomes.filter(({ status }) => status === "rejected");
  assert.equal(winners.length, 1, JSON.stringify(outcomes));
  assert.equal(losers.length, RACE_CLIENTS - 1, JSON.stringify(outcomes));
  assert.deepEqual([...new Set(losers.map(({ reason }) => reason?.status))], [409]);
  assert.deepEqual([...new Set(losers.map(({ reason }) => reason?.code))], [
    "MBT_BIN_LEG_ALREADY_ASSIGNED"
  ]);

  const winner = winners[0].value;
  assert.equal(winner.replayed, false);
  assert.equal(winner.body.schemaVersion, "mbt-bin-dispatch-assignment-v1");
  assert.equal(winner.body.visitId, fixture.frontVisitId);
  assert.deepEqual(winner.body.stops.map(({ id }) => id), fixture.frontStops.map(({ stopId }) => stopId));
  const state = await durableBinDispatchState(fixture);
  assert.deepEqual({
    planRevision: state.plan_revision,
    visitStatus: state.visit_status,
    visitRevision: state.visit_revision,
    reservations: state.reservations,
    receipts: state.receipts,
    audits: state.audits
  }, {
    planRevision: 2,
    visitStatus: "planned",
    visitRevision: 2,
    reservations: 1,
    receipts: 1,
    audits: 1
  });
  const assignedStops = (Array.isArray(state.trucks) ? state.trucks : [])
    .flatMap((truck) => Array.isArray(truck.loads) ? truck.loads : [])
    .flatMap((load) => Array.isArray(load.stops) ? load.stops : [])
    .filter((stop) => stop?.mbt?.visitId === fixture.frontVisitId);
  assert.deepEqual(
    assignedStops.map(({ id }) => id),
    fixture.frontStops.map(({ stopId }) => stopId),
    "the winner materializes exactly one complete mandatory-stop group"
  );
  assert.equal(new Set(assignedStops.map((stop) => stop.mbt.stopGroupId)).size, 1);
  assert.deepEqual(await ordinaryDispatchSideEffects(), ordinaryBefore);
});

test("P3-F16: twenty-five simultaneous exact retries return one durable result and twenty-four replays", {
  timeout: 120_000
}, async () => {
  const assignMbtBinFrontLeg = requiredOperation("assignMbtBinFrontLeg");
  const fixture = await createBinDispatchFixture({
    label: "exact-assignment-retries",
    planDate: binDispatchPlanDate(210)
  });
  const command = binAssignmentCommand(fixture, "shared-exact-retry");
  const outcomes = await releaseTogether(Array.from(
    { length: EXACT_RETRY_CLIENTS },
    () => () => assignMbtBinFrontLeg(structuredClone(command), {
      capability: enabledBinDispatchBoundary
    })
  ));
  assert.equal(outcomes.every(({ status }) => status === "fulfilled"), true, JSON.stringify(outcomes));
  const results = outcomes.map(({ value }) => value);
  assert.equal(results.filter(({ replayed }) => replayed === false).length, 1);
  assert.equal(results.filter(({ replayed }) => replayed === true).length, EXACT_RETRY_CLIENTS - 1);
  for (const result of results.slice(1)) {
    assert.deepEqual(result.body, results[0].body);
  }
  const state = await durableBinDispatchState(fixture);
  assert.deepEqual({
    reservations: state.reservations,
    receipts: state.receipts,
    audits: state.audits,
    planRevision: state.plan_revision,
    visitRevision: state.visit_revision
  }, {
    reservations: 1,
    receipts: 1,
    audits: 1,
    planRevision: 2,
    visitRevision: 2
  });
});
