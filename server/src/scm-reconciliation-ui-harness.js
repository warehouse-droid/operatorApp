import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const [schedule, css, html] = await Promise.all([
  "../public/scm-schedule.js",
  "../public/dispatch.css",
  "../public/scm-schedule.html"
].map((file) => readFile(new URL(file, import.meta.url), "utf8")));

function includesAll(source, values, label) {
  for (const value of values) assert.ok(source.includes(value), `${label} is missing: ${value}`);
}

includesAll(schedule, [
  "scmScheduleRoles",
  '["admin", "scm", "scm_staff"]',
  "data-reconciliation-preference",
  "/api/scm/reconciliation/preferences",
  "SCM_SCHEDULE_RECONCILIATION_PREF_KEY",
  "loadLocalScmScheduleReconciliationPreference"
], "SCM/Admin reconciliation-detail preference");

includesAll(schedule, [
  "scmScheduleNeedsReconciliationReview",
  "scm-reconcile-badge review",
  "scm-reconcile-reason",
  "toggle-review-filter",
  "reconciliationReviewCount",
  "reconciliationStatus",
  "Review blocked"
], "review visibility, count, filter, and edit block");

includesAll(schedule, [
  "scmScheduleReconciliationSummaryHtml",
  "Source fulfilled",
  "Destination received",
  "Abandoned / closed",
  "Split allocated",
  "exactAllocation",
  "lastReconciledAt",
  "scmScheduleReconciliationLinesHtml"
], "compact PO/TO reconciliation details");

includesAll(schedule, [
  "/api/scm/reconciliation/retry",
  "/api/scm/reconciliation/resolve",
  "accept_current",
  "allocate",
  "dismiss_info",
  "An admin audit note is required",
  "scmScheduleCanResolveReconciliation"
], "role-gated review actions");

includesAll(schedule, [
  "scmSchedulePoSplitLineAdjustmentHtml",
  "Admin source-line adjustment",
  "/api/scm/reconciliation/po-split-line-options?",
  "/api/scm/reconciliation/po-split-lines/",
  "/reassign",
  "expectedSourceLineId",
  "newSourceLineId",
  "expectedBaselineQty",
  "allowBaselineReduction",
  "data-po-split-source-select",
  "data-po-split-line-note",
  "data-po-split-baseline-confirm",
  "An admin audit note is required for this source-line adjustment.",
  "Confirm the received-baseline reduction",
  "Source line adjusted for"
], "admin PO split source-line adjustment");
assert.match(
  schedule,
  /function scmSchedulePoSplitLineAdjustmentHtml[\s\S]*?scmScheduleCanResolveReconciliation\(\)[\s\S]*?orderKind[\s\S]*?!== "PO"/,
  "PO split source-line adjustment must be visible only to admins and only for PO rows."
);

includesAll(schedule, [
  "scmScheduleMissingSourceReview",
  "source_missing",
  "NetSuite record unavailable",
  "Verify again and close locally",
  "/api/scm/reconciliation/close-missing-po",
  "reviewCaseId",
  "expectedLastDetectedAt"
], "controlled missing-PO local cancellation");
assert.match(
  schedule,
  /canResolve && missingSourceReview \?[\s\S]*?: canResolve \?[\s\S]*?accept_current/,
  "A source_missing review must render the verified local-cancel action instead of generic Accept current."
);

includesAll(schedule, [
  "scmScheduleCanCompleteVrma",
  "complete-vrma",
  "Complete VRMA",
  "/complete-override",
  "SCM confirmed this local VRMA delivery is complete.",
  "does not update NetSuite"
], "SCM/Admin local VRMA completion override");

includesAll(schedule, [
  "scmScheduleHistoryTime",
  "completedAt",
  "cancelledAt",
  "statusChangedAt",
  ".sort((left, right) => scmScheduleHistoryTime(right.row) - scmScheduleHistoryTime(left.row)"
], "newest-first completed/cancelled history");

includesAll(css, [
  ".scm-review-filter",
  ".scm-reconciliation-visibility",
  ".scm-sheet-row.reconcile-review",
  ".scm-reconciliation-detail",
  ".scm-reconcile-quantity-grid",
  ".scm-reconcile-resolution",
  ".scm-reconcile-missing-resolution",
  ".scm-po-split-line-adjustments",
  ".scm-po-split-line-adjustment-card",
  ".scm-po-split-baseline-confirm",
  ".scm-po-split-line-candidate-metrics",
  ".scm-complete-vrma"
], "reconciliation schedule styling");

assert.ok(html.includes("/dispatch.css?v=20260730-column-header-filters-v1"), "Reconciliation CSS cache bust is missing.");
assert.ok(html.includes("/scm-schedule.js?v=20260730-status-visibility-v1"), "Reconciliation client cache bust is missing.");

const payloadStart = schedule.indexOf("function normalizeScmSchedulePayload");
const payloadEnd = schedule.indexOf("function loadScmSchedulePresetsOnce", payloadStart);
assert.ok(payloadStart >= 0 && payloadEnd > payloadStart, "Schedule payload normalizer must remain independently testable.");
const normalizePayload = Function(`${schedule.slice(payloadStart, payloadEnd)}; return normalizeScmSchedulePayload;`)();
assert.deepEqual(normalizePayload([{ orderRef: "PO1" }]), { rows: [{ orderRef: "PO1" }], meta: {} });
assert.deepEqual(
  normalizePayload({ rows: [{ orderRef: "PO2" }], meta: { reconciliationReviewCount: 3 } }),
  { rows: [{ orderRef: "PO2" }], meta: { reconciliationReviewCount: 3 } }
);

const helperStart = schedule.indexOf("function scmScheduleFirstValue");
const helperEnd = schedule.indexOf("function scmScheduleReconciliationQuantity", helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, "Reconciliation status/history helper block must remain independently testable.");
const helperContext = {
  scmScheduleRows: [
    { orderRef: "PO-OLD", status: "Completed", completedAt: "2026-07-01T10:00:00Z" },
    {
      orderRef: "TO-REVIEW",
      status: "Queued",
      reconciliationStatus: "review",
      reconciliationReason: "Destination receipt was deleted."
    },
    { orderRef: "PO-NEW", status: "Completed", completedAt: "2026-07-28T10:00:00Z" }
  ],
  scmScheduleMeta: {},
  scmScheduleReviewOnly: false,
  scmScheduleFilters: { view: "completed", status: [] },
  scmScheduleFilterValues: (value) => Array.isArray(value) ? value : [value].filter(Boolean)
};
vm.runInNewContext(
  `${schedule.slice(helperStart, helperEnd)}
  result = {
    needsReview: scmScheduleNeedsReconciliationReview(scmScheduleRows[1]),
    reason: scmScheduleReconciliationReason(scmScheduleRows[1]),
    reviewCount: scmScheduleReviewCount(),
    history: scmScheduleDisplayRows().map((row) => row.orderRef)
  };`,
  helperContext
);
assert.equal(helperContext.result.needsReview, true);
assert.equal(helperContext.result.reason, "Destination receipt was deleted.");
assert.equal(helperContext.result.reviewCount, 1);
assert.deepEqual([...helperContext.result.history], ["PO-NEW", "PO-OLD", "TO-REVIEW"]);

const reductionStart = schedule.indexOf("function scmSchedulePoSplitRequiresBaselineReduction");
const reductionEnd = schedule.indexOf("function scmSchedulePoSplitCandidatePreviewHtml", reductionStart);
assert.ok(reductionStart >= 0 && reductionEnd > reductionStart, "PO split baseline-reduction helper must remain independently testable.");
const baselineReductionRequired = Function(
  `${schedule.slice(reductionStart, reductionEnd)}; return scmSchedulePoSplitRequiresBaselineReduction;`
)();
assert.equal(baselineReductionRequired({ baselineQty: 24, recommendedBaselineQty: 0 }), true);
assert.equal(baselineReductionRequired({ baselineQty: 0, recommendedBaselineQty: 0 }), false);
assert.equal(baselineReductionRequired({ requiresBaselineReduction: true, baselineQty: 0, recommendedBaselineQty: 0 }), true);

console.log("SCM reconciliation UI harness passed.");
