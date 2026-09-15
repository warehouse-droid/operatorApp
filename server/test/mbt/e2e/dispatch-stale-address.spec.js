import { expect, test } from "./mbt-e2e-test.js";
import fs from "node:fs/promises";

test.use({ serviceWorkers: "block", viewport: { width: 1440, height: 1000 } });
test("SA-5 real address edit and grouping keep CE94487's two destinations separate", async ({ page, browserName }, testInfo) => {
  if (browserName === "chromium") { await page.coverage.startJSCoverage({ resetOnNavigation: false }); }
  const oldAddress = "39 Estoril St, Richmond Hill, ON L4C 0B6";
  const newAddress = "145 Valleymede Dr, Richmond Hill, ON L4B 1T3";
  const orders = ["SOA08353", "SOA08354", "SOB120030"].map((id, index) => ({
    id, type: "SO", sourceTable: "sales_orders", customer: "Address test", address: index === 1 ? newAddress : oldAddress,
    destinationAddress: index === 1 ? newAddress : oldAddress, defaultDestinationAddress: index === 1 ? newAddress : oldAddress,
    sourceYard: "3445", pickupLocations: ["3445"], catalogHydrated: true, pallets: 1, weight: 1000,
    items: [{ itemId: 123 + index, lineId: 123 + index, quantity: 2, sku: `STONE-${index}` }]
  }));
  const plan = { id: "325", planDate: "2026-09-12", status: "draft", revision: 11, assignedOrderSnapshots: [], trucks: [], summary: {} };
  const errors = [];
  const writes = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    globalThis.localStorage.setItem("mbbs.staff.token", "isolated-address-fixture");
    globalThis.localStorage.setItem("mbbs.staff.role", "dispatcher");
    globalThis.localStorage.setItem("mbbs.staff.roles", JSON.stringify(["dispatcher"]));
    globalThis.localStorage.setItem("mbbs.dispatch.planDate", "2026-09-12");
    globalThis.EventSource = class { addEventListener() {} close() {} };
  });
  await page.route("**/api/**", route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const reply = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (pathname.startsWith("/api/dispatch/v2/order-feed/")) {
      return reply({ order: orders.find(order => order.id === decodeURIComponent(pathname.split("/").at(-1))) });
    }
    if (pathname.endsWith("/acquire")) { return reply({ lease: { active: true }, editLeaseToken: "address-test" }); }
    if (pathname.endsWith("/heartbeat") || pathname.endsWith("/release") || pathname === "/api/dispatch/audit") { return reply({}); }
    if (request.method() === "PUT" && pathname === "/api/dispatch/orders/SOA08353/details") {
      writes.push(request.postDataJSON());
      Object.assign(orders[0], { address: newAddress, destinationAddress: newAddress, defaultDestinationAddress: newAddress });
      return reply({ updated: { tranid: "SOA08353", dispatch_address: newAddress } });
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) { return reply({ message: "Isolated fixture has no plan persistence" }, 409); }
    const fixtures = {
      "/api/auth/me": { operator: { id: "fixture", username: "fixture", role: "dispatcher", roles: ["dispatcher"] } },
      "/api/dispatch/config": { driverOrientedPlanning: true, plannerOrderPoolMode: "on", plannerCommandMode: "off" },
      "/api/dispatch/setup": { drivers: [{ login: "li", name: "Li", license: "AZ" }], trucks: [{ id: "T8", plate: "CE94487", capacityLbs: 83000, baseYard: "3445" }], ownYards: [], planning: {} },
      "/api/dispatch/v2/bootstrap": { exists: true, plan }, "/api/dispatch/plans/current": plan,
      "/api/dispatch/v2/order-pool": { orders, nextCursor: "", ready: true }, "/api/dispatch/orders": orders,
      "/api/dispatch/vendor-yards": [], "/api/dispatch/planned-assignments": [], "/api/dispatch/plans": [],
      "/api/dispatch/driver-job-statuses": [], "/api/dispatch/driver-truck-switches/attention": [],
      "/api/dispatch/plan-edit-lease": { lease: null },
      "/api/dispatch/forecast": { planId: "325", planDate: plan.planDate, loads: [], stops: [], travelLegs: [] },
      "/api/mbt/status": { capabilities: { binDispatch: { enabled: false } } }
    };
    return reply(fixtures[pathname] ?? {});
  });
  await page.goto("/dispatch.html");
  await page.locator('[data-action="enter-edit-mode"]').click();
  await expect(page.locator('[data-action="exit-edit-mode"]')).toBeVisible();
  await expect.poll(() => page.evaluate("orders.length")).toBe(3);
  await page.evaluate("modalType='edit-order'; modalOrderId='SOA08353'; render({save:false});");
  await page.locator('[data-form="edit-order-details"] [name="address"]').fill(` ${newAddress}`);
  await page.locator('[data-form="edit-order-details"] button[type="submit"]').click();
  await expect.poll(() => writes.length).toBe(1);
  await expect.poll(() => page.evaluate("orderById('SOA08353').destinationAddress")).toBe(newAddress);
  await page.evaluate("selectedOrderIds=new Set(['SOA08353','SOA08354']); selectedOrderId='SOA08353'; render({save:false});");
  await page.locator('[data-action="open-group-modal"]').click();
  await page.locator('[data-action="confirm-group"]').click();
  await expect.poll(() => page.evaluate("orderById('GOA-8353-8354')?.destinationAddress")).toBe(newAddress);
  const visits = await page.evaluate(`consecutiveExactDropVisits([
    {id:'drop3',type:'drop',orderId:'SOB120030'}, {id:'drop4',type:'drop',orderId:'GOA-8353-8354'}
  ]).map(visit=>({address:visit.address,orders:visit.entries.map(entry=>entry.order.id)}))`);
  expect(visits).toEqual([{ address: oldAddress, orders: ["SOB120030"] }, { address: newAddress, orders: ["GOA-8353-8354"] }]);
  expect(errors).toEqual([]);
  if (browserName === "chromium") {
    const coverage = await page.coverage.stopJSCoverage();
    await testInfo.attach("cargo-v8-coverage", { body: JSON.stringify(coverage.find(entry => new URL(entry.url).pathname === "/dispatch.js")), contentType: "application/json" });
  }
});

if (process.env.STALE_ADDRESS_PLAN_FILE) {
  test("SA-5 current saved CE94487 plan produces separate stop timings without changing assignments", async ({ page }) => {
    const replay = JSON.parse(await fs.readFile(process.env.STALE_ADDRESS_PLAN_FILE, "utf8"));
    expect(replay.readOnly).toBe(true);
    expect(replay.plan.planDate).toBe("2026-09-12");
    await page.addInitScript(() => {
      globalThis.localStorage.setItem("mbbs.staff.token", "isolated-address-replay");
      globalThis.localStorage.setItem("mbbs.staff.role", "dispatcher");
      globalThis.EventSource = class { addEventListener() {} close() {} };
    });
    await page.route("**/api/**", route => {
      const pathname = new URL(route.request().url()).pathname;
      const fixtures = {
        "/api/auth/me": { operator: { id: "fixture", role: "dispatcher", roles: ["dispatcher"] } },
        "/api/dispatch/config": { driverOrientedPlanning: true, plannerOrderPoolMode: "on", plannerCommandMode: "off" },
        "/api/dispatch/setup": replay.setup,
        "/api/dispatch/vendor-yards": [], "/api/dispatch/planned-assignments": [], "/api/dispatch/plans": [],
        "/api/dispatch/v2/bootstrap": { exists: true, plan: { ...replay.plan, assignedOrderSnapshots: replay.plan.orders } },
        "/api/dispatch/v2/order-pool": { orders: replay.plan.orders, nextCursor: "", ready: true },
        "/api/dispatch/orders": replay.plan.orders, "/api/dispatch/driver-job-statuses": [],
        "/api/dispatch/plan-edit-lease": { lease: null },
        "/api/mbt/status": { capabilities: { binDispatch: { enabled: false } } }
      };
      return route.fulfill({ status: route.request().method() === "GET" ? 200 : 409,
        contentType: "application/json", body: JSON.stringify(fixtures[pathname] ?? {}) });
    });
    await page.goto("/dispatch.html");
    await expect.poll(() => page.evaluate("dispatchPlannerSnapshotState")).toBe("ready");
    await page.evaluate(value => { globalThis.__addressReplay = value; }, replay);
    const projection = await page.evaluate(`(() => {
      const replay=globalThis.__addressReplay;
      currentPlan={...replay.plan}; currentPlanDate=replay.plan.planDate;
      drivers=replay.setup.drivers; fleet=replay.setup.trucks;
      driverLaneOrder=replay.plan.summary.driverLaneOrder;
      orders=structuredClone(replay.plan.orders).map(normalizeOrder);
      trucks=structuredClone(replay.plan.trucks);
      dispatchForecast=null; driverJobStatuses=[];
      const group=orderById('GOA-8353-8354');
      group.address=group.destinationAddress=group.defaultDestinationAddress='145 Valleymede Dr, Richmond Hill, ON L4B 1T3';
      clearActiveRouteEstimates();
      const timed=trucksWithTimingMetadata().flatMap(truck=>truck.loads||[])
        .filter(load=>(load.stops||[]).some(stop=>stop.orderId===group.id));
      return {revision:replay.plan.revision,beforeTrucks:replay.plan.trucks,
        visits:timed.flatMap(load=>consecutiveExactDropVisits(load.stops).filter(visit=>visit.type==='drop')
          .map(visit=>({address:visit.address,refs:visit.entries.map(entry=>entry.order.id)}))),
        loads:timed.map(load=>({id:load.id,timing:load.timing,plannedStartMinute:load.plannedStartMinute,
          plannedFinishMinute:load.plannedFinishMinute,stops:load.stops.map(stop=>({id:stop.id,timing:stop.timing}))}))};
    })()`);
    expect(projection.visits).toEqual([
      { address: "145 Valleymede Dr, Richmond Hill, ON L4B 1T3", refs: ["GOA-8353-8354"] },
      { address: "39 Estoril St, Richmond Hill, ON L4C 0B6", refs: ["SOB120030"] }
    ]);
    expect(projection.loads).toHaveLength(1);
    const stops = projection.loads[0].stops;
    expect(stops[2].timing.arrival).toBeGreaterThan(stops[1].timing.depart);
    await fs.writeFile("test-artifacts/stale-address/timing-projection.json", JSON.stringify(projection), { mode: 0o600 });
  });
}
