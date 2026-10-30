// Re-save every retained Dispatch plan state through the current save path in a
// rolled-back transaction. Unlike dispatch-all-history-replay.mjs this records
// every outcome instead of stopping at the first failure, so a baseline run and
// a candidate run can be compared state by state.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { query, withTransaction, closeDb } from "../src/db.js";
import { persistedDispatchPlan } from "../src/dispatch-plan-fence.js";
import { dispatchPlannedAssignmentMap } from "../src/dispatch-plan-repository.js";
import {
  applyDispatchV2Command,
  getDispatchV2Bootstrap,
  syncDispatchPlanOrderAssignments
} from "../src/dispatch-planner-v2-repository.js";
import { historicalReplayDraftReason, historicalReplayFixtureReason } from "./dispatch-all-history-fixture-classification.mjs";
import { hydrateHistoricalDispatchPlanOrders } from "../src/dispatch-historical-order-snapshots.js";
import { applyConfirmedDispatchPlanToDelivery } from "../src/delivery-repository.js";

const output = process.env.DISPATCH_HISTORY_OUTPUT || "test-artifacts/history-replay";
const label = process.env.DISPATCH_HISTORY_LABEL || "candidate";
const from = process.env.DISPATCH_HISTORY_FROM || "2026-08-01";
const through = process.env.DISPATCH_HISTORY_THROUGH || "2999-12-31";
const limit = Number(process.env.DISPATCH_HISTORY_LIMIT || 0);
// Delivery-only mode replays just the confirmed-plan Operator step on the stored state.
const deliveryOnly = process.env.DISPATCH_HISTORY_DELIVERY_ONLY === "1";
const resultsPath = `${output}/${label}.ndjson`;

const hash = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);

function assignedCargo(plan) {
  const refs = new Set(dispatchPlannedAssignmentMap(plan).keys());
  const cards = new Map();
  const visit = (order) => {
    const key = String(order.id || "").toLowerCase();
    if (!cards.has(key)) cards.set(key, order);
    for (const child of order.childOrderDetails || []) visit(child);
  };
  for (const order of plan.orders || []) visit(order);
  return [...refs].sort().map((ref) => {
    const order = cards.get(ref.toLowerCase());
    return [ref, order ? {
      pallets: Number(order.pallets || 0), layers: Number(order.layers || 0),
      sections: Number(order.sections || 0), pieces: Number(order.pieces || 0), salesQty: Number(order.salesQty || 0),
      items: (order.items || []).map((item) => [String(item.itemId || item.item_id || item.sku || ""),
        ...["pallets", "layers", "sections", "pieces", "quantity"].map((field) => Number(item[field] || 0))])
    } : null];
  });
}

// Route shape the save produced: stop order, kind, place and allocated refs.
function routeFingerprint(trucks = []) {
  return hash((trucks || []).map((truck) => (truck.loads || []).map((load) => [String(load.id || ""),
    (load.stops || []).map((stop) => [stop.type, String(stop.orderId || ""), String(stop.location || ""),
      Array.isArray(stop.orderRefs) ? [...stop.orderRefs].map(String).sort() : null])])));
}

// Split orders that travel inside a group in this plan state.
function groupedSplitRefs(orders = []) {
  const refs = new Set();
  const visit = (order, nested) => {
    if (nested && /-S\d+$/iu.test(String(order?.id || ""))) refs.add(String(order.id));
    for (const child of order?.childOrderDetails || []) visit(child, true);
  };
  for (const order of orders) visit(order, false);
  return [...refs].sort();
}

// Operator materialization of a confirmed plan: which split orders it keeps active.
async function replayDelivery(header, saved) {
  const plan = { id: String(header.id), planDate: header.date_text, status: "confirmed",
    orders: saved.orders || [], trucks: saved.trucks || [] };
  try {
    const splitRows = () => query(`SELECT tranid, netsuite_active FROM sales_orders WHERE tranid LIKE '%-S%'
      UNION ALL SELECT tranid, netsuite_active FROM transfer_orders WHERE tranid LIKE '%-S%'`).then((result) =>
      new Map(result.rows.map((row) => [row.tranid, row.netsuite_active])));
    const before = await splitRows();
    await applyConfirmedDispatchPlanToDelivery(plan);
    const after = await splitRows();
    const changed = [...after].filter(([ref, active]) => before.get(ref) !== active)
      .map(([ref, active]) => `${ref}:${active ? "active" : "inactive"}`).sort();
    return { result: "applied", changed };
  } catch (error) {
    return { result: "error", code: error.code || error.name, message: String(error.message || "").slice(0, 200) };
  }
}

try {
  assert.equal(process.env.MBT_TEST_ISOLATED, "1");
  assert.equal((await query("SELECT current_database() AS name")).rows[0].name, "mbt_test_history");
  await mkdir(output, { recursive: true, mode: 0o700 });
  await writeFile(resultsPath, "", { mode: 0o600 });
  const headers = new Map((await query("SELECT *, plan_date::text AS date_text FROM dispatch_plans")).rows
    .map((row) => [String(row.id), row]));
  const inScope = (header) => header && header.date_text >= from && header.date_text <= through;
  let cases = (await query(`SELECT * FROM (
      SELECT 'snapshot' AS stream, s.plan_id AS source_id, s.plan_id, s.saved_at AS event_at FROM dispatch_plan_snapshots s
      UNION ALL SELECT 'history', h.id, h.plan_id, h.archived_at FROM dispatch_plan_snapshot_history h
      UNION ALL SELECT 'command', c.id, c.plan_id, c.created_at FROM dispatch_plan_commands c
    ) states ORDER BY event_at, stream, source_id`)).rows
    .filter((entry) => inScope(headers.get(String(entry.plan_id))));
  if (limit > 0) cases = cases.slice(-limit);
  const fixturePlans = new Map((await query("SELECT plan_id, orders, summary FROM dispatch_plan_snapshots")).rows
    .map((state) => [String(state.plan_id), historicalReplayFixtureReason(headers.get(String(state.plan_id)), state)])
    .filter(([, reason]) => reason));
  const draftIds = new Set((await query(`SELECT id, archive_reason, checkpoint_kind, summary
      FROM dispatch_plan_snapshot_history`)).rows.filter(historicalReplayDraftReason).map((row) => String(row.id)));
  const counts = {};
  const started = Date.now();
  for (const [index, entry] of cases.entries()) {
    const header = headers.get(String(entry.plan_id));
    const row = { index, stream: entry.stream, sourceId: String(entry.source_id), planId: String(entry.plan_id),
      planDate: header.date_text };
    if (fixturePlans.has(row.planId)) row.result = "fixture_control";
    else if (entry.stream === "history" && draftIds.has(row.sourceId)) row.result = "recovery_draft";
    if (!row.result) {
      const table = { snapshot: "dispatch_plan_snapshots", history: "dispatch_plan_snapshot_history",
        command: "dispatch_plan_commands" }[entry.stream];
      const column = entry.stream === "snapshot" ? "plan_id" : "id";
      const source = (await query(`SELECT * FROM ${table} WHERE ${column}=$1`, [entry.source_id])).rows[0];
      const receipt = source.result?.plan;
      if (entry.stream === "command" && !receipt) row.result = "evidence_gap";
      else {
        const orders = receipt?.orders || receipt?.assignedOrderSnapshots || source.orders || [];
        const trucks = receipt?.trucks || source.trucks || [];
        const summary = receipt?.summary || source.summary || {};
        const revision = Number(receipt?.revision ?? source.revision ?? header.revision);
        const begin = performance.now();
        if (deliveryOnly) {
          if ((receipt?.status || header.status) === "confirmed") {
            await withTransaction(async () => {
              row.delivery = await replayDelivery(header, { orders, trucks });
              row.groupedSplits = groupedSplitRefs(orders);
            }, { rollback: true });
          }
          row.result = "delivery_only";
          row.ms = Math.round(performance.now() - begin);
          counts[row.result] = (counts[row.result] || 0) + 1;
          await appendFile(resultsPath, `${JSON.stringify(row)}\n`);
          continue;
        }
        try {
          await withTransaction(async () => {
            await query("UPDATE dispatch_plans SET status=$2, note=$3, revision=$4 WHERE id=$1",
              [header.id, receipt?.status || header.status, receipt?.note ?? header.note, revision]);
            await query(`INSERT INTO dispatch_plan_snapshots(plan_id, orders, trucks, summary, saved_at)
              VALUES($1, $2::jsonb, $3::jsonb, $4::jsonb, $5) ON CONFLICT(plan_id) DO UPDATE
              SET orders=EXCLUDED.orders, trucks=EXCLUDED.trucks, summary=EXCLUDED.summary, saved_at=EXCLUDED.saved_at`,
            [header.id, JSON.stringify(orders), JSON.stringify(trucks), JSON.stringify(summary),
              receipt?.savedAt || source.original_saved_at || source.saved_at || entry.event_at]);
            const raw = (await query(`SELECT p.*, p.plan_date::text, s.orders, s.trucks, s.summary, s.saved_at
              FROM dispatch_plans p JOIN dispatch_plan_snapshots s ON s.plan_id=p.id WHERE p.id=$1`, [header.id])).rows[0];
            const before = persistedDispatchPlan(raw);
            const hydrated = await hydrateHistoricalDispatchPlanOrders(before);
            await query("DELETE FROM dispatch_plan_commands WHERE plan_id=$1 AND applied_revision>$2", [header.id, revision]);
            await syncDispatchPlanOrderAssignments(hydrated.plan);
            const applied = await applyDispatchV2Command({ planId: header.id, command: {
              commandId: `history-replay:${label}:${index}`, commandType: "replace_plan",
              baseRevision: before.revision, baseDigest: before.digest, compactReceipt: true,
              payload: { orders, trucks, summary } } });
            const saved = (await query("SELECT orders, trucks FROM dispatch_plan_snapshots WHERE plan_id=$1",
              [header.id])).rows[0];
            row.cargoKept = JSON.stringify(assignedCargo(saved)) === JSON.stringify(assignedCargo(hydrated.plan));
            row.route = routeFingerprint(saved.trucks);
            const reread = await getDispatchV2Bootstrap({ planId: header.id });
            row.digestKept = reread.plan.digest === applied.payload.acknowledgement.digest;
            row.result = row.cargoKept && row.digestKept ? "saved" : "saved_with_drift";
            if ((receipt?.status || header.status) === "confirmed") row.delivery = await replayDelivery(header, saved);
          }, { rollback: true });
        } catch (error) {
          row.result = "rejected";
          row.code = error.code || error.name;
          row.message = String(error.message || "").slice(0, 400);
        }
        row.ms = Math.round(performance.now() - begin);
      }
    }
    counts[row.result] = (counts[row.result] || 0) + 1;
    await appendFile(resultsPath, `${JSON.stringify(row)}\n`);
    if (index % 50 === 0) console.log(JSON.stringify({ label, processed: index + 1, total: cases.length, counts }));
  }
  const summary = { label, from, through, total: cases.length, counts, seconds: Math.round((Date.now() - started) / 1000) };
  await writeFile(`${output}/${label}-summary.json`, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(summary));
} finally {
  await closeDb();
}
