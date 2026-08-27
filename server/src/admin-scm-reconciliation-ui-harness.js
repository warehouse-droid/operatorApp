import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const [control, css, adminHtml, controlHtml, sidebar] = await Promise.all([
  "../public/control.js",
  "../public/control.css",
  "../public/admin.html",
  "../public/control.html",
  "../public/app-sidebar.js"
].map((file) => readFile(new URL(file, import.meta.url), "utf8")));

function includesAll(source, values, label) {
  for (const value of values) assert.ok(source.includes(value), `${label} is missing: ${value}`);
}

includesAll(control, [
  'nightlyTime: "21:30"',
  'timeZone: SCM_RECONCILIATION_TIME_ZONE',
  'initialBackfillSince: "2026-01-01"',
  "/api/control/scm-reconciliation/settings",
  "/api/control/scm-reconciliation/runs",
  "/api/control/scm-reconciliation/run",
  "nightlyEnabled",
  "nightlyTime",
  "initialBackfillSince",
  "initialBackfillModifiedSince"
], "reconciliation settings and loading");

includesAll(control, [
  '["all", "SO", "PO", "TO", "order_family"]',
  "body.orderKind = orderKind",
  "normalizeScmReconciliationOrderRefs",
  "body.orderRefs = orderRefs",
  'body.orderRef = orderRefs.join(", ")',
  "const body = { scope, dryRun, includeTerminalOrders }",
  "scmReconciliationIncludeTerminalOrders",
  "scmReconciliationScopeApproved(scope, orderKind)",
  "scmReconciliationSoInitialApproved",
  "const dryRun = forceInitialDryRun",
  '"succeeded", "awaiting_approval"',
  "scmReconciliationAppliedRunFor",
  "Apply dry-run scope",
  "fresh live reconciliation against current NetSuite data",
  "/apply"
], "manual run and scoped dry-run apply controls");

const orderRefHelperStart = control.indexOf("function normalizeScmReconciliationOrderRefs");
const orderRefHelperEnd = control.indexOf("function normalizeScmReconciliationSettings", orderRefHelperStart);
assert.ok(
  orderRefHelperStart >= 0 && orderRefHelperEnd > orderRefHelperStart,
  "Multi-reference normalization helpers must remain independently testable."
);
const orderRefContext = { result: null };
vm.runInNewContext(
  `${control.slice(orderRefHelperStart, orderRefHelperEnd)}
   result = {
     normalized: normalizeScmReconciliationOrderRefs("pob03581, POB03582\\npob03581\\r\\npob03583,,"),
     arrayInput: normalizeScmReconciliationOrderRefs(["tob00749", " TOB00750\\ntob00749 "]),
     preview: scmReconciliationOrderRefsPreview(["POB03581", "POB03582", "POB03583"], 2)
   };`,
  orderRefContext
);
assert.deepEqual(
  Array.from(orderRefContext.result.normalized),
  ["POB03581", "POB03582", "POB03583"],
  "CSV/newline source references must be trimmed, uppercased, and deduplicated."
);
assert.deepEqual(
  Array.from(orderRefContext.result.arrayInput),
  ["TOB00749", "TOB00750"],
  "Server-returned reference arrays must use the same normalization."
);
assert.equal(
  orderRefContext.result.preview,
  "POB03581, POB03582 +1 more",
  "Large targeted scopes need a compact count-aware confirmation preview."
);

const applyHelperSource = control.match(
  /function scmReconciliationRunIsDry[\s\S]*?(?=\nfunction scmReconciliationRunSummary)/
)?.[0] || "";
assert.ok(applyHelperSource, "Scoped reconciliation apply helpers are missing.");
function canApply(run, {
  settings = { initialDryRunApproved: false },
  runs = [run]
} = {}) {
  const context = {
    run,
    result: null,
    scmReconciliationRuns: runs,
    scmReconciliationSettings: settings,
    firstDefined(object, keys, fallback) {
      for (const key of keys) {
        if (object?.[key] !== undefined && object?.[key] !== null) return object[key];
      }
      return fallback;
    },
    scmReconciliationBoolean(value) {
      return value === true || String(value).toLowerCase() === "true";
    },
    scmReconciliationRunId(value) {
      return String(value?.id || "");
    },
    scmReconciliationRunStatus(value) {
      return String(value?.status || "").trim().toLowerCase().replaceAll(" ", "_").replaceAll("-", "_");
    }
  };
  vm.runInNewContext(`${applyHelperSource}; result = scmReconciliationRunCanApply(run);`, context);
  return context.result;
}
const scopedDryRun = { id: 5, scope: "TO", dryRun: true, status: "succeeded" };
assert.equal(canApply(scopedDryRun), true, "A completed TO-only dry run must expose Apply.");
assert.equal(
  canApply(scopedDryRun, {
    runs: [scopedDryRun, {
      id: 6,
      scope: "TO",
      dryRun: false,
      status: "succeeded",
      resumeOfRunId: 5
    }]
  }),
  false,
  "An already applied dry run must not expose a duplicate Apply action."
);
assert.equal(
  canApply({ id: 7, scope: "all", dryRun: true, status: "awaiting_approval" }),
  true,
  "The initial company-wide proposal must retain its Apply action."
);
assert.equal(
  canApply({ id: 8, scope: "PO", dryRun: true, status: "failed" }),
  false,
  "A failed dry run must never be applied."
);

const resumeHelperStart = control.indexOf("function scmReconciliationRunCanResume");
const resumeHelperEnd = control.indexOf(
  "function scmReconciliationRunStopRequested",
  resumeHelperStart
);
assert.ok(
  resumeHelperStart >= 0 && resumeHelperEnd > resumeHelperStart,
  "Run-resume eligibility helpers must remain independently testable."
);
function canResume(run) {
  const context = {
    run,
    result: null,
    firstDefined(object, keys, fallback) {
      for (const key of keys) {
        if (object?.[key] !== undefined && object?.[key] !== null) return object[key];
      }
      return fallback;
    },
    scmReconciliationBoolean(value) {
      return value === true || String(value).toLowerCase() === "true";
    },
    scmReconciliationRunStatus(value) {
      return String(value?.status || "")
        .trim()
        .toLowerCase()
        .replaceAll(" ", "_")
        .replaceAll("-", "_");
    }
  };
  vm.runInNewContext(
    `${control.slice(resumeHelperStart, resumeHelperEnd)}
     result = scmReconciliationRunCanResume(run);`,
    context
  );
  return context.result;
}
assert.equal(
  canResume({ status: "interrupted" }),
  true,
  "Interrupted runs must remain resumable when an older API omits resumeAllowed."
);
assert.equal(
  canResume({ status: "failed", resumeAllowed: true }),
  true,
  "The server must be able to expose a resumable legacy global failure."
);
assert.equal(
  canResume({ status: "interrupted", resumeAllowed: false }),
  false,
  "An explicit server-side eligibility refusal must override the status fallback."
);
assert.equal(
  canResume({ status: "failed", resume_allowed: "true" }),
  true,
  "Snake-case run payloads must expose the same resume eligibility."
);
assert.equal(
  canResume({ status: "failed" }),
  false,
  "An ordinary failed run must not be resumable without server approval."
);
assert.equal(
  canResume({ status: "succeeded", resumeAllowed: false }),
  false,
  "Completed runs must never expose Resume remaining orders."
);

const resumeActionStart = control.indexOf("async function resumeScmReconciliationRun");
const resumeActionEnd = control.indexOf("\nfunction ", resumeActionStart + 1);
assert.ok(
  resumeActionStart >= 0 && resumeActionEnd > resumeActionStart,
  "The manual reconciliation resume action is missing."
);
const resumeAction = control.slice(resumeActionStart, resumeActionEnd);
includesAll(resumeAction, [
  "scmReconciliationRunCanResume(run)",
  "scmReconciliationRuns.some(scmReconciliationRunIsActive)",
  "Completed, reviewed, and skipped orders will remain untouched.",
  "Only unfinished orders will continue; the request that was in flight will be repeated.",
  "/resume",
  'method: "POST"',
  "is resuming from its saved order progress"
], "manual resume confirmation and request");

includesAll(control, [
  "SO / PO / TO Reconciliation",
  "Initial full reconciliation:",
  "SO only",
  "All SO / PO / TO",
  'reconciliation: "/admin/reconciliation"',
  "SCM_RECONCILIATION_SELECTED_RUN_KEY",
  "ensureScmReconciliationSelectedRun",
  "selectScmReconciliationRun",
  "renderScmReconciliationSection",
  "Manual reconciliation",
  "Run history",
  "scm-reconciliation-workspace",
  "scm-reconciliation-run-browser",
  "scm-reconciliation-selected-detail",
  "scmReconciliationSettingsLoaded",
  'role="status" aria-live="polite"',
  "scmReconciliationRunMetricHtml",
  "scmReconciliationRunProgressHtml",
  "Loading IF / IR evidence",
  "Run interrupted",
  "scmReconciliationRunIsActive",
  "scheduleScmReconciliationPoll"
], "run state and result rendering");

assert.match(
  control,
  /scmReconciliationRunCanResume\(run\)[\s\S]{0,500}?Resume remaining orders/,
  "Resume remaining orders must render only for a server-eligible run."
);
assert.match(
  control,
  /Resume remaining orders<\/button>[\s\S]{0,500}?scmReconciliationRunCanApply\(run\)/,
  "Resume must remain a distinct action from applying a completed dry run."
);

includesAll(control, [
  '<textarea name="orderRefs"',
  "Source order references",
  "Target order families",
  "Include locally terminal / skipped orders",
  "Broad runs exclude Completed, Cancelled/closed, Hold, and saved Skip decisions by default.",
  "Targeted order-family runs inherently override this filter.",
  'data-field="scm-reconciliation-include-terminal"',
  "scmReconciliationIncludeTerminalOrders = Boolean(event.target.checked)",
  "orderRefs.length.toLocaleString()",
  "families",
  "stop-scm-reconciliation-run",
  "stopScmReconciliationRun",
  "/api/control/scm-reconciliation/runs/${encodeURIComponent(id)}/stop",
  "Stop run",
  "preserve its recorded progress"
], "multi-family, terminal-scope, and active-run controls");
assert.ok(
  !control.includes('<input name="orderRef" data-field="scm-reconciliation-order-ref"'),
  "The targeted family form must not regress to a single-line source reference input."
);

includesAll(control, [
  "loadScmReconciliationRunDetails",
  "/api/scm/reconciliation/runs/",
  "Order-by-order review",
  "Full proposed result",
  "Select a reconciliation run",
  "Refresh order details",
  "Load more orders",
  "Decision before apply",
  "Accept NetSuite outcome",
  "Skip this order and future broad runs",
  "Apply normally; keep Review if conflict remains",
  "saveScmReconciliationTargetDecision",
  "expectedUpdatedAt",
  "scmReconciliationRunPendingDecisions",
  "scmReconciliationRunReviewCount",
  "scmReconciliationDecisionBusyTargets",
  "scmReconciliationDecisionDrafts",
  "scmReconciliationTargetDecisionControlId",
  "updateScmReconciliationTargetDecisionDraft",
  "data-review-decision-note",
  "aria-labelledby",
  "aria-describedby",
  "aria-required",
  "role=\"status\" aria-live=\"polite\"",
  "scm-reconciliation-target-reason-details"
], "reviewable paginated dry-run order proposals");

const reconciliationSectionStart = control.indexOf("function renderScmReconciliationSection");
const reconciliationSectionEnd = control.indexOf(
  "function renderScmReconciliationSyncLink",
  reconciliationSectionStart
);
assert.ok(
  reconciliationSectionStart >= 0 && reconciliationSectionEnd > reconciliationSectionStart,
  "The dedicated reconciliation section renderer is missing."
);
const reconciliationSection = control.slice(reconciliationSectionStart, reconciliationSectionEnd);
assert.ok(
  reconciliationSection.indexOf("scm-reconciliation-manual-bar")
    < reconciliationSection.indexOf("scm-reconciliation-settings-disclosure"),
  "Manual reconciliation must render before collapsible nightly settings."
);
assert.ok(
  reconciliationSection.indexOf("scm-reconciliation-run-browser")
    < reconciliationSection.indexOf("scm-reconciliation-selected-detail"),
  "Run history must render to the left of the selected-run detail in DOM order."
);
const syncSectionStart = control.indexOf("function renderSyncSection");
const syncSectionEnd = control.indexOf("\nfunction ", syncSectionStart + 1);
const syncSection = control.slice(syncSectionStart, syncSectionEnd);
assert.ok(
  syncSection.includes("renderScmReconciliationSyncLink")
    && !syncSection.includes("renderScmReconciliationSection"),
  "Admin Sync must link to, not embed, the reconciliation workspace."
);
assert.ok(
  !control.includes("toggle-scm-reconciliation-targets"),
  "The dedicated master-detail page must not retain per-run expand/collapse controls."
);

const decisionSummaryStart = control.indexOf("function scmReconciliationRunSummary");
const decisionSummaryEnd = control.indexOf("function scmReconciliationRunMetricHtml", decisionSummaryStart);
assert.ok(
  decisionSummaryStart >= 0 && decisionSummaryEnd > decisionSummaryStart,
  "Dry-run decision summary helpers must remain independently testable."
);
const decisionSummaryContext = {
  firstDefined(object, keys, fallback) {
    for (const key of keys) {
      if (object?.[key] !== undefined && object?.[key] !== null) return object[key];
    }
    return fallback;
  },
  result: null
};
vm.runInNewContext(
  `${control.slice(decisionSummaryStart, decisionSummaryEnd)}
  result = {
    camelPending: scmReconciliationRunPendingDecisions({
      reviewDecisionSummary: { reviewTargets: 17, pendingTargets: 3 }
    }),
    camelCount: scmReconciliationRunReviewCount({
      summary: { reviewOrders: 16 },
      reviewDecisionSummary: { reviewTargets: 17, pendingTargets: 3 }
    }),
    snakePending: scmReconciliationRunPendingDecisions({
      review_decision_summary: { review_targets: 4, pending_targets: 2 }
    }),
    snakeCount: scmReconciliationRunReviewCount({
      review_decision_summary: { review_targets: 4, pending_targets: 2 }
    }),
    summaryFallback: scmReconciliationRunReviewCount({
      summary: { reviewOrders: 16 }
    })
  };`,
  decisionSummaryContext
);
assert.equal(decisionSummaryContext.result.camelPending, 3);
assert.equal(decisionSummaryContext.result.camelCount, 17, "Decision targets must be the displayed review count.");
assert.equal(decisionSummaryContext.result.snakePending, 2);
assert.equal(decisionSummaryContext.result.snakeCount, 4);
assert.equal(decisionSummaryContext.result.summaryFallback, 16);

const targetHelperStart = control.indexOf("function scmReconciliationTargetCalculatedOutcome");
const targetHelperEnd = control.indexOf("function renderScmReconciliationTargetDecision", targetHelperStart);
assert.ok(
  targetHelperStart >= 0 && targetHelperEnd > targetHelperStart,
  "Dry-run target presentation helpers must remain independently testable."
);
const targetHelpers = Function(
  `${control.slice(targetHelperStart, targetHelperEnd)}
   return {
     outcome: scmReconciliationTargetCalculatedOutcome,
     reason: scmReconciliationTargetReasonPresentation
   };`
)();
assert.equal(
  targetHelpers.outcome(
    { orderKind: "TO" },
    {
      reconciliationStatus: "review",
      quantities: { ordered: 100, fulfilled: 100, received: 100, abandoned: 0 }
    }
  ),
  "Completed",
  "A fully fulfilled and received TO should expose its calculated Completed outcome."
);
assert.equal(
  targetHelpers.outcome(
    { orderKind: "TO" },
    {
      reconciliationStatus: "review",
      quantities: { ordered: 100, fulfilled: 100, received: 80, abandoned: 0 }
    }
  ),
  "",
  "An incomplete TO must not expose an inferred Completed acceptance."
);
assert.equal(
  targetHelpers.outcome(
    { orderKind: "TO" },
    {
      reconciliationStatus: "missing",
      calculatedApplicationStatus: "Completed",
      quantities: { ordered: 100, fulfilled: 100, received: 100, abandoned: 0 }
    }
  ),
  "",
  "A missing NetSuite order must not expose Accept NetSuite outcome."
);
const longReason = [
  "NetSuite changed the first planned line.",
  "NetSuite changed the second planned line.",
  "NetSuite changed the third planned line."
].join(" ");
assert.equal(targetHelpers.reason(longReason).collapsed, true);
assert.equal(targetHelpers.reason(longReason).summary, "NetSuite changed the first planned line.");
assert.equal(targetHelpers.reason("One concise review reason.").collapsed, false);

includesAll(css, [
  ".scm-reconciliation-panel",
  ".scm-reconciliation-manual-bar",
  ".scm-reconciliation-settings-disclosure",
  ".scm-reconciliation-settings",
  ".scm-reconciliation-run-form",
  ".scm-reconciliation-run-options",
  ".scm-reconciliation-family-ref textarea",
  ".scm-reconciliation-workspace",
  ".scm-reconciliation-run-browser",
  ".scm-reconciliation-run-list-item",
  ".scm-reconciliation-selected-detail",
  ".scm-reconciliation-run-card",
  ".scm-reconciliation-result-grid",
  ".scm-reconciliation-status",
  ".scm-reconciliation-target-review",
  ".scm-reconciliation-target-card",
  ".scm-reconciliation-target-quantities",
  ".scm-reconciliation-target-decision",
  ".scm-reconciliation-target-reason-details",
  ".scm-reconciliation-decision-saved.draft",
  ".control-visually-hidden"
], "reconciliation control styling");

assert.match(
  css,
  /@media \(max-width: 900px\)[\s\S]*?\.scm-reconciliation-workspace\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/,
  "The master-detail reconciliation workspace must stack on narrower screens."
);

assert.match(
  css,
  /@media \(max-width: 760px\)[\s\S]*?\.scm-reconciliation-target-card > header\s*\{[^}]*flex-direction:\s*column/,
  "Mobile reviewed-order headers must stack vertically."
);
assert.match(
  css,
  /@media \(max-width: 760px\)[\s\S]*?\.scm-reconciliation-target-decision \.actions\s*\{[^}]*display:\s*grid/,
  "Mobile decision actions must use a deterministic one-column layout."
);

assert.ok(
  adminHtml.includes("/control.css?v=20260730-reconciliation-multi-ref-v1"),
  "Admin reconciliation CSS cache bust is missing."
);
assert.ok(
  adminHtml.includes("/control.js?v=20260825-so-reattempt-current-item-v1"),
  "Admin reconciliation client cache bust is missing."
);
assert.ok(
  controlHtml.includes("/control.css?v=20260825-so-reattempt-current-item-v1"),
  "Control reconciliation CSS cache bust is missing."
);
assert.ok(
  controlHtml.includes("/control.js?v=20260825-so-reattempt-current-item-v1"),
  "Control reconciliation client cache bust is missing."
);
includesAll(sidebar, [
  '{ label: "SO / PO / TO Reconcile", href: "/admin/reconciliation", controlSection: "reconciliation", icon: "RC" }'
], "dedicated reconciliation sidebar navigation");
for (const html of [adminHtml, controlHtml]) {
  assert.ok(
    html.includes("/app-sidebar.js?v=20260805-so-type-filter-v2"),
    "Reconciliation sidebar cache bust is missing."
  );
}

console.log("Admin SO/PO/TO reconciliation UI harness passed.");
