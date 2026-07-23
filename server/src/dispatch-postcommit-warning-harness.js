import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("./server.js", import.meta.url), "utf8");

function sourceSlice(startMarker, endMarker, description = startMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `Expected ${description} source was not found.`);
  return source.slice(start, end);
}

const helperSource = sourceSlice(
  "async function runDispatchPlanPostCommitFollowup",
  "function shippedDispatchCsv",
  "post-commit follow-up helper"
);
const audits = [];
const errors = [];
const runFollowup = Function(
  "writeDispatchAudit",
  "console",
  `"use strict"; ${helperSource}; return runDispatchPlanPostCommitFollowup;`
)(
  async (record) => audits.push(record),
  { error: (...args) => errors.push(args) }
);
const followupWarnings = [];
const result = await runFollowup({
  plan: { id: "plan-1", planDate: "2026-07-22", revision: 7, status: "confirmed" },
  committedAction: "saved",
  stage: "delivery_materialization",
  code: "DISPATCH_PLAN_DELIVERY_MATERIALIZATION_FAILED",
  label: "Delivery order materialization",
  sessionId: "session-1",
  operator: { id: "operator-1", username: "dispatcher" },
  followupWarnings
}, async () => {
  throw new Error("duplicate key value violates unique constraint");
});

assert.equal(result, null, "A post-commit follow-up error must not reject the already committed save.");
assert.equal(followupWarnings.length, 1);
assert.deepEqual(followupWarnings[0], {
  code: "DISPATCH_PLAN_DELIVERY_MATERIALIZATION_FAILED",
  stage: "delivery_materialization",
  step: "delivery_materialization",
  label: "Delivery order materialization",
  message: "duplicate key value violates unique constraint",
  summary: "Delivery order materialization failed after the dispatch plan was saved. The plan itself was saved successfully."
});
assert.equal(errors.length, 1, "The full underlying Error must be logged on the server.");
assert.equal(audits.length, 1, "A durable follow-up failure audit must be attempted.");
assert.equal(audits[0].action, "dispatch_plan_followup_failed");

const saveRoute = sourceSlice(
  'app.put("/api/dispatch/plans/:id"',
  'app.post("/api/dispatch/plans/:id/confirm"',
  "dispatch plan save route"
);
const confirmRoute = sourceSlice(
  'app.post("/api/dispatch/plans/:id/confirm"',
  'app.post("/api/dispatch/plans/:id/reopen"',
  "dispatch plan confirm route"
);

for (const [name, route] of [["save", saveRoute], ["confirm", confirmRoute]]) {
  for (const stage of ["order_dependencies", "co_assignments", "scm_schedule", "delivery_materialization"]) {
    assert.match(route, new RegExp(`stage: "${stage}"`), `The ${name} route must isolate the ${stage} post-commit follow-up.`);
  }
  assert.match(route, /res\.json\(\{ \.\.\.plan, operatorFlags, scmSchedule, followupWarnings }\);/,
    `The ${name} response must report follow-up warnings with HTTP success.`);
}

console.log("Dispatch post-commit warning semantics checks passed.");
