import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const publicRoot = new URL("../../../public/", import.meta.url);

async function readPublic(name) {
  return readFile(new URL(name, publicRoot), "utf8");
}

async function loadI18n(language = "en") {
  const source = await readPublic("i18n.js");
  const stored = new Map([["mbbs.ui.language", language]]);
  const context = {
    localStorage: {
      getItem: (key) => stored.get(key) || null,
      setItem: (key, value) => stored.set(key, value)
    },
    document: { documentElement: {}, addEventListener() {} },
    window: { dispatchEvent() {} },
    CustomEvent: class CustomEvent {}
  };
  vm.runInNewContext(source, context, { filename: "i18n.js" });
  return context.window.MBBS_I18N;
}

test("SOA06329 completion uses one Toronto date/time conversion", async () => {
  const i18n = await loadI18n("en");

  assert.equal(
    i18n.displayDateTime("2026-08-13T02:16:00.195Z"),
    "12-Aug 10:16 PM"
  );
  assert.equal(
    i18n.displayDate("2026-08-13T02:16:00.195Z"),
    "12-Aug",
    "timestamp date-only views must also use the Toronto calendar date"
  );
  assert.equal(
    i18n.displayDate("2026-08-13"),
    "13-Aug",
    "date-only business fields must not shift across timezones"
  );
});

test("Chinese timestamp output uses the same Toronto instant", async () => {
  const i18n = await loadI18n("zh-CN");
  assert.equal(i18n.displayDateTime("2026-08-13T02:16:00.195Z"), "8\u670812\u65e5 22:16");
});

test("every Driver completion UI routes timestamp instants through the shared formatter", async () => {
  const [loaded, control, statistics, driver, dispatch, operator, setup] = await Promise.all([
    "dispatch-loaded-export.js",
    "control.js",
    "dispatch-statistics.js",
    "driver.js",
    "dispatch.js",
    "operator.js",
    "dispatch-setup.js"
  ].map(readPublic));

  assert.match(loaded, /function loadedFormatDate\(value\) \{\s*return value \? \(window\.MBBS_I18N\?\.displayDateTime\(value\)/u);
  assert.match(control, /function formatDate\(value\) \{\s*if \(!value\) return "";\s*return window\.MBBS_I18N\?\.displayDateTime\(value\)/u);
  assert.match(statistics, /function dateTimeText\(value\) \{[\s\S]*?MBBS_I18N\?\.displayDateTime\(value\)/u);
  assert.match(driver, /function dateTimeText\(value\) \{\s*return window\.MBBS_I18N\?\.displayDateTime\(value\)/u);
  assert.match(dispatch, /const displayDateTime = \(value\) => window\.MBBS_I18N\?\.displayDateTime\(value\)/u);
  assert.match(operator, /function formatDateTime\(value\) \{[\s\S]*?MBBS_I18N\?\.displayDateTime\(value\)/u);
  assert.match(setup, /const displayDateTime = \(value\) => window\.MBBS_I18N\?\.displayDateTime\(value\)/u);
});

test("all audited UI instant formatters declare Toronto or use the shared formatter", async () => {
  const sources = await Promise.all([
    "dispatch-offline-review.js",
    "dispatch-snapshot.js",
    "sales-printing.js",
    "scm-schedule.js",
    "scm-stock-requests.js",
    "sales-stock-requests.js",
    "scm-printers.js",
    "scm-smart.js",
    "scm-netsuite-po.js",
    "mbt-assets.js",
    "mbt-frontdesk.js",
    "dispatch-monitor.js",
    "dispatch-dvir.js"
  ].map(readPublic));

  for (const source of sources) {
    assert.ok(
      source.includes("MBBS_I18N?.displayDateTime") || source.includes('timeZone: "America/Toronto"'),
      "each independently formatted instant must declare the business timezone"
    );
  }
});

test("today defaults use the Toronto business date instead of UTC or device-local date", async () => {
  const sources = await Promise.all([
    "dispatch-snapshot.js",
    "operator.js",
    "control.js",
    "driver.js",
    "dispatch.js",
    "dispatch-dvir.js",
    "dispatch-loaded-export.js",
    "dispatch-statistics.js"
  ].map(readPublic));

  for (const source of sources) {
    assert.ok(source.includes("America/Toronto") || source.includes("dispatchCompanyLocalDate"));
  }
});
