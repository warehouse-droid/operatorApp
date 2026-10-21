import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import http from "node:http";
import test from "node:test";
import { chromium, expect } from "@playwright/test";
import { query } from "../../../src/db.js";
import { createDispatchPlan } from "../../../src/dispatch-plan-repository.js";
import { createDispatchV2Fixture } from "../support/dispatch-v2-fixture.js";
import { seedSalesOrder, splitSalesOrder } from "../support/fulfilled-so-fixture.js";
import { registerSalesSplit, registerSplitGroup } from "../support/registered-split-fixture.js";

test("mixed S1/S2 group is draggable in Chromium and accepts a leased same-day HTTP adjustment", async () => {
  const fixture = await createDispatchV2Fixture();
  let server, browser;
  const groupRef = "GOA-REGISTERED-BROWSER-S1-S2";
  const date = "2096-10-07";
  try {
    const children = [];
    for (const [index, parent] of ["SO-REGISTERED-BROWSER-A", "SO-REGISTERED-BROWSER-B"].entries()) {
      await seedSalesOrder(817162800 + index, parent, { status: "B" });
      const result = await fixture.request(`/api/dispatch/orders?type=SO&search=${parent}`);
      assert.equal(result.response.status, 200);
      const source = result.payload.find(order => order.id === parent);
      assert.ok(source);
      const child = { ...source, id: `${parent}-S${index + 1}`, originalOrderId: parent };
      children.push(child);
      await registerSalesSplit(parent, { ref: child.id, order: child });
      if (index === 0) {
        await seedSalesOrder(-817162800, child.id, { status: "B" });
        await splitSalesOrder(817162800, parent, -817162800, child.id);
      }
    }
    const group = { ...children[0], id: groupRef, childOrders: children.map(child => child.id),
      childOrderDetails: children, items: children.flatMap(child => child.items), globalGroupDefinition: true };
    await registerSplitGroup(group);
    server = http.createServer(async (req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname.endsWith(".js") || url.pathname.endsWith(".css")) {
        res.setHeader("Content-Type", url.pathname.endsWith(".js") ? "text/javascript" : "text/css");
        res.end(await readFile(new URL(`../../../public${url.pathname}`, import.meta.url)));
      } else if (url.pathname === "/api/dispatch/orders") {
        const result = await fixture.request(req.url);
        res.statusCode = result.response.status;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(result.payload));
      } else {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end('<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/dispatch.css"></head><body><main id="dispatchApp"></main><script>function requireDispatchLogin() {}</script><script src="/dispatch-edit-activity.js"></script><script src="/dispatch.js"></script></body></html>');
      }
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const order = await page.evaluate(async ({ ref, planDate }) => {
      trucks = []; fleet = []; currentPlanDate = planDate;
      currentPlan = { id: "registered-split-browser", planDate, orders: [], trucks: [] };
      dispatchConfig = { plannerOrderPoolMode: "off", googleMapsEnabled: false };
      dispatchPlannerSnapshotState = "ready";
      const orders = await (await fetch(`/api/dispatch/orders?type=SO&search=${ref}`)).json();
      applyDispatchOrderFeed(orders);
      app.innerHTML = renderOrderPool();
      return orders.find(candidate => candidate.id === ref);
    }, { ref: groupRef, planDate: date });
    assert.ok(order, "HTTP feed includes the mixed split group");
    assert.equal(order.dispatchPlanningRestricted, false);
    assert.equal(order.dispatchCompletionStatus === "completed", false);
    const card = page.locator(`[data-order="${groupRef}"]`);
    await expect(card).toHaveAttribute("draggable", "true");
    await expect(card).toHaveAttribute("data-planned", "false");
    await expect(card).not.toContainText("Planning restricted");
    await expect(card).not.toContainText("Completed");
    await mkdir("test-artifacts/registered-split-planning/final", { recursive: true });
    await card.screenshot({ path: "test-artifacts/registered-split-planning/final/mixed-group.png" });
    assert.deepEqual(errors, []);

    await query("INSERT INTO dispatch_trucks (id,plate,active) VALUES (817162850,'SPLIT-TEST',true)");
    await query("INSERT INTO dispatch_drivers (id,name,login,active) VALUES (817162851,'Split tester','split-browser',true)");
    const plan = await createDispatchPlan({ planDate: date });
    const sessionId = "registered-split-browser-session";
    const lease = await fixture.acquireLease({ planDate: date, sessionId });
    const livePlan = await fixture.request(`/api/dispatch/plans/${plan.id}`);
    assert.equal(livePlan.response.status, 200);
    const trucksForPlan = [{ id: "817162850", plate: "SPLIT-TEST", driverId: "817162851", driverLogin: "split-browser", loads: [{
      id: "registered-split-load", name: "Delivery", driverId: "817162851", driverLogin: "split-browser", truckId: "817162850",
      orders: [groupRef], stops: [{ id: "registered-pickup", type: "pickup", orderId: groupRef, yard: "3445" },
        { id: "registered-drop", type: "drop", orderId: groupRef, address: "Test Road" }]
    }] }];
    const save = async (snapshot, nextTrucks) => fixture.request(`/api/dispatch/plans/${plan.id}`, {
      method: "PUT", headers: { "x-dispatch-edit-lease": lease }, body: { planDate: date, orders: [order], trucks: nextTrucks,
        sessionId, baseRevision: snapshot.revision, baseDigest: snapshot.digest }
    });
    const firstSave = await save(livePlan.payload, trucksForPlan);
    assert.equal(firstSave.response.status, 200, JSON.stringify(firstSave.payload));
    const adjusted = structuredClone(firstSave.payload.trucks);
    adjusted[0].loads.push({ id: "registered-same-day-addition", name: "Same-day addition", truckId: "817162850", stops: [] });
    const adjustment = await save(firstSave.payload, adjusted);
    assert.equal(adjustment.response.status, 200, JSON.stringify(adjustment.payload));
    assert.equal(adjustment.payload.trucks[0].loads.length, 2);
    assert.deepEqual(adjustment.payload.trucks[0].loads[0].stops, firstSave.payload.trucks[0].loads[0].stops);
    assert.equal(adjustment.payload.orders.find(candidate => candidate.id === groupRef)?.dispatchPlanningRestricted, false);
  } finally {
    await browser?.close();
    if (server) {await new Promise(resolve => server.close(resolve));}
    await fixture.close();
  }
});
