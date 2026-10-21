import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { query, withTransaction, closeDb } from "./src/db.js";
import { cancelSalesOrderPoAllocation } from "./src/dispatch-repository.js";
import { writeDispatchAudit } from "./src/dispatch-audit-repository.js";

const ref = "GOA-9948-9949-9998";
const expectedIds = ["259", "260", "261", "262"];
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const apply = process.env.RETIRED_PO_FIX_MODE === "apply";

try {
  const result = await withTransaction(async () => {
    if (!apply) await query("SET TRANSACTION READ ONLY");
    await query("SET LOCAL statement_timeout='20s'");
    await query("SET LOCAL lock_timeout='5s'");
    if (apply) await query("SELECT pg_advisory_xact_lock(hashtext('dispatch_fleet_planning_mutation'))");
    const group = (await query(`SELECT * FROM dispatch_global_order_groups WHERE group_ref=$1${apply ? " FOR UPDATE" : ""}`, [ref])).rows[0];
    assert.ok(group && group.active === false, "The group must still be retired");
    const planned = (await query(`SELECT p.id FROM dispatch_plans p JOIN dispatch_plan_snapshots s ON s.plan_id=p.id
      WHERE p.status<>'cancelled' AND (EXISTS(SELECT 1 FROM jsonb_array_elements(s.orders)o WHERE o->>'id'=$1)
      OR s.trucks::text LIKE '%'||$1||'%')`, [ref])).rows;
    assert.deepEqual(planned, [], "The retired group must remain absent from live plans");
    const before = (await query(`SELECT * FROM dispatch_so_po_allocations WHERE dispatch_target_ref=$1 ORDER BY id${apply ? " FOR UPDATE" : ""}`, [ref])).rows;
    const active = before.filter(row => row.status === "active");
    if (!apply) return { mode: "preview", ref, retired: true, beforeHash: hash(before), before,
      activeIds: active.map(row => row.id), purchaseOrders: [...new Set(active.map(row => row.po_order_ref))] };
    assert.deepEqual(active.map(row => row.id), expectedIds, "Active links changed since diagnosis");
    assert.equal(hash(before), process.env.RETIRED_PO_FIX_HASH, "PO links changed since preview");
    const directory = "/app/data/support-fixes";
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const backup = `${directory}/retired-group-po-links-20261015-${Date.now()}.json`;
    await writeFile(backup, JSON.stringify({ ref, group, before, beforeHash: hash(before) }), { mode: 0o600, flag: "wx" });
    for (const row of active) {
      const cancelled = await cancelSalesOrderPoAllocation(row.id, { cancelledBy: "support-retired-group-po-links-20261015" });
      assert.equal(cancelled.status, "cancelled");
    }
    const after = (await query("SELECT * FROM dispatch_so_po_allocations WHERE dispatch_target_ref=$1 ORDER BY id", [ref])).rows;
    assert.equal(after.filter(row => row.status === "active").length, 0);
    assert.deepEqual(after.map(row => row.id), before.map(row => row.id));
    for (const [index, row] of after.entries()) {
      const unchanged = value => Object.fromEntries(Object.entries(value).filter(([key]) =>
        !["status", "cancelled_by", "cancelled_at", "updated_at"].includes(key)));
      assert.deepEqual(unchanged(row), unchanged(before[index]));
    }
    const audit = await writeDispatchAudit({ action: "support_retired_group_po_links_removed",
      entityType: "dispatch_group", entityId: ref, orderId: ref, planId: group.source_plan_id,
      planDate: "2026-10-15", source: "support", sessionId: "support-retired-group-po-links-20261015",
      before, after, details: { reason: "User requested all PO links removed from the already ungrouped order",
        allocationIds: expectedIds, purchaseOrders: [...new Set(active.map(row => row.po_order_ref))], backup } });
    return { mode: "applied", ref, removedActiveLinks: active.length, remainingActiveLinks: 0,
      allocationIds: expectedIds, purchaseOrders: [...new Set(active.map(row => row.po_order_ref))], backup, auditId: audit.id };
  });
  console.log(JSON.stringify(result));
} finally {
  await closeDb();
}
