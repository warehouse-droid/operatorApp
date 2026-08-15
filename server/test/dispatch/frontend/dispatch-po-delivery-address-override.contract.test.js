// @ts-check

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../../../public/dispatch.js", import.meta.url), "utf8");

test("PO edit form exposes an optional delivery override and requests a targeted refresh", () => {
  assert.match(
    source,
    /isPurchaseOrderDeliveryOverride = order\.type === "PO" && order\.sourceTable === "purchase_orders"/u
  );
  assert.match(source, /order\.deliveryAddressOverride \|\| ""/u);
  assert.match(source, /Delivery address override <small>\(optional\)<\/small>/u);
  assert.match(source, /Leave blank to use the mapped destination yard/u);
  assert.match(
    source,
    /isPurchaseOrderDeliveryOverride\s*\? `\/api\/dispatch\/orders\/\$\{encodeURIComponent\(order\.id\)\}\/details\?response=targeted`\s*:\s*`\/api\/dispatch\/orders\/\$\{encodeURIComponent\(order\.id\)\}\/details\?response=ack`/u
  );
  assert.match(source, /if \(!isPurchaseOrderDeliveryOverride\) order\.address = data\.address;/u);
});
