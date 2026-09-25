import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import "../../../public/operator-delivery-refresh.js";

function tracker() {
  const context = { account: "a", session: "s", yard: "1", mode: "standard", view: "active", module: "delivery", batch: "planned", date: "2026-09-18", truck: "A", leaving: false };
  return { context, refresh: globalThis.OperatorDeliveryRefresh.create(() => context) };
}

test("R3 only the newest completion in each channel may update its current view", () => {
  const { refresh } = tracker();
  const older = refresh.begin("orders"), detail = refresh.begin("detail"), newer = refresh.begin("orders");
  assert.equal(refresh.current(older), false);
  assert.equal(refresh.current(newer), true);
  assert.equal(refresh.current(detail), true);
});

test("R4 cache epochs survive tab changes but not invalidation or a yard round trip", () => {
  const { context, refresh } = tracker();
  const key = refresh.cacheKey();
  context.view = "packed";
  assert.equal(refresh.cacheKey(), key);
  refresh.invalidate();
  assert.notEqual(refresh.cacheKey(), key);
  const beforeYard = refresh.cacheKey();
  context.yard = "28"; refresh.observe(); context.yard = "1";
  assert.notEqual(refresh.cacheKey(), beforeYard);
});

test("R5 each navigation context and tab round trip invalidates outstanding reads", () => {
  for (const key of ["account", "session", "yard", "mode", "view", "module", "batch", "date", "truck", "leaving"]) {
    const { context, refresh } = tracker();
    const ticket = refresh.begin("orders");
    const previous = context[key];
    context[key] = key === "leaving" ? true : "changed";
    assert.equal(refresh.current(ticket), false, key);
    context[key] = previous;
    assert.equal(refresh.current(ticket), false, `${key} round trip`);
  }
});

test("R3 random completion order can never let an earlier snapshot win", () => {
  fc.assert(fc.property(fc.shuffledSubarray([0, 1, 2, 3, 4, 5], { minLength: 6, maxLength: 6 }), (completionOrder) => {
    const { refresh } = tracker();
    const tickets = completionOrder.map(() => refresh.begin("orders"));
    const accepted = completionOrder.filter((index) => refresh.current(tickets[index]));
    assert.deepEqual(accepted, [5]);
  }), { seed: 20260918, numRuns: 150 });
});

test("R4 random invalidations and navigation round trips reject former reads", () => {
  fc.assert(fc.property(fc.boolean(), fc.constantFrom("view", "yard", "session", "mode", "batch", "date"), (invalidate, key) => {
    const { context, refresh } = tracker();
    const ticket = refresh.begin("orders");
    if (invalidate) { refresh.invalidate(); }
    else {
      const original = context[key];
      context[key] = "other"; refresh.observe(); context[key] = original;
    }
    assert.equal(refresh.current(ticket), false);
    assert.equal(refresh.current(refresh.begin("orders")), true, "fresh requests remain usable");
  }), { seed: 20260918, numRuns: 150 });
});

test("P2 the installed operator shell precaches the versioned refresh guard and client together", () => {
  const html = readFileSync(new URL("../../../public/operator.html", import.meta.url), "utf8");
  const workerUrl = new URL("../../../public/service-worker.js", import.meta.url);
  const worker = readFileSync(workerUrl, "utf8");
  const assets = [...html.matchAll(/src="(\/operator(?:-delivery-refresh)?\.js\?v=[^"]+)"/gu)].map((match) => match[1]);
  assert.equal(assets.length, 2);
  assert.ok(assets[0].startsWith("/operator-delivery-refresh.js"));
  for (const asset of assets) { assert.ok(worker.includes(JSON.stringify(asset))); }
  assert.ok(assets[0].endsWith("v=20260924-operator-responsiveness-v1"));
  assert.ok(assets[1].endsWith("v=20260925-receipt-confirmation-v1"));
  assert.match(worker, /mbbs-yard-operator-20260925-receipt-confirmation-v1/u);
  vm.runInNewContext(worker, { self: { addEventListener() {} } }, { filename: fileURLToPath(workerUrl) });
});
