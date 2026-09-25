// Run via stdin in the live app. NetSuite calls are reads only. The explicit
// --reconcile flag refreshes the already-identified stale SO through normal sync.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { query, withTransaction, closeDb } from "/app/src/db.js";
import * as repository from "/app/src/order-sync-repository.js";
import { fetchSalesOrderReferenceFromNetSuite, fetchDeliveryOrderDetailsFromNetSuite } from "/app/src/netsuite.js";

const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const id = 994171;
async function local(lock = false) {
  const header = (await query(`SELECT * FROM sales_orders WHERE netsuite_id=$1 ${lock ? "FOR UPDATE" : ""}`, [id])).rows[0];
  const lines = (await query(`SELECT * FROM sales_order_lines WHERE sales_order_id=$1 ORDER BY id ${lock ? "FOR UPDATE" : ""}`, [id])).rows;
  return { header, lines };
}
const operatorFields = row => Object.fromEntries(Object.entries(row).filter(([key]) =>
  /^(?:id$|line_id$|packed_|loaded_|operator_|outbound_operator_|fulfilled_|dispatch_|receiving_status|local_yard_order_status)/u.test(key)));

try {
  if (process.argv.includes("--reconcile")) {
    const observed = await local();
    assert.equal(observed.header.tranid, "SOA08816");
    const header = await fetchSalesOrderReferenceFromNetSuite(id);
    const lines = await fetchDeliveryOrderDetailsFromNetSuite(id);
    assert.equal(Number(header.id), id);
    assert.ok(lines.length > 0 && !lines.some(line => Number(line.line_id) === 4962524));
    const result = await withTransaction(async () => {
      await query("SET LOCAL lock_timeout='5s'");
      const before = await local(true);
      assert.equal(digest(before), digest(observed), "Local order changed during the source read; retry safely");
      // The normal sync's missing-line reconciliation is sufficient here. Do
      // not refresh header parsing timestamps or unrelated NetSuite quantities.
      await repository.markMissingOutboundOrderLines(id, lines.map(line => line.line_id));
      const after = await local();
      assert.deepEqual(operatorFields(after.header), operatorFields(before.header));
      assert.deepEqual(after.lines.map(operatorFields), before.lines.map(operatorFields));
      assert.equal(after.lines.find(line => Number(line.line_id) === 4962524).netsuite_active, false);
      return { orderRef: header.tranid, orderId: id, progressBefore: digest(before.lines.map(operatorFields)), progressAfter: digest(after.lines.map(operatorFields)),
        removedLineRetainedInactive: true };
    });
    console.log(JSON.stringify({ event: "reconciled", ...result }));
  }
  const inbox = (await query(`SELECT DISTINCT ON (record_type,netsuite_order_id) record_type,netsuite_order_id,payload,completed_at
    FROM netsuite_order_webhook_inbox WHERE status='succeeded' AND received_at >= '2026-09-16 15:21:37+00'
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(payload->'lines') line WHERE line->>'orderLine' IS NOT NULL)
    ORDER BY record_type,netsuite_order_id,id DESC`)).rows;
  const verified = [], mismatches = [], counts = {};
  for (const snapshot of inbox) {
    counts[snapshot.record_type] = (counts[snapshot.record_type] || 0) + 1;
    if (snapshot.record_type === "transfer_order") { continue; }
    const table = snapshot.record_type === "purchase_order" ? "purchase_order_lines" : "sales_order_lines";
    const parent = snapshot.record_type === "purchase_order" ? "purchase_order_id" : "sales_order_id";
    const rows = (await query(`SELECT line_id,item_id,netsuite_order_line FROM ${table} WHERE ${parent}=$1`, [snapshot.netsuite_order_id])).rows;
    for (const line of snapshot.payload.lines.filter(candidate => ["InvtPart", "NonInvtPart"].includes(candidate.itemType))) {
      const localLine = rows.find(row => String(row.line_id) === String(line.lineUniqueKey));
      const result = { orderId: snapshot.netsuite_order_id, kind: snapshot.record_type, lineKey: String(line.lineUniqueKey), orderLine: Number(line.orderLine) };
      if (localLine && Number(localLine.item_id) === Number(line.itemId) && Number(localLine.netsuite_order_line) === Number(line.orderLine)) { verified.push(result); }
      else { mismatches.push(result); }
    }
  }
  console.log(JSON.stringify({ event: "webhook_verification", at: new Date().toISOString(), counts, verifiedLines: verified.length,
    mismatches, transferWebhookVerified: false }));
  assert.equal(mismatches.length, 0);
} finally { await closeDb(); }
