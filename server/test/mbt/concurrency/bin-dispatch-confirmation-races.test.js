// @ts-check

import assert from "node:assert/strict";
import test, { after } from "node:test";

import { closeDb, query } from "../../../src/db.js";
import {
  binAssignmentCommand,
  binDispatchPlanDate,
  createBinDispatchFixture,
  enabledBinDispatchBoundary
} from "../support/bin-dispatch-fixtures.js";

const binDispatch = /** @type {Record<string, Function>} */ (await import(
  "../../../src/mbt/bin-dispatch-service.js"
));
const CONFIRM_CLIENTS = 25;

/** @param {string} name */
function requiredOperation(name) {
  const operation = binDispatch[name];
  assert.equal(typeof operation, "function", `P3.11 requires concurrency-safe ${name}.`);
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

test("P3.11 confirmation race: twenty-five authorized retries produce one confirmed revision and one Driver projection", {
  timeout: 120_000
}, async () => {
  const assign = requiredOperation("assignMbtBinFrontLeg");
  const confirm = requiredOperation("confirmMbtBinDispatchPlan");
  const fixture = await createBinDispatchFixture({
    label: "confirm-race",
    planDate: binDispatchPlanDate(900)
  });
  await assign(binAssignmentCommand(fixture, "confirm-race"), {
    capability: enabledBinDispatchBoundary
  });
  const outcomes = await releaseTogether(Array.from({ length: CONFIRM_CLIENTS }, (_, index) => () => confirm({
    actor: { operatorId: `p311-confirm-racer-${index}`, roles: ["dispatcher"] },
    planId: fixture.planId,
    note: "P3.11 concurrent confirmation retry"
  }, { capability: enabledBinDispatchBoundary })));
  assert.equal(outcomes.every(({ status }) => status === "fulfilled"), true, JSON.stringify(outcomes));
  assert.deepEqual([...new Set(outcomes.map(({ value }) => Number(value.revision)))], [3]);
  const state = await query(
    `SELECT plan.status, plan.revision::int,
            (SELECT count(*)::int FROM dispatch_plan_load_assignments assignment
              WHERE assignment.plan_id = plan.id) AS load_assignments
       FROM dispatch_plans plan WHERE plan.id = $1`,
    [fixture.planId]
  );
  assert.deepEqual(state.rows[0], { status: "confirmed", revision: 3, load_assignments: 4 });
});
