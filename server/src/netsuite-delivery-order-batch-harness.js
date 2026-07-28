import assert from "node:assert/strict";
import fs from "node:fs";
import {
  fetchDeliveryOrderDetailsBatchFromNetSuite
} from "./netsuite.js";

const empty = await fetchDeliveryOrderDetailsBatchFromNetSuite([]);
assert(empty instanceof Map, "Batch delivery detail lookup must return a Map.");
assert.equal(empty.size, 0, "An empty order set must return an empty Map without querying NetSuite.");

await assert.rejects(
  fetchDeliveryOrderDetailsBatchFromNetSuite([123, "not-an-id"]),
  /Every NetSuite sales order ID must be a valid positive integer/
);
await assert.rejects(
  fetchDeliveryOrderDetailsBatchFromNetSuite(null),
  /must be provided as an iterable/
);

const source = fs.readFileSync(new URL("./netsuite.js", import.meta.url), "utf8");
const batchSource = source.match(
  /export async function fetchDeliveryOrderDetailsBatchFromNetSuite[\s\S]*?(?=\nexport async function fetchTransferOrderDetailsFromNetSuite)/
)?.[0] || "";

assert(batchSource, "The batched Sales Order detail reader must remain exported.");
assert.match(batchSource, /tl\.transaction AS transaction_id/,
  "Every returned line must retain its source Sales Order ID.");
assert.match(batchSource, /await suiteqlAll\(/,
  "The batch reader must use paged SuiteQL rather than one request per Sales Order.");
assert.match(batchSource, /tl\.transaction IN \(\$\{chunk\.join\(","\)\}\)/,
  "Validated Sales Order IDs must share one IN query per bounded chunk.");
assert.match(batchSource, /rows\.map\(normalizeOpenDeliveryLine\)/,
  "Batch results must use the same normalized line shape as the single-order reader.");
assert.match(batchSource, /new Map\(ids\.map\(\(orderId\) => \[orderId, \[\]\]\)\)/,
  "The result must contain an empty array for requested orders with no open lines.");

console.log("NetSuite batched delivery-order detail harness passed.");
