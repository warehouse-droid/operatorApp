// Run via: docker exec -i <app> node --input-type=module - [--apply] < this-file
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeDb, query, withTransaction } from "./src/db.js";
import { updateDispatchOrderDetails } from "./src/dispatch-repository.js";
import { writeDispatchAudit } from "./src/dispatch-audit-repository.js";
import { getDispatchPlan } from "./src/dispatch-plan-repository.js";
import { DISPATCH_FLEET_PLANNING_LOCK } from "./src/dispatch-fleet-status.js";

const mossbrook = "94 Mossbrook Crescent, Scarborough, ON M1W 2W9";
const heatherside = "76 Heatherside Dr, Scarborough, ON M1W 1T7";
const targets = new Map([["SOA08748-S1", mossbrook], ["SOA08748-S2", heatherside]]);
const snapshotHash = row => createHash("sha256").update(JSON.stringify(row)).digest("hex");
try {
  const result = await withTransaction(async () => {
    await query("SELECT pg_advisory_xact_lock(hashtext($1))", [DISPATCH_FLEET_PLANNING_LOCK]);
    const plan = (await query(`SELECT p.id,p.plan_date::text,p.revision,s.orders,s.trucks FROM dispatch_plans p
      JOIN dispatch_plan_snapshots s ON s.plan_id=p.id WHERE p.id=327 FOR UPDATE OF p`)).rows[0];
    assert.equal(plan.plan_date, "2026-09-15");
    assert.equal(Number(plan.revision), 45, "Recheck the current plan if dispatch has edited it.");
    const before = (await query(`SELECT split_ref,full_order FROM dispatch_global_order_splits
      WHERE split_ref=ANY($1::text[]) AND active=true ORDER BY split_ref FOR UPDATE`, [[...targets.keys()]])).rows;
    assert.equal(before.length, 2);
    for (const row of before) {
      assert.equal(row.full_order.originalOrderId, "SOA08748");
      assert.ok([mossbrook, targets.get(row.split_ref)].includes(row.full_order.address));
    }
    const completed = await query(`SELECT id FROM driver_job_records WHERE plan_id=327
      AND status IN ('in_progress','complete') AND stop_type IN ('drop','dropoff','delivery')
      AND (order_refs::text LIKE '%SOA08748-S1%' OR order_refs::text LIKE '%SOA08748-S2%')`);
    assert.equal(completed.rowCount, 0, "Do not alter an already executing delivery destination.");
    const beforeSnapshotHash = snapshotHash(plan);
    if (!process.argv.includes("--apply")) return { dryRun: true,
      orders: before.map(row => ({ id: row.split_ref, before: row.full_order.address, after: targets.get(row.split_ref) })),
      planRevision: plan.revision, snapshotHash: beforeSnapshotHash };
    const updates = [];
    for (const { split_ref: target, full_order: order } of before) {
      const address = targets.get(target);
      const updated = await updateDispatchOrderDetails(target, { type: "SO", sourceTable: "sales_orders",
        address, pickupAddress: order.pickupAddressOverride || "",
        expectedDeliveryDate: order.expectedDeliveryDate || "", windowStart: order.windowStart || "", windowEnd: order.windowEnd || "" });
      const audit = await writeDispatchAudit({ action: "dispatch_info_updated", entityType: "order", entityId: target,
        orderId: target, planId: 327, planDate: plan.plan_date, source: "support-fix",
        before: { address: order.address, dispatchDetailsOverride: order.dispatchDetailsOverride || null }, after: updated,
        details: { type: "SO", sourceTable: "sales_orders", address,
          reason: "Persist the split destinations confirmed by the user; S2 override is also recorded in load-drop audits 21192 and 21198." } });
      updates.push({ target, address: updated.dispatch_address, auditId: audit.id });
    }
    const projected = await getDispatchPlan(327);
    for (const [ref, address] of [["SOA08751", mossbrook], ...targets]) {
      const current = projected.orders.find(order => order.id === ref);
      assert.equal(current?.destinationAddress, address, ref);
    }
    const after = (await query(`SELECT p.id,p.plan_date::text,p.revision,s.orders,s.trucks FROM dispatch_plans p
      JOIN dispatch_plan_snapshots s ON s.plan_id=p.id WHERE p.id=327`)).rows[0];
    assert.equal(snapshotHash(after), beforeSnapshotHash, "The correction must not rewrite route snapshots.");
    return { applied: true, updates,
      planRevision: plan.revision, snapshotUnchanged: true };
  });
  console.log(JSON.stringify(result));
} finally { await closeDb(); }
