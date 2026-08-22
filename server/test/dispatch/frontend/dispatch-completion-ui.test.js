import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const dispatchJsUrl = new URL("../../../public/dispatch.js", import.meta.url);
const dispatchHtmlUrl = new URL("../../../public/dispatch.html", import.meta.url);

test("Dispatch exposes the guarded manual completion command for supported selected orders", async () => {
  const [source, html] = await Promise.all([
    readFile(dispatchJsUrl, "utf8"),
    readFile(dispatchHtmlUrl, "utf8")
  ]);
  assert.match(source, /function dispatchCompletionOrderKind\(/u);
  assert.match(source, /data-action="manual-complete-order"/u);
  assert.match(source, /\/api\/dispatch\/order-completions/u);
  assert.match(source, /Driver.*forgot|forgot.*Driver/iu);
  assert.match(source, /reason/iu);
  assert.match(source, /confirm/u);
  assert.match(source, /completedAt/u);
  assert.match(source, /loadDispatchOrders\(\)/u);
  assert.match(source, /order\.dispatchCompletionStatus === "completed"/u);
  assert.match(source, /!SALES_PLANNING_HOST && !dispatchCompleted/u);
  assert.match(source, /Dispatch completed/u);
  assert.match(html, /dispatch\.js\?v=20260822-load-reorder-v1/u);
});
