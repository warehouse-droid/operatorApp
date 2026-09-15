import { expect, test } from "@playwright/test";

async function fixture(page, { ref = "SOM06255", status = "open", fail = false } = {}) {
  const staleOrder = {
    id: ref, type: "SO", sourceTable: "sales_orders", netsuiteId: "980538",
    customer: "Unpack regression fixture", address: "100 Test Street", sourceYard: "150",
    pickupLocations: ["150"], catalogHydrated: true, pallets: 26, layers: 0,
    weight: 0, salesQty: 2763.69, operatorStatus: "packed", localYardOrderStatus: "Open",
    items: [
      { itemId: 2055, lineId: 4902668, sku: "MBBS-Special Order", pallets: 15, quantity: 1274.4, unit: "SQFT" },
      { itemId: 2055, lineId: 4902669, sku: "MBBS-Special Order", pallets: 11, quantity: 1489.29, unit: "SQFT" }
    ]
  };
  const plan = {
    id: "323", planDate: "2026-09-14", status: "draft", revision: 32,
    assignedOrderSnapshots: [], summary: {},
    trucks: [{ id: "T4", plate: "TEST", driverLogin: "dao", driver: "Dao", base: "150",
      loads: [{ id: "L1", name: "Load 1", driverLogin: "dao", stops: [], orders: [] }] }]
  };
  let liveStatus = status;
  const reads = [];
  const writes = [];
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    globalThis.localStorage.setItem("mbbs.staff.token", "isolated-unpack-fixture");
    globalThis.localStorage.setItem("mbbs.staff.role", "dispatcher");
    globalThis.localStorage.setItem("mbbs.staff.roles", JSON.stringify(["dispatcher"]));
    globalThis.localStorage.setItem("mbbs.dispatch.planDate", "2026-09-14");
    globalThis.EventSource = class {
      addEventListener(name, handler) {
        if (name === "app-event") { globalThis.emitFixtureEvent = (event) => handler({ data: JSON.stringify(event) }); }
      }
      close() {}
    };
  });
  await page.route("**/api/**", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;
    const reply = (body, code = 200) => route.fulfill({ status: code, contentType: "application/json", body: JSON.stringify(body) });
    if (pathname === "/api/dispatch/orders" && url.searchParams.get("search")) {
      reads.push(url.searchParams.get("search"));
      if (fail) { return reply({ error: "Current packing status unavailable" }, 503); }
      return reply([{ ...staleOrder, operatorStatus: liveStatus, localYardOrderStatus: liveStatus === "loaded" ? "Loaded" : "Open" }]);
    }
    // Deliberately stale catalog hydration: a force-read of the catalog is insufficient.
    if (pathname.startsWith("/api/dispatch/v2/order-feed/")) { return reply({ order: staleOrder }); }
    if (pathname.endsWith("/acquire")) { return reply({ lease: { active: true }, editLeaseToken: "test-unpack-lease" }); }
    if (pathname.endsWith("/heartbeat") || pathname.endsWith("/release")) { return reply({ released: true }); }
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      writes.push(pathname);
      return reply({ error: "No production writes in the fixture" }, 409);
    }
    const { operatorStatus: _packing, localYardOrderStatus: _yard, ...card } = staleOrder;
    const fixtures = {
      "/api/auth/me": { operator: { id: "fixture", username: "fixture", role: "dispatcher", roles: ["dispatcher"] } },
      "/api/dispatch/config": { driverOrientedPlanning: true, plannerOrderPoolMode: "on", plannerCommandMode: "off" },
      "/api/dispatch/setup": { drivers: [{ login: "dao", name: "Dao", license: "AZ" }], trucks: [{ id: "T4", plate: "TEST", capacityLbs: 83000, baseYard: "150" }], ownYards: [], planning: {} },
      "/api/dispatch/v2/bootstrap": { exists: true, plan }, "/api/dispatch/plans/current": plan,
      "/api/dispatch/v2/order-pool": { orders: [{ ...card, catalogHydrated: false }], nextCursor: "", ready: true },
      "/api/dispatch/orders": [staleOrder], "/api/dispatch/vendor-yards": [],
      "/api/dispatch/planned-assignments": [], "/api/dispatch/plans": [],
      "/api/dispatch/driver-job-statuses": [], "/api/dispatch/driver-truck-switches/attention": [],
      "/api/dispatch/plan-edit-lease": { lease: null },
      "/api/dispatch/forecast": { planId: plan.id, planDate: plan.planDate, loads: [], stops: [], travelLegs: [] },
      "/api/mbt/status": { capabilities: { binDispatch: { enabled: false } } }
    };
    return reply(fixtures[pathname] ?? {});
  });
  await page.goto("/dispatch.html");
  await page.locator('[data-action="enter-edit-mode"]').click();
  await expect(page.locator('[data-action="exit-edit-mode"]')).toBeVisible();
  await page.evaluate((order) => {
    // Simulate a card hydrated while the yard still had the order packed.
    globalThis.eval(`orders = [${JSON.stringify(order)}]; orderCatalog = orders;
      selectedOrderId = ${JSON.stringify(order.id)}; selectedOrderIds = new Set([selectedOrderId]); render({save:false});`);
  }, staleOrder);
  return { reads, writes, errors, setStatus(value) { liveStatus = value; } };
}

for (const ref of ["SOM06255", "SOM06256"]) {
  test(`${ref}: Split replaces a stale packed status with the current unpacked order`, async ({ page }) => {
    const view = await fixture(page, { ref });
    await page.locator('[data-action="open-split-modal"]').click();
    await expect(page.getByRole("heading", { name: "Split Order", exact: true })).toBeVisible();
    expect(view.reads).toContain(ref);
    expect(await page.evaluate(`orderById('${ref}').operatorStatus`)).toBe("open");
    expect(await page.evaluate(`orderById('${ref}').items.map(item => item.quantity)`)).toEqual([1274.4, 1489.29]);
    expect(view.writes).toEqual([]);
    expect(view.errors).toEqual([]);
  });
}

test("an open blocked dialog becomes splittable after the unpack event", async ({ page }) => {
  const view = await fixture(page, { status: "packed" });
  await page.locator('[data-action="open-split-modal"]').click();
  await expect(page.getByRole("heading", { name: "Split Blocked" })).toBeVisible();
  view.setStatus("open");
  await page.evaluate(() => globalThis.emitFixtureEvent({ type: "delivery.order.unpacked", payload: { orderId: "980538" } }));
  await expect(page.getByRole("heading", { name: "Split Order", exact: true })).toBeVisible();
  expect(view.writes).toEqual([]);
  expect(view.errors).toEqual([]);
});

test("fresh loaded status still blocks splitting", async ({ page }) => {
  const view = await fixture(page, { status: "loaded" });
  await page.locator('[data-action="open-split-modal"]').click();
  await expect(page.getByRole("heading", { name: "Split Blocked" })).toBeVisible();
  await expect(page.locator(".warning-detail")).toContainText("already loaded");
  expect(view.writes).toEqual([]);
  expect(view.errors).toEqual([]);
});

test("failed status lookup does not open a split editor", async ({ page }) => {
  const view = await fixture(page, { fail: true });
  await page.locator('[data-action="open-split-modal"]').click();
  await expect(page.locator(".route-notice")).toContainText("Current packing status unavailable");
  await expect(page.getByRole("heading", { name: "Split Order", exact: true })).toHaveCount(0);
  expect(view.writes).toEqual([]);
  expect(view.errors).toEqual([]);
});

test("full browser payload preserves assigned source cargo and a new group while excluding incidental retired source rows", async ({ page }) => {
  const view = await fixture(page);
  await page.evaluate(`
    const source = orderById('SOM06255');
    orders = [
      {...source, id:'SOA08404-S2', originalOrderId:'SOA08404', raw:{tranid:'SOA08404-S2'}},
      {...source, id:'CO-GOA-7894-7895', type:'CO', sourceTable:'local_co_orders',
        childOrders:['SOA07894','SOA07895'], raw:{tranid:'CO-GOA-7894-7895'}},
      {...source, id:'SOA07894', raw:{tranid:'SOA07894'}},
      {...source, id:'GOM-6255S1-6256S1', planOwned:true, childOrders:['SOM06255-S1','SOM06256-S1']}
    ].map(normalizeOrder);
    trucks[0].loads[0].stops = [{id:'drop-SOA07894',type:'drop',orderId:'SOA07894'}];
  `);
  const payload = await page.evaluate("planPayload()");
  expect(payload.orders.map(order => order.id).sort()).toEqual(["GOM-6255S1-6256S1", "SOA07894"]);
  expect(payload.orders.find(order => order.id === "SOA07894").items.map(item => item.quantity)).toEqual([1274.4, 1489.29]);
  expect(payload.trucks.flatMap(truck => truck.loads).flatMap(load => load.stops).some(stop => stop.orderId === "SOA07894")).toBe(true);
  expect(view.errors).toEqual([]);
});
