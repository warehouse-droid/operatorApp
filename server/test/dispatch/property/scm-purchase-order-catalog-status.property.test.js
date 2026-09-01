// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

import { effectiveScmPurchaseOrderCatalogStatus } from "../../../src/scm-purchase-order-catalog-status.js";

function pseudoRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const statuses = [
  "Queued",
  "Planned",
  "Urgent",
  "Priority",
  "Surplus Only",
  "Book Appt",
  "Hold",
  "Cancelled",
  "In Transit",
  "Partially Done"
];

test("property: completion evidence is monotonic for arbitrary catalog and schedule states", () => {
  const random = pseudoRandom(0x50b03782);
  for (let run = 0; run < 500; run += 1) {
    const stored = statuses[Math.floor(random() * statuses.length)];
    const scheduled = statuses[Math.floor(random() * statuses.length)];
    const viaOrder = random() < 0.5;
    const status = effectiveScmPurchaseOrderCatalogStatus(
      { dispatchCompleted: viaOrder, dispatchPlanned: random() < 0.5, scm: { status: stored } },
      {
        schedule_id: run + 1,
        schedule_status: scheduled,
        schedule_updated_at: new Date(1_700_000_000_000 + run).toISOString(),
        reconciliation_status: random() < 0.2 ? "review" : "ok",
        reconciled_at: new Date(1_800_000_000_000 + run).toISOString(),
        reconciliation_application_status: statuses[Math.floor(random() * statuses.length)],
        completion_event_id: viaOrder ? null : run + 100
      }
    );
    assert.equal(status, "Completed", `run ${run}`);
  }
});

test("property: a strictly newer saved Hold wins any nonterminal reconciliation snapshot", () => {
  const random = pseudoRandom(0x51a7e123);
  for (let run = 0; run < 500; run += 1) {
    const reconciledAt = 1_700_000_000_000 + Math.floor(random() * 1_000_000);
    const status = effectiveScmPurchaseOrderCatalogStatus(
      { dispatchPlanned: random() < 0.5, scm: { status: statuses[Math.floor(random() * statuses.length)] } },
      {
        schedule_id: run + 1,
        schedule_status: "Hold",
        schedule_updated_at: new Date(reconciledAt + 1 + Math.floor(random() * 1_000_000)).toISOString(),
        reconciliation_status: "ok",
        reconciled_at: new Date(reconciledAt).toISOString(),
        reconciliation_application_status: statuses[Math.floor(random() * 6)]
      }
    );
    assert.equal(status, "Hold", `run ${run}`);
  }
});

test("property: without a persisted schedule identity, the catalog snapshot is unchanged", () => {
  const random = pseudoRandom(0x52b03782);
  for (let run = 0; run < 500; run += 1) {
    const stored = statuses[Math.floor(random() * statuses.length)];
    const status = effectiveScmPurchaseOrderCatalogStatus(
      { dispatchPlanned: random() < 0.5, scm: { status: stored } },
      {
        schedule_id: 0,
        schedule_status: statuses[Math.floor(random() * statuses.length)],
        reconciliation_status: random() < 0.5 ? "review" : "ok",
        reconciliation_application_status: "Completed"
      }
    );
    assert.equal(status, stored, `run ${run}`);
  }
});

test("property: an unscheduled source Hold is monotonic over any stale alias snapshot", () => {
  const random = pseudoRandom(0x53b03782);
  for (let run = 0; run < 500; run += 1) {
    const stored = statuses[Math.floor(random() * statuses.length)];
    const status = effectiveScmPurchaseOrderCatalogStatus(
      { dispatchPlanned: random() < 0.5, scm: { status: stored } },
      {
        schedule_id: 0,
        source_initial_status: "Hold"
      }
    );
    assert.equal(status, "Hold", `run ${run}`);
  }
});
