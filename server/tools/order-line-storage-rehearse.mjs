import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { mapNetSuiteTransferSourceLines } from "../src/netsuite.js";
import { selectIncompleteNetSuiteOrders, planNetSuiteOrderLineBackfill } from "../src/netsuite-order-line-backfill.js";
const folder = "test-artifacts/order-line-storage";
const records = readFileSync(`${folder}/live-snapshot.jsonl`, "utf8").trim().split("\n").map(line => JSON.parse(line));
const orders = selectIncompleteNetSuiteOrders(records.find(record => record.event === "headers").headers);
const plans = records.filter(record => record.event === "batch").map(record => {
  const remote = record.kind === "TO" ? record.ids.flatMap(id => mapNetSuiteTransferSourceLines(record.remote.filter(row => Number(row.order_id) === id))) : record.remote;
  return { kind: record.kind, ids: record.ids, ...planNetSuiteOrderLineBackfill(record.local, remote) };
});
const summary = ["SO", "PO", "TO"].map(kind => ({ kind, orders: orders.filter(order => order.kind === kind).length,
  updates: plans.filter(plan => plan.kind === kind).flatMap(plan => plan.updates).length,
  subtotals: plans.filter(plan => plan.kind === kind).flatMap(plan => plan.excluded).filter(row => row.reason === "subtotal_not_fulfillable").length,
  inactiveHistorical: plans.filter(plan => plan.kind === kind).flatMap(plan => plan.excluded).filter(row => row.reason === "inactive_historical_line").length,
  unresolved: plans.filter(plan => plan.kind === kind).flatMap(plan => plan.unresolved) }));
writeFileSync(`${folder}/live-rehearsal.json`, JSON.stringify({ summary, plans }, null, 2));
console.log(JSON.stringify(summary, null, 2));
assert.ok(summary.every(row => row.unresolved.length === 0), "Review unresolved identities before applying");
