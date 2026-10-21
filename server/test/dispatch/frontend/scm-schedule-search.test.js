import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import fc from "fast-check";

const source = readFileSync(new URL("../../../public/scm-schedule.js", import.meta.url), "utf8");
const surfaces = [
  ["/sales/schedule", "sales", "yard manager"],
  ["/dispatch/po-to-schedule", "dispatcher", "dispatch"],
  ["/dispatch/po-to-schedule", "admin", "completed"],
  ["/dispatch/po-to-schedule", "scm", "dispatch"],
  ["/scm/POTOschedule", "dispatcher", "dispatch"]
];
const rows = [
  { orderKind: "PO", orderRef: "SEARCH-QUEUED", status: "Queued", method: "MBT" },
  { orderKind: "TO", orderRef: "SEARCH-COMPLETED", status: "Completed", method: "Vendor" },
  { orderKind: "PO", orderRef: "SEARCH-CANCELLED", status: "Cancelled", method: "Customer Pickup" },
  { orderKind: "PO", orderRef: "SEARCH-SPECIAL", status: "Priority", isSpecialOrder: true },
  { orderKind: "PO", orderRef: "SEARCH-BLANKET", status: "Queued", isBlanket: true },
  { orderKind: "VRMA", orderRef: "SEARCH-VRMA", status: "Completed" },
  { orderKind: "PO", orderRef: "SEARCH-HOLD", status: "Hold" },
  { orderKind: "TO", orderRef: "SEARCH-RECON-HOLD", status: "Queued", reconciliationApplicationStatus: "Hold" },
  { orderKind: "PO", orderRef: "OTHER", status: "Queued" }
];
const expected = rows.slice(0, 6).map((row) => row.orderRef);

function contextFor(path, role) {
  const storage = new Map();
  const app = { addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; } };
  const context = vm.createContext({
    document: { getElementById: () => app, addEventListener() {}, activeElement: null },
    window: { location: { pathname: path }, addEventListener() {} },
    URLSearchParams,
    localStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    requireDispatchLogin() {},
    fetch: async (url) => ({ ok: true, json: async () => url.includes("formatting") ? { rules: {} }
      : url.includes("presets") ? [] : rows.filter((row) => row.orderRef.includes("SEARCH")) })
  });
  vm.runInContext(source, context, { filename: new URL("../../../public/scm-schedule.js", import.meta.url).pathname });
  vm.runInContext(`scmScheduleOperator = { id: "search-user", role: ${JSON.stringify(role)} };`, context);
  const run = (script) => JSON.parse(vm.runInContext(`JSON.stringify(${script})`, context));
  return { context, run, storage };
}

for (const [path, role, view] of surfaces) {
  test(`${role} ${path} searches across filters, statuses and types, excluding Hold`, () => {
    const { run } = contextFor(path, role);
    const result = run(`(() => {
      Object.assign(scmScheduleFilters, { view: ${JSON.stringify(view)}, search: "  sEaRcH  ",
        status: ["Urgent"], kind: ["TO"], method: ["MBT"], dropoffPoint: ["150"],
        brand: ["different"], from: "2099-01-01", to: "2099-01-02", weightMin: "999999",
        contentSearch: "different", orderSearch: "different", packingSearch: "different" });
      scmScheduleReviewOnly = true;
      scmScheduleRows = ${JSON.stringify(rows)};
      return { query: scmScheduleQuery(), refs: scmScheduleRows.filter(scmScheduleRowMatchesCurrentFilters).map(row => row.orderRef),
        filters: scmScheduleFilters };
    })()`);
    assert.deepEqual(result.refs.sort(), [...expected].sort());
    const params = new URLSearchParams(result.query.slice(1));
    assert.equal(params.get("search"), "sEaRcH");
    for (const key of ["view", "status", "kind", "method", "dropoffPoint", "brand", "from", "to", "weightMin", "contentSearch", "orderSearch", "packingSearch", "reconciliationStatus"]) {
      assert.equal(params.has(key), false, `${key} should not constrain a global search`);
    }
    if (path.startsWith("/dispatch/")) assert.equal(params.get("surface"), "dispatch");
    assert.deepEqual(result.filters.kind, ["TO"]);
    assert.deepEqual(result.filters.status, ["Urgent"]);
  });

  test(`${role} ${path} loads non-Hold historical and Blanket results without hiding them`, async () => {
    const { context, run } = contextFor(path, role);
    vm.runInContext(`scmScheduleFilters.search = "SEARCH"; scmScheduleFilters.view = ${JSON.stringify(view)};`, context);
    await vm.runInContext("loadScmSchedule()", context);
    assert.equal(run("scmScheduleNotice"), "");
    assert.deepEqual(run("scmScheduleDisplayRows().map(row => row.orderRef)").sort(), [...expected].sort());
  });
}

test("clearing global search restores stored column filters and ordinary restricted-row visibility", () => {
  const { run, storage } = contextFor("/sales/schedule", "sales");
  const result = run(`(() => {
    scmScheduleFilters.view = "yard manager";
    Object.assign(scmScheduleFilters, { kind: ["PO"], status: ["Queued"] });
    saveLocalScmScheduleFilterPreference();
    scmScheduleRows = ${JSON.stringify(rows)};
    scmScheduleFilters.search = "SEARCH";
    const searched = scmScheduleRows.filter(scmScheduleRowMatchesCurrentFilters).map(row => row.orderRef);
    scmScheduleFilters.search = " \t ";
    return { searched, restored: scmScheduleRows.filter(scmScheduleRowMatchesCurrentFilters).map(row => row.orderRef),
      query: scmScheduleQuery(), saved: loadLocalScmScheduleFilterPreference() };
  })()`);
  assert.deepEqual(result.searched.sort(), [...expected].sort());
  assert.deepEqual(result.restored.sort(), ["OTHER", "SEARCH-QUEUED"]);
  assert.deepEqual(result.saved.kind, ["PO"]);
  assert.deepEqual(result.saved.status, ["Queued"]);
  assert.equal(storage.size, 1);
  assert.equal(new URLSearchParams(result.query.slice(1)).has("search"), false);
});

test("SCM structured search keeps its existing type, method and column filters", () => {
  const { run } = contextFor("/scm/POTOschedule", "scm");
  const result = run(`(() => {
    Object.assign(scmScheduleFilters, { view: "scm working", search: "SEARCH", kind: ["TO"], method: ["MBT"], brand: ["different"] });
    scmScheduleRows = ${JSON.stringify(rows)};
    return { query: scmScheduleQuery(), refs: scmScheduleRows.filter(scmScheduleRowMatchesCurrentFilters).map(row => row.orderRef) };
  })()`);
  const params = new URLSearchParams(result.query.slice(1));
  assert.deepEqual(params.getAll("kind"), ["TO"]);
  assert.deepEqual(params.getAll("method"), ["MBT"]);
  assert.deepEqual(params.getAll("brand"), ["different"]);
  assert.deepEqual(result.refs, []);
});

test("property: global search matches text across every type/status except Hold, independent of browse filters", () => {
  const { run } = contextFor("/dispatch/po-to-schedule", "dispatcher");
  fc.assert(fc.property(
    fc.constantFrom("PO", "TO", "VRMA"),
    fc.constantFrom("Queued", "Hold", "Completed", "Cancelled", "Priority", "Reconcile Review", "In Transit"),
    fc.boolean(), fc.boolean(),
    (orderKind, status, isBlanket, matches) => {
      const row = { orderKind, status, isBlanket, orderRef: matches ? "pRoPeRtY-123" : "unrelated", method: "Vendor" };
      const actual = run(`(() => {
        Object.assign(scmScheduleFilters, { view: "dispatch", search: "PROPERTY", kind: ["TO"], status: ["Urgent"], brand: ["other"] });
        return scmScheduleRowMatchesCurrentFilters(${JSON.stringify(row)});
      })()`);
      assert.equal(actual, matches && status !== "Hold");
    }
  ), { numRuns: 200, seed: 20261014 });
});
