import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { query, withTransaction, closeDb } from "../src/db.js";
import { DISPATCH_FLEET_PLANNING_LOCK } from "../src/dispatch-fleet-status.js";
import { writeDispatchAudit } from "../src/dispatch-audit-repository.js";
import { listDispatchOrders } from "../src/dispatch-repository.js";
import { upsertDispatchOrderCatalog } from "../src/dispatch-order-catalog-repository.js";

const ref = "CO-GOA-7894-7895";
const guard = (condition, message) => assert.ok(condition, `Repair guard: ${message}`);

async function lockedRepairState() {
  await query("SET LOCAL lock_timeout='5s'");
  await query("SET LOCAL statement_timeout='30s'");
  await query("SELECT pg_advisory_xact_lock(hashtext($1))", [DISPATCH_FLEET_PLANNING_LOCK]);
  await query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`dispatch-global-order-definition:${ref.toLowerCase()}`]);
  const co = (await query("SELECT * FROM local_co_orders WHERE co_ref=$1 FOR UPDATE", [ref])).rows[0];
  const group = (await query("SELECT * FROM dispatch_global_order_groups WHERE group_ref=$1 FOR UPDATE", [ref])).rows[0];
  if (!group) { return null; }
  guard(co?.status === "pending_load" && co.source_order_ref === "GOA-7894-7895", "canonical CO is not the recreated pending order");
  guard(group.active === false && group.order_type === "CO", "definition is not a retired CO");
  guard(group.full_order.sourceTable === "local_co_orders", "definition is not a legacy direct CO");
  assert.deepEqual([...(group.full_order.childOrders || [])].sort(), ["SOA07894", "SOA07895"], "Repair guard: aggregate membership changed");
  const events = (await query(`SELECT id,action,created_at FROM dispatch_audit_log
    WHERE order_id=$1 AND action IN ('co_saved_to_local_db','co_cancelled_in_local_db')
    ORDER BY created_at DESC,id DESC LIMIT 1`, [ref])).rows;
  const recreation = events[0];
  guard(recreation?.action === "co_saved_to_local_db" && recreation.created_at > group.updated_at
    && co.updated_at >= recreation.created_at, "no subsequent explicit CO recreation");
  const assignments = await query(`SELECT 1 FROM dispatch_plan_order_assignments
    WHERE lower(order_ref)=lower($1) OR lower(planned_order_ref)=lower($1) LIMIT 1`, [ref]);
  guard(assignments.rowCount === 0, "CO acquired a live assignment; review its current lifecycle");
  const split = await query("SELECT 1 FROM dispatch_global_order_splits WHERE lower(split_ref)=lower($1)", [ref]);
  guard(split.rowCount === 0, "a derived definition also owns the CO reference");
  const members = (await query("SELECT * FROM dispatch_global_order_group_members WHERE group_ref=$1 ORDER BY position FOR UPDATE", [ref])).rows;
  return { co, group, members, recreation };
}

/** Rehearses real writes with rollback by default; only this incident's obsolete metadata is removed. */
export async function repairDispatchRetiredConfirm({ apply = false, expectedFingerprint = "", backupPath = "" } = {}) {
  return withTransaction(async () => {
    const before = await lockedRepairState();
    if (!before) { return { applied: false, alreadyCorrect: true, ref }; }
    const fingerprint = createHash("sha256").update(JSON.stringify(before)).digest("hex");
    if (apply) {
      guard(expectedFingerprint === fingerprint, "state changed; rehearse again");
      guard(Boolean(backupPath), "applying requires a private backup path");
      await fs.mkdir(path.dirname(backupPath), { recursive: true, mode: 0o700 });
      await fs.writeFile(backupPath, JSON.stringify(before), { flag: "wx", mode: 0o600 });
    }
    // The canonical CO and its lines are untouched. The misclassified global
    // group is archived in audit; its dependent membership rows cascade away.
    await query("DELETE FROM dispatch_global_order_groups WHERE group_ref=$1", [ref]);
    await query("DELETE FROM dispatch_order_catalog_entries WHERE lower(order_ref)=lower($1)", [ref]);
    const orders = (await listDispatchOrders({ type: "CO", exactOrderRefs: [ref] })).filter(order => order.id === ref);
    guard(orders.length === 1, "recreated canonical CO is not available in the source feed");
    await upsertDispatchOrderCatalog({ orders, source: "retired-confirmation-repair" });
    await writeDispatchAudit({ action: "dispatch_retired_direct_co_definition_repaired", entityType: "dispatch_order",
      entityId: ref, orderId: ref, source: "retired-confirmation-repair", operatorName: "system:authorized-dispatch-repair",
      before, after: { authority: "local_co_orders", status: before.co.status },
      details: { fingerprint, recreationAuditId: before.recreation.id, backupPath: apply ? backupPath : "rollback rehearsal" } });
    assert.deepEqual((await query("SELECT * FROM local_co_orders WHERE co_ref=$1", [ref])).rows[0], before.co, "Canonical CO changed");
    return { ref, applied: apply, rolledBack: !apply, fingerprint, recreationAuditId: before.recreation.id };
  }, { rollback: !apply });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const value = flag => process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : "";
  try {
    console.log(JSON.stringify(await repairDispatchRetiredConfirm({ apply: process.argv.includes("--apply"),
      expectedFingerprint: value("--fingerprint"), backupPath: value("--backup") })));
  } finally { await closeDb(); }
}
