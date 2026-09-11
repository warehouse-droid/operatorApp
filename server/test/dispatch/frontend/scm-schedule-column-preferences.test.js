import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import fc from "fast-check";

const source = readFileSync(new URL("../../../public/scm-schedule.js", import.meta.url), "utf8");

function scheduleContext(saved = {}, failRead = false) {
  const values = new Map(Object.entries(saved));
  const app = { addEventListener() {}, querySelector() { return null; } };
  const context = vm.createContext({
    document: { getElementById: () => app, addEventListener() {} },
    window: { location: { pathname: "/scm/POTOschedule" }, addEventListener() {} },
    localStorage: {
      getItem(key) {
        if (failRead) throw new Error("Storage unavailable");
        return values.get(key) || null;
      },
      setItem(key, value) { values.set(key, value); }
    },
    requireDispatchLogin() {}
  });
  vm.runInContext(source, context);
  vm.runInContext('scmScheduleOperator = {id: "ui-admin", role: "admin"}; scmScheduleFilters.view = "scm working"; loadScmScheduleColumnPreferences();', context);
  return { context, values };
}

test("arbitrary saved column subsets never hide every data column or create unknown columns", () => {
  const { context } = scheduleContext();
  const keys = JSON.parse(vm.runInContext("JSON.stringify(SCM_SCHEDULE_COLUMNS.map(column => column.key))", context));
  fc.assert(fc.property(fc.array(fc.oneof(fc.constantFrom(...keys), fc.string()), { maxLength: 35 }), (hiddenColumns) => {
    const { context: subject } = scheduleContext({
      "mbbs.scmSchedule.columns.v1.scm.ui-admin": JSON.stringify({ hiddenColumns })
    });
    const data = JSON.parse(vm.runInContext("JSON.stringify({visible: scmScheduleVisibleColumns(), hidden: [...scmScheduleHiddenColumns]})", subject));
    assert.ok(data.visible.some((column) => !column.utility));
    assert.ok(data.visible.every((column) => keys.includes(column.key)));
    assert.ok(data.hidden.every((key) => keys.includes(key)));
    for (const key of keys.filter((key) => !hiddenColumns.includes(key))) {
      assert.ok(data.visible.some((column) => column.key === key), `Unhidden ${key} must remain visible`);
    }
    const requestedData = keys.filter((key) => !["select", "action"].includes(key));
    if (requestedData.some((key) => !hiddenColumns.includes(key))) {
      for (const key of keys.filter((key) => hiddenColumns.includes(key))) {
        assert.equal(data.visible.some((column) => column.key === key), false);
      }
    }
  }), { numRuns: 250, seed: 20260910 });
});

test("old widths and text settings remain intact while the compact column gets its own width", () => {
  const { context } = scheduleContext({
    "mbbs.scmSchedule.sheetPreferences.v1": JSON.stringify({ fontSize: 14, rowHeight: 72, widths: { content: 620, eta: 230, driver: 150, sla: 100 } })
  });
  const prefs = JSON.parse(vm.runInContext("JSON.stringify(scmScheduleSheetPreferences)", context));
  assert.equal(prefs.fontSize, 14);
  assert.equal(prefs.rowHeight, 72);
  assert.equal(prefs.widths.content, 620);
  assert.equal(prefs.widths.timing, 170);
});

test("invalid JSON, null, invalid values and denied reads all fall back to visible columns", () => {
  for (const saved of ["{", "null", "[]", '{"hiddenColumns":null}', '{"hiddenColumns":42}', '{"hiddenColumns":[null,42,{}]}']) {
    const { context } = scheduleContext({ "mbbs.scmSchedule.columns.v1.scm.ui-admin": saved });
    assert.equal(vm.runInContext("scmScheduleHiddenColumns.size", context), 0);
  }
  const { context } = scheduleContext({}, true);
  assert.equal(vm.runInContext("scmScheduleHiddenColumns.size", context), 0);
});
