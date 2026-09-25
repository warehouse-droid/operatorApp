import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { normalizeOperatorPreferences, STYLE_ROLES } from "../../../src/operator-preferences-policy.js";

const publicFile = (name) => readFileSync(new URL(`../../../public/${name}`, import.meta.url), "utf8");
function browser(language = "zh-CN") {
  const storage = new Map([["mbbs.ui.language", language]]);
  const context = vm.createContext({
    localStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    document: { documentElement: {}, addEventListener() {} },
    CustomEvent: class {},
  });
  vm.runInContext("window = globalThis", context);
  context.dispatchEvent = () => {};
  for (const name of ["i18n.js", "operator-display-settings.js", "operator-order-keypad.js", "operator-load-summary.js"]) {
    vm.runInContext(publicFile(name), context);
  }
  return context;
}
const plain = (value) => JSON.parse(JSON.stringify(value));

test("UOM display is language-aware, preserves other sales units and never mutates load grouping", () => {
  const ctx = browser();
  for (const [code, label] of [["PLT", "板"], ["LYR", "层"], ["SEC", "组"], ["PCS", "件"]]) {
    assert.equal(ctx.MBBS_I18N.unit(code), label);
    assert.equal(ctx.MBBS_I18N.unit(` ${code.toLowerCase()} `), label);
  }
  for (const value of ["PC", "EA", "SQFT", " Pallet ", "xPCS", "", "层"]) {
    assert.equal(ctx.MBBS_I18N.unit(value), value);
  }
  const lines = [{ item_id: 1, unit: "PCS", packed_piece_qty: 2, to_pcs: 1 }, { item_id: 1, unit: "PCS", packed_piece_qty: 3, to_pcs: 1 }];
  const original = JSON.stringify(lines);
  assert.equal(ctx.MBBS_LOAD_SUMMARY.rows(lines)[0].quantity, "5 件");
  assert.equal(JSON.stringify(lines), original);
  ctx.MBBS_I18N.setLanguage("en");
  assert.equal(ctx.MBBS_I18N.unit("pcs"), "pcs");
  assert.equal(ctx.MBBS_LOAD_SUMMARY.rows(lines)[0].quantity, "5 pcs");
});

test("server and browser agree on defaults, exact sizes, independent overrides and reset", () => {
  const ctx = browser();
  const model = ctx.OperatorDisplaySettings;
  assert.deepEqual(plain(model.normalize()), normalizeOperatorPreferences());
  const settings = normalizeOperatorPreferences();
  settings.styles.general.itemNames = { fontSizePx: 23, color: "#123456" };
  settings.styles.detail.itemNames = { fontSizePx: 31, color: null };
  settings.styles.general.labels.fontSizePx = 8;
  settings.styles.detail.quantities.fontSizePx = 48;
  settings.useDeviceKeyboard = true;
  assert.deepEqual(plain(model.normalize(settings)), normalizeOperatorPreferences(settings));
  assert.deepEqual(plain(model.effective(settings, "detail", "itemNames")), { fontSizePx: 31, color: "#123456" });
  const reset = { ...model.normalize(), useDeviceKeyboard: settings.useDeviceKeyboard };
  assert.equal(reset.useDeviceKeyboard, true);
  assert.equal(model.styleCss(reset), "");
});

test("reject unsupported styles, non-pixel values, injected CSS and impersonation fields", () => {
  for (const fontSizePx of [7, 49, 12.5, "18", "18px", false]) {
    assert.throws(() => normalizeOperatorPreferences({ styles: { detail: { labels: { fontSizePx } } } }), { status: 400 });
  }
  for (const color of ["red", "#fff", "#ffffff;display:none", "url(https://example.org)", 42]) {
    assert.throws(() => normalizeOperatorPreferences({ styles: { general: { headings: { color } } } }), { status: 400 });
  }
  for (const input of [{ operatorId: "someone-else" }, { styles: { driver: {} } }, { styles: { general: { unknown: {} } } }, { spacing: { general: "inherit" } }, { useDeviceKeyboard: "false" }, [], null]) {
    assert.throws(() => normalizeOperatorPreferences(input), { status: 400 });
  }
  const sanitized = browser().OperatorDisplaySettings.normalize({ styles: { general: { headings: { color: "red;background:url(x)", fontSizePx: "20px" } } } });
  assert.equal(sanitized.styles.general.headings.color, null);
  assert.equal(sanitized.styles.general.headings.fontSizePx, null);
});

test("order keypad preserves leading zeros, cursor edits, selection and changing prefixes", () => {
  const edit = browser().OperatorOrderKeypad.edit;
  assert.deepEqual(plain(edit("", "SOB")), { value: "SOB", caret: 3 });
  assert.deepEqual(plain(edit("SOB0012", "SOM")), { value: "SOM0012", caret: 7 });
  assert.deepEqual(plain(edit("0012", "SOA")), { value: "SOA0012", caret: 7 });
  assert.deepEqual(plain(edit("SOB0012", "9", 5, 7)), { value: "SOB009", caret: 6 });
  assert.deepEqual(plain(edit("SOB0012", "back", 5, 7)), { value: "SOB00", caret: 5 });
  assert.deepEqual(plain(edit("SOB0012", "back", 0, 0)), { value: "SOB0012", caret: 0 });
  assert.deepEqual(plain(edit("SOB0012", "clear")), { value: "", caret: 0 });
});

test("every configurable text style has a translated label", () => {
  const i18n = browser().MBBS_I18N;
  for (const role of STYLE_ROLES) {
    assert.notEqual(i18n.t(`operator.preferencesRole.${role}`, "missing"), "missing");
  }
});
