import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compileFunction } from "node:vm";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "espree";
import { cargoFunctions } from "../../support/sales-order-cargo-fixture.mjs";

function browser({ allocations = [], accept = true, failed = false, type = "SO", blocked = false } = {}) {
  const calls = [];
  const group = { id: "GOA-9948-9949-9998", type, childOrders: ["SOA09948", "SOA09949", "SOA09998"] };
  const functions = cargoFunctions(process.env.PO_IDENTITY_BROWSER_SOURCE || "../../public/dispatch.js", ["ungroupOrderWithPoCheck"], {
    orderById: () => group,
    groupedOrderTransitCoId: () => "",
    currentPlanDate: "2026-10-15",
    URLSearchParams,
    saveCurrentPlanNow: async () => { calls.push("save"); },
    fetch: async url => {
      calls.push(["fetch", url]);
      return { ok: !failed, json: async () => ({ allocations }) };
    },
    dispatchErrorMessage: async () => "Connection unavailable",
    confirm: message => { calls.push(["confirm", message]); return accept; },
    ungroupOrder: id => { calls.push(["ungroup", id]); return blocked ? null : [{ id: "SOA09948" }]; },
    queueGlobalOrderRetirement: id => calls.push(["retire", id]),
    requestTargetedOrderPoolRefresh: refs => calls.push(["refresh", refs]),
    commitPlanMutation: action => calls.push(["commit", action]),
    render: () => calls.push("render"),
    routeNotice: ""
  });
  return { calls, run: () => functions.ungroupOrderWithPoCheck(group.id) };
}

const linked = [{ id: "259", poOrderRef: "SN1402535" }, { id: "260", poOrderRef: "SN1402535" },
  { id: "261", poOrderRef: "LOINC-039408" }, { id: "262", poOrderRef: "LOINC-039408" }];

test("ungroup warns about every current PO allocation before retiring or saving the ungroup", async () => {
  const app = browser({ allocations: linked });
  assert.equal(await app.run(), true);
  const warning = app.calls.find(call => call[0] === "confirm");
  assert.match(warning[1], /GOA-9948-9949-9998/);
  assert.match(warning[1], /4 PO allocations/);
  assert.match(warning[1], /SN1402535/);
  assert.match(warning[1], /LOINC-039408/);
  assert.match(warning[1], /remove all/i);
  assert.ok(app.calls.findIndex(call => call[0] === "confirm") < app.calls.findIndex(call => call[0] === "ungroup"));
  assert.deepEqual(app.calls.filter(call => ["retire", "commit"].includes(call[0])), [
    ["retire", "GOA-9948-9949-9998"], ["commit", "ungroup_order"]
  ]);
  assert.deepEqual(app.calls.find(call => call[0] === "refresh")[1], [
    "SOA09948", "SOA09949", "SOA09998", "SN1402535", "LOINC-039408"
  ]);
});

test("cancelling the PO warning leaves the group and PO links intact", async () => {
  const app = browser({ allocations: linked, accept: false });
  assert.equal(await app.run(), false);
  assert.equal(app.calls.filter(call => call[0] === "confirm").length, 1);
  assert.ok(!app.calls.some(call => ["ungroup", "retire", "commit"].includes(call[0])));
});

test("ungroup checks the latest server allocations even when the local group has no PO projection", async () => {
  const app = browser();
  assert.equal(await app.run(), true);
  const request = app.calls.find(call => call[0] === "fetch");
  assert.match(request[1], /GOA-9948-9949-9998\/po-allocations\?planDate=2026-10-15/);
  assert.ok(!app.calls.some(call => call[0] === "confirm"));
  assert.ok(app.calls.some(call => call[0] === "ungroup"));
});

test("failed PO detection blocks ungrouping and preserves the group", async () => {
  const app = browser({ failed: true });
  assert.equal(await app.run(), false);
  assert.ok(app.calls.some(call => call[0] === "fetch"));
  assert.ok(!app.calls.some(call => ["confirm", "ungroup", "retire", "commit"].includes(call[0])));
  assert.ok(app.calls.includes("render"));
});

test("non-sales groups retain their existing ungroup behavior", async () => {
  const app = browser({ type: "TO" });
  assert.equal(await app.run(), true);
  assert.ok(!app.calls.some(call => call[0] === "fetch"));
  assert.ok(app.calls.some(call => call[0] === "ungroup"));
});

test("an existing ungroup guard can reject the group without retiring it or committing a plan mutation", async () => {
  const app = browser({ blocked: true });
  assert.equal(await app.run(), false);
  assert.ok(app.calls.some(call => call[0] === "ungroup"));
  assert.ok(app.calls.includes("render"));
  assert.ok(!app.calls.some(call => ["retire", "commit", "refresh"].includes(call[0])));
});

test("the real Ungroup click handler waits for PO detection on the clicked group", async () => {
  const url = new URL(process.env.PO_IDENTITY_BROWSER_SOURCE || "../../../public/dispatch.js", import.meta.url);
  const source = readFileSync(url, "utf8");
  const parsed = parse(source, { ecmaVersion: "latest", sourceType: "script", range: true });
  const registration = parsed.body.find(node => node.type === "ExpressionStatement"
    && node.expression.type === "CallExpression"
    && node.expression.callee.object?.name === "app"
    && node.expression.callee.property?.name === "addEventListener"
    && node.expression.arguments[0]?.value === "click");
  const callback = registration.expression.arguments[1];
  const [start, end] = callback.range;
  const calls = [];
  const dependencies = {
    selectedOrderId: "OTHER", selectedOrderIds: new Set(),
    DISPATCH_VIEW_MUTATION_ACTIONS: new Set(["ungroup-order"]), ensureDispatchPlanEditor: () => true,
    ungroupOrder: () => { calls.push("unguarded"); },
    ungroupOrderWithPoCheck: async ref => { await Promise.resolve(); calls.push(ref); }
  };
  const handler = compileFunction(source.slice(0, start).replace(/[^\n\r]/gu, " ")
    + "return " + source.slice(start, end) + ";", Object.keys(dependencies), { filename: fileURLToPath(url) })(...Object.values(dependencies));
  const button = { dataset: { action: "ungroup-order", orderRef: "GOA-9948-9949-9998" }, closest: () => null };
  await handler({ target: { dataset: {}, closest: selector => selector === "button" ? button : null } });
  assert.deepEqual(calls, ["GOA-9948-9949-9998"]);
});
