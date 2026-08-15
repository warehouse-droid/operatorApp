import crypto from "node:crypto";

import { createOperator } from "../../../src/auth-repository.js";
import { query } from "../../../src/db.js";
import { expect, test } from "./mbt-e2e-test.js";

const runId = crypto.randomUUID().slice(0, 8);
const username = `dispatch-popup-boundary-${runId}`;
const password = "dispatch-popup-boundary-test";
const planDate = "2038-11-14";

const orders = [
  {
    id: "DP-UI-A", type: "SO", customer: "Popup Test A", address: "1 Test Street",
    items: [{ sku: "A", qty: 2 }], pallets: 1, status: "open", sourceTable: "sales_orders"
  },
  {
    id: "DP-UI-B", type: "SO", customer: "Popup Test B", address: "2 Test Street",
    items: [{ sku: "B", qty: 2 }], pallets: 1, status: "open", sourceTable: "sales_orders"
  }
];

const dispatchFixtures = new Map([
  ["/api/dispatch/config", {}],
  ["/api/dispatch/vendor-yards", []],
  ["/api/dispatch/setup", { drivers: [], trucks: [], ownYards: [], planning: {} }],
  ["/api/dispatch/orders", orders],
  ["/api/dispatch/plans", []],
  ["/api/dispatch/plans/current", {
    exists: false, planDate, id: null, revision: 0, orders: [], trucks: []
  }],
  ["/api/dispatch/driver-job-statuses", []],
  ["/api/dispatch/forecast", { loads: [] }],
  ["/api/dispatch/plan-edit-lease", { lease: null }]
]);

function dispatchFixture(path) {
  if (path.endsWith("/acquire")) {
    return { lease: { active: true }, editLeaseToken: "test-popup-lease" };
  }
  if (path.endsWith("/heartbeat") || path.endsWith("/release")) {
    return { released: true };
  }
  return dispatchFixtures.get(path) ?? {};
}

function json(route, body) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "cache-control": "no-store" },
    body: JSON.stringify(body)
  });
}

async function clickVisualCenter(_page, locator) {
  await expect(locator).toBeVisible();
  await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const x = rect.left + (rect.width / 2);
    const y = rect.top + (rect.height / 2);
    const hit = globalThis.document.elementFromPoint(x, y);
    if (hit !== element && !element.contains(hit)) {
      throw new Error(`The ${element.dataset.action || element.tagName} control is covered at its visual center.`);
    }
  });
  await locator.dispatchEvent("click");
}

async function removeOperator() {
  await query(
    "DELETE FROM operator_sessions WHERE operator_id IN (SELECT id FROM operators WHERE username = $1)",
    [username]
  );
  await query("DELETE FROM operators WHERE username = $1", [username]);
}

async function loginToken(request) {
  const response = await request.post("/api/auth/login", { data: { username, password } });
  expect(response.status()).toBe(200);
  return (await response.json()).token;
}

test.beforeAll(async () => {
  await createOperator({
    username,
    password,
    displayName: "Dispatch popup boundary",
    role: "dispatcher",
    roles: ["dispatcher"]
  });
});

test.afterAll(async () => {
  await removeOperator();
});

test("DP-15 browser: group and split popups preserve the planner root, focus, scroll, and avoid a snapshot refetch", async ({ page, request }) => {
  const requestsAfterInitialLoad = [];
  await page.route("**/api/dispatch/**", async (route) => {
    const requestInfo = route.request();
    requestsAfterInitialLoad.push(`${requestInfo.method()} ${new URL(requestInfo.url()).pathname}`);
    const path = new URL(requestInfo.url()).pathname;
    return json(route, dispatchFixture(path));
  });

  const token = await loginToken(request);
  await page.goto("/");
  await page.evaluate(({ token: value, date }) => {
    globalThis.localStorage.setItem("mbbs.staff.token", value);
    globalThis.localStorage.setItem("mbbs.staff.role", "dispatcher");
    globalThis.localStorage.setItem("mbbs.staff.roles", JSON.stringify(["dispatcher"]));
    globalThis.localStorage.setItem("mbbs.dispatch.token", value);
    globalThis.localStorage.setItem("mbbs.dispatch.planDate", date);
  }, { token, date: planDate });
  await page.goto("/dispatch/planning");

  // These are intentionally a selector contract: the incremental renderer
  // needs stable ownership boundaries that a browser test can observe.
  const root = page.locator("[data-dispatch-planner-root]");
  const modalLayer = page.locator("[data-dispatch-modal-layer]");
  await expect(root).toBeVisible();
  await expect(modalLayer).toBeAttached();
  const rootHandle = await root.elementHandle();
  await page.locator('[data-order="DP-UI-A"]').click();
  await page.locator('[data-order="DP-UI-B"]').click({ modifiers: ["Control"] });
  const groupButton = page.locator('[data-action="open-group-modal"]');
  await expect(groupButton).toBeVisible();
  await page.locator("#planDateInput").focus();
  await page.locator(".truck-board").evaluate((element) => {
    // The fixture intentionally has no planned trucks. Add a test-only scroll
    // sentinel so a real, browser-clamped scroll offset can prove that opening
    // a modal did not replace or rerender the planner root.
    const sentinel = globalThis.document.createElement("div");
    sentinel.dataset.dispatchScrollSentinel = "true";
    sentinel.style.height = "1000px";
    sentinel.style.pointerEvents = "none";
    element.style.height = "200px";
    element.style.maxHeight = "200px";
    element.style.flex = "0 0 200px";
    element.append(sentinel);
    element.scrollTop = 120;
  });
  await expect(page.locator(".truck-board")).toHaveJSProperty("scrollTop", 120);
  requestsAfterInitialLoad.length = 0;

  await groupButton.click();
  await expect(modalLayer.getByRole("heading", { name: "Group Orders" })).toBeVisible();
  expect(await rootHandle.evaluate((element) => element === globalThis.document.querySelector("[data-dispatch-planner-root]"))).toBe(true);
  await expect(page.locator("#planDateInput")).toBeFocused();
  await expect(page.locator(".truck-board")).toHaveJSProperty("scrollTop", 120);

  const closeButton = modalLayer.getByRole("button", { name: "Close", exact: true });
  await clickVisualCenter(page, closeButton);
  await expect(modalLayer.getByRole("heading", { name: "Group Orders" })).toBeHidden();
  await page.locator('[data-order="DP-UI-A"]').click();
  await clickVisualCenter(page, page.locator('[data-action="open-split-modal"]'));
  await expect(modalLayer.getByRole("heading", { name: "Split Order" })).toBeVisible();
  await page.locator("#splitParts").fill("3");
  expect(await rootHandle.evaluate((element) => element === globalThis.document.querySelector("[data-dispatch-planner-root]"))).toBe(true);
  expect(requestsAfterInitialLoad).not.toContain("GET /api/dispatch/plans/current");
});

test("DP-13/DP-14 browser: unchanged polling keeps the preview and changed execution keeps its map and stop scroll", async ({ page, request }) => {
  const stableOrder = {
    id: "DP-STABLE-A",
    type: "SO",
    customer: "Stable Preview",
    address: "88 Stable Preview Road",
    sourceYard: "3445",
    pickupLocations: ["3445"],
    items: [{ sku: "STABLE-A", pallets: 2 }],
    pallets: 2,
    weight: 4000,
    status: "open",
    sourceTable: "sales_orders"
  };
  const stablePlan = {
    id: "778",
    planId: "778",
    planDate,
    revision: 3,
    digest: "dp-stable-preview-digest",
    status: "draft",
    summary: { driverLaneOrder: ["stable-driver"] },
    assignedOrderSnapshots: [stableOrder],
    trucks: [{
      id: "DP-STABLE-TRUCK",
      plate: "DP-STABLE-TRUCK",
      driver: "Stable Driver",
      driverLogin: "stable-driver",
      base: "3445",
      loads: [{
        id: "dp-stable-load",
        name: "Stable Load",
        driverName: "Stable Driver",
        driverLogin: "stable-driver",
        truckId: "DP-STABLE-TRUCK",
        truckPlate: "DP-STABLE-TRUCK",
        startMode: "fixed",
        start: "08:00",
        stops: [
          { id: "dp-stable-pick", loadId: "dp-stable-load", type: "pick", orderId: stableOrder.id, location: "3445" },
          { id: "dp-stable-drop", loadId: "dp-stable-load", type: "drop", orderId: stableOrder.id, location: stableOrder.address }
        ]
      }]
    }]
  };
  let emitChangedStatus = false;
  let statusReads = 0;
  let forecastReads = 0;
  await page.addInitScript(() => {
    const nativeSetInterval = globalThis.setInterval.bind(globalThis);
    globalThis.setInterval = (callback, delay, ...args) => {
      if (Number(delay) === 15000) {
        globalThis.__dispatchForecastTick = () => callback(...args);
        return 15000;
      }
      return nativeSetInterval(callback, delay, ...args);
    };
  });
  await page.route("**/api/dispatch/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/dispatch/v2/bootstrap") {
      return json(route, { exists: true, plan: stablePlan });
    }
    if (path === "/api/dispatch/config") {
      return json(route, { googleMapsApiKey: "", driverOrientedPlanning: true });
    }
    if (path === "/api/dispatch/setup") {
      return json(route, {
        drivers: [{ name: "Stable Driver", login: "stable-driver", license: "AZ" }],
        trucks: [{ plate: "DP-STABLE-TRUCK", capacityLbs: 48_000, baseYard: "3445" }],
        ownYards: [{ code: "3445", name: "3445", address: "3445 Kennedy Road, Toronto, ON" }],
        planning: {}
      });
    }
    if (path === "/api/dispatch/orders") {
      return json(route, [stableOrder]);
    }
    if (path === "/api/dispatch/plans/778/revision") {
      return json(route, { revision: 3, savedAt: "2038-11-14T10:00:00.000Z" });
    }
    if (path === "/api/dispatch/driver-job-statuses") {
      statusReads += 1;
      return json(route, emitChangedStatus ? [{
        job_id: "dp-stable-complete",
        load_id: "dp-stable-load",
        stop_id: "dp-stable-drop",
        stop_type: "dropoff",
        status: "complete",
        order_refs: [stableOrder.id]
      }] : []);
    }
    if (path === "/api/dispatch/driver-truck-switches/attention") {
      return json(route, []);
    }
    if (path === "/api/dispatch/forecast") {
      forecastReads += 1;
      return json(route, {
        planId: "778",
        planRevision: 3,
        planDate,
        generatedAt: `2038-11-14T10:00:${String(forecastReads).padStart(2, "0")}.000Z`,
        loads: [],
        stops: [],
        travelLegs: [],
        timelineEvents: []
      });
    }
    if (path === "/api/dispatch/plan-edit-lease") {
      return json(route, { lease: null });
    }
    if (path === "/api/dispatch/plans") {
      return json(route, []);
    }
    return json(route, dispatchFixture(path));
  });
  await page.route("**/api/mbt/status", (route) => json(route, { capabilities: { binDispatch: { enabled: false } } }));

  const token = await loginToken(request);
  await page.goto("/");
  await page.evaluate(({ token: value, date }) => {
    globalThis.localStorage.setItem("mbbs.staff.token", value);
    globalThis.localStorage.setItem("mbbs.staff.role", "dispatcher");
    globalThis.localStorage.setItem("mbbs.staff.roles", JSON.stringify(["dispatcher"]));
    globalThis.localStorage.setItem("mbbs.dispatch.token", value);
    globalThis.localStorage.setItem("mbbs.dispatch.planDate", date);
  }, { token, date: planDate });
  await page.goto("/dispatch/planning");
  const loadTitle = page.locator('[data-action="select-load"][data-load="dp-stable-load"]');
  await loadTitle.focus();
  await expect(loadTitle).toBeFocused();
  await loadTitle.press("Enter");

  const mapCanvas = page.locator("#googleMapPreview");
  const stopList = page.locator('.preview-stop-list[data-load="dp-stable-load"]');
  await expect(mapCanvas).toBeVisible();
  await expect(stopList).toBeVisible();
  const mapHandle = await mapCanvas.elementHandle();
  await page.addStyleTag({
    content: `
      .preview-stop-list[data-load="dp-stable-load"] {
        height: 120px !important;
        max-height: 120px !important;
        overflow-y: auto !important;
      }
      .preview-stop-list[data-load="dp-stable-load"] > * {
        min-height: 400px !important;
      }
    `
  });
  await stopList.evaluate((element) => {
    element.scrollTop = 160;
  });
  await expect(stopList).toHaveJSProperty("scrollTop", 160);

  const runExecutionTick = async () => {
    const priorStatusReads = statusReads;
    const priorForecastReads = forecastReads;
    await page.evaluate(() => globalThis.__dispatchForecastTick());
    await expect.poll(() => statusReads).toBeGreaterThan(priorStatusReads);
    await expect.poll(() => forecastReads).toBeGreaterThan(priorForecastReads);
    await page.evaluate(() => new Promise((resolve) => {
      globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolve));
    }));
  };

  await runExecutionTick();
  expect(await mapHandle.evaluate((element) => element === globalThis.document.querySelector("#googleMapPreview"))).toBe(true);
  await expect(stopList).toHaveJSProperty("scrollTop", 160);

  emitChangedStatus = true;
  await runExecutionTick();
  expect(await mapHandle.evaluate((element) => element === globalThis.document.querySelector("#googleMapPreview"))).toBe(true);
  await expect(page.locator('.preview-stop-list[data-load="dp-stable-load"]')).toHaveJSProperty("scrollTop", 160);
  await expect(page.locator('[data-load-card="dp-stable-load"]')).toHaveClass(/driver-active/u);
});

test("DP-17/DP-19 browser: compact Custom Order startup keeps completed travel styling through a failed save", async ({ page, request }) => {
  const compactOrder = {
    id: "DP-UI-CUSTOM",
    customOrderId: "120",
    customOrder: true,
    type: "CUSTOM",
    sourceTable: "dispatch_custom_orders",
    dispatchRef: "DP-UI-CUSTOM",
    customer: "Custom Order",
    address: "88 Compact Test Road",
    destinationAddress: "88 Compact Test Road",
    sourceYard: "3445",
    sourceAddress: "3445 Kennedy Road, Toronto, ON",
    defaultSourceAddress: "3445 Kennedy Road, Toronto, ON",
    pickupLocations: ["3445"],
    stopMinutes: 47,
    instructions: "Compact browser evidence",
    notes: "Compact browser evidence",
    items: [{ sku: "CUSTOM", quantity: 1, unit: "LOAD" }],
    salesQty: 1,
    salesQuantities: [{ unit: "LOAD", quantity: 1 }],
    packed: { pallets: 0, layers: 0, sections: 0, pieces: 0 },
    weight: 2300
  };
  const nestedChild = {
    id: "3022094354",
    type: "PO",
    customer: "Historical grouped PO child",
    address: "12441 Woodbine Avenue, Whitchurch-Stouffville, ON",
    sourceYard: "3445",
    pickupLocations: ["3445"],
    items: [{ sku: "NESTED-CHILD", pallets: 2 }],
    pallets: 2,
    weight: 4000
  };
  const nestedGroup = {
    id: "POB03597",
    type: "PO",
    customer: "Historical grouped PO",
    address: nestedChild.address,
    sourceYard: "3445",
    pickupLocations: ["3445"],
    items: nestedChild.items,
    pallets: nestedChild.pallets,
    weight: nestedChild.weight
  };
  const compactPlan = {
    id: "777",
    planId: "777",
    planDate,
    revision: 4,
    digest: "dp-compact-browser-digest",
    status: "draft",
    summary: { driverLaneOrder: ["compact-driver"] },
    // Production snapshots created before group materialization can contain the
    // historical child stop IDs while only retaining the current parent order.
    // Driver evidence, not order-feed completeness, must protect those stops.
    assignedOrderSnapshots: [compactOrder, nestedGroup],
    trucks: [{
      id: "DP-TRAVEL-TRUCK",
      plate: "DP-TRAVEL-TRUCK",
      driver: "Compact Driver",
      driverLogin: "compact-driver",
      base: "3445",
      loads: [{
        id: "dp-travel-load",
        name: "Load 1",
        driverName: "Compact Driver",
        driverLogin: "compact-driver",
        truckId: "DP-TRAVEL-TRUCK",
        truckPlate: "DP-TRAVEL-TRUCK",
        startMode: "auto",
        stops: [
          { id: "dp-travel-pick", loadId: "dp-travel-load", type: "pick", orderId: compactOrder.id, location: "3445" },
          { id: "dp-travel-drop", loadId: "dp-travel-load", type: "drop", orderId: compactOrder.id, location: compactOrder.address }
        ]
      }, {
        id: "dp-nested-load",
        name: "Load 2",
        driverName: "Compact Driver",
        driverLogin: "compact-driver",
        driverSequence: 1,
        truckId: "DP-TRAVEL-TRUCK",
        truckPlate: "DP-TRAVEL-TRUCK",
        startMode: "auto",
        stops: [
          { id: "dp-nested-pick", loadId: "dp-nested-load", type: "pick", orderId: nestedChild.id, location: "3445" },
          { id: "dp-nested-drop", loadId: "dp-nested-load", type: "drop", orderId: nestedChild.id, location: nestedChild.address }
        ]
      }]
    }]
  };
  const forecast = {
    planId: "777",
    planRevision: 4,
    loads: [],
    timelineEvents: [],
    stops: [
      {
        stopId: "dp-travel-pick",
        plannedArrival: "2038-11-14T18:11:00.000Z",
        plannedLeave: "2038-11-14T18:41:00.000Z",
        forecastArrival: "2038-11-14T18:30:00.000Z",
        forecastLeave: "2038-11-14T18:30:00.000Z",
        actualArrival: "2038-11-14T18:30:00.000Z",
        actualLeave: "2038-11-14T18:30:00.000Z",
        status: "complete"
      },
      {
        stopId: "dp-travel-drop",
        plannedArrival: "2038-11-14T19:17:00.000Z",
        plannedLeave: "2038-11-14T19:47:00.000Z",
        forecastArrival: "2038-11-14T18:31:00.000Z",
        forecastLeave: "2038-11-14T20:03:00.000Z",
        actualArrival: "2038-11-14T18:31:00.000Z",
        actualLeave: "2038-11-14T20:03:00.000Z",
        status: "complete"
      }
    ],
    travelLegs: [{
      kind: "inter_stop",
      loadId: "dp-travel-load",
      legId: "dp-travel-pick-to-dp-travel-drop",
      from: "3445 Kennedy Road, Toronto, ON",
      to: "88 Compact Test Road",
      plannedLeave: "2038-11-14T07:40:00.000Z",
      plannedArrival: "2038-11-14T08:10:00.000Z",
      actualLeave: "2038-11-14T07:42:00.000Z",
      actualArrival: "2038-11-14T08:12:00.000Z",
      status: "complete"
    }]
  };
  let failedSaveRequests = 0;
  const routePayloads = new Map([
    ["/api/dispatch/v2/bootstrap", { exists: true, plan: compactPlan }],
    ["/api/dispatch/config", { googleMapsApiKey: "", driverOrientedPlanning: true }],
    ["/api/dispatch/setup", {
      drivers: [{ name: "Compact Driver", login: "compact-driver", license: "AZ", ownYardFixedMinutes: 40, deliveryFixedMinutes: 35, minutesPerPallet: 1 }],
      trucks: [{ plate: "DP-TRAVEL-TRUCK", capacityLbs: 48_000, baseYard: "3445" }],
      ownYards: [{ code: "3445", name: "3445", address: "3445 Kennedy Road, Toronto, ON" }],
      planning: { truckSwitchMinutes: 10 }
    }],
    ["/api/dispatch/forecast", forecast],
    ["/api/dispatch/driver-job-statuses", [{
      load_id: "dp-nested-load",
      stop_id: "dp-nested-pick",
      stop_type: "pickup",
      status: "complete",
      order_refs: [nestedChild.id]
    }]],
    ["/api/dispatch/driver-truck-switches/attention", []],
    ["/api/dispatch/plans", []],
    ["/api/dispatch/plan-edit-lease", { lease: null }],
    ["/api/dispatch/plan-edit-lease/heartbeat", { released: true }],
    ["/api/dispatch/plan-edit-lease/release", { released: true }]
  ]);
  let lastSaveCommand = null;
  await page.route("**/api/dispatch/**", async (route) => {
    const requestInfo = route.request();
    const path = new URL(requestInfo.url()).pathname;
    if (path === "/api/dispatch/orders") {
      return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "full feed unavailable in compact-start test" }) });
    }
    if (routePayloads.has(path)) {
      return json(route, routePayloads.get(path));
    }
    if (path === "/api/dispatch/plan-edit-lease/acquire") {
      const body = requestInfo.postDataJSON();
      return json(route, {
        lease: { active: true, sessionId: body.sessionId, operatorName: "Compact browser" },
        editLeaseToken: "test-compact-browser-lease"
      });
    }
    if (path === "/api/dispatch/v2/plans/777/commands") {
      failedSaveRequests += 1;
      lastSaveCommand = requestInfo.postDataJSON();
      return route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ error: "Injected save rejection", code: "DISPATCH_TEST_SAVE_REJECTED" })
      });
    }
    return json(route, dispatchFixture(path));
  });
  await page.route("**/api/mbt/status", (route) => json(route, { capabilities: { binDispatch: { enabled: false } } }));

  const token = await loginToken(request);
  await page.goto("/");
  await page.evaluate(({ token: value, date }) => {
    globalThis.localStorage.setItem("mbbs.staff.token", value);
    globalThis.localStorage.setItem("mbbs.staff.role", "dispatcher");
    globalThis.localStorage.setItem("mbbs.staff.roles", JSON.stringify(["dispatcher"]));
    globalThis.localStorage.setItem("mbbs.dispatch.token", value);
    globalThis.localStorage.setItem("mbbs.dispatch.planDate", date);
  }, { token, date: planDate });
  await page.goto("/dispatch/planning");

  const root = page.locator("[data-dispatch-planner-root]");
  const rootHandle = await root.elementHandle();
  const pickupTiming = page.locator('[data-stop="dp-travel-pick"] .stop-time');
  // Compare the timing grid by semantic cells. Browser innerText inserts a
  // separator between CSS-grid cells only after the stylesheet settles, even
  // though the four cell values and visible layout are unchanged.
  const pickupTimingCellLocator = pickupTiming.locator(".time-compare > span");
  const pickupTimingCells = () => pickupTimingCellLocator.evaluateAll((elements) =>
    elements.map((element) => element.textContent.replace(/\s+/g, " ").trim())
  );
  await expect(pickupTimingCellLocator).toHaveCount(4);
  await expect(pickupTimingCellLocator.first()).toHaveText("Actual");
  const pickupTimingBeforeMutation = await pickupTimingCells();
  expect(pickupTimingBeforeMutation.join(" ")).toContain("Actual");
  const travel = page.locator('[data-travel-leg="dp-travel-pick-to-dp-travel-drop"]');
  await expect(travel).toHaveClass(/inter-stop-travel.*status-complete/);
  const style = await travel.evaluate((element) => {
    const computed = globalThis.getComputedStyle(element);
    const main = element.querySelector(".stop-main").getBoundingClientRect();
    const timing = element.querySelector(".stop-time").getBoundingClientRect();
    return {
      backgroundColor: computed.backgroundColor,
      borderTopStyle: computed.borderTopStyle,
      timingRightAligned: timing.left > main.left
    };
  });
  expect(style).toEqual({
    backgroundColor: "rgb(207, 215, 221)",
    borderTopStyle: "dashed",
    timingRightAligned: true
  });

  await page.getByRole("button", { name: "Enter Edit Mode" }).dispatchEvent("click");
  await page.locator('[data-load-start-mode="dp-travel-load"]').selectOption("fixed");
  await expect.poll(() => failedSaveRequests).toBeGreaterThan(0);
  const nestedSavedLoad = lastSaveCommand.payload.trucks
    .flatMap((truck) => truck.loads || [])
    .find((load) => load.id === "dp-nested-load");
  expect(nestedSavedLoad.stops.find((stop) => stop.id === "dp-nested-pick")?.orderId).toBe(nestedChild.id);
  await expect.poll(pickupTimingCells).toEqual(pickupTimingBeforeMutation);
  await expect(travel).toHaveClass(/inter-stop-travel.*status-complete/);
  expect(await rootHandle.evaluate((element) => element === globalThis.document.querySelector("[data-dispatch-planner-root]"))).toBe(true);
});
