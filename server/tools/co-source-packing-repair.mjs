import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { query, withTransaction, closeDb } from "../src/db.js";
import { withCoSourcePackingHandoff } from "../src/co-source-packing-handoff.js";
import { getDeliveryOrder } from "../src/delivery-repository.js";

const [mode, manifestPath] = process.argv.slice(2);
assert.ok(["preview", "apply", "verify"].includes(mode), "Choose preview, apply or verify");
assert.ok(manifestPath, "A private repair manifest path is required");
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const packFields = ["packed_pallet_qty", "packed_layer_qty", "packed_section_qty", "packed_piece_qty", "packed_sales_qty"];
const progress = line => Boolean(line.confirmed || line.confirmed_at || packFields.some(key => Number(line[key] || 0) > 0));
const omit = (value, keys) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));

async function snapshot() {
  const state = {};
  for (const [key, sql] of [
    ["source", "SELECT * FROM sales_orders WHERE tranid='SOA08838'"],
    ["sourceLines", "SELECT * FROM sales_order_lines WHERE sales_order_id=995146 ORDER BY id"],
    ["co", "SELECT * FROM local_co_orders WHERE co_ref='CO-SOA08838'"],
    ["coLines", "SELECT * FROM local_co_order_lines WHERE co_id=(SELECT id FROM local_co_orders WHERE co_ref='CO-SOA08838') ORDER BY id"],
    ["transfer", "SELECT * FROM transfer_orders WHERE tranid='TOB01102'"],
    ["transferLines", "SELECT * FROM transfer_order_lines WHERE transfer_order_id=995267 ORDER BY id"],
    ["dependencies", "SELECT * FROM order_dependencies WHERE sales_order_ref='SOA08838' ORDER BY id"],
    ["allocations", "SELECT l.* FROM order_dependency_lines l JOIN order_dependencies d ON d.id=l.dependency_id WHERE d.sales_order_ref='SOA08838' ORDER BY l.id"],
    ["plans", "SELECT p.id,p.revision,s.orders,s.trucks FROM dispatch_plans p JOIN dispatch_plan_snapshots s ON s.plan_id=p.id WHERE p.id IN (328,329) ORDER BY p.id"]
  ]) {state[key] = (await query(sql)).rows;}
  return JSON.parse(JSON.stringify(state));
}

function validate(before, after) {
  for (const key of ["co", "coLines", "transfer", "transferLines", "dependencies", "allocations", "plans"]) {
    assert.deepEqual(after[key], before[key], `${key} must stay unchanged`);
  }
  assert.equal(before.source[0].netsuite_id, "995146");
  assert.deepEqual(omit(after.source[0], ["operator_status", "preparing_operator_id", "preparing_started_at", "status_updated_at"]),
    omit(before.source[0], ["operator_status", "preparing_operator_id", "preparing_started_at", "status_updated_at"]));
  assert.equal(after.source[0].operator_status, "open");
  assert.equal(after.source[0].preparing_operator_id, null);
  assert.equal(after.source[0].preparing_started_at, null);
  assert.equal(after.sourceLines.length, before.sourceLines.length);
  for (const line of before.sourceLines) {
    const current = after.sourceLines.find(row => row.id === line.id);
    if (!progress(line)) {assert.deepEqual(current, line); continue;}
    assert.deepEqual(omit(current, [...packFields, "confirmed", "confirmed_at"]), omit(line, [...packFields, "confirmed", "confirmed_at"]));
    for (const key of packFields) {assert.equal(Number(current[key]), 0);}
    assert.equal(current.confirmed, false);
    assert.equal(current.confirmed_at, null);
  }
}

try {
  if (mode === "verify") {
    const saved = JSON.parse(await readFile(manifestPath, "utf8"));
    const current = await snapshot();
    validate(saved.before, current);
    const operatorCo = await getDeliveryOrder("CO-SOA08838");
    assert.equal(operatorCo.order_type, "co_order");
    assert.equal(operatorCo.lines.length, saved.before.coLines.length);
    for (const prior of saved.before.coLines) {
      const line = operatorCo.lines.find(row => String(row.id) === String(prior.id));
      assert.ok(line);
      assert.equal(Number(line.quantity), Number(prior.quantity));
      for (const field of packFields.slice(0, 4)) {assert.equal(Number(line[field]), Number(prior[field]));}
    }
    console.log(JSON.stringify({ verified: true, releasedLines: saved.before.sourceLines.filter(progress).length,
      coPackingPreserved: true, operatorCoLines: operatorCo.lines.length, transferLinkPreserved: true, plansPreserved: true }));
  } else {
    const expected = mode === "apply" ? JSON.parse(await readFile(manifestPath, "utf8")) : null;
    let before;
    let after;
    await withTransaction(async () => {
      await withCoSourcePackingHandoff({ coRef: "CO-SOA08838", sourceOrderRef: "SOA08838", fromYard: "150",
        requestedBy: "codex:co-source-packing-handoff" }, async () => {
        before = await snapshot();
        const co = before.co[0];
        assert.equal(co.source_order_ref, "SOA08838");
        assert.equal(co.from_location, "150");
        assert.equal(co.to_location, "3445");
        assert.ok(["pending_load", "preparing", "packed"].includes(co.status));
        assert.equal(co.loaded_at, null);
        assert.equal(co.received_at, null);
        assert.deepEqual(co.details?.childOrderIds || [], []);
        if (expected) {assert.equal(hash(before), expected.beforeHash, "Order state changed since preview; prepare a new preview");}
        return co;
      });
      after = await snapshot();
      validate(before, after);
    }, { rollback: mode === "preview" });
    const report = { mode, salesOrder: "SOA08838", coOrder: "CO-SOA08838",
      releasedLines: before.sourceLines.filter(progress).length,
      coPackedLinesPreserved: before.coLines.filter(progress).length,
      transferLinkPreserved: true, plansPreserved: true };
    if (mode === "preview") {
      assert.equal(hash(await snapshot()), hash(before), "Preview must roll back all packing changes");
      await writeFile(manifestPath, JSON.stringify({ beforeHash: hash(before), before, report }, null, 2), { mode: 0o600 });
    }
    console.log(JSON.stringify(report));
  }
} finally {await closeDb();}
