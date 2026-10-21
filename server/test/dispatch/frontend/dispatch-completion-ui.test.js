import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { splitTargetBrowser, splitTargetOrders } from "../../support/dispatch-split-target-fixture.mjs";

const dispatchJsUrl = new URL("../../../public/dispatch.js", import.meta.url);
const dispatchHtmlUrl = new URL("../../../public/dispatch.html", import.meta.url);

test("Dispatch displays completion status without a manual completion button", async () => {
  const [source, html] = await Promise.all([
    readFile(dispatchJsUrl, "utf8"),
    readFile(dispatchHtmlUrl, "utf8")
  ]);
  assert.match(source, /function dispatchCompletionOrderKind\(/u);
  for (const type of ["SO", "TO", "PO", "VRMA", "CUSTOM"]) {
    const order = { ...splitTargetOrders()[0], type };
    const actions = splitTargetBrowser([order], [order.id]).renderSelectedOrderActions();
    assert.doesNotMatch(actions, /manual-complete-order|Mark completed/u, `${type} must not expose manual completion`);
  }
  assert.match(source, /\/api\/dispatch\/order-completions/u);
  assert.match(source, /Driver.*forgot|forgot.*Driver/iu);
  assert.match(source, /reason/iu);
  assert.match(source, /confirm/u);
  assert.match(source, /completedAt/u);
  assert.match(source, /loadDispatchOrders\(\)/u);
  assert.match(source, /order\.dispatchCompletionStatus === "completed"/u);
  assert.match(source, /!dispatchCompleted && order\.scm\?\.status/u);
  assert.match(source, /Dispatch completed/u);
  assert.match(html, /dispatch\.js\?v=[^"\s]+/u);
});
