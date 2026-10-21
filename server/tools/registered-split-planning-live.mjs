// Run through stdin in the live /app directory; every query is read-only.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { query, withTransaction, closeDb } from "./src/db.js";
import { listFulfilledSalesDeliveryStates } from "./src/dispatch-fulfilled-so-repository.js";
import { getDispatchOrderCatalogOrder } from "./src/dispatch-order-catalog-repository.js";
import { listDriverPwaCompletedDispatchRefs } from "./src/dispatch-history-mode.js";

const groupRef = "GOA-9222S1-9223S2";
const members = ["SOA09222-S1", "SOA09223-S2"];
const refs = [groupRef, ...members, "SOA09222", "SOA09223", "SOA09704"];
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function operationalRows() {
  const sources = (await query("SELECT row_to_json(s) AS value FROM sales_orders s WHERE lower(tranid)=ANY($1::text[]) ORDER BY netsuite_id", [refs.map(ref => ref.toLowerCase())])).rows;
  const lines = (await query(`SELECT row_to_json(l) AS value FROM sales_order_lines l
    WHERE sales_order_id IN (SELECT netsuite_id FROM sales_orders WHERE lower(tranid)=ANY($1::text[])) ORDER BY id`, [refs.map(ref => ref.toLowerCase())])).rows;
  const definitions = (await query(`SELECT row_to_json(g) AS value FROM dispatch_global_order_groups g WHERE group_ref=$1`, [groupRef])).rows;
  const splits = (await query("SELECT row_to_json(s) AS value FROM dispatch_global_order_splits s WHERE split_ref=ANY($1::text[]) ORDER BY split_ref", [members])).rows;
  const snapshots = (await query("SELECT row_to_json(s) AS value FROM dispatch_plan_snapshots s WHERE plan_id IN (343,349) ORDER BY plan_id")).rows;
  const jobs = (await query("SELECT row_to_json(j) AS value FROM driver_job_records j WHERE plan_id IN (343,349) ORDER BY id")).rows;
  const decisions = (await query("SELECT row_to_json(r) AS value FROM dispatch_executed_order_reviews r WHERE plan_id=349 ORDER BY token")).rows;
  const audit = (await query("SELECT row_to_json(a) AS value FROM dispatch_audit_log a WHERE plan_id IN (343,349) ORDER BY id")).rows;
  return { sources, lines, definitions, splits, snapshots, jobs, decisions, audit };
}

try {
  const proof = await withTransaction(async () => {
    await query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await query("SET LOCAL statement_timeout='15s'");
    const readOnly = (await query("SHOW transaction_read_only")).rows[0].transaction_read_only === "on";
    assert.equal(readOnly, true);
    const before = await operationalRows();
    const states = await listFulfilledSalesDeliveryStates(refs);
    const completed = await listDriverPwaCompletedDispatchRefs({ candidateRefs: refs.slice(0, -1) });
    const catalog = await getDispatchOrderCatalogOrder(groupRef);
    assert.ok(catalog);
    const { loadDispatchOrdersForResponse } = await import("./src/server.js");
    const feed = await loadDispatchOrdersForResponse({ type: "SO", exactOrderRefs: [groupRef] });
    const order = feed.find(row => row.id === groupRef);
    assert.ok(order, "Exact Dispatch order feed must include the active group");
    const phase = process.env.REGISTERED_SPLIT_VERIFY_PHASE || "after";
    if (phase === "after") {
      for (const ref of members) {
        assert.equal(states.get(ref.toLowerCase())?.blocked, false, ref);
        assert.equal(states.get(ref.toLowerCase())?.locallyCompleted, false, ref);
      }
      assert.equal(catalog.dispatchPlanningRestricted, false);
      assert.equal(order.dispatchPlanningRestricted, false);
      assert.equal(order.dispatchCompletionStatus === "completed", false);
      assert.equal(completed.size, 0);
    } else {
      assert.equal(states.has("soa09223-s2"), false);
      assert.equal(catalog.dispatchPlanningRestricted, true);
      assert.equal(order.dispatchPlanningRestricted, true);
    }
    assert.deepEqual(await operationalRows(), before);
    const sourceDecision = before.decisions.map(row => row.value).find(row => row.order_ref === "SOA09704" && row.decision === "accept_netsuite_change");
    assert.ok(sourceDecision, "The prior source decision remains recorded");
    const hashes = Object.fromEntries(Object.entries(before).map(([name, rows]) => [name, { count: rows.length, hash: hash(rows) }]));
    return { passed: true, phase, readOnly, groupRef, members, states: Object.fromEntries(states),
      planningRestricted: order.dispatchPlanningRestricted, catalogPlanningRestricted: catalog.dispatchPlanningRestricted,
      completionStatus: order.dispatchCompletionStatus || null, driverCompleted: [...completed],
      operationalRowsUnchanged: true, operationalHashes: hashes, earlierSourceDecisionPreserved: true };
  });
  console.log(JSON.stringify(proof));
} finally {await closeDb();}
