// @ts-check

import { query, withTransaction } from "./db.js";
import { writeDispatchAudit } from "./dispatch-audit-repository.js";
import { resolveDispatchSalesTarget } from "./dispatch-order-target-repository.js";
import { projectLinkedDirectShipAllocations } from "./linked-direct-ship-sync-domain.js";

const fields = ["sales_line_id", "transfer_outbound_line_id", "transfer_receiving_line_id", "item_id", "item_name", "unit",
  "allocated_quantity", "pallet_qty", "layer_qty", "section_qty", "piece_qty", "line_role", "dispatch_target_line_key"];
const numericFields = new Set(["allocated_quantity", "pallet_qty", "layer_qty", "section_qty", "piece_qty"]);
/** @param {any} error */
function targetUnavailable(error) {
  return error.code === "DISPATCH_DERIVED_ORDER_RETIRED" || /was not found|has no available Sales Order item lines/.test(error.message);
}
/** @param {any} current */
function activeDirectDependency(current) {
  return current && current.status !== "cancelled" && current.dependency_mode === "direct_to_customer";
}
/** @param {any[]} projected @param {any[]} transfers */
function attachReceivingIdentities(projected,transfers) {
  for (const line of projected) {
    const receiving = transfers.find(source => source.line_stage === "receiving" && String(source.item_id) === String(line.item_id)
      && String(source.unit || "").trim().toUpperCase() === String(line.unit || "").trim().toUpperCase());
    line.transfer_receiving_line_id = receiving?.id ?? line.transfer_receiving_line_id ?? null;
  }
}
/** @param {any[]} targets @param {any[]} sources @param {any[]} existing @param {any[]} others @param {boolean} palletOnly */
function projectAllocations(targets,sources,existing,others,palletOnly) {
  const palletIds = new Set(sources.filter(line => String(line.item_name || "").trim().toUpperCase() === "PALLET")
    .map(line => String(line.item_id)));
  const selected = (/** @type {any} */ id) => !palletOnly || palletIds.has(String(id));
  const projected = projectLinkedDirectShipAllocations({ targetLines: targets.filter(line => selected(line.itemId)),
    sourceLines: sources.filter(line => selected(line.item_id)), existingLines: existing.filter(line => selected(line.item_id)), otherAllocations: others });
  attachReceivingIdentities(projected,sources);
  return [...existing.filter(line => !selected(line.item_id) || line.line_role === "manual_transfer"),...projected];
}
/** @param {any[]} changes @param {any} dependencyId */
async function persistAllocations(changes,dependencyId) {
  for (const line of changes) {
    if (line.id) {
      await query(`UPDATE order_dependency_lines SET ${fields.map((field,index) => `${field}=$${index+2}`).join(",")},updated_at=now() WHERE id=$1`,
        [line.id,...fields.map(field => line[field] ?? null)]);
    } else {
      await query(`INSERT INTO order_dependency_lines(dependency_id,${fields.join(",")})
        VALUES($1,${fields.map((_field,index) => `$${index+2}`).join(",")})`, [dependencyId,...fields.map(field => line[field] ?? null)]);
    }
  }
}
/** @param {any} line */
function snapshot(line) {
  return Object.fromEntries(fields.map(field => [field,numericFields.has(field) ? Number(line[field] || 0) : String(line[field] ?? "")]));
}
/** @param {any} dependency @param {boolean} apply @param {boolean} palletOnly */
async function refreshDependency(dependency,apply,palletOnly) {
  const ref = dependency.dispatch_target_ref || dependency.sales_order_ref;
  if (apply) { await query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`order-dependency:${ref.toLowerCase()}`]); }
  const locking = apply ? " FOR UPDATE" : "";
  const current = (await query(`SELECT * FROM order_dependencies WHERE id=$1${locking}`, [dependency.id])).rows[0];
  if (!activeDirectDependency(current)) { return { dependencyId: dependency.id, changed: false }; }
  if ((current.dispatch_target_ref || current.sales_order_ref) !== ref) {
    throw Object.assign(new Error("The direct-ship target changed during refresh. Retry against its current target."),
      {code:"DIRECT_SHIP_TARGET_CHANGED",status:409});
  }
  let resolved;
  try { resolved = await resolveDispatchSalesTarget({ dispatchTargetRef: ref, planDate: current.planned_date }); }
  catch (error) {
    if (targetUnavailable(error)) {
      return { dependencyId: current.id, changed: false, reason: "target_unavailable", message: /** @type {any} */(error).message };
    }
    throw error;
  }
  const ids = [...new Set(resolved.lines.map(line => line.salesLineId))];
  const sales = (await query(`SELECT id,quantity,loaded_qty FROM sales_order_lines WHERE id=ANY($1::bigint[]) ORDER BY id${locking}`, [ids])).rows;
  const byId = new Map(sales.map((/** @type {any} */ line) => [String(line.id),line]));
  const targetLines = resolved.lines.map((/** @type {any} */ line) => ({ ...line, sourceQuantity: byId.get(String(line.salesLineId))?.quantity,
    loadedQuantity: byId.get(String(line.salesLineId))?.loaded_qty }));
  const existing = (await query(`SELECT * FROM order_dependency_lines WHERE dependency_id=$1 ORDER BY id${locking}`, [current.id])).rows;
  const transfers = (await query(`SELECT * FROM transfer_order_lines WHERE transfer_order_id=$1
    AND COALESCE(netsuite_active,true) ORDER BY id`, [current.transfer_order_id])).rows;
  const others = (await query(`SELECT dl.sales_line_id,dl.allocated_quantity,dl.dispatch_target_line_key
    FROM order_dependency_lines dl JOIN order_dependencies d ON d.id=dl.dependency_id
    WHERE dl.sales_line_id=ANY($1::bigint[]) AND d.id<>$2 AND d.status<>'cancelled'
    UNION ALL SELECT sales_line_id,allocated_sales_qty,dispatch_target_line_key FROM dispatch_so_po_allocations
      WHERE sales_line_id=ANY($1::bigint[]) AND status='active'`, [ids,current.id])).rows;
  const projected = projectAllocations(targetLines,transfers,existing,others,palletOnly);
  const changes = projected.filter(line => {
    const before = existing.find((/** @type {any} */ old) => String(old.id) === String(line.id));
    return !before || JSON.stringify(snapshot(before)) !== JSON.stringify(snapshot(line));
  });
  if (apply) { await persistAllocations(changes,current.id); }
  if (apply && changes.length) {
    await query("UPDATE order_dependencies SET updated_at=now() WHERE id=$1", [current.id]);
    await writeDispatchAudit({ action: "netsuite.direct_ship.quantities_reconciled", entityType: "order_dependency", entityId: String(current.id),
      orderId: ref, source: "netsuite_sync", before: existing.map(snapshot), after: projected.map(snapshot),
      details: { transferOrderRef: current.transfer_order_ref, changedLines: changes.length,
        preservedExecutionHistory: true, matchingBasis: "item_and_unit" } });
  }
  return { dependencyId: current.id, transferOrderRef: current.transfer_order_ref, targetRef: ref,
    changed: changes.length > 0, changedLines: changes.length, applied: apply,
    before: existing.map(snapshot), after: projected.map(snapshot) };
}

/** @param {{transferOrderId?: number, salesOrderId?: number, apply?: boolean, palletOnly?: boolean}} input @returns {Promise<Record<string, any>[]>} */
export async function reconcileLinkedDirectShipQuantities({ transferOrderId = 0, salesOrderId = 0, apply = true, palletOnly = false }) {
  return withTransaction(async () => {
    const dependencies = (await query(`SELECT d.* FROM order_dependencies d
      WHERE d.dependency_mode='direct_to_customer' AND d.status<>'cancelled' AND (
        d.transfer_order_id=$1 OR d.sales_order_id=$2
        OR EXISTS(SELECT 1 FROM order_dependency_lines dl JOIN sales_order_lines sl ON sl.id=dl.sales_line_id
          WHERE dl.dependency_id=d.id AND sl.sales_order_id=$2)
        OR EXISTS(SELECT 1 FROM dispatch_delivery_group_members m JOIN sales_orders so ON so.tranid=m.member_order_ref
          WHERE m.group_ref=d.dispatch_target_ref AND so.netsuite_id=$2))
      ORDER BY COALESCE(d.dispatch_target_ref,d.sales_order_ref),d.id`, [transferOrderId,salesOrderId])).rows;
    const results = [];
    for (const dependency of dependencies) { results.push(await refreshDependency(dependency,apply,palletOnly)); }
    return results;
  });
}
