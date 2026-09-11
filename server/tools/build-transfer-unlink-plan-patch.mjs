// Apply only the release-scoped edits to the frozen production base. The local
// worktree also contains an unrelated planner-V2 draft which must not ship.
import assert from "node:assert/strict";
import fs from "node:fs";
const file = "/app/src/dispatch-plan-repository.js";
let source = fs.readFileSync(file, "utf8");
for (const [before, after] of [
  ["await sanitizeDispatchPlan({\n        id: String(planId),\n        orders:",
    "await sanitizeDispatchPlan({\n        id: String(planId),\n        planDate: expectedPlanDate,\n        orders:"],
  ["const reconciled = reconcileAuthoritativeDispatchOrderProjection({\n    plan,\n    projectedOrders,",
    "const reconciled = reconcileAuthoritativeDispatchOrderProjection({\n    plan: { ...plan, orders: strippedOrders },\n    projectedOrders,"]
]) {
  assert.equal(source.split(before).length, 2, "Release patch must match exactly once");
  source = source.replace(before, after);
}
fs.writeFileSync(file, source);
