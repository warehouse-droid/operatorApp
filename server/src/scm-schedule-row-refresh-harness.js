import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

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
