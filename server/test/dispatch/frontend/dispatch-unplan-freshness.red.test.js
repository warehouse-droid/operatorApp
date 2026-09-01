// @ts-check

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const dispatchSource = fs.readFileSync(new URL("../../../public/dispatch.js", import.meta.url), "utf8");
const dispatchPage = fs.readFileSync(new URL("../../../public/dispatch.html", import.meta.url), "utf8");
const planRepositorySource = fs.readFileSync(new URL("../../../src/dispatch-plan-repository.js", import.meta.url), "utf8");

function sourceBetween(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  assert.ok(start >= 0, `Missing source marker: ${startNeedle}`);
  assert.ok(end > start, `Missing source marker after ${startNeedle}: ${endNeedle}`);
  return source.slice(start, end);
}

test("an assignment from the locally edited plan cannot keep a removed order drag-locked", () => {
  const functionSource = sourceBetween(
    dispatchSource,
    "function isOrderPlannedOutsideCurrentPlan",
    "function orderPlannedElsewhereText"
  );
  const context = vm.createContext({
    currentPlan: { id: "771" },
    currentPlanDate: "2026-08-29",
    isOrderAssignedInCurrentPlan: () => false
  });
  vm.runInContext(functionSource, context);

  const staleSamePlan = vm.runInContext(`isOrderPlannedOutsideCurrentPlan({
    id: "POB-UNPLANNED",
    dispatchPlanned: true,
    dispatchPlanId: "771",
    dispatchPlanDate: "2026-08-29"
  })`, context);
  const trulyElsewhere = vm.runInContext(`isOrderPlannedOutsideCurrentPlan({
    id: "POB-OTHER-DATE",
    dispatchPlanned: true,
    dispatchPlanId: "772",
    dispatchPlanDate: "2026-08-30"
  })`, context);
  const legacySameDate = vm.runInContext(`isOrderPlannedOutsideCurrentPlan({
    id: "POB-LEGACY-UNPLANNED",
    dispatchPlanned: true,
    dispatchPlanDate: "2026-08-29"
  })`, context);

  assert.equal(staleSamePlan, false,
    "the local plan graph must win immediately while its save refreshes assignment metadata");
  assert.equal(trulyElsewhere, true,
    "an assignment owned by another plan must remain protected");
  assert.equal(legacySameDate, false,
    "legacy same-day metadata without a plan id must not drag-lock a locally removed order");
});

test("a full plan save commits assignment projections with its snapshot", () => {
  const save = sourceBetween(
    planRepositorySource,
    "export async function saveDispatchPlanSnapshot",
    "export async function restoreDispatchPlanSnapshot"
  );
  const snapshot = save.indexOf("INSERT INTO dispatch_plan_snapshots");
  const projection = save.indexOf("syncDispatchPlannerReadProjections", snapshot);
  const result = save.indexOf("return getDispatchPlan", projection);
  assert.ok(snapshot >= 0 && projection > snapshot && result > projection,
    "planned-assignment projection deletion/insertion must share the save transaction");
});

test("Dispatch requests the unplan-freshness client generation", () => {
  assert.match(dispatchPage, /dispatch\.js\?v=20260830-po-link-co-reconcile-v1/);
});
