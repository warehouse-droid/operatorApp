import { compactDispatchOrderCard } from "../../../src/dispatch-planner-optimization.js";
import { expect, test } from "./mbt-e2e-test.js";

test.use({ serviceWorkers: "block", viewport: { width: 1440, height: 1000 } });

for (const failSecond of [false, true]) {
  test(`grouping selected compact Sales Orders ${failSecond ? "stops on failed details" : "retains all item IDs and quantities"}`, async ({ page, browserName }, testInfo) => {
    if (browserName === "chromium") { await page.coverage.startJSCoverage({ resetOnNavigation: false }); }
    const orders = ["SOB119854", "SOB119855"].map((id, orderIndex) => ({
      id, type: "SO", sourceTable: "sales_orders", customer: "Group hydration fixture", address: "100 Test Street", sourceYard: "12441",
      pickupLocations: ["12441"], catalogHydrated: true, pallets: 1, layers: 0, weight: 1000, salesQty: 12, status: "open",
      items: Array.from({ length: 12 }, (_, index) => ({ itemId: 1158 + index, lineId: 4919454 + index + orderIndex * 100, sku: `STONE-${index}`, quantity: index + 1, unit: "pcs" }))
    }));
    const cards = orders.map(compactDispatchOrderCard);
    const plan = { id: "323", planDate: "2026-09-11", status: "draft", revision: 32, assignedOrderSnapshots: [],
      trucks: [{ id: "T4", plate: "TEST", driverLogin: "dao", driver: "Dao", base: "12441", loads: [{ id: "L1", name: "Load 1", driverLogin: "dao", stops: [], orders: [] }] }], summary: {} };
    const errors = [];
    const reads = [];
    const audits = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      globalThis.localStorage.setItem("mbbs.staff.token", "isolated-group-fixture");
      globalThis.localStorage.setItem("mbbs.staff.role", "dispatcher");
      globalThis.localStorage.setItem("mbbs.staff.roles", JSON.stringify(["dispatcher"]));
      globalThis.localStorage.setItem("mbbs.dispatch.planDate", "2026-09-11");
      globalThis.EventSource = class { addEventListener() {} close() {} };
    });
    await page.route("**/api/**", (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      const reply = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
      if (pathname.startsWith("/api/dispatch/v2/order-feed/")) {
        const ref = decodeURIComponent(pathname.split("/").at(-1));
        reads.push(ref);
        if (failSecond && ref === "SOB119855") { return reply({ message: "Fixture details unavailable" }, 503); }
        return reply({ order: orders.find((order) => order.id === ref) });
      }
      if (pathname.endsWith("/acquire")) { return reply({ lease: { active: true }, editLeaseToken: "test-group-lease" }); }
      if (pathname.endsWith("/heartbeat") || pathname.endsWith("/release")) { return reply({ released: true }); }
      if (pathname === "/api/dispatch/audit") { audits.push(request.postDataJSON()); return reply({}); }
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) { return reply({ message: "No real plan writes in browser fixture" }, 409); }
      const fixtures = {
        "/api/auth/me": { operator: { id: "fixture", username: "fixture", display_name: "Group fixture", role: "dispatcher", roles: ["dispatcher"] } },
        "/api/dispatch/config": { driverOrientedPlanning: true, plannerOrderPoolMode: "on", plannerCommandMode: "off" },
        "/api/dispatch/setup": { drivers: [{ login: "dao", name: "Dao", license: "AZ" }], trucks: [{ id: "T4", plate: "TEST", capacityLbs: 83000, baseYard: "12441" }], ownYards: [], planning: {} },
        "/api/dispatch/v2/bootstrap": { exists: true, plan }, "/api/dispatch/plans/current": plan,
        "/api/dispatch/v2/order-pool": { orders: cards, nextCursor: "", ready: true }, "/api/dispatch/orders": cards,
        "/api/dispatch/vendor-yards": [], "/api/dispatch/planned-assignments": [], "/api/dispatch/plans": [],
        "/api/dispatch/driver-job-statuses": [], "/api/dispatch/driver-truck-switches/attention": [],
        "/api/dispatch/plan-edit-lease": { lease: null },
        "/api/dispatch/forecast": { planId: "323", planDate: plan.planDate, loads: [], stops: [], travelLegs: [] },
        "/api/mbt/status": { capabilities: { binDispatch: { enabled: false } } }
      };
      return reply(fixtures[pathname] ?? {});
    });
    await page.goto("/dispatch/planning");
    await page.locator('[data-action="enter-edit-mode"]').click();
    await expect(page.locator('[data-action="exit-edit-mode"]')).toBeVisible();
    // Reproduce a multi-selection containing a card the dispatcher never opened.
    await page.evaluate("selectedOrderIds = new Set(['SOB119854','SOB119855']); selectedOrderId='SOB119854'; render({save:false});");
    await page.locator('[data-action="open-group-modal"]').click();
    await page.locator('[data-action="confirm-group"]').click();
    if (failSecond) {
      await expect.poll(() => reads.includes("SOB119855")).toBe(true);
      await expect(page.locator("body")).toContainText("Grouping failed");
      expect(await page.evaluate("orders.some(order => order.id === 'GOB-119854-119855')")).toBe(false);
      expect(audits.filter((audit) => audit.action === "orders_grouped")).toHaveLength(0);
    } else {
      await expect.poll(() => page.evaluate("orders.find(order => order.id === 'GOB-119854-119855')?.items.length || 0")).toBe(24);
      const group = await page.evaluate("orders.find(order => order.id === 'GOB-119854-119855')");
      expect(group.items.map((item) => [item.itemId,item.lineId,item.quantity])).toEqual(orders.flatMap((order) => order.items.map((item) => [item.itemId,item.lineId,item.quantity])));
      expect(reads).toContain("SOB119855");
    }
    expect(errors).toEqual([]);
    if (browserName === "chromium") {
      const coverage = await page.coverage.stopJSCoverage();
      const dispatch = coverage.find((entry) => new URL(entry.url).pathname === "/dispatch.js");
      await testInfo.attach("cargo-v8-coverage", { body: JSON.stringify(dispatch), contentType: "application/json" });
    }
  });
}
