import crypto from "node:crypto";
import { query } from "../../../src/db.js";
import { persistedDispatchPlan } from "../../../src/dispatch-plan-fence.js";
import { acquireDispatchPlanEditLease } from "../../../src/dispatch-plan-lease-repository.js";
import { createBinDispatchFixture, binDispatchPlanDate, binAssignmentCommand, enabledBinDispatchBoundary }
  from "./bin-dispatch-fixtures.js";
import { runMbtBinPlanningCommand } from "../../../src/mbt/bin-planning-service.js";

export const boundary = { capability: enabledBinDispatchBoundary };
export async function storedPlan(id) {
  const { rows } = await query(`SELECT p.*, s.orders,s.trucks,s.summary,s.saved_at FROM dispatch_plans p
    JOIN dispatch_plan_snapshots s ON s.plan_id=p.id WHERE p.id=$1`, [id]);
  return persistedDispatchPlan(rows[0]);
}
export async function planningFixture(offset = 0, options = {}) {
  const f = await createBinDispatchFixture({ label: "mbt-planning", planDate: options.planDate || binDispatchPlanDate(offset), includePilotScope: false });
  const actorId = `planner-${f.suffix}`;
  await query(`INSERT INTO operators (id,username,display_name,password_hash,password_salt,role,roles)
    VALUES ($1,$1,'BIN planner','test-hash','test-salt','dispatcher',ARRAY['dispatcher'])`, [actorId]);
  const input = { planDate: f.planDate, operatorId: actorId, operatorName: "BIN planner", sessionId: crypto.randomUUID() };
  const lease = await acquireDispatchPlanEditLease(input);
  const p = await storedPlan(f.planId);
  p.trucks[0].loads.forEach((load, index) => Object.assign(load, {
    plannedStartMinute: 420 + index * 120, plannedFinishMinute: 480 + index * 120,
    startMode: "fixed", startTime: `${String(7 + index * 2).padStart(2, "0")}:00`, switchYard: "12441"
  }));
  await query("UPDATE dispatch_plan_snapshots SET trucks=$2::jsonb WHERE plan_id=$1", [f.planId, JSON.stringify(p.trucks)]);
  return { ...f, actor: { operatorId: actorId, roles: ["dispatcher"] }, editLease: { ...input, token: lease.token } };
}
export async function command(f, action, overrides = {}) {
  const plan = await storedPlan(f.planId);
  const visit = await query("SELECT revision::int FROM mbt_service_visits WHERE service_visit_id=$1", [f.frontVisitId]);
  return { ...binAssignmentCommand(f, crypto.randomUUID()), actor: f.actor,
    action, editLease: f.editLease, baseRevision: plan.revision, baseDigest: plan.digest,
    expectedPlanRevision: plan.revision, expectedVisitRevision: visit.rows[0].revision,
    ...overrides };
}
export async function run(f, action, overrides = {}) {
  return runMbtBinPlanningCommand(await command(f, action, overrides), boundary);
}
