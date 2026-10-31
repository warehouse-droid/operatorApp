import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import test from "node:test";
import { chromium } from "@playwright/test";

/* global orders, normalizeOrder, orderCatalog, trucks, fleet, currentPlanDate, currentPlan, compactCurrentPlan,
dispatchConfig, dispatchSetupLoaded, dispatchPlannerSnapshotState, planEditMode, prepareUnsplitOrder, routeNotice */

// A split sibling inside a group is not a top-level order. Unsplit must still
// see it, or the parent comes back while that sibling keeps its quantity.
async function unsplitCase(grouped, run) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.endsWith(".js")) {
      res.setHeader("Content-Type", "text/javascript");
      res.end(await readFile(new URL(`../../../public${url.pathname}`, import.meta.url))); return;
    }
    if (!url.pathname.startsWith("/api/")) {
      res.setHeader("Content-Type", "text/html");
      res.end('<!doctype html><main id="dispatchApp"></main><script>function requireDispatchLogin() {}</script><script src="/dispatch-edit-activity.js"></script><script src="/dispatch.js"></script>'); return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end("{}");
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(grouped => {
      const order = (id, extra = {}) => normalizeOrder({ id, type: "TO", customer: id, address: "Yard 2967",
        pickupLocations: ["3445"], items: [{ sku: "T", quantity: 1 }], ...extra });
      const s1 = order("TO200-S1", { originalOrderId: "TO200" });
      const s2 = order("TO200-S2", { originalOrderId: "TO200" });
      orders = grouped
        ? [s2, order("GTO-200S1-300", { childOrders: ["TO200-S1", "TO300"], childOrderDetails: [s1, order("TO300")] })]
        : [s1, s2];
      orderCatalog = [...structuredClone(orders), order("TO200")];
      trucks = []; fleet = [];
      currentPlanDate = "2099-11-07";
      currentPlan = compactCurrentPlan({ id: "unsplit-plan", planDate: currentPlanDate, revision: 1, digest: "d", status: "draft" });
      dispatchConfig = { plannerOrderPoolMode: "off", plannerCommandMode: "off", googleMapsEnabled: false };
      dispatchSetupLoaded = true; dispatchPlannerSnapshotState = "ready"; planEditMode = true;
    }, grouped);
    await run(page);
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
}

test("unsplit is refused while a sibling split travels inside a group", () => unsplitCase(true, async page => {
  const result = await page.evaluate(() => ({ prepared: prepareUnsplitOrder("TO200-S2"), notice: routeNotice }));
  assert.equal(result.prepared, null);
  assert.match(result.notice, /GTO-200S1-300/u);
}));

test("unsplit of ungrouped siblings still sends the whole family", () => unsplitCase(false, async page => {
  const result = await page.evaluate(() => prepareUnsplitOrder("TO200-S2")?.siblingIds);
  assert.deepEqual(result, ["TO200-S1", "TO200-S2"]);
}));
