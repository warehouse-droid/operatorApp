// @ts-check

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const ui = await readFile(new URL("../../../public/dispatch-scm.js", import.meta.url), "utf8");

test("WL-11 PO Split initial/search loads bounded summaries and lazily hydrates selected detail", () => {
  assert.match(ui, /\/api\/dispatch\/scm\/v2\/purchase-orders/u);
  assert.match(ui, /limit["']?\s*[,=:]\s*["']200["']/u);
  assert.match(ui, /AbortController/u);
  assert.match(ui, /scmOrderDetail/u);
  assert.match(ui, /\/api\/dispatch\/scm\/v2\/purchase-orders\/\$\{encodeURIComponent/u);
  assert.doesNotMatch(ui, /window\.__scmSearchTimer\s*=\s*setTimeout\(loadScmOrders,\s*250\)/u);
});

test("WL-12 list mutations use targeted refresh instead of returning every PO detail", () => {
  assert.match(ui, /refreshScmOrder/u);
  assert.match(ui, /response=targeted/u);
});
