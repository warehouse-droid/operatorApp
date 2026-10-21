import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import http from "node:http";
import test from "node:test";
import { chromium, expect } from "@playwright/test";
import { query } from "../../../src/db.js";
import { createDispatchV2Fixture } from "../support/dispatch-v2-fixture.js";
import { seedSalesOrder } from "../support/fulfilled-so-fixture.js";

test("browser shows an unplanned first-split group as available without a Completed label", async () => {
  const fixture = await createDispatchV2Fixture();
  let server, browser;
  const groupRef = "GOA-FIRST-BROWSER-S1";
  try {
    const children = [];
    for (const [index, parent] of ["SO-FIRST-BROWSER-A", "SO-FIRST-BROWSER-B"].entries()) {
      await seedSalesOrder(817161900 + index, parent, { status: "B" });
      const result = await fixture.request(`/api/dispatch/orders?type=SO&search=${parent}`);
      assert.equal(result.response.status, 200);
      const source = result.payload.find(order => order.id === parent);
      assert.ok(source);
      const child = { ...source, id: `${parent}-S1`, originalOrderId: parent };
      children.push(child);
      await query(`INSERT INTO dispatch_global_order_splits
        (split_ref,order_type,parent_order_ref,source_plan_date,full_order,card)
        VALUES ($1,'SO',$2,'2096-10-01',$3::jsonb,$3::jsonb)`, [child.id, parent, JSON.stringify(child)]);
    }
    const group = { ...children[0], id: groupRef, childOrders: children.map(child => child.id),
      childOrderDetails: children, items: children.flatMap(child => child.items), globalGroupDefinition: true };
    await query(`INSERT INTO dispatch_global_order_groups
      (group_ref,order_type,source_plan_date,full_order,card,search_text)
      VALUES ($1,'SO','2096-10-01',$2::jsonb,$2::jsonb,$3)`, [groupRef, JSON.stringify(group), groupRef.toLowerCase()]);
    for (const [position, child] of children.entries()) {
      await query(`INSERT INTO dispatch_global_order_group_members (group_ref,member_order_ref,position)
        VALUES ($1,$2,$3)`, [groupRef, child.id, position]);
    }
    server = http.createServer(async (req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname.endsWith(".js") || url.pathname.endsWith(".css")) {
        res.setHeader("Content-Type", url.pathname.endsWith(".js") ? "text/javascript" : "text/css");
        res.end(await readFile(new URL(`../../../public${url.pathname}`, import.meta.url)));
      } else if (url.pathname === "/api/dispatch/orders") {
        const result = await fixture.request(req.url);
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
    const order = await page.evaluate(async ref => {
      trucks = []; fleet = []; currentPlanDate = "2096-10-01";
      currentPlan = { id: "first-split-browser", planDate: currentPlanDate, orders: [], trucks: [] };
      dispatchConfig = { plannerOrderPoolMode: "off", googleMapsEnabled: false };
      dispatchPlannerSnapshotState = "ready";
      const orders = await (await fetch(`/api/dispatch/orders?type=SO&search=${ref}`)).json();
      applyDispatchOrderFeed(orders);
      app.innerHTML = renderOrderPool();
      return orders.find(candidate => candidate.id === ref);
    }, groupRef);
    assert.ok(order, "HTTP feed includes the global group");
    assert.equal(order.dispatchPlanningRestricted, false);
    assert.equal(order.dispatchCompletionStatus === "completed", false);
    const card = page.locator(`[data-order="${groupRef}"]`);
    await expect(card).toHaveAttribute("draggable", "true");
    await expect(card).toHaveAttribute("data-planned", "false");
    await expect(card).not.toContainText("Completed");
    await mkdir("test-artifacts/first-split-group-status-20261001", { recursive: true });
    await card.screenshot({ path: "test-artifacts/first-split-group-status-20261001/unplanned-group.png" });
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    if (server) { await new Promise(resolve => server.close(resolve)); }
    await fixture.close();
  }
});
