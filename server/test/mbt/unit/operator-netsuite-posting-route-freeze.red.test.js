import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const server = await readFile(new URL("../../../src/server.js", import.meta.url), "utf8");

function guardedMutationCount(functionKey) {
  return [...server.matchAll(new RegExp(
    `assertOperatorNetSuitePostingOrderMutable\\(\\{\\s*functionKey: "${functionKey}"`,
    "gu"
  ))].length;
}

test("P5 accepted commands freeze every quantity/draft mutation for their Operator function", () => {
  assert.match(server, /import \{[^}]*assertOperatorNetSuitePostingOrderMutable[^}]*\} from "\.\/operator-netsuite-posting-controller\.js"/su);
  assert.ok(guardedMutationCount("customer_pickup") >= 3, "Customer Pickup line, page, and clear mutations must be frozen.");
  assert.ok(guardedMutationCount("receiving") >= 3, "Receiving line, page, and unconfirm mutations must be frozen.");
  assert.ok(guardedMutationCount("delivery_prep") >= 7, "Delivery Prep status, draft, line, quantity, and unpack mutations must be frozen.");
});

test("G1 no legacy Operator endpoint can bypass the per-yard Delivery Prep gate", () => {
  const legacyRoute = server.slice(
    server.indexOf('app.post("/api/delivery/orders/:id/fulfill"'),
    server.indexOf('app.post("/api/delivery/orders/:id/load"')
  );
  assert.match(legacyRoute, /status\(410\)/u);
  assert.doesNotMatch(legacyRoute, /runDeliveryFulfillment/u);
  assert.doesNotMatch(legacyRoute, /transformSalesOrderToItemFulfillment/u);
});
