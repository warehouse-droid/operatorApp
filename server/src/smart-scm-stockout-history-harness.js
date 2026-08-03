import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {
  loadSmartScmInventoryWeekEvidence,
  smartScmFormulaDemandEvidence,
  smartScmInventoryWeekStatus,
  smartScmStockoutDemandWindow,
  smartScmWeeklyTimeline
} from "./smart-scm-forecast-repository.js";
import { closeDb, query, withTransaction } from "./db.js";

const migration = await fs.readFile(
  new URL("../migrations/094_smart_scm_inventory_history.sql", import.meta.url),
  "utf8"
);
const syncService = await fs.readFile(
  new URL("./smart-scm-sync-service.js", import.meta.url),
  "utf8"
);
const forecastRepository = await fs.readFile(
  new URL("./smart-scm-forecast-repository.js", import.meta.url),
  "utf8"
);

assert.match(migration, /CREATE TABLE IF NOT EXISTS scm_smart_inventory_sync_runs/i);
assert.match(migration, /CREATE TABLE IF NOT EXISTS scm_smart_inventory_snapshots/i);
assert.match(migration, /PRIMARY KEY \(run_id, item_id, location_id\)/i);
assert.match(forecastRepository, /AT TIME ZONE 'America\/Toronto'/i,
  "Snapshot observations must be grouped into Toronto calendar days and weeks.");
assert.match(forecastRepository, /row_number\(\) OVER[\s\S]*daily_rank = 1/i,
  "Forecast evidence must keep only the last complete observation from each Toronto day.");
assert.match(syncService, /withTransaction\(async \(\) => \{[\s\S]*upsertInventoryBalancesBulk\(canonical\)[\s\S]*insertInventorySnapshotRows\(snapshotRunId, canonical\)[\s\S]*inventory_status = 'ready'/i,
  "Current balances, policies, immutable snapshot rows, and ready state must share the successful transaction.");

assert.equal(smartScmInventoryWeekStatus({ observedDays: 3, availableDays: 3 }), "unknown");
assert.equal(smartScmInventoryWeekStatus({ observedDays: 4, availableDays: 3 }), "in_stock");
assert.equal(smartScmInventoryWeekStatus({ observedDays: 4, availableDays: 2 }), "stockout");

const padded = smartScmWeeklyTimeline([
  { transaction_date: "2026-01-05", pallet_quantity: 4 },
  { transaction_date: "2026-01-20", pallet_quantity: 2 }
], new Date("2026-02-02T00:00:00Z"));
assert.deepEqual(padded.dates, ["2026-01-05", "2026-01-12", "2026-01-19", "2026-01-26", "2026-02-02"]);
assert.deepEqual(padded.values, [4, 0, 2, 0, 0], "Normal timelines must retain trailing zero-sales weeks through the active source cutoff.");

const mixedInventory = new Map([
  ["2026-01-05", { observedDays: 5, availableDays: 4, status: "in_stock" }],
  ["2026-01-12", { observedDays: 5, availableDays: 2, status: "stockout" }],
  ["2026-01-26", { observedDays: 4, availableDays: 3, status: "in_stock" }],
  ["2026-02-02", { observedDays: 6, availableDays: 4, status: "in_stock" }]
]);
const mixedTimeline = {
  dates: ["2026-01-05", "2026-01-12", "2026-01-19", "2026-01-26", "2026-02-02"],
  values: [10, 20, 6, 2, 0]
};
const mixed = smartScmFormulaDemandEvidence(
  { to_plt: 100, quantity_available: 0, expected_demand_change: 20 },
  mixedTimeline,
  { formula_average_weeks: 6, stockout_benchmark_weeks: 6 },
  mixedInventory,
  new Date("2026-02-02T00:00:00Z")
);
assert.equal(mixed.method, "mixed");
assert.equal(mixed.evidenceConfidence, "low");
assert.equal(mixed.snapshotWeeks, 3);
assert.equal(mixed.proxyWeeks, 1);
assert.equal(mixed.evidenceStartWeek, "2026-01-05");
assert.equal(mixed.evidenceEndWeek, "2026-02-02");
assert(Math.abs(mixed.demand - 5.4) < 0.000001,
  "Stockout demand must average 10, 6, 2, and 0, exclude the known-stockout 20 week, then apply +20% expected demand.");

const snapshotOnly = smartScmStockoutDemandWindow({
  dates: ["2026-01-05", "2026-01-12", "2026-01-19", "2026-01-26"],
  values: [9, 6, 3, 100],
  inventoryWeeks: new Map([
    ["2026-01-05", { status: "in_stock" }],
    ["2026-01-12", { status: "in_stock" }],
    ["2026-01-19", { status: "in_stock" }]
  ]),
  completedThrough: new Date("2026-01-26T00:00:00Z"),
  targetWeeks: 3
});
assert.deepEqual(snapshotOnly.values, [9, 6, 3], "Unknown positive-sales proxy weeks must not displace a sufficient snapshot window.");
assert.equal(snapshotOnly.method, "snapshot");
assert.equal(snapshotOnly.confidence, "high");

const proxyOnly = smartScmStockoutDemandWindow({
  dates: ["2026-03-02", "2026-03-09", "2026-03-16"],
  values: [5, 50, 7],
  inventoryWeeks: new Map([
    ["2026-03-09", { observedDays: 5, availableDays: 0, status: "stockout" }]
  ]),
  completedThrough: new Date("2026-03-16T00:00:00Z"),
  targetWeeks: 3
});
assert.deepEqual(proxyOnly.values, [5, 7]);
assert.equal(proxyOnly.method, "positive_sales_proxy");
assert.equal(proxyOnly.confidence, "low");

const normal = smartScmFormulaDemandEvidence(
  { to_plt: 100, quantity_available: 100, expected_demand_change: -0.25 },
  { dates: ["2026-04-06", "2026-04-13"], values: [4, 0] },
  { formula_average_weeks: 2, stockout_benchmark_weeks: 6 },
  new Map(),
  new Date("2026-04-13T00:00:00Z")
);
assert.equal(normal.stockout, false);
assert.equal(normal.method, "none");
assert.equal(normal.evidenceConfidence, "none");
assert.equal(normal.demand, 1.5, "Normal demand must preserve completed zero-sales weeks and the expected-demand adjustment.");

try {
  await withTransaction(async () => {
    await query(migration);
    const itemId = 99999094;
    const observations = [
      ["2026-06-01T14:00:00Z", 10],
      ["2026-06-02T12:00:00Z", 10],
      ["2026-06-02T20:00:00Z", 0],
      ["2026-06-03T14:00:00Z", 10],
      ["2026-06-04T14:00:00Z", 0],
      ["2026-06-05T14:00:00Z", 10],
      ["2026-06-08T14:00:00Z", 10],
      ["2026-06-09T14:00:00Z", 10],
      ["2026-06-10T14:00:00Z", 10]
    ];
    for (const [observedAt, quantityAvailable] of observations) {
      const run = await query(
        `INSERT INTO scm_smart_inventory_sync_runs (
           status, trigger_source, requested_item_count, item_count, balance_count,
           observed_at, started_at, completed_at
         ) VALUES ('completed', 'harness', 1, 1, 1, $1::timestamptz, $1::timestamptz, $1::timestamptz)
         RETURNING id`,
        [observedAt]
      );
      await query(
        `INSERT INTO scm_smart_inventory_snapshots (
           run_id, item_id, location_id, yard_code, quantity_on_hand, quantity_available
         ) VALUES ($1, $2, 1, '3445', $3, $3)`,
        [run.rows[0].id, itemId, quantityAvailable]
      );
    }
    const evidenceByPolicy = await loadSmartScmInventoryWeekEvidence(
      [{ item_id: itemId, location_id: 1 }],
      new Date("2026-06-08T00:00:00Z")
    );
    const weeks = evidenceByPolicy.get(`${itemId}:1`);
    assert.deepEqual(weeks.get("2026-06-01"), {
      observedDays: 5,
      availableDays: 3,
      status: "in_stock"
    }, "The later Tuesday observation must replace the earlier one before weekly availability is classified.");
    assert.deepEqual(weeks.get("2026-06-08"), {
      observedDays: 3,
      availableDays: 3,
      status: "unknown"
    }, "Fewer than four distinct Toronto observation days must remain unknown.");
  }, { rollback: true });
  console.log("Smart SCM stockout inventory-history harness passed.");
} finally {
  await closeDb();
}
