import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { cargoFunctions } from "../../support/sales-order-cargo-fixture.mjs";
import { dependencyAppliesToDispatchOrder as serverRule } from "../../../src/order-dependency-repository.js";

const { dependencyAppliesToDispatchOrder: browserRule } = cargoFunctions("../../public/dispatch.js",
  ["dependencyAppliesToDispatchOrder"], {});

const replenishment = { mode: "yard_replenishment", dispatchTargetRef: "SO1", salesOrderRef: "SO1",
  canonicalSalesOrderRef: "SO1", lines: [{ itemId: 20 }] };
const cases = [
  ["the linked order itself", replenishment, { id: "SO1", items: [{ itemId: 10 }] }, true],
  ["a split without the linked item", replenishment, { id: "SO1-S1", items: [{ itemId: 10 }] }, false],
  ["a split with the linked item", replenishment, { id: "SO1-S2", items: [{ itemId: 10 }, { itemId: 20 }] }, true],
  ["a split with an item lacking identity", replenishment, { id: "SO1-S1", items: [{ sku: "X" }] }, true],
  ["a split without item details", replenishment, { id: "SO1-S1" }, true],
  ["a link without item lines", { ...replenishment, lines: [] }, { id: "SO1-S1", items: [{ itemId: 10 }] }, true],
  ["a direct pickup link", { ...replenishment, mode: "direct_to_customer" }, { id: "SO1-S1", items: [{ itemId: 10 }] }, true],
  ["a group holding the linked split", replenishment, { id: "GSO-1S2-9", items: [{ itemId: 20 }, { itemId: 30 }] }, true],
  ["a group without the linked item", replenishment, { id: "GSO-1S1-9", items: [{ itemId: 10 }, { item_id: 30 }] }, false]
];

for (const [name, dependency, order, expected] of cases) {
  test(`browser and server agree: ${name}`, () => {
    assert.equal(serverRule(dependency, order), expected);
    assert.equal(browserRule(dependency, order), expected);
  });
}

test("client splits keep only the replenishment links their items need", () => {
  const source = readFileSync(new URL("../../../public/dispatch.js", import.meta.url), "utf8");
  const split = source.slice(source.indexOf("function splitOrder("), source.indexOf("function prepareUnsplitOrder("));
  assert.match(split, /dependencyAppliesToDispatchOrder\(dependency, \{ id, items: totals\.items \}\)/u);
});
