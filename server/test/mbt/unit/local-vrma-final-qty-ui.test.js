import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { deliveryLoadConfirmation } from "../../../src/operator-load-state.js";

const source = readFileSync(new URL("../../../public/operator.js", import.meta.url), "utf8");
const dialogSource = source.slice(source.indexOf("let loadPartialConfirmation = null;"), source.indexOf("async function pollFulfillmentJob("));
function render(summaries) {
  let rendered = null;
  const dialog = { dataset: {}, setAttribute() {}, addEventListener() {}, showModal() {} };
  const context = vm.createContext({ document: { createElement: () => dialog, body: { appendChild: node => { rendered = node; } } },
    escapeHtml: value => String(value).replaceAll("<", "&lt;"), summaries });
  vm.runInContext(`${dialogSource}\nconfirmMissingLoadLines(summaries);`, context);
  return rendered?.innerHTML || "";
}
const line = { id: "a", item_type: "InvtPart", item_name: "Return item", quantity: 100, packed_sales_qty: 80 };
test("only local VRMA confirmation declares that estimates finalize on load", () => {
  const local = deliveryLoadConfirmation({ order_type: "vrma_order", vrma_local_only: true, lines: [line] });
  assert.equal(local.finalizesEstimatedQuantity, true);
  for (const order of [{ order_type: "sales_order" }, { order_type: "transfer_order" }, { order_type: "co_order" },
    { order_type: "vrma_order", vrma_reference_only: true }]) {
    assert.notEqual(deliveryLoadConfirmation({ ...order, lines: [line] }).finalizesEstimatedQuantity, true);
  }
});
test("local VRMA confirmation explains abandonment even when every line has some packing", () => {
  const html = render([{ orderRef: "LOCAL-VRMA", total: 1, confirmed: 1, missing: [], finalizesEstimatedQuantity: true }]);
  assert.match(html, /loaded quantit.*final/i);
  assert.match(html, /remaining.*abandoned/i);
  assert.doesNotMatch(html, /Remaining lines stay open/);
});
test("mixed confirmation distinguishes local VRMA abandonment from sales order open balance", () => {
  const html = render([{ orderRef: "VRMA-LOCAL", total: 2, confirmed: 1, missing: [{ sku: "VRMA-item" }], finalizesEstimatedQuantity: true },
    { orderRef: "SO-NORMAL", total: 2, confirmed: 1, missing: [{ sku: "Sales-item" }] }]);
  assert.match(html, /VRMA-LOCAL/);
  assert.match(html, /remaining.*abandoned/i);
  assert.match(html, /SO-NORMAL/);
  assert.match(html, /Remaining lines stay open/);
});
