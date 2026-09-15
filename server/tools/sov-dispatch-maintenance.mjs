import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { query, withTransaction, closeDb } from "../src/db.js";
import { fetchSovPendingFulfillmentOrdersFromNetSuite, fetchDeliveryOrderDetailsFromNetSuite, suiteql } from "../src/netsuite.js";
import { isNetSuiteM2mActive } from "../src/netsuite-m2m-runtime.js";
import { upsertSalesOrders, upsertSalesOrderLines, markMissingOutboundOrderLines } from "../src/order-sync-repository.js";
import { listDispatchOrders } from "../src/dispatch-repository.js";
import { upsertDispatchOrderCatalog } from "../src/dispatch-order-catalog-repository.js";
import { repairSovDispatchPlan } from "../src/sov-dispatch-repair.js";
import { withVoyageDispatchYard } from "../src/dispatch-sales-order-locations.js";

const [command, ...args] = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
const apply = args.includes("--apply");
const manifestPath = option("--manifest");
const output = value => process.stdout.write(`${JSON.stringify(value)}\n`);

async function writePrivate(file, value) {
  assert.ok(file, "An output path is required");
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, JSON.stringify(value, null, 2), { flag: "wx", mode: 0o600 });
}

async function readManifest() {
  assert.ok(args.includes("--manifest"), "--manifest is required");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  assert.equal(manifest.version, 1);
  assert.ok(Array.isArray(manifest.orders));
  if (apply) {
    assert.ok(Date.now() - Date.parse(manifest.observedAt) < 15 * 60 * 1000, "Discover again: NetSuite eligibility evidence is over 15 minutes old");
  }
  for (const { header, lines } of manifest.orders) {
    assert.match(header.tranid, /^SOV/iu);
    assert.ok(["B", "D", "E"].includes(header.status));
    assert.equal(Number(header.delivery_method_id), 2);
    assert.ok(Array.isArray(lines));
  }
  return manifest;
}

async function discover() {
  assert.ok(args.includes("--manifest"), "--manifest is required");
  assert.ok(await isNetSuiteM2mActive(), "NetSuite M2M access must be active");
  const headers = await fetchSovPendingFulfillmentOrdersFromNetSuite();
  const unique = new Map();
  for (const header of headers) {
    if (!unique.has(String(header.id)) || Number(header.outbound_location_id) === 4) {
      unique.set(String(header.id), header);
    }
  }
  const orders = [];
  for (const header of unique.values()) {
    orders.push({ header, lines: await fetchDeliveryOrderDetailsFromNetSuite(header.id) });
  }
  const example = (await suiteql(`SELECT t.tranid,t.status,BUILTIN.DF(t.status) AS status_text,
    BUILTIN.DF(t.custbody3) AS delivery_method,tl.mainline,tl.location AS location_id,
    BUILTIN.DF(tl.location) AS location,tl.item
    FROM transaction t JOIN transactionline tl ON tl.transaction=t.id
    WHERE t.type='SalesOrd' AND t.tranid='SOV02222' AND (tl.mainline='T' OR (tl.item IS NOT NULL AND tl.taxline='F'))`)).items || [];
  const manifest = { version: 1, observedAt: new Date().toISOString(), orders, example };
  await writePrivate(manifestPath, manifest);
  output({ command, manifestPath, eligible: orders.map(({ header, lines }) => ({ ref: header.tranid,
    status: header.status, headerLocation: header.outbound_location,
    lineLocations: [...new Set(lines.map(line => `${line.location_id}:${line.location}`))], lines: lines.length })), example });
}

async function refresh() {
  const manifest = await readManifest();
  const result = await withTransaction(async () => {
    let lineCount = 0;
    for (const { header, lines } of manifest.orders) {
      await upsertSalesOrders([header]);
      await upsertSalesOrderLines(header.id, lines);
      await markMissingOutboundOrderLines(header.id, lines.map(line => line.line_id));
      lineCount += lines.length;
    }
    const refs = manifest.orders.map(({ header }) => header.tranid);
    const orders = refs.length ? await listDispatchOrders({ type: "SO", exactOrderRefs: refs }) : [];
    await upsertDispatchOrderCatalog({ orders, source: "sov-dispatch-refresh" });
    return { command, applied: apply, orders: manifest.orders.length, lines: lineCount, catalogOrders: orders.length };
  }, { rollback: !apply });
  output(result);
}

async function repair() {
  const manifest = await readManifest();
  const eligibleOrderRefs = manifest.orders.map(({ header }) => header.tranid);
  const plans = (await query(`SELECT p.id,p.plan_date::text FROM dispatch_plans p
    JOIN dispatch_plan_snapshots s ON s.plan_id=p.id
    WHERE p.status IN ('draft','confirmed') AND s.orders::text ~* 'SOV[0-9]'
    ORDER BY p.plan_date,p.id`)).rows;
  for (const plan of plans) {
    const preview = await repairSovDispatchPlan({ planId: plan.id, eligibleOrderRefs });
    output({ command: "preview", planDate: plan.plan_date, ...preview });
    if (apply && preview.changed) {
      assert.ok(args.includes("--backup-dir"), "--backup-dir is required for a repair");
      const backupPath = path.join(option("--backup-dir"), `plan-${plan.id}-${preview.fingerprint}.json`);
      output(await repairSovDispatchPlan({ planId: plan.id, eligibleOrderRefs, apply: true,
        expectedFingerprint: preview.fingerprint, backupPath }));
    }
  }
}

async function setup() {
  assert.ok(args.includes("--setup"), "--setup is required");
  const setupPath = option("--setup");
  const before = JSON.parse(await fs.readFile(setupPath, "utf8"));
  const after = { ...before, ownYards: withVoyageDispatchYard(before.ownYards) };
  const changed = JSON.stringify(before) !== JSON.stringify(after);
  if (apply && changed) {
    assert.ok(args.includes("--backup-dir"), "--backup-dir is required");
    await writePrivate(path.join(option("--backup-dir"), "dispatch-setup.json"), before);
    const temporary = `${setupPath}.sov-${process.pid}`;
    await fs.writeFile(temporary, JSON.stringify(after, null, 2), { flag: "wx", mode: 0o600 });
    await fs.rename(temporary, setupPath);
  }
  output({ command, applied: apply, changed, ownYards: after.ownYards.map(yard => yard.code) });
}

try {
  assert.ok(["discover", "refresh", "repair", "setup"].includes(command), "Use discover, refresh, repair, or setup");
  await ({ discover, refresh, repair, setup })[command]();
} catch (error) {
  output({ command, error: error.message, code: error.code || "SOV_MAINTENANCE_FAILED" });
  process.exitCode = 1;
} finally {
  await closeDb();
}
