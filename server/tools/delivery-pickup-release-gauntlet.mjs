import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { query, closeDb, withTransaction } from "../src/db.js";
import { packingOrder } from "../test/support/group-underpack-fixture.mjs";

assert.equal(process.env.MBT_TEST_ISOLATED, "1");
assert.match(process.env.DATABASE_URL, /\/mbt_test$/);
const migration = "migrations/306_delivery_pickup_packing_release.sql";
const tests = "test/mbt/integration/delivery-pickup-release.test.js";
const sql = await readFile(migration, "utf8");
const regressions = [
  "test/mbt/integration/customer-pickup-yard-scope.test.js",
  "test/mbt/integration/operator-customer-pickup-photo-gate.red.test.js",
  "test/mbt/integration/group-underpack.test.js"
];
const results = [];
function run(label, args, expected = 0) {
  const result = spawnSync(process.execPath, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 180000 });
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  const summary = output.split("\n").filter(line => /^# (tests|pass|fail|skipped)|^not ok|^Passed|^PASS/.test(line));
  console.log(JSON.stringify({ label, exit: result.status, summary }));
  results.push({ label, exit: result.status, summary });
  if (expected === "fail") {
    assert.equal(result.status, 1, `${label}: mutant did not fail normally\n${output.slice(-4000)}`);
    assert.match(output, /ERR_ASSERTION|Property failed/);
  } else {
    assert.equal(result.status, expected, `${label}\n${output.slice(-6500)}`);
  }
}

function syncShape() {
  const result = spawnSync(process.execPath, ["src/sync-shape-harness.js"], { encoding: "utf8", timeout: 180000 });
  const report = JSON.parse(result.stdout.trim() || result.stderr.trim());
  return { exit: result.status, ok: report.ok, message: report.message, checks: report.checks };
}

async function compareSyncBaseline() {
  await query("DROP TRIGGER release_delivery_packing_on_pickup ON sales_orders");
  const baseline = syncShape();
  await query(sql);
  const candidate = syncShape();
  assert.deepEqual(candidate, baseline, "Sync shape gained a new failure");
  if (baseline.exit !== 0) {
    assert.equal(baseline.message, "Receiving did not use the fixed PO receipt baseline.");
  }
  console.log(JSON.stringify({ label: "sync shape baseline comparison", baseline, candidate, newFailures: 0 }));
}

async function repairRehearsal() {
  await withTransaction(async () => {
    const order = await packingOrder({ packed: 0 });
    await query("UPDATE sales_orders SET sales_order_type='Pick-Up' WHERE netsuite_id=$1", [order.id]);
    await query("UPDATE sales_orders SET operator_status='packed' WHERE netsuite_id=$1", [order.id]);
    await query("UPDATE sales_order_lines SET sync_exception='qty_reduced' WHERE id=$1", [order.lineId]);
    const repair = (await readFile("tools/soa10368-pickup-repair.sql", "utf8")).replaceAll("1064528", String(order.id)).replaceAll("SOA10368", order.ref);
    await withTransaction(async () => {
      await query("UPDATE sales_order_lines SET packed_sales_qty=1 WHERE id=$1", [order.lineId]);
      await assert.rejects(() => withTransaction(() => query(repair)), /new operational work/);
    }, { rollback: true });
    await query(repair);
    assert.equal((await query("SELECT operator_status FROM sales_orders WHERE netsuite_id=$1", [order.id])).rows[0].operator_status, "open");
    assert.equal((await query("SELECT sync_exception FROM sales_order_lines WHERE id=$1", [order.lineId])).rows[0].sync_exception, null);
    assert.equal((await query("SELECT 1 FROM delivery_audit_log WHERE order_id=$1 AND action='delivery.pickup.stale_packing.repair'", [order.id])).rowCount, 1);
  }, { rollback: true });
  console.log("PASS repair rehearsal and new-work rejection; rolled back");
}

const mutants = [
  ["sales-only packing retained", "packed_sales_qty = 0,", "packed_sales_qty = line.packed_sales_qty,"],
  ["completed load erased", "packed_piece_qty = 0, packed_sales_qty = 0,", "packed_piece_qty = 0, packed_sales_qty = 0, loaded_qty = 0,"],
  ["repeat pickup erases draft", "btrim(OLD.sales_order_type) = 'Delivery' AND ", ""],
  ["quantity lock bypassed", "IF NOT pg_try_advisory_xact_lock", "IF false AND NOT pg_try_advisory_xact_lock"],
  ["packed status retained", "NEW.operator_status := CASE WHEN has_loaded AND has_remaining THEN 'partial_loaded' WHEN has_loaded THEN 'loaded' ELSE 'open' END;", "NEW.operator_status := OLD.operator_status;"]
];

try {
  run("lint new test and gauntlet", ["node_modules/eslint/bin/eslint.js", "--config", "eslint.mbt.config.js", "--max-warnings=0", tests, "tools/delivery-pickup-release-gauntlet.mjs"]);
  run("regression and new acceptance suites", ["--test", "--test-concurrency=1", tests, ...regressions]);
  await compareSyncBaseline();
  await repairRehearsal();
  for (const [label, from, to] of mutants) {
    assert.equal(sql.split(from).length, 2, `Non-unique mutant ${label}`);
    await query(sql.replace(from, to));
    run(`mutant: ${label}`, ["--test", "--test-concurrency=1", tests], "fail");
    if (label === "sales-only packing retained" || label === "completed load erased") {
      run(`property-only mutant: ${label}`, ["--test", "--test-name-pattern=random source", tests], "fail");
    }
    await query(sql);
  }
  run("restored acceptance suite", ["--test", "--test-concurrency=1", tests]);
  for (const file of [migration, tests, "tools/soa10368-pickup-repair.sql", "tools/delivery-pickup-release-gauntlet.mjs"]) {
    console.log(JSON.stringify({ file, sha256: createHash("sha256").update(await readFile(file)).digest("hex") }));
  }
  console.log(JSON.stringify({ passed: true, mutantKills: mutants.length, checks: results.length }));
} finally {
  await query(sql);
  await closeDb();
}
