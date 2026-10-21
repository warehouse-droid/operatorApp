import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../../../public/scm-schedule.js", import.meta.url), "utf8");

function scheduleContext(path = "/scm/POTOschedule") {
  const storage = new Map();
  const app = { addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; } };
  const context = vm.createContext({
    document: { getElementById: () => app, addEventListener() {} },
    window: { location: { pathname: path }, addEventListener() {} },
    URLSearchParams,
    localStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    requireDispatchLogin() {}
  });
  vm.runInContext(source, context);
  vm.runInContext('scmScheduleOperator = { id: "test-user", role: "admin" }; scmScheduleFilters.view = scmScheduleDefaultViewForRole();', context);
  return (script) => JSON.parse(vm.runInContext(`JSON.stringify(${script})`, context));
}

test("Direct ship filters persist and display the linked orders", () => {
  const run = scheduleContext();
  assert.deepEqual(run('saveLocalScmScheduleFilterPreference({ status: ["Direct ship"] })').status, ["Direct ship"]);
  assert.deepEqual(run("loadLocalScmScheduleFilterPreference()").status, ["Direct ship"]);
  assert.deepEqual(run(`(() => {
    scmScheduleFilters.status = ["Direct ship"];
    return [
      { orderKind: "PO", status: "Queued", calculatedStatus: "Direct ship" },
      { orderKind: "TO", status: "Queued", calculatedStatus: "Direct ship" },
      { orderKind: "PO", status: "Queued" }
    ].map(scmScheduleRowMatchesCurrentFilters);
  })()`), [true, true, false]);
});

test("Direct ship renders as a system status without a manual status editor", () => {
  const run = scheduleContext();
  for (const orderKind of ["PO", "TO"]) {
    const html = run(`scmScheduleTableRowHtml({ orderKind: "${orderKind}", orderRef: "DIRECT-SCHEDULE", method: "MBT", calculatedStatus: "Direct ship" })`);
    assert.match(html, />Direct ship</);
    assert.doesNotMatch(html, /data-field="status"/);
  }
});

test("legacy and multiple saved filters normalize and round trip through browser storage", () => {
  const run = scheduleContext();
  assert.deepEqual(run('normalizeScmSchedulePersistedFilters({ kind: "sp.o", method: "Vendor", status: "Queued" })'), {
    kind: ["Sp.O"], method: ["Vendor"], dropoffPoint: [], status: ["Queued"]
  });
  const filters = { kind: ["Sp.O", "TO"], method: ["MBT", "Vendor"], dropoffPoint: ["3445", "2967"], status: ["Queued"] };
  assert.deepEqual(run(`saveLocalScmScheduleFilterPreference(${JSON.stringify(filters)})`), filters);
  assert.deepEqual(run("loadLocalScmScheduleFilterPreference()"), filters);
  assert.deepEqual(run('normalizeScmSchedulePersistedFilters({ kinds: ["po", "PO", "invalid"], methods: ["MBT", "MBT", "Courier"], dropoffPoints: ["3445", "unknown"] })'), {
    kind: ["PO"], method: ["MBT"], dropoffPoint: ["3445"], status: []
  });
});

test("queries send repeated selections and ignore the hidden Method filter in Dispatch", () => {
  const run = scheduleContext();
  const query = run('(() => { Object.assign(scmScheduleFilters, { kind: ["PO", "TO"], method: ["Vendor", "MBT"], dropoffPoint: ["3445", "150"] }); return scmScheduleQuery(); })()');
  const params = new URLSearchParams(query.slice(1));
  assert.deepEqual(params.getAll("kind"), ["PO", "TO"]);
  assert.deepEqual(params.getAll("method"), ["Vendor", "MBT"]);
  assert.deepEqual(params.getAll("dropoffPoint"), ["3445", "150"]);
  assert.equal(run('(() => { scmScheduleFilters.view = "dispatch"; return new URLSearchParams(scmScheduleQuery().slice(1)).has("method"); })()'), false);
  assert.equal(run('(() => { clearScmScheduleColumnFilters(); return scmScheduleHasColumnFilters(); })()'), false);
});

test("selections use OR within a column and AND between columns, including special POs and combined yards", () => {
  const run = scheduleContext();
  const result = run(`(() => {
    Object.assign(scmScheduleFilters, { method: ["MBT", "Vendor"], kind: ["Sp.O", "TO"], dropoffPoint: ["3445", "150"] });
    const row = { orderKind: "PO", isSpecialOrder: true, method: "Vendor", dropoffPoint: "2967 + 3445", status: "Queued" };
    return [row, { ...row, orderKind: "TO", isSpecialOrder: false, method: "MBT", dropoffPoint: "150" },
      { ...row, isSpecialOrder: false }, { ...row, method: "Customer Pickup" }, { ...row, dropoffPoint: "2967" }]
      .map(scmScheduleRowMatchesCurrentFilters);
  })()`);
  assert.deepEqual(result, [true, true, false, false, false]);
});

test("column click sequence changes the result and repeated clicks reverse and promote that column", () => {
  const run = scheduleContext();
  const rows = [
    { orderRef: "PO-A", orderKind: "PO", brand: "A" },
    { orderRef: "VRMA-B", orderKind: "VRMA", brand: "B" },
    { orderRef: "PO-B", orderKind: "PO", brand: "B" },
    { orderRef: "VRMA-A", orderKind: "VRMA", brand: "A" }
  ];
  assert.deepEqual(run(`(() => { scmScheduleRows = ${JSON.stringify(rows)}; sortScmScheduleByColumn("type"); sortScmScheduleByColumn("brand"); return scmScheduleDisplayRows().map(row => row.orderRef); })()`),
    ["PO-A", "VRMA-A", "PO-B", "VRMA-B"]);
  assert.deepEqual(run('(() => { scmScheduleSorts = [{ key: "date", direction: "ascending" }]; sortScmScheduleByColumn("brand"); sortScmScheduleByColumn("type"); return scmScheduleDisplayRows().map(row => row.orderRef); })()'),
    ["PO-A", "PO-B", "VRMA-A", "VRMA-B"]);
  assert.deepEqual(run('(() => { sortScmScheduleByColumn("brand"); return { rows: scmScheduleDisplayRows().map(row => row.orderRef), sorts: scmScheduleSorts }; })()'), {
    rows: ["PO-B", "VRMA-B", "PO-A", "VRMA-A"],
    sorts: [{ key: "brand", direction: "descending" }, { key: "type", direction: "ascending" }, { key: "date", direction: "ascending" }]
  });
});

test("default dates ascend, numeric fields sort numerically, and blanks remain last in both directions", () => {
  const run = scheduleContext();
  const rows = [
    { orderRef: "PO-100", queuedDate: "2026-10-03", weightLbs: 100, slaDays: 100 },
    { orderRef: "PO-10", queuedDate: "2026-10-02", weightLbs: 10, slaDays: 10 },
    { orderRef: "PO-2", queuedDate: "2026-10-01", weightLbs: 2, slaDays: 2 },
    { orderRef: "PO-EMPTY", queuedDate: "", weightLbs: null, slaDays: null }
  ];
  assert.deepEqual(run(`(() => { scmScheduleRows = ${JSON.stringify(rows)}; return scmScheduleDisplayRows().map(row => row.orderRef); })()`),
    ["PO-2", "PO-10", "PO-100", "PO-EMPTY"]);
  for (const key of ["weight", "sla", "order"]) {
    assert.deepEqual(run(`(() => { sortScmScheduleByColumn("${key}"); return scmScheduleDisplayRows().map(row => row.orderRef); })()`),
      ["PO-2", "PO-10", "PO-100", "PO-EMPTY"]);
    const expected = key === "order" ? ["PO-EMPTY", "PO-100", "PO-10", "PO-2"] : ["PO-100", "PO-10", "PO-2", "PO-EMPTY"];
    assert.deepEqual(run(`(() => { sortScmScheduleByColumn("${key}"); return scmScheduleDisplayRows().map(row => row.orderRef); })()`), expected);
  }
});

test("all data headers and each timing field offer keyboard accessible sorting", () => {
  const run = scheduleContext();
  for (const column of run("SCM_SCHEDULE_COLUMNS")) {
    const html = run(`scmScheduleHeaderHtml(${JSON.stringify(column)})`);
    if (column.utility) assert.doesNotMatch(html, /data-action="sort-column"/);
    else assert.match(html, /<button[^>]+data-action="sort-column"[^>]+aria-label="Sort/);
  }
  const timing = run('scmScheduleColumnFilterHtml({key: "timing"})');
  for (const key of ["eta", "driver", "sla"]) assert.match(timing, new RegExp(`data-sort-key="${key}"`));
  assert.equal(scheduleContext("/dispatch/po-to-schedule")("scmScheduleCanShowMethodFilter()"), false);
  assert.equal(scheduleContext("/sales/schedule")("scmScheduleCanShowMethodFilter()"), true);
});
