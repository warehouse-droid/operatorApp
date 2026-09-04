import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const netsuite = fs.readFileSync(new URL("../../../src/netsuite.js", import.meta.url), "utf8");
const reconciliation = fs.readFileSync(
  new URL("../../../src/scm-reconciliation-service.js", import.meta.url),
  "utf8"
);

test("ordinary PO detail synchronization requests NetSuite visual line identity", () => {
  const functionBody = netsuite.match(
    /export async function fetchPurchaseOrderDetailsFromNetSuite[\s\S]*?\n\}\n/u
  )?.[0] || "";
  assert.match(functionBody, /tl\.id AS order_line/u);
  assert.match(functionBody, /tl\.linesequencenumber AS line_sequence_number/u);
  assert.match(functionBody, /ORDER BY tl\.linesequencenumber, tl\.id, tl\.uniquekey/u);
});

test("exact reconciliation stores one canonical camel-case NetSuite sequence field", () => {
  const functionBody = reconciliation.match(
    /function mappedOrderLine\(line\)[\s\S]*?\n\}\n/u
  )?.[0] || "";
  assert.match(functionBody, /lineSequenceNumber:\s*line\.lineSequenceNumber/u);
  assert.match(functionBody, /orderLine:\s*line\.orderLine/u);
});
