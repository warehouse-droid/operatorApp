import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import { query, withTransaction, closeDb } from "../src/db.js";
import { saveDispatchPlanSnapshot } from "../src/dispatch-plan-repository.js";
import { validateDispatchPlanDependencies } from "../src/order-dependency-repository.js";
import { previewScmDependencyMutation } from "../src/scm-dependency-preview-service.js";
import { executeScmDependencyCommand, scmDependencyPayloadHash } from "../src/scm-dependency-command-service.js";

const target = "GOB-118670-118675-119387";
const transfer = "TOB00957";
const refs = ["SOB118670", "SOB118675", "SOB119387", transfer];
const [mode, file] = process.argv.slice(2);
const tables = ["sales_orders", "sales_order_lines", "transfer_orders", "transfer_order_lines", "order_dependencies", "order_dependency_lines", "driver_job_records"];

function affectedPlan(row) {
  const order = row.orders.find((o) => o.id === target);
  if (!order) { return null; }
  const trucks = row.trucks.map((truck) => ({ ...truck, loads: (truck.loads || []).map((load) => ({
    ...load, stops: (load.stops || []).filter((stop) => stop.orderId === target).map((stop) => ({
      ...stop, ...(stop.orderRefs ? { orderRefs: stop.orderRefs.filter((ref) => ref === target) } : {})
    }))
  })).filter((load) => load.stops.some((stop) => stop.type === "drop")) })).filter((truck) => truck.loads.length);
  return trucks.length ? { id: String(row.plan_id), planDate: row.plan_date, status: "draft", revision: Number(row.revision), orders: [order], trucks, summary: {} } : null;
}

async function capture() {
  return withTransaction(async () => {
    await query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    const data = { target, transfer, capturedAt: new Date().toISOString(), window: ["2026-09-01T15:20:00Z", "2026-09-08T15:20:00Z"], tables: {} };
    const reads = [
      ["sales_orders", "SELECT * FROM sales_orders WHERE tranid=ANY($1::text[])", [refs]],
      ["sales_order_lines", "SELECT * FROM sales_order_lines WHERE sales_order_id IN (SELECT netsuite_id FROM sales_orders WHERE tranid=ANY($1::text[]))", [refs]],
      ["transfer_orders", "SELECT * FROM transfer_orders WHERE tranid=$1", [transfer]],
      ["transfer_order_lines", "SELECT * FROM transfer_order_lines WHERE transfer_order_id IN (SELECT netsuite_id FROM transfer_orders WHERE tranid=$1)", [transfer]],
      ["order_dependencies", "SELECT * FROM order_dependencies WHERE transfer_order_ref=$1 AND status<>'cancelled'", [transfer]],
      ["order_dependency_lines", "SELECT * FROM order_dependency_lines WHERE dependency_id IN (SELECT id FROM order_dependencies WHERE transfer_order_ref=$1 AND status<>'cancelled')", [transfer]],
      ["driver_job_records", "SELECT * FROM driver_job_records WHERE order_refs ? $1 ORDER BY id", [transfer]]
    ];
    for (const [table, sql, args] of reads) { data.tables[table] = (await query(sql, args)).rows; }
    data.assignments = (await query(`SELECT a.*,p.status FROM dispatch_plan_order_assignments a JOIN dispatch_plans p ON p.id=a.plan_id WHERE a.order_ref=$1`, [transfer])).rows;
    const history = (await query(`SELECT h.plan_id,h.plan_date::text,h.revision,h.orders,h.trucks FROM dispatch_plan_snapshot_history h
      WHERE h.archived_at >= $1 AND h.archived_at < $2 AND h.orders::text LIKE $3 ORDER BY h.archived_at,h.id`, [...data.window, `%${target}%`])).rows;
    const current = (await query(`SELECT p.id AS plan_id,p.plan_date::text,p.revision,s.orders,s.trucks FROM dispatch_plans p
      JOIN dispatch_plan_snapshots s ON s.plan_id=p.id WHERE p.status<>'cancelled' AND s.orders::text LIKE $1 ORDER BY p.plan_date`, [`%${target}%`])).rows;
    data.plans = [...history, ...current].map(affectedPlan).filter(Boolean);
    return data;
  }, { rollback: true });
}

async function insertRows(table, rows) {
  assert.ok(tables.includes(table));
  for (const original of rows) {
    const row = { ...original };
    if (table === "order_dependencies") { row.proposal_id = null; }
    // Photo blobs and offline foreign keys are not needed to reproduce route
    // completion. Keep timestamps, status, identity and cargo evidence intact.
    if (table === "driver_job_records") {
      row.photo_data_urls = [];
      row.source_offline_event_id = null;
      row.manifest_id = null;
    }
    const columns = Object.keys(row);
    const known = new Set((await query("SELECT column_name FROM information_schema.columns WHERE table_name=$1", [table])).rows.map((r) => r.column_name));
    const selected = columns.filter((column) => known.has(column));
    assert.ok(selected.every((column) => /^[a-z_]+$/u.test(column)));
    await query(`INSERT INTO ${table} (${selected.join(",")}) VALUES (${selected.map((_, i) => `$${i + 1}`).join(",")})`,
      selected.map((column) => typeof row[column] === "object" && row[column] !== null ? JSON.stringify(row[column]) : row[column]));
  }
}

async function seed(data, plan) {
  for (const assignment of data.assignments) {
    await query("INSERT INTO dispatch_plans (id,plan_date,status) VALUES ($1,$2,$3)", [assignment.plan_id, assignment.plan_date, assignment.status]);
    await query(`INSERT INTO dispatch_plan_order_assignments (plan_id,plan_date,order_ref,planned_order_ref,load_id,stop_id,assignment)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`, [assignment.plan_id, assignment.plan_date, assignment.order_ref, assignment.planned_order_ref, assignment.load_id, assignment.stop_id, JSON.stringify(assignment.assignment)]);
  }
  await query("INSERT INTO dispatch_plans (id,plan_date,status,revision) VALUES ($1,$2,'draft',$3)", [plan.id, plan.planDate, plan.revision]);
  await query("INSERT INTO dispatch_plan_snapshots (plan_id,orders,trucks,summary) VALUES ($1,$2::jsonb,$3::jsonb,'{}')", [plan.id, JSON.stringify(plan.orders), JSON.stringify(plan.trucks)]);
  for (const table of tables) { await insertRows(table, data.tables[table]); }
  for (const truck of plan.trucks) {
    const plate = truck.plate || truck.truckPlate;
    await query("INSERT INTO dispatch_trucks (plate,active) SELECT $1,true WHERE NOT EXISTS (SELECT 1 FROM dispatch_trucks WHERE plate=$1)", [plate]);
    for (const load of truck.loads) {
      await query("INSERT INTO dispatch_drivers (name,login,active) SELECT $1,$2,true WHERE NOT EXISTS (SELECT 1 FROM dispatch_drivers WHERE login=$2)", [load.driverName, load.driverLogin]);
    }
  }
}

function cargoWithoutZeroProjections(items) {
  const projectionKeys = ["poAllocatedLayers", "poAllocatedPallets", "poAllocatedPieces", "poAllocatedSalesQty", "poAllocatedSections"];
  return items.map((item) => {
    const cargo = { ...item };
    for (const key of projectionKeys) {
      assert.equal(Number(cargo[key] ?? 0), 0, "Incident must retain zero PO allocation");
      delete cargo[key];
    }
    return cargo;
  });
}

async function replay(data) {
  assert.equal(process.env.MBT_TEST_ISOLATED, "1", "Incident replay may write only the isolated test database");
  assert.ok(data.plans.length > 0);
  const outcomes = [];
  for (const plan of data.plans) {
    await withTransaction(async () => {
      await seed(data, plan);
      assert.deepEqual(await validateDispatchPlanDependencies(plan), []);
      const saved = await saveDispatchPlanSnapshot(plan.id, { ...plan, baseRevision: plan.revision });
      assert.equal(saved.revision, plan.revision + 1);
      assert.equal(saved.planDate, plan.planDate);
      assert.deepEqual(cargoWithoutZeroProjections(saved.orders[0].items), cargoWithoutZeroProjections(plan.orders[0].items));
      const dependencyId = Number(data.tables.order_dependencies[0].id);
      const command = { requestId: crypto.randomUUID(), action: "unlink_to", targetRef: target,
        planId: plan.id, planDate: plan.planDate, expectedPlanRevision: saved.revision, payload: { dependencyId } };
      const before = (await query("SELECT * FROM driver_job_records ORDER BY id")).rows;
      const preview = await previewScmDependencyMutation(command);
      assert.deepEqual(preview.blockers, []);
      command.payloadHash = scmDependencyPayloadHash(command);
      const result = await executeScmDependencyCommand(command);
      assert.equal(result.status, "applied");
      assert.deepEqual((await query("SELECT * FROM driver_job_records ORDER BY id")).rows, before);
      assert.equal(result.plan.orders.some((o) => (o.orderDependencies || []).some((d) => Number(d.id) === dependencyId)), false);
      outcomes.push({ date: plan.planDate, fromRevision: plan.revision, saveRevision: saved.revision, unlinkRevision: result.planRevision });
    }, { rollback: true });
  }
  return { incident: target, historicalAffectedLoadReplays: outcomes.length, executionRecordsPreserved: data.tables.driver_job_records.length, outcomes };
}

try {
  assert.ok(["capture", "replay"].includes(mode));
  if (mode === "capture") {
    const data = await capture();
    fs.writeFileSync(file, JSON.stringify(data), { mode: 0o600, flag: "wx" });
    console.log(JSON.stringify({ captured: true, affectedPlanSnapshots: data.plans.length }));
  } else { console.log(JSON.stringify(await replay(JSON.parse(fs.readFileSync(file, "utf8"))))); }
} finally { await closeDb(); }
