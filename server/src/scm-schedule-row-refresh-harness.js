import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const [client, server, repository] = await Promise.all([
  readFile(new URL("../public/scm-schedule.js", import.meta.url), "utf8"),
  readFile(new URL("./server.js", import.meta.url), "utf8"),
  readFile(new URL("./dispatch-repository.js", import.meta.url), "utf8")
]);

for (const expected of [
  "function scmScheduleTableRowHtml",
  "function replaceScmScheduleRow",
  "function scmScheduleRowMatchesCurrentFilters",
  "function migrateScmScheduleRowState",
  "data-schedule-row=",
  "payload?.row",
  "replaceScmScheduleRow(rowId, payload?.row)",
  "It no longer matches the current filters.",
  "target.disabled = true",
  'target.textContent = "Saving"'
]) {
  assert(client.includes(expected), `Targeted schedule row refresh is missing ${expected}.`);
}

const predicateStart = client.indexOf("function scmScheduleRowMatchesCurrentFilters");
const predicateEnd = client.indexOf("function moveScmScheduleMapEntry", predicateStart);
const predicateHelpersStart = client.indexOf("function scmScheduleTextFilterMatches");
const statusHelperStart = client.indexOf("function scmScheduleFirstValue");
const statusHelperEnd = client.indexOf("function scmScheduleReconciliationStatus", statusHelperStart);
assert(predicateStart >= 0 && predicateEnd > predicateStart,
  "The targeted row filter predicate could not be isolated.");
assert(predicateHelpersStart >= 0 && predicateHelpersStart < predicateStart,
  "The targeted row column-filter helpers could not be isolated.");
assert(statusHelperStart >= 0 && statusHelperEnd > statusHelperStart,
  "The effective-status helper dependency could not be isolated.");
const predicateContext = {
  scmScheduleFilters: {
    view: "scm working",
    search: "needle",
    status: ["Hold"],
    method: "Vendor",
    kind: "PO",
    queuedFrom: "2026-07-31",
    queuedTo: "2026-08-01",
    pickup: "alliance",
    dropoffPoint: "3445",
    brand: ["Acme"],
    contentSearch: "needle",
    remarkSearch: "priority",
    orderSearch: "po-needle",
    weightMin: "900",
    weightMax: "1100",
    packingSearch: "pack-77",
    from: "2026-08-01",
    to: "2026-08-03",
    driverSearch: "alex",
    slaMin: "1",
    slaMax: "3"
  },
  scmScheduleReviewOnly: false,
  scmScheduleCanViewRestrictedOrders: () => true,
  scmScheduleIsRestrictedOrder: () => false,
  scmScheduleFilterValues: (value) => Array.isArray(value) ? value : [value].filter(Boolean),
  scmScheduleNeedsReconciliationReview: () => false
};
vm.runInNewContext(`${client.slice(statusHelperStart, statusHelperEnd)}
  ${client.slice(predicateHelpersStart, predicateStart)}
  ${client.slice(predicateStart, predicateEnd)}
  const matching = {
    orderRef: "PO-NEEDLE", party: "Acme Vendor", content: "Needle item",
    status: "Hold", method: "Vendor", orderKind: "PO", dropoffPoint: "3445 + 12441",
    brand: "Acme", queuedDate: "2026-08-01", pickupPoint: "Alliance yard",
    remark: "Priority shipment", weightLbs: 1000, packingSlipRef: "PACK-77",
    etaDate: "2026-08-02", driver: "Alex", slaDays: 1, isBlanket: false
  };
  result = {
    matching: scmScheduleRowMatchesCurrentFilters(matching),
    wrongSearch: scmScheduleRowMatchesCurrentFilters({ ...matching, orderRef: "PO-OTHER", content: "Other item" }),
    wrongStatus: scmScheduleRowMatchesCurrentFilters({ ...matching, status: "Queued" }),
    wrongBrand: scmScheduleRowMatchesCurrentFilters({ ...matching, brand: "Other" }),
    wrongPickup: scmScheduleRowMatchesCurrentFilters({ ...matching, pickupPoint: "Other yard" }),
    wrongRemark: scmScheduleRowMatchesCurrentFilters({ ...matching, remark: "Routine" }),
    wrongWeight: scmScheduleRowMatchesCurrentFilters({ ...matching, weightLbs: 1200 }),
    wrongPacking: scmScheduleRowMatchesCurrentFilters({ ...matching, packingSlipRef: "OTHER" }),
    wrongDriver: scmScheduleRowMatchesCurrentFilters({ ...matching, driver: "Sam" }),
    wrongSla: scmScheduleRowMatchesCurrentFilters({ ...matching, slaDays: 4 })
  };`, predicateContext);
assert.deepEqual(
  JSON.parse(JSON.stringify(predicateContext.result)),
  {
    matching: true,
    wrongSearch: false,
    wrongStatus: false,
    wrongBrand: false,
    wrongPickup: false,
    wrongRemark: false,
    wrongWeight: false,
    wrongPacking: false,
    wrongDriver: false,
    wrongSla: false
  },
  "Global search and every selected column filter must be applied conjunctively to a refreshed row."
);

const saveHandler = client.match(/if \(action === "save-row"\) \{([\s\S]*?)\n  \}\n\}\);/)?.[1] || "";
assert(saveHandler, "The PO/TO Schedule save handler could not be inspected.");
assert(!saveHandler.includes("renderScmSchedule();"),
  "Saving one row still renders the entire schedule.");
assert.equal((saveHandler.match(/await loadScmSchedule\(\)/g) || []).length, 1,
  "A full schedule reload must exist only as the compatibility fallback.");
assert.match(
  saveHandler,
  /if \(!replacement\.replaced\) \{[\s\S]*?await loadScmSchedule\(\);/,
  "The compatibility reload is not gated on a missing targeted row response."
);
assert.match(
  client,
  /function replaceScmScheduleRow[\s\S]*?scrollTop[\s\S]*?scrollLeft[\s\S]*?insertAdjacentHTML[\s\S]*?oldElement\.remove\(\)/,
  "Targeted row replacement does not preserve scroll or swap only the matching DOM row."
);
for (const state of [
  "scmScheduleSelectedRows",
  "scmScheduleExpandedReconciliationRows",
  "scmSchedulePoSplitLineOptions",
  "scmSchedulePoSplitLineOptionsErrors",
  "scmSchedulePoSplitLineOptionsLoading",
  "scmSchedulePoSplitLineAdjustmentBusy"
]) {
  assert(client.includes(state), `Targeted row replacement does not preserve ${state}.`);
}

for (const expected of [
  "async function refreshedScmScheduleRow",
  "SELECT order_kind, order_ref",
  "exactRef: identity.order_ref",
  "enrichScmScheduleWithReconciliation([row]",
  "? { row: await refreshedScmScheduleRow(updated, operator) }"
]) {
  assert(server.includes(expected), `Single-row server hydration is missing ${expected}.`);
}
assert.equal(
  (server.match(/\? \{ row: await refreshedScmScheduleRow\(updated, operator\) \}/g) || []).length,
  2,
  "Both schedule create and update endpoints must return a hydrated row."
);
for (const expected of [
  'exactRef = ""',
  "const cleanExactRef",
  "lower(t.tranid) = lower($10)",
  "lower(v.vrma_ref) = lower($10)"
]) {
  assert(repository.includes(expected), `Exact schedule row query is missing ${expected}.`);
}

console.log("PO/TO Schedule targeted row save/refresh harness passed.");
