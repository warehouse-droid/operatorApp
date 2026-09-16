import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { splitTargetBrowser, splitTargetOrders } from "../../support/dispatch-split-target-fixture.mjs";
import { retiredConfirmBrowser } from "../../support/retired-confirm-fixture.mjs";

test("hovering SOA08716 keeps SOA08748 selected and displays the hovered tooltip", () => {
  const browser = splitTargetBrowser();
  browser.hover("SOA08716");
  assert.match(browser.tooltip.innerHTML, /SOA08716/u);
  assert.equal(browser.selectedOrder().id, "SOA08748");
  assert.deepEqual(browser.selectedOrders().map(order => order.id), ["SOA08748"]);
});

test("rerendered Split action and saved children stay bound to SOA08748 after hovering SOA08716", () => {
  const orders = splitTargetOrders();
  orders[1].planOwned = true;
  const other = structuredClone(orders[1]);
  const browser = splitTargetBrowser(orders);
  browser.hover("SOA08716");
  const actions = browser.renderSelectedOrderActions();
  const target = actions.match(/data-action="open-split-modal" data-order-ref="([^"]+)"/u)?.[1];
  assert.equal(target, "SOA08748");
  browser.splitOrder(target);
  const payload = retiredConfirmBrowser({ id: "327", planDate: "2026-09-15", orders, trucks: [] }).planPayload();
  assert.deepEqual(payload.orders.map(order => order.id), ["SOA08748-S1", "SOA08748-S2", "SOA08716"]);
  assert.deepEqual(orders.find(order => order.id === "SOA08716"), other);
  assert.equal(payload.orders.slice(0, 2).reduce((sum, order) => sum + order.items[0].quantity, 0), 4);
});

test("hover preserves explicit multi-selection", () => {
  const browser = splitTargetBrowser(splitTargetOrders(), ["SOA08748", "SOA08717"]);
  browser.hover("SOA08716");
  assert.equal(browser.selectedOrder().id, "SOA08748");
  assert.deepEqual(browser.selectedOrders().map(order => order.id), ["SOA08748", "SOA08717"]);
});

test("hover does not create a selection when the selection set is empty", () => {
  const browser = splitTargetBrowser(splitTargetOrders(), []);
  const previous = browser.selectedOrder();
  browser.hover("SOA08716");
  assert.equal(browser.selectedOrder(), previous);
  assert.deepEqual(browser.selectedOrders(), []);
});

test("property: arbitrary hover sequences preserve the selected split target and all orders", () => {
  fc.assert(fc.property(
    fc.constantFrom("SOA08748", "SOA08717"),
    fc.array(fc.constantFrom("SOA08748", "SOA08716", "SOA08717", "UNKNOWN", ""), { minLength: 1, maxLength: 20 }),
    (selected, sequence) => {
      const orders = splitTargetOrders();
      const before = structuredClone(orders);
      const browser = splitTargetBrowser(orders, [selected]);
      for (const ref of sequence) {
        browser.hover(ref);
        assert.equal(browser.selectedOrder().id, selected);
        assert.deepEqual(browser.selectedOrders().map(order => order.id), [selected]);
        if (orders.some(order => order.id === ref)) {
          assert.match(browser.tooltip.innerHTML, new RegExp(ref, "u"));
        }
      }
      assert.deepEqual(orders, before);
    }
  ), { seed: 20260915, numRuns: 75 });
});
