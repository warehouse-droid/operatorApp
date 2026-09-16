import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import http from "node:http";
import test from "node:test";
import { chromium, expect } from "@playwright/test";
import { createDispatchV2Fixture } from "../support/dispatch-v2-fixture.js";
import { seedSalesOrder, completeDriver } from "../support/fulfilled-so-fixture.js";

test("browser renders real fulfilled SO responses and disables dragging after local delivery", async () => {
  const fixture = await createDispatchV2Fixture();
  let server, browser;
  const artifact = "test-artifacts/dispatch-so-fulfilled-planning";
  try {
    await seedSalesOrder(817157001, "SO-FULFILLED-BROWSER", { status: "G" });
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
        res.end('<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/dispatch.css"></head><body><main id="dispatchApp"></main><script>function requireDispatchLogin() {}</script><script src="/dispatch.js"></script></body></html>');
      }
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.coverage.startJSCoverage({ resetOnNavigation: false, reportAnonymousScripts: false });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const refresh = () => page.evaluate(async () => {
      trucks = []; fleet = []; currentPlanDate = "2096-09-15";
      currentPlan = { id: "fulfilled-browser", planDate: currentPlanDate, orders: [], trucks: [] };
      dispatchConfig = { plannerOrderPoolMode: "off", googleMapsEnabled: false };
      dispatchPlannerSnapshotState = "ready";
      const orders = await (await fetch("/api/dispatch/orders?type=SO&search=SO-FULFILLED-BROWSER")).json();
      applyDispatchOrderFeed(orders);
      app.innerHTML = renderOrderPool();
    });
    await refresh();
    const card = page.locator('[data-order="SO-FULFILLED-BROWSER"]');
    await expect(card).toHaveAttribute("draggable", "true");
    await expect(card).toContainText("Completed · delivery pending");
    await mkdir(artifact, { recursive: true });
    await card.screenshot({ path: `${artifact}/fulfilled-planable.png` });
    await completeDriver("SO-FULFILLED-BROWSER");
    await refresh();
    await expect(card).toHaveAttribute("draggable", "false");
    await expect(card).toContainText("Completed · search only");
    await expect(card).not.toContainText("Completed · delivery pending");
    await card.screenshot({ path: `${artifact}/driver-completed.png` });
    assert.deepEqual(errors, []);
    const coverage = (await page.coverage.stopJSCoverage()).filter(entry => entry.url.includes("/dispatch.js"));
    await mkdir(`${artifact}/coverage-tmp`, { recursive: true });
    await writeFile(`${artifact}/coverage-tmp/browser.json`, JSON.stringify({ result: coverage.map(entry => ({
      url: "file:///app/public/dispatch.js", functions: entry.functions
    })) }));
  } finally {
    await browser?.close();
    if (server) await new Promise(resolve => server.close(resolve));
    await fixture.close();
  }
});
