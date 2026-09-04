import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const publicUrl = new URL("../../../public/", import.meta.url);
const clientUrl = new URL("dispatch-scm.js", publicUrl);
const client = fs.readFileSync(clientUrl, "utf8");

function clientContext() {
  const scmApp = {
    addEventListener() {},
    contains() { return false; },
    querySelector() { return null; },
    querySelectorAll() { return []; }
  };
  const context = vm.createContext({
    CSS: { escape: (value) => String(value) },
    URLSearchParams,
    clearTimeout,
    confirm: () => true,
    console,
    document: {
      activeElement: null,
      getElementById: () => scmApp
    },
    fetch: async () => { throw new Error("Unexpected network call"); },
    requireDispatchLogin() {},
    sessionStorage: { getItem: () => "" },
    setTimeout,
    window: {
      MBBS_I18N: null,
      addEventListener() {},
      location: { search: "" },
      scrollX: 0,
      scrollY: 0
    }
  });
  vm.runInContext(client, context, { filename: fileURLToPath(clientUrl) });
  return context;
}

test("PO detail follows and visibly labels NetSuite line sequence", () => {
  const context = clientContext();
  const html = vm.runInContext(`
    scmOrders = [{
      id: "PO-SEQUENCE",
      type: "PO",
      catalogHydrated: true,
      destinationYard: "3445",
      scm: { status: "Queued" },
      items: [
        { lineRowId: 1, lineId: 100, netSuiteLineSequence: 8, sku: "PALLET-FOUR", quantity: 4, unit: "EACH" },
        { lineRowId: 2, lineId: 900, netSuiteLineSequence: 5, sku: "PALLET-SIX", quantity: 6, unit: "EACH" },
        { lineRowId: 3, lineId: 500, netSuiteLineSequence: 7, sku: "PALLET-THREE", quantity: 3, unit: "EACH" }
      ]
    }];
    selectedScmOrderId = "PO-SEQUENCE";
    renderSelectedOrder();
  `, context);

  assert.ok(html.indexOf("PALLET-SIX") < html.indexOf("PALLET-THREE"));
  assert.ok(html.indexOf("PALLET-THREE") < html.indexOf("PALLET-FOUR"));
  assert.match(html, /NetSuite line 5/);
  assert.match(html, /NetSuite line 7/);
  assert.match(html, /NetSuite line 8/);
});
test("split editor follows source NetSuite sequence instead of SKU order", () => {
  const context = clientContext();
  const html = vm.runInContext(`
    scmSplitEditor = {
      split: { splitPoRef: "SPLIT-SEQUENCE", sourcePoRef: "PO-SEQUENCE", revision: 1, locked: false },
      lines: [
        { sourceLineId: 11, lineId: 100, netSuiteLineSequence: 8, sku: "A-LAST-IN-NETSUITE", inSplit: true, toPlt: 0, current: { salesQty: 4 }, maximum: { salesQty: 4 }, unit: "EACH" },
        { sourceLineId: 12, lineId: 900, netSuiteLineSequence: 5, sku: "Z-FIRST-IN-NETSUITE", inSplit: true, toPlt: 0, current: { salesQty: 6 }, maximum: { salesQty: 6 }, unit: "EACH" },
        { sourceLineId: 13, lineId: 500, netSuiteLineSequence: 7, sku: "M-MIDDLE-IN-NETSUITE", inSplit: true, toPlt: 0, current: { salesQty: 3 }, maximum: { salesQty: 3 }, unit: "EACH" }
      ]
    };
    scmSplitLineInputs = {};
    renderScmSplitLineEditor({ id: "SPLIT-SEQUENCE", isScmSplit: true });
  `, context);

  assert.ok(html.indexOf("Z-FIRST-IN-NETSUITE") < html.indexOf("M-MIDDLE-IN-NETSUITE"));
  assert.ok(html.indexOf("M-MIDDLE-IN-NETSUITE") < html.indexOf("A-LAST-IN-NETSUITE"));
  assert.match(html, /NetSuite line 5/);
  assert.match(html, /NetSuite line 7/);
  assert.match(html, /NetSuite line 8/);
});

test("line ordering is total, deterministic, and safe for hostile sequence metadata", () => {
  const context = clientContext();
  const result = vm.runInContext(`JSON.stringify(scmOrderedLines([
    { marker: "missing-high", lineId: 90 },
    { marker: "valid-two-high", lineId: 20, netSuiteLineSequence: 2 },
    { marker: "negative", lineId: 40, netSuiteLineSequence: -1 },
    { marker: "valid-one", lineId: 30, netSuiteLineSequence: "1" },
    { marker: "hostile", lineId: 50, netSuiteLineSequence: "5 OR 1=1" },
    { marker: "valid-two-low", lineId: 10, netSuiteLineSequence: 2 },
    { marker: "zero", lineId: 60, netSuiteLineSequence: 0 },
    { marker: "missing-low", lineId: 5 }
  ]).map((line) => line.marker))`, context);

  assert.deepEqual(JSON.parse(result), [
    "valid-one",
    "valid-two-low",
    "valid-two-high",
    "missing-low",
    "negative",
    "hostile",
    "zero",
    "missing-high"
  ]);
});

test("line ordering conserves every generated row across repeated permutations", () => {
  const context = clientContext();
  for (let seed = 1; seed <= 128; seed += 1) {
    const lines = Array.from({ length: 24 }, (_, index) => ({
      marker: `${seed}:${index}`,
      lineId: ((index * 17) + seed) % 29,
      netSuiteLineSequence: index % 5 === 0 ? "bad" : ((index * 11) + seed) % 13 + 1
    }));
    const input = JSON.stringify(lines);
    const first = JSON.parse(vm.runInContext(
      `JSON.stringify(scmOrderedLines(${input}).map((line) => line.marker))`,
      context
    ));
    const second = JSON.parse(vm.runInContext(
      `JSON.stringify(scmOrderedLines([...${input}].reverse()).map((line) => line.marker))`,
      context
    ));
    assert.deepEqual(new Set(first), new Set(lines.map((line) => line.marker)));
    assert.equal(first.length, lines.length);
    assert.deepEqual(first, second, `seed ${seed} must not depend on API arrival order`);
  }
});
