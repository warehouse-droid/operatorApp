// NetSuite reads only. --apply writes local mappings; --import-missing imports
// previously absent source orders through the existing targeted sync path.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as netsuite from "/app/src/netsuite.js";
import * as repository from "/app/src/order-sync-repository.js";
import { query, withTransaction, closeDb } from "/app/src/db.js";
import { writeAudit } from "/app/src/auth-repository.js";
import { syncTargetedNetSuiteOrder } from "/app/src/targeted-order-sync.js";
import { selectIncompleteNetSuiteOrders, planNetSuiteOrderLineBackfill, readOrderLineBackfillRows,
  applyOrderLineBackfill } from "/app/src/netsuite-order-line-backfill.js";

const apply = process.argv.includes("--apply");
const importMissing = process.argv.includes("--import-missing");
assert.ok(!importMissing || apply, "Importing missing orders requires --apply");
const tables = { SO: ["sales_orders", "sales_order_lines", "sales_order_id", "SalesOrd"],
  PO: ["purchase_orders", "purchase_order_lines", "purchase_order_id", "PurchOrd"],
  TO: ["transfer_orders", "transfer_order_lines", "transfer_order_id", "TrnfrOrd"] };
const emit = value => console.log(JSON.stringify({ at: new Date().toISOString(), ...value }));

async function sourceRows(kind, ids) {
  assert.ok(ids.every(id => Number.isSafeInteger(Number(id)) && Number(id) > 0));
  const rows = await netsuite.suiteqlAll(`SELECT t.id AS order_id,t.type,t.tranid,BUILTIN.DF(t.status) AS status_text,
    tl.uniquekey AS line_id,tl.id AS order_line_number,tl.id AS netsuite_order_line,
    tl.item AS item_id,tl.quantity,tl.location AS location_id,BUILTIN.DF(tl.units) AS unit,
    tl.donotprintline AS do_not_print_line,tl.linesequencenumber AS line_sequence_number
    FROM transaction t JOIN transactionline tl ON tl.transaction=t.id
    WHERE t.type='${tables[kind][3]}' AND t.id IN (${ids.map(Number).join(",")})
      AND tl.item IS NOT NULL AND tl.mainline='F' AND (tl.taxline='F' OR tl.taxline IS NULL)
    ORDER BY t.id,tl.id,tl.uniquekey`);
  const active = rows.filter(row => selectIncompleteNetSuiteOrders([{ ...row, id: row.order_id }]).length === 1);
  if (kind !== "TO") {return active;}
  // Logical transfer identity is scoped to one transaction.
  return ids.flatMap(id => netsuite.mapNetSuiteTransferSourceLines(active.filter(row => Number(row.order_id) === Number(id))));
}

async function localHeaders(kind, ids) {
  return (await query(`SELECT netsuite_id FROM ${tables[kind][0]} WHERE netsuite_id=ANY($1::bigint[])`, [ids])).rows;
}

async function importOrder(order) {
  let headerLocked = false;
  const guardedHeaderUpsert = original => async rows => {
    assert.ok(rows.every(row => Number(row.id) === Number(order.id)), "Import source identity changed");
    if (!headerLocked) {
      // Remote reads have finished. Hold the header lock only for local writes.
      await query(`LOCK TABLE ${tables[order.kind][0]} IN SHARE ROW EXCLUSIVE MODE`);
      if ((await localHeaders(order.kind, [order.id])).length) {
        throw Object.assign(new Error("Order was imported concurrently."), { code: "ORDER_ALREADY_IMPORTED" });
      }
      headerLocked = true;
    }
    return original(rows);
  };
  const dependencies = {
    ...repository,
    // Fresh authoritative discovery already resolved the ID. Do not re-resolve
    // by a potentially duplicated transaction number when importing it.
    findLocalOrder: async () => null,
    findNetSuiteOrder: async () => ({ id: Number(order.id), tranid: order.tranid }),
    fetchSalesOrder: netsuite.fetchSalesOrderReferenceFromNetSuite,
    fetchSalesOrderLines: netsuite.fetchDeliveryOrderDetailsFromNetSuite,
    fetchPurchaseOrder: netsuite.fetchPurchaseOrderReferenceFromNetSuite,
    fetchPurchaseOrderLines: netsuite.fetchPurchaseOrderDetailsFromNetSuite,
    fetchTransferOrder: netsuite.fetchTransferOrderByIdFromNetSuite,
    fetchTransferOrderLines: netsuite.fetchTransferOrderDetailsFromNetSuite,
    writeAudit, emitEvent: (name, data) => emit({ event: "import_event", name, data })
  };
  for (const name of ["upsertSalesOrders", "upsertPurchaseOrders", "upsertOutboundTransferOrders", "upsertInboundTransferOrders"]) {
    dependencies[name] = guardedHeaderUpsert(repository[name]);
  }
  try {return await withTransaction(() => syncTargetedNetSuiteOrder({ orderRef: order.tranid }, dependencies));}
  catch (error) {
    if (error.code === "ORDER_ALREADY_IMPORTED") {return { skipped: "already_imported", id: order.id };}
    throw error;
  }
}

async function progressSnapshot(kind, ids, lock = false) {
  const lower = kind.toLowerCase();
  const [, table, parent] = tables[kind];
  const rows = (await query(`SELECT to_jsonb(l)-'netsuite_order_line'-'netsuite_order_line_synced_at' AS data
    FROM ${table} l WHERE ${parent}=ANY($1::bigint[]) OR ${parent} IN
      (SELECT split_${lower}_id FROM dispatch_scm_${lower}_splits WHERE source_${lower}_id=ANY($1::bigint[]) AND status='active')
    ORDER BY id ${lock ? "FOR UPDATE OF l" : ""}`, [ids])).rows;
  return { rows: rows.length, sha256: createHash("sha256").update(JSON.stringify(rows)).digest("hex") };
}

try {
  const discovered = await netsuite.suiteqlAll(`SELECT t.id,t.type,t.tranid,BUILTIN.DF(t.status) AS status_text
    FROM transaction t WHERE t.type IN ('SalesOrd','PurchOrd','TrnfrOrd')
      AND (UPPER(BUILTIN.DF(t.status)) LIKE '%PENDING%' OR UPPER(BUILTIN.DF(t.status)) LIKE '%PARTIALLY%')
    ORDER BY t.type,t.id`);
  const orders = selectIncompleteNetSuiteOrders(discovered);
  const excluded = discovered.filter(row => String(row.tranid).startsWith("SOT") && /pending|partially/i.test(row.status_text)
    && !/ : Pending Bill(?:ing)?$/u.test(row.status_text));
  emit({ event: "discovery", mode: apply ? "apply" : "dry-run", orders, policyExcluded: excluded });
  const totals = {};
  for (const kind of ["SO", "PO", "TO"]) {
    const selected = orders.filter(order => order.kind === kind);
    const existing = new Set((await localHeaders(kind, selected.map(order => order.id))).map(row => String(row.netsuite_id)));
    const missing = selected.filter(order => !existing.has(String(order.id)));
    emit({ event: "missing_local_orders", kind, orders: missing });
    if (importMissing) {
      for (const order of missing) {emit({ event: "imported", kind, result: await importOrder(order) });}
    }
    const total = { orders: selected.length, missingOrders: importMissing ? 0 : missing.length,
      lines: 0, updated: 0, unchanged: 0, unresolved: 0, conflicts: 0, subtotals: 0, inactiveHistorical: 0 };
    for (let offset = 0; offset < selected.length; offset += 50) {
      const batch = selected.slice(offset, offset + 50);
      const ids = batch.map(order => Number(order.id));
      // Observe local versions before the network read; a newer webhook wins.
      const local = await readOrderLineBackfillRows(kind, ids);
      const remote = await sourceRows(kind, ids);
      const plan = planNetSuiteOrderLineBackfill(local, remote);
      let applied = { updated: [], conflicts: [] };
      if (apply) {
        applied = await withTransaction(async () => {
          const before = await progressSnapshot(kind, ids, true);
          const result = await applyOrderLineBackfill(kind, plan.updates);
          const after = await progressSnapshot(kind, ids);
          assert.deepEqual(after, before, "Backfill changed an operational field");
          emit({ event: "progress_preserved", kind, ids, ...after });
          return result;
        });
      }
      emit({ event: "batch", kind, ids, sourceRows: remote, plan, applied });
      total.lines += local.length;
      total.updated += apply ? applied.updated.length : plan.updates.length;
      total.unchanged += plan.unchanged.length;
      total.unresolved += plan.unresolved.length;
      total.conflicts += applied.conflicts.length;
      total.subtotals += plan.excluded.filter(row => row.reason === "subtotal_not_fulfillable").length;
      total.inactiveHistorical += plan.excluded.filter(row => row.reason === "inactive_historical_line").length;
    }
    totals[kind] = total;
  }
  emit({ event: "summary", mode: apply ? "apply" : "dry-run", totals, policyExcluded: excluded.map(row => row.tranid) });
  if (Object.values(totals).some(total => total.unresolved || total.conflicts || total.missingOrders)) {process.exitCode = 2;}
} finally {await closeDb();}
