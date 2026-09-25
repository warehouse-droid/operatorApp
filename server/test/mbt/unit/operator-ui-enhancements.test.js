import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import fc from "fast-check";

const source = await readFile(new URL("../../../public/operator.js", import.meta.url), "utf8");
const between = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

function pickupUi(line, viewMode = "active") {
  const context = vm.createContext({
    currentModule: "customer-pickup", viewMode, selectedOrder: { lines: [line] },
    selectedLineId: line.id, compactLineMode: false,
    qty: (value) => Number(value) || 0, displayQty: String,
    t: (_key, fallback) => fallback, escapeHtml: String, displayUnit: String,
    isVrmaReferenceOrder: () => false, orderLocksCurrentOperator: () => false
  });
  vm.runInContext(between("function isCustomerPickupMode", "function receivingRemainingSalesQty"), context);
  vm.runInContext(between("function renderLine(line)", "function renderLinkedSupplyBreakdown"), context);
  return context;
}

const pieceLine = (packed = 5, loaded = 0) => ({
  id: "item-a", sku: "ITEM-A", item_type: "InvtPart", quantity: 20, piece_qty: 20,
  to_pcs: 1, packed_piece_qty: packed, loaded_qty: loaded, confirmed: packed > 0
});

test("pickup card and editor show the confirmed draft separately from remaining in either delivery view", () => {
  for (const viewMode of ["active", "packed"]) {
    const line = pieceLine();
    const ui = pickupUi(line, viewMode);
    assert.equal(ui.panelValue(line, "pieces"), 5);
    const html = ui.renderLine(line);
    assert.match(html, /confirmed-measure[\s\S]*?<b>5<\/b>/u);
    assert.match(html, /remaining-measure[\s\S]*?<b>15<\/b>/u);
    assert.match(html, /can still adjust before Loaded/u);
    assert.doesNotMatch(html, /class="line-card[^"]*underpacked/u);
  }
});

test("pickup saved and remaining quantities conserve the order through partial loads", () => {
  fc.assert(fc.property(fc.integer({ min: 0, max: 19 }), fc.integer({ min: 1, max: 20 }), (loaded, requested) => {
    const packed = Math.min(20 - loaded, requested);
    const line = pieceLine(packed, loaded);
    const ui = pickupUi(line);
    assert.equal(ui.panelValue(line, "pieces"), packed);
    assert.equal(ui.remainingValue(line, "pieces"), 20 - loaded - packed);
    assert.equal(ui.panelLimit(line, "pieces"), 20 - loaded);
  }), { numRuns: 100, seed: 20260911 });
});

test("pickup sales-only lines display confirmed sales quantities and unconfirmed lines show availability", () => {
  const line = { ...pieceLine(0, 4), piece_qty: 0, to_pcs: 0, unit: "SQFT", packed_sales_qty: 7 };
  const ui = pickupUi(line);
  assert.equal(ui.panelValue(line, "sales"), 7);
  assert.equal(ui.remainingValue(line, "sales"), 9);
  line.packed_sales_qty = 0;
  assert.equal(ui.panelValue(line, "sales"), 16);
});
