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
assert(predicateStart >= 0 && predicateEnd > predicateStart,
  "The targeted row filter predicate could not be isolated.");
const predicateContext = {
  scmScheduleFilters: {
    view: "scm working",
    search: "needle",
    status: ["Hold"],
    method: "Vendor",
    kind: "PO",
    dropoffPoint: "3445",
    brand: ["Acme"],
    from: "2026-08-01",
    to: "2026-08-03"
  },
  scmScheduleReviewOnly: false,
  scmScheduleCanViewRestrictedOrders: () => true,
  scmScheduleIsRestrictedOrder: () => false,
  scmScheduleFilterValues: (value) => Array.isArray(value) ? value : [value].filter(Boolean),
  scmScheduleNeedsReconciliationReview: () => false
};
vm.runInNewContext(`${client.slice(predicateStart, predicateEnd)}
  const matching = {
    orderRef: "PO-NEEDLE", party: "Acme Vendor", content: "Needle item",
    status: "Hold", method: "Vendor", orderKind: "PO", dropoffPoint: "3445 + 12441",
    brand: "Acme", etaDate: "2026-08-02", isBlanket: false
  };
  result = {
    matching: scmScheduleRowMatchesCurrentFilters(matching),
    wrongSearch: scmScheduleRowMatchesCurrentFilters({ ...matching, orderRef: "PO-OTHER", content: "Other item" }),
    wrongStatus: scmScheduleRowMatchesCurrentFilters({ ...matching, status: "Queued" }),
    wrongBrand: scmScheduleRowMatchesCurrentFilters({ ...matching, brand: "Other" })
  };`, predicateContext);
assert.deepEqual(
  JSON.parse(JSON.stringify(predicateContext.result)),
  { matching: true, wrongSearch: false, wrongStatus: false, wrongBrand: false },
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
