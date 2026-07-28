import crypto from "node:crypto";
import { applyConfirmedDispatchPlanToDelivery } from "./delivery-repository.js";
import { closeDb, query, withTransaction } from "./db.js";
import { syncScmScheduleFromDispatchPlan } from "./dispatch-repository.js";
import { writeDispatchAudit } from "./dispatch-audit-repository.js";
import {
  confirmDispatchPlan,
  createDispatchPlan,
  dispatchPlannedAssignmentMap,
  dispatchPlannedOrderConflictRefs,
  dispatchPlannedOrderRefs,
  getCurrentDispatchPlan,
  saveDispatchPlanSnapshot
} from "./dispatch-plan-repository.js";
import { translateDriverOrientedDispatchPlan } from "./dispatch-plan-mirror.js";
import { listDispatchDrivers, listDispatchTrucks } from "./dispatch-setup-repository.js";
import { syncOrderDependenciesFromDispatchPlan, validateDispatchPlanDependencies } from "./order-dependency-repository.js";

function argument(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || fallback) : fallback;
}

async function readStandardInput() {
  let value = "";
  for await (const chunk of process.stdin) value += chunk;
  if (!value.trim()) throw new Error("Source plan JSON was not provided on standard input.");
  return JSON.parse(value);
}

function countPlan(plan = {}) {
  const loads = (plan.trucks || []).flatMap((truck) => truck.loads || []);
  return {
    orders: (plan.orders || []).length,
    trucks: (plan.trucks || []).length,
    loads: loads.length,
    stops: loads.reduce((sum, load) => sum + (load.stops || []).length, 0)
  };
}

async function findPlanDateConflicts(plan = {}) {
  const currentRefs = dispatchPlannedOrderRefs(plan);
  if (!currentRefs.size) return [];
  const result = await query(
    `SELECT p.id, p.plan_date::text AS plan_date, p.status, s.orders, s.trucks
       FROM dispatch_plans p
       JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
      WHERE p.status <> 'cancelled'
        AND p.plan_date <> $1::date`,
    [plan.planDate]
  );
  const conflicts = [];
  for (const row of result.rows) {
    const otherPlan = { orders: row.orders || [], trucks: row.trucks || [] };
    for (const ref of dispatchPlannedOrderConflictRefs(plan, otherPlan)) {
      conflicts.push({ orderRef: ref, planId: String(row.id), planDate: row.plan_date });
    }
  }
  return conflicts;
}

function dateCompare(leftValue, rightValue) {
  const left = String(leftValue || "").slice(0, 10);
  const right = String(rightValue || "").slice(0, 10);
  if (!left || !right || left === right) return 0;
  return left < right ? -1 : 1;
}

function timingNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function dropOccurrences(plan = {}, orderRef = "") {
  const occurrences = [];
  for (const truck of plan.trucks || []) {
    for (const load of truck.loads || []) {
      for (const stop of load.stops || []) {
        if (stop?.type === "drop" && String(stop.orderId || "") === String(orderRef || "")) {
          occurrences.push({ truck, load, stop });
        }
      }
    }
  }
  return occurrences;
}

function sourcePickupMinute(occurrence = {}) {
  const orderRef = String(occurrence.stop?.orderId || "");
  const pickup = (occurrence.load?.stops || []).find((stop) =>
    stop?.type === "pick" && String(stop.orderId || "") === orderRef
  );
  return timingNumber(pickup?.timing?.arrival) ?? timingNumber(occurrence.load?.timing?.start);
}

function coFinishMinute(occurrence = {}) {
  return timingNumber(occurrence.load?.timing?.finish) ?? timingNumber(occurrence.stop?.timing?.depart);
}

async function findCoSequenceConflicts(plan = {}) {
  const result = await query(
    `SELECT p.id, p.plan_date::text AS plan_date, s.orders, s.trucks
       FROM dispatch_plans p
       JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
      WHERE p.status <> 'cancelled'`,
    []
  );
  const candidatePlans = [
    plan,
    ...result.rows.map((row) => ({
      id: String(row.id), planDate: row.plan_date, orders: row.orders || [], trucks: row.trucks || []
    }))
  ];
  const coOccurrences = new Map();
  for (const candidate of candidatePlans) {
    const candidateDate = String(candidate.planDate || "").slice(0, 10);
    const coRefs = new Set((candidate.orders || [])
      .filter((order) => order?.type === "CO")
      .map((order) => String(order?.id || ""))
      .filter(Boolean));
    for (const truck of candidate.trucks || []) {
      for (const load of truck.loads || []) {
        for (const stop of load.stops || []) {
          const ref = String(stop?.orderId || "");
          if (stop?.type === "drop" && ref.startsWith("CO-")) coRefs.add(ref);
        }
      }
    }
    for (const coRef of coRefs) {
      const occurrence = dropOccurrences(candidate, coRef)[0];
      if (!occurrence) continue;
      const current = coOccurrences.get(coRef);
      if (!current || dateCompare(candidateDate, current.planDate) < 0) {
        coOccurrences.set(coRef, { planDate: candidateDate, finish: coFinishMinute(occurrence) });
      }
    }
  }

  const conflicts = [];
  for (const order of plan.orders || []) {
    const orderRef = String(order?.id || "");
    const coRef = String(order?.transitCo?.id || "");
    if (!orderRef || !coRef || order?.type === "CO") continue;
    const occurrences = dropOccurrences(plan, orderRef);
    if (!occurrences.length) continue;
    const co = coOccurrences.get(coRef);
    if (!co) {
      conflicts.push({ orderRef, coRef, reason: `${orderRef} requires ${coRef} to be planned first.` });
      continue;
    }
    const comparison = dateCompare(co.planDate, plan.planDate);
    if (comparison > 0) {
      conflicts.push({ orderRef, coRef, reason: `${coRef} is planned after ${orderRef}.` });
      continue;
    }
    if (comparison < 0) continue;
    const pickup = sourcePickupMinute(occurrences[0]);
    if (Number.isFinite(co.finish) && Number.isFinite(pickup) && co.finish > pickup) {
      conflicts.push({ orderRef, coRef, reason: `${coRef} must finish before ${orderRef} pickup.` });
    }
  }
  return conflicts;
}

async function validateTranslatedPlan(plan = {}) {
  const dependencyConflicts = await validateDispatchPlanDependencies(plan);
  const dateConflicts = await findPlanDateConflicts(plan);
  const coConflicts = await findCoSequenceConflicts(plan);
  if (!dependencyConflicts.length && !dateConflicts.length && !coConflicts.length) return;
  const counts = [
    dependencyConflicts.length ? `${dependencyConflicts.length} dependency` : "",
    dateConflicts.length ? `${dateConflicts.length} cross-date` : "",
    coConflicts.length ? `${coConflicts.length} CO-sequence` : ""
  ].filter(Boolean).join(", ");
  const first = dependencyConflicts[0]
    || (dateConflicts[0] ? `${dateConflicts[0].orderRef} is already planned on ${dateConflicts[0].planDate}.` : "")
    || coConflicts[0]?.reason
    || "Destination validation failed.";
  throw new Error(`Translated plan has ${counts} conflict(s): ${first}`);
}

async function mirrorPlan({ sourcePlan, targetDate, apply }) {
  const sourceDigest = crypto.createHash("sha256").update(JSON.stringify({
    id: sourcePlan.id,
    revision: sourcePlan.revision,
    planDate: sourcePlan.planDate,
    status: sourcePlan.status,
    confirmedAt: sourcePlan.confirmedAt,
    orders: sourcePlan.orders,
    trucks: sourcePlan.trucks,
    summary: sourcePlan.summary
  })).digest("hex");
  const destinationDrivers = await listDispatchDrivers();
  const destinationTrucks = await listDispatchTrucks();
  const translated = translateDriverOrientedDispatchPlan({
    sourcePlan,
    destinationDrivers,
    destinationTrucks,
    targetDate
  });
  await validateTranslatedPlan(translated.plan);
  translated.plan.summary.mirrorTranslation.sourceDigestSha256 = sourceDigest;
  translated.plan.summary.mirrorTranslation.sourceStatus = sourcePlan.status;
  translated.plan.summary.mirrorTranslation.sourceConfirmedAt = sourcePlan.confirmedAt || null;

  const transactionResult = await withTransaction(async () => {
    await query("SELECT pg_advisory_xact_lock(hashtext($1))", [`dispatch-plan-mirror:${targetDate}`]);
    // Browser edit leases do not use the advisory lock above. Lock their table
    // briefly so a dispatcher cannot enter Edit Mode during the atomic import.
    await query("LOCK TABLE dispatch_plan_edit_leases IN SHARE ROW EXCLUSIVE MODE");
    const activeLease = await query(
      `SELECT operator_name, expires_at
         FROM dispatch_plan_edit_leases
        WHERE plan_date = $1::date
          AND expires_at > now()
        LIMIT 1`,
      [targetDate]
    );
    if (activeLease.rows[0]) {
      throw new Error(`${activeLease.rows[0].operator_name || "Another dispatcher"} is editing the destination plan until ${activeLease.rows[0].expires_at}.`);
    }
    const existing = await getCurrentDispatchPlan({ planDate: targetDate });
    if (existing?.id) throw new Error(`Destination already has plan ${existing.id} for ${targetDate}.`);
    await validateTranslatedPlan(translated.plan);

    const created = await createDispatchPlan({
      planDate: targetDate,
      note: `Mirrored and translated from localhost:3099 plan ${sourcePlan.id || ""}`,
      status: "draft"
    });
    let saved = await saveDispatchPlanSnapshot(created.id, {
      orders: translated.plan.orders,
      trucks: translated.plan.trucks,
      summary: translated.plan.summary,
      baseRevision: created.revision,
      planDate: targetDate,
      sessionId: `mirror-3099-to-3000-${targetDate}`
    });
    await syncOrderDependenciesFromDispatchPlan(saved);
    const scmSchedule = await syncScmScheduleFromDispatchPlan(saved, {
      updatedBy: `mirror-3099-to-3000-${targetDate}`
    });
    saved = await confirmDispatchPlan(created.id, {
      note: `Mirrored and translated from localhost:3099 plan ${sourcePlan.id || ""}`
    });
    const changedOrderRefs = [...dispatchPlannedAssignmentMap(saved).keys()];
    const operatorFlags = await applyConfirmedDispatchPlanToDelivery(saved, {
      forceOrderRefs: changedOrderRefs
    });
    await writeDispatchAudit({
      action: "dispatch_plan_mirrored_and_translated",
      entityType: "plan",
      entityId: String(saved.id),
      planId: saved.id,
      planDate: targetDate,
      sessionId: `mirror-3099-to-3000-${targetDate}`,
      operatorName: "Codex mirror utility",
      source: "dispatch-plan-mirror",
      details: {
        sourceHost: "localhost:3099",
        sourcePlanId: String(sourcePlan.id || ""),
        sourceRevision: Number(sourcePlan.revision || 0),
        sourceStatus: sourcePlan.status || "",
        sourceConfirmedAt: sourcePlan.confirmedAt || null,
        sourceDigestSha256: sourceDigest,
        translation: translated.report,
        scmSchedule,
        operatorFlags
      }
    });

    const verified = await getCurrentDispatchPlan({ planDate: targetDate });
    const expectedCounts = countPlan(saved);
    const actualCounts = countPlan(verified);
    if (verified?.status !== "confirmed" || JSON.stringify(actualCounts) !== JSON.stringify(expectedCounts)) {
      throw new Error("Destination verification failed inside the mirror transaction.");
    }
    return {
      applied: apply,
      planId: String(verified.id),
      revision: Number(verified.revision || 0),
      status: verified.status,
      counts: actualCounts,
      translation: translated.report,
      scmSchedule,
      operatorFlags
    };
  }, { rollback: !apply });

  return transactionResult;
}

const apply = process.argv.includes("--apply");
const targetDate = argument("--date", "2026-07-22");

try {
  const sourcePlan = await readStandardInput();
  const result = await mirrorPlan({ sourcePlan, targetDate, apply });
  console.log(JSON.stringify({ ok: true, mode: apply ? "applied" : "dry-run-rolled-back", ...result }));
} catch (error) {
  console.error(JSON.stringify({ ok: false, mode: apply ? "apply" : "dry-run", error: error.message }));
  process.exitCode = 1;
} finally {
  await closeDb();
}
