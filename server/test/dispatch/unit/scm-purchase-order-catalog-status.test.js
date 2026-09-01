// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

import {
  effectiveScmPurchaseOrderCatalogStatus,
  operationalScmPurchaseOrderCatalogStatus,
  storedScmPurchaseOrderCatalogStatus
} from "../../../src/scm-purchase-order-catalog-status.js";

function evidence(overrides = {}) {
  return {
    schedule_id: 17,
    schedule_status: "Queued",
    schedule_updated_at: "2026-08-28T02:00:00.000Z",
    reconciliation_status: "",
    reconciled_at: null,
    reconciliation_application_status: "",
    reconciliation_blocked: false,
    completion_event_id: null,
    ...overrides
  };
}

test("catalog status defaults a PO without saved state to Hold", () => {
  assert.equal(storedScmPurchaseOrderCatalogStatus({}), "Hold");
  assert.equal(storedScmPurchaseOrderCatalogStatus({ scm: { status: " Queued " } }), "Queued");
  assert.equal(effectiveScmPurchaseOrderCatalogStatus({ scm: { status: "Priority" } }, {}), "Priority");
});

test("a live source initial Hold replaces a stale Queued alias until a saved status exists", () => {
  const queuedAlias = { scm: { status: "Queued" } };
  assert.equal(
    effectiveScmPurchaseOrderCatalogStatus(queuedAlias, {
      schedule_id: null,
      source_initial_status: "Hold"
    }),
    "Hold"
  );
  assert.equal(
    effectiveScmPurchaseOrderCatalogStatus(queuedAlias, evidence({
      schedule_status: "Queued",
      source_initial_status: "Hold"
    })),
    "Queued",
    "an explicit schedule status remains authoritative for its exact identity"
  );
});

test("manual operational statuses survive a dispatch assignment", () => {
  const cases = new Map([
    ["Complete", "Completed"],
    ["Completed", "Completed"],
    ["Cancelled", "Cancelled"],
    ["Canceled", "Canceled"],
    ["Hold", "Hold"],
    ["In Transit", "In Transit"],
    ["Partially Done", "Partially Done"],
    ["Reconcile Review", "Reconcile Review"]
  ]);
  for (const [saved, expected] of cases) {
    assert.equal(
      operationalScmPurchaseOrderCatalogStatus(
        { dispatchPlanned: true, scm: { status: "Queued" } },
        evidence({ schedule_status: saved })
      ),
      expected,
      saved
    );
  }
  assert.equal(
    operationalScmPurchaseOrderCatalogStatus(
      { dispatchPlanned: true, scm: { status: "Hold" } },
      evidence({ schedule_status: "Queued" })
    ),
    "Planned"
  );
});
test("Driver completion evidence is monotonic over every other status source", () => {
  assert.equal(
    effectiveScmPurchaseOrderCatalogStatus(
      { scm: { status: "Queued" } },
      evidence({ schedule_status: "Hold", completion_event_id: 91 })
    ),
    "Completed"
  );
  assert.equal(
    effectiveScmPurchaseOrderCatalogStatus(
      { dispatchCompleted: true, scm: { status: "Queued" } },
      evidence({ schedule_status: "Hold" })
    ),
    "Completed"
  );
});

test("review and reconciliation completion retain terminal precedence", () => {
  assert.equal(
    effectiveScmPurchaseOrderCatalogStatus(
      { scm: { status: "Queued" } },
      evidence({ reconciliation_blocked: true })
    ),
    "Reconcile Review"
  );
  assert.equal(
    effectiveScmPurchaseOrderCatalogStatus(
      { scm: { status: "Queued" } },
      evidence({ reconciliation_status: "review" })
    ),
    "Reconcile Review"
  );
  assert.equal(
    effectiveScmPurchaseOrderCatalogStatus(
      { scm: { status: "Queued" } },
      evidence({ reconciliation_application_status: "Completed" })
    ),
    "Completed"
  );
});

test("newer schedule status wins and older schedule status yields to reconciliation", () => {
  assert.equal(
    effectiveScmPurchaseOrderCatalogStatus(
      { scm: { status: "Queued" } },
      evidence({
        schedule_status: "Hold",
        schedule_updated_at: "2026-08-28T03:00:00.000Z",
        reconciled_at: "2026-08-28T02:00:00.000Z",
        reconciliation_status: "ok",
        reconciliation_application_status: "Queued"
      })
    ),
    "Hold"
  );
  assert.equal(
    effectiveScmPurchaseOrderCatalogStatus(
      { scm: { status: "Queued" } },
      evidence({
        schedule_status: "Queued",
        schedule_updated_at: "2026-08-28T01:00:00.000Z",
        reconciled_at: "2026-08-28T02:00:00.000Z",
        reconciliation_status: "ok",
        reconciliation_application_status: "Hold"
      })
    ),
    "Hold"
  );
  assert.equal(
    effectiveScmPurchaseOrderCatalogStatus(
      { scm: { status: "Hold" } },
      evidence({
        schedule_status: "Queued",
        reconciliation_status: "pending",
        reconciliation_application_status: "Hold"
      })
    ),
    "Queued"
  );
});
