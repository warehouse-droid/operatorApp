import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const [schedule, poSplit, vrma, css, repository, enrichment, server, scheduleHtml, poHtml, vrmaHtml] = await Promise.all([
  "../public/scm-schedule.js",
  "../public/dispatch-scm.js",
  "../public/scm-vrma.js",
  "../public/dispatch.css",
  "dispatch-repository.js",
  "dispatch-enrichment.js",
  "server.js",
  "../public/scm-schedule.html",
  "../public/dispatch-scm.html",
  "../public/scm-vrma.html"
].map((file) => readFile(new URL(file, import.meta.url), "utf8")));

function includesAll(source, values, label) {
  for (const value of values) assert.ok(source.includes(value), label + " is missing: " + value);
}

includesAll(schedule, [
  'return !scmScheduleDispatchHost && scmScheduleFilters.view === "scm working";',
  'if (scmScheduleDispatchHost) return canViewRestricted ? ["dispatch", "completed"] : ["dispatch"];',
  'if (scmScheduleDispatchHost) return "dispatch";'
], "Dispatch-hosted schedule restriction");

includesAll(schedule, [
  "SCM_SCHEDULE_SHEET_PREF_KEY",
  "data-sheet-setting=\"fontSize\"",
  "data-sheet-setting=\"rowHeight\"",
  "scm-column-resizer",
  "grid.style.gridTemplateColumns",
  "loadScmSchedulePresetsOnce()",
  "renderScheduleTableRows({ pickupOptions, dropoffOptions })",
  "schedule-groups?includeSchedule=false",
  "?includeSchedule=false`",
  'status: [], method: "", kind: "", dropoffPoint: "", brand: []',
  "scmScheduleMultiFilterHtml",
  "data-multi-filter-option",
  "queueScmScheduleSearch",
  'params.set("search", search);',
  "scmScheduleLoadRequestId"
], "Resizable schedule grid, multi-select filters, and global onchange search");
const scheduleQueryStart = schedule.indexOf("function scmScheduleQuery");
const scheduleQueryEnd = schedule.indexOf("function normalizeScmSchedulePayload", scheduleQueryStart);
assert(scheduleQueryStart >= 0 && scheduleQueryEnd > scheduleQueryStart,
  "The PO/TO Schedule query builder could not be isolated.");
const scheduleQueryContext = {
  scmScheduleFilters: {
    view: "scm working",
    search: "cement",
    status: ["Hold", "Queued"],
    method: "Vendor",
    kind: "PO",
    dropoffPoint: "3445",
    brand: ["Acme"],
    from: "2026-08-01",
    to: "2026-08-31"
  },
  scmScheduleReviewOnly: true,
  scmScheduleCanShowScmWorkingControls: () => true,
  URLSearchParams
};
vm.runInNewContext(
  `${schedule.slice(scheduleQueryStart, scheduleQueryEnd)}; result = scmScheduleQuery();`,
  scheduleQueryContext
);
const combinedScheduleParams = new URLSearchParams(String(scheduleQueryContext.result).replace(/^\?/, ""));
assert.equal(combinedScheduleParams.get("search"), "cement");
assert.deepEqual(combinedScheduleParams.getAll("status"), ["Hold", "Queued"]);
for (const [key, value] of [
  ["view", "scm working"],
  ["method", "Vendor"],
  ["kind", "PO"],
  ["dropoffPoint", "3445"],
  ["brand", "Acme"],
  ["from", "2026-08-01"],
  ["to", "2026-08-31"],
  ["reconciliationStatus", "review"]
]) assert.equal(combinedScheduleParams.get(key), value,
  `${key} must remain active alongside global search.`);

includesAll(poSplit, [
  "function scmLineSalesQuantity",
  "quantities.pallets) * scmNumber(item.toPlt)",
  "quantities.layers) * scmNumber(item.toLyr)",
  "quantities.sections) * scmNumber(item.toSec)",
  "quantities.pieces) * scmNumber(item.toPcs)",
  "scmLineSalesQuantity(item, quantities) * scmNumber(item.itemWeight)",
  'maximumFractionDigits: 0',
  "function scmItemWeightText",
  't("dispatch.weightPerPallet", "Weight per PLT")',
  "scmNumber(item.itemWeight) * palletConversion",
  'data-scm-line-weight=',
  'item.lineWeight',
  'dispatch.availableLineWeight',
  'dispatch.totalSelectedWeight',
  'scmWeightLabel(order.weight)',
  'class="scm-detail-total-weight"',
  'dispatch.splitPoTotalWeight',
  'dispatch.poTotalWeight'
], "PO Split weight UI");

includesAll(vrma, [
  "function vrmaLineSalesQuantity",
  "line.palletQty) * vrmaNumber(line.item.toPlt)",
  "line.layerQty) * vrmaNumber(line.item.toLyr)",
  "line.sectionQty) * vrmaNumber(line.item.toSec)",
  "line.pieceQty) * vrmaNumber(line.item.toPcs)",
  "vrmaLineSalesQuantity(line) * vrmaNumber(line.item?.itemWeight)",
  "Unit weight:",
  "data-vrma-line-weight",
  "updateVrmaLineWeightDisplay(line)",
  'data-action="delete-vrma"',
  'method: "DELETE"',
  "expectedUpdatedAt: scmVrmaDraft.concurrencyUpdatedAt",
  "function activeVrmaRows"
], "VRMA weight and safe-delete UI");
assert.ok(
  !/SCM_VRMA_MANUAL_STATUSES\s*=\s*\[[^\]]*"Cancelled"/.test(vrma),
  "VRMA cancellation must use the audited Delete VRMA workflow."
);

includesAll(repository, [
  "'itemWeight', COALESCE(l.item_weight, 0)",
  "'lineWeight', GREATEST(",
  "itemWeight: positiveQuantity(row.item_weight)",
  "weightLbs: quantity * itemWeight"
], "SCM item-weight API data");
includesAll(css, [
  ".scm-line-totals",
  ".scm-line-selected-weight",
  ".vrma-line-weight",
  ".scm-sheet-settings",
  ".scm-column-resizer",
  "--scm-schedule-row-height",
  "align-items: center"
], "SCM weight and schedule layout styles");
includesAll(repository, [
  "createPurchaseOrderDispatchEnricher({ allowOllama: false })",
  'schedulePoEnricher(po, { mappedLocalVendor: po.local_vendor || "" })',
  "plan_order_types AS MATERIALIZED",
  "JOIN plan_order_types plan_order",
  "plan_order.plan_id = snap.plan_id",
  "normalizeScmScheduleFilterValues",
  "cardinality($2::text[]) = 0",
  "status = ANY($2::text[])",
  "cardinality($6::text[]) = 0",
  "normalizeScmScheduleFilterValues(status)",
  'String(view || "").trim().toLowerCase()',
  "load.value->>'driverName'",
  "load.value->>'truckPlate'",
  "NULLIF(s.dispatch_assignment_note, '')",
  "dispatch_assignment_note = EXCLUDED.dispatch_assignment_note"
], "Batched enrichment, type-safe planning, multi-value filters, and conjunctive global search");
const scheduleParamsStart = repository.indexOf("const params = [", repository.indexOf("export async function listScmSchedule"));
const scheduleParamsEnd = repository.indexOf("const result = await query", scheduleParamsStart);
assert(scheduleParamsStart >= 0 && scheduleParamsEnd > scheduleParamsStart,
  "The PO/TO Schedule repository filter parameters could not be isolated.");
assert.doesNotMatch(
  repository.slice(scheduleParamsStart, scheduleParamsEnd),
  /globalSearch\s*\?/,
  "Global search must not clear structured schedule filters before the SQL query."
);
includesAll(enrichment, [
  "export async function createPurchaseOrderDispatchEnricher",
  "Array.isArray(options.vendorYards)",
  'hasOwnProperty.call(options, "mappedLocalVendor")',
  "options.allowOllama !== false"
], "Reusable PO enrichment context");
assert.equal((server.match(/req\.query\.includeSchedule === "false"/g) || []).length, 3, "Schedule mutations must support omitting unused full-list responses.");
assert.ok(scheduleHtml.includes("/scm-schedule.js?v=20260801-conjunctive-filters-v1"), "Schedule cache bust missing.");
assert.ok(poHtml.includes("/dispatch-scm.js?v=20260723-po-type-filters-v1"), "PO Split cache bust missing.");
assert.ok(vrmaHtml.includes("/scm-vrma.js?v=20260730-vrma-delete-v1"), "VRMA cache bust missing.");

const poStart = poSplit.indexOf("function scmNumber");
const poEnd = poSplit.indexOf("function scmHasConversion");
assert.ok(poStart >= 0 && poEnd > poStart, "PO weight helper block not found.");
const poContext = {};
vm.runInNewContext(
  poSplit.slice(poStart, poEnd) + "\nresult = scmLineWeight({ toPlt: 100, toLyr: 10, toSec: 0, toPcs: 1, itemWeight: 0.5 }, { pallets: 2, layers: 3, sections: 0, pieces: 4, salesQty: 0 });",
  poContext
);
assert.equal(poContext.result, 117, "PO mixed-unit weight must use server-equivalent stock quantity (234 x 0.5 lb).");
const poPalletContext = { t: (_key, fallback) => fallback };
vm.runInNewContext(
  poSplit.slice(poStart, poEnd) + "\nresult = scmItemWeightText({ toPlt: 100, itemWeight: 0.5, unit: 'SQFT' });",
  poPalletContext
);
assert.equal(poPalletContext.result, "Weight per PLT: 50 lb / PLT", "PO converted item must display pallet weight instead of sales-unit weight.");
const poRoundedContext = { t: (_key, fallback) => fallback };
vm.runInNewContext(
  poSplit.slice(poStart, poEnd) + "\nresult = scmWeightLabel(50.6);",
  poRoundedContext
);
assert.equal(poRoundedContext.result, "51 lb", "PO weight displays must round to whole pounds.");

const vrmaStart = vrma.indexOf("function vrmaNumber");
const vrmaEnd = vrma.indexOf("function vrmaLineFromOrder");
assert.ok(vrmaStart >= 0 && vrmaEnd > vrmaStart, "VRMA weight helper block not found.");
const vrmaContext = {};
vm.runInNewContext(
  vrma.slice(vrmaStart, vrmaEnd) + "\nresult = vrmaLineWeight({ item: { toPlt: 100, toLyr: 10, toSec: 0, toPcs: 1, itemWeight: 0.5 }, palletQty: 2, layerQty: 3, sectionQty: 0, pieceQty: 4, quantity: 0 });",
  vrmaContext
);
assert.equal(vrmaContext.result, 117, "VRMA mixed-unit weight must match persisted server weight.");

console.log("SCM schedule filters, global search, layout, performance, restriction, and item-weight harness passed.");
