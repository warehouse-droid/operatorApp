import crypto from "node:crypto";

import { createOperator } from "../../../src/auth-repository.js";
import { query } from "../../../src/db.js";
import { expect, test } from "./mbt-e2e-test.js";

const planId = "267";
const planDate = "2026-09-03";
const loadId = "T3-L1788382684125-4cd619c5c20b48";
const orderRef = "GOB-118968-119023";
const pickupStopId = "scm-dependency-pick-gob-118968-119023-techo-bloc-vaughan-4";
const stopIds = [
  "stop-d58db37f-51af-4c2e-8577-64225a5a18c9",
  `${loadId}-SOB119213-1788382684125-6408b98d981d58`,
  `${loadId}-GOA-7937-7938-1788382716437-0e990605ed6c18`,
  "stop-961be731-c371-4acb-9291-75d8df39e2f8",
  pickupStopId,
  `${loadId}-${orderRef}-1788384353678-72a24b549759d8`,
  `${loadId}-#11619-1-1788382840789-2d106964aafe68`
];
const username = `dispatch-active-co-pickup-${crypto.randomUUID().slice(0, 8)}`;
const password = "dispatch-active-co-pickup-test";

const basicItem = (quantity = 1, extra = {}) => ({
  sku: extra.sku || "TEST-ITEM",
  itemName: extra.itemName || extra.sku || "TEST-ITEM",
  unit: extra.unit || "EACH",
  quantity,
  salesQty: quantity,
  pallets: Number(extra.pallets || 0),
  layers: Number(extra.layers || 0),
  sections: Number(extra.sections || 0),
  pieces: Number(extra.pieces || 0),
  itemWeight: Number(extra.itemWeight || 1),
  ...extra
});

const assignedOrders = [
  {
    id: "SOB119213",
    type: "SO",
    customer: "YZ Landscaping",
    sourceYard: "12441",
    pickupLocations: ["12441"],
    address: "30 Hancock St, Aurora, ON L4G 7C4",
    destinationAddress: "30 Hancock St, Aurora, ON L4G 7C4",
    items: [basicItem(1)],
    pallets: 1,
    weight: 1000,
    localDispatchStatus: "planned"
  },
  {
    id: "GOA-7937-7938",
    type: "SO",
    customer: "Grouped customer",
    sourceYard: "12441",
    pickupLocations: ["12441"],
    address: "82 Eaglewood Blvd, Mississauga, ON L5G 1V4",
    destinationAddress: "82 Eaglewood Blvd, Mississauga, ON L5G 1V4",
    items: [basicItem(1)],
    pallets: 1,
    weight: 1000,
    localDispatchStatus: "planned"
  },
  {
    id: "#11619-1",
    type: "PO",
    customer: "Oakville Natural Stone Corporation",
    sourceYard: "Oakville Stone",
    pickupLocations: ["Oakville Stone"],
    address: "3445 Kennedy Road, Toronto, ON",
    destinationAddress: "3445 Kennedy Road, Toronto, ON",
    destinationYard: "3445",
    destinationLocationId: 1,
    dropoffs: [{
      key: "location:1",
      destinationLocationId: 1,
      destinationYard: "3445",
      address: "3445 Kennedy Road, Toronto, ON",
      pallets: 1,
      salesQty: 1,
      lineRowIds: ["oakville-line"]
    }],
    items: [basicItem(1, { lineRowId: "oakville-line", pallets: 1 })],
    pallets: 1,
    weight: 1000,
    localDispatchStatus: "planned"
  },
  {
    id: orderRef,
    type: "SO",
    customer: "Homeworld Roofing Corp",
    sourceYard: "12441",
    pickupLocations: ["12441", "TECHO BLOC Vaughan"],
    address: "27 John Rolph StMarkham, ON L6B 1R8",
    destinationAddress: "27 John Rolph StMarkham, ON L6B 1R8",
    items: [
      basicItem(10, { sku: "YARD-STOCK", pallets: 1 }),
      basicItem(81.38, {
        sku: "MBBS-Special Order",
        unit: "SQFT",
        poAllocatedSalesQty: 81.38
      })
    ],
    poPickupManifest: [{
      poOrderRef: "LOINC-030542",
      location: "TECHO BLOC Vaughan",
      address: "720 Arrow Rd. North York, ON M9M 2M1",
      items: [basicItem(81.38, { sku: "MBBS-Special Order", unit: "SQFT" })]
    }],
    childOrders: ["SOB119023", "SOB118968"],
    transitCo: {
      id: "CO-GOB-118968-119023",
      status: "pending_load",
      fromYard: "3445",
      toYard: "12441",
      sourceOrderId: orderRef
    },
    transitOriginalSourceYard: "3445",
    transitOriginalPickupLocations: ["3445"],
    pallets: 2,
    weight: 2000,
    localDispatchStatus: "planned",
    globalGroupDefinition: true
  },
  {
    id: "CO-GOB-118968-119023",
    type: "CO",
    customer: "Transit Depot Order",
    sourceOrderId: orderRef,
    sourceYard: "3445",
    pickupLocations: ["3445"],
    destinationYard: "12441",
    address: "12441 Woodbine Avenue, Whitchurch-Stouffville, ON",
    destinationAddress: "12441 Woodbine Avenue, Whitchurch-Stouffville, ON",
    items: [],
    pallets: 0,
    weight: 0,
    localDispatchStatus: "open"
  }
];

const stops = [
  { id: stopIds[0], type: "pick", loadId, orderId: "SOB119213", location: "12441" },
  { id: stopIds[1], type: "drop", loadId, orderId: "SOB119213", location: "12441" },
  { id: stopIds[2], type: "drop", loadId, orderId: "GOA-7937-7938", location: "12441" },
  { id: stopIds[3], type: "pick", loadId, orderId: "#11619-1", location: "Oakville Stone" },
  {
    id: stopIds[4],
    type: "pick",
    loadId,
    orderId: orderRef,
    location: "TECHO BLOC Vaughan",
    dependencySource: "scm-dependency-management",
    dependencyManaged: true,
    dependencyTargetRefs: [orderRef]
  },
  { id: stopIds[5], type: "drop", loadId, orderId: orderRef, location: "12441" },
  {
    id: stopIds[6],
    type: "drop",
    loadId,
    orderId: "#11619-1",
    location: "Oakville Stone",
    dropoffKey: "location:1",
    dropLocation: "3445",
    dropAddress: "3445 Kennedy Road, Toronto, ON",
    destinationLocationId: 1,
    lineRowIds: ["oakville-line"],
    dropPallets: 1,
    dropSalesQty: 1,
    dropWeight: 1000
  }
];

const truck = {
  id: "T3",
  plate: "BC71838",
  driver: "Dao",
  driverLogin: "dao",
  license: "AZ",
  base: "12441",
  capacityLbs: 80000,
  ownYardFixedMinutes: 30,
  vendorFixedMinutes: 30,
  deliveryFixedMinutes: 10,
  minutesPerPallet: 1,
  travelTimePercent: 30,
  loads: [{
    id: loadId,
    name: "Load 1",
    start: "07:00",
    startMode: "fixed",
    truckId: "T3",
    truckPlate: "BC71838",
    driverName: "Dao",
    driverLogin: "dao",
    switchYard: "12441",
    stops
  }]
};

const plan = {
  id: planId,
  planDate,
  revision: 35,
  status: "confirmed",
  savedAt: "2026-09-03T03:00:00.000Z",
  assignedOrderSnapshots: assignedOrders,
  trucks: [truck],
  summary: { driverLaneOrder: ["dao"], ownYardCodes: ["3445", "2967", "12441", "150"] }
};

const travelPairs = [
  ["12441", "30 Hancock St, Aurora, ON L4G 7C4"],
  ["30 Hancock St, Aurora, ON L4G 7C4", "82 Eaglewood Blvd, Mississauga, ON L5G 1V4"],
  ["82 Eaglewood Blvd, Mississauga, ON L5G 1V4", "Oakville Stone"],
  ["Oakville Stone", "TECHO BLOC Vaughan"],
  ["TECHO BLOC Vaughan", "27 John Rolph StMarkham, ON L6B 1R8"],
  ["27 John Rolph StMarkham, ON L6B 1R8", "3445"]
];

const forecast = {
  planId,
  planDate,
  planRevision: 35,
  generatedAt: "2026-09-03T03:00:00.000Z",
  loads: [],
  stops: stopIds.map((stopId, index) => ({
    loadId,
    stopId,
    plannedArrival: `2026-09-03T${String(11 + index).padStart(2, "0")}:00:00.000Z`,
    plannedLeave: `2026-09-03T${String(11 + index).padStart(2, "0")}:20:00.000Z`,
    forecastArrival: `2026-09-03T${String(11 + index).padStart(2, "0")}:00:00.000Z`,
    forecastLeave: `2026-09-03T${String(11 + index).padStart(2, "0")}:20:00.000Z`,
    status: "pending"
  })),
  travelLegs: travelPairs.map(([from, to], index) => ({
    loadId,
    kind: "inter_stop",
    legId: `${loadId}-inter-${index}`,
    from,
    to,
    plannedLeave: `2026-09-03T${String(11 + index).padStart(2, "0")}:20:00.000Z`,
    plannedArrival: `2026-09-03T${String(12 + index).padStart(2, "0")}:00:00.000Z`,
    forecastLeave: `2026-09-03T${String(11 + index).padStart(2, "0")}:20:00.000Z`,
    forecastArrival: `2026-09-03T${String(12 + index).padStart(2, "0")}:00:00.000Z`,
    status: "pending"
  }))
};

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: { "cache-control": "no-store" },
    body: JSON.stringify(body)
  });
}

function dispatchFixture(path) {
  return new Map([
    ["/api/dispatch/config", {
      googleMapsApiKey: "",
      driverOrientedPlanning: true,
      plannerOrderPoolMode: "off",
      plannerCommandMode: "off"
    }],
    ["/api/dispatch/setup", {
      drivers: [{ login: "dao", name: "Dao", license: "AZ" }],
      trucks: [{ plate: "BC71838", capacityLbs: 80000, baseYard: "12441" }],
      ownYards: [],
      planning: {}
    }],
    ["/api/dispatch/vendor-yards", [
      { vendor: "Oakville Natural Stone Corporation", yard: "Oakville Stone", address: "Oakville Stone", active: true },
      { vendor: "Techo Bloc", yard: "TECHO BLOC Vaughan", address: "720 Arrow Rd. North York, ON M9M 2M1", active: true }
    ]],
    ["/api/dispatch/v2/bootstrap", { exists: true, plan }],
    ["/api/dispatch/orders", []],
    ["/api/dispatch/v2/order-pool", { orders: [], nextCursor: "" }],
    ["/api/dispatch/planned-assignments", []],
    ["/api/dispatch/plans", []],
    ["/api/dispatch/driver-job-statuses", []],
    ["/api/dispatch/driver-truck-switches/attention", []],
    ["/api/dispatch/forecast", forecast],
    ["/api/dispatch/plan-edit-lease", { lease: null }]
  ]).get(path);
}

async function loginToken(request) {
  const response = await request.post("/api/auth/login", { data: { username, password } });
  expect(response.status()).toBe(200);
  return (await response.json()).token;
}

async function removeOperator() {
  await query(
    "DELETE FROM operator_sessions WHERE operator_id IN (SELECT id FROM operators WHERE username = $1)",
    [username]
  );
  await query("DELETE FROM operators WHERE username = $1", [username]);
}

test.beforeAll(async () => {
  await createOperator({
    username,
    password,
    displayName: "Dispatch active CO pickup replay",
    role: "dispatcher",
    roles: ["dispatcher"]
  });
});

test.afterAll(removeOperator);

test("DAO Load 1 renders the Techo PO pickup as the fifth of seven physical stops", async ({ page, request }) => {
  const dispatchWrites = [];
  await page.coverage.startJSCoverage({ resetOnNavigation: false });
  await page.addInitScript(({ date }) => {
    globalThis.localStorage.setItem("mbbs.dispatch.planDate", date);
    globalThis.EventSource = class {
      addEventListener() {}
      close() {}
    };
  }, { date: planDate });
  await page.route("**/api/dispatch/**", (route) => {
    const requestUrl = new URL(route.request().url());
    const method = route.request().method();
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      dispatchWrites.push({ method, path: requestUrl.pathname });
      return json(route, {}, 409);
    }
    const fixture = dispatchFixture(requestUrl.pathname);
    return json(route, fixture === undefined ? {} : fixture);
  });
  await page.route("**/api/mbt/status", (route) => json(route, {
    capabilities: { binDispatch: { enabled: false } }
  }));

  const token = await loginToken(request);
  await page.addInitScript((authToken) => {
    globalThis.localStorage.setItem("mbbs.staff.token", authToken);
    globalThis.localStorage.setItem("mbbs.staff.role", "dispatcher");
    globalThis.localStorage.setItem("mbbs.staff.roles", JSON.stringify(["dispatcher"]));
    globalThis.localStorage.setItem("mbbs.dispatch.token", authToken);
  }, token);

  await page.goto("/dispatch/planning?activeCoManifestReplay=1");
  await expect(page.locator("[data-dispatch-planner-root]")).toBeVisible();
  await expect(page.locator("#planDateInput")).toHaveValue(planDate);

  const load = page.locator(`[data-load-card="${loadId}"]`);
  await expect(load).toBeVisible();
  const boardStops = load.locator("article.stop-card[data-stop]");
  await expect(boardStops).toHaveCount(7);
  await expect.poll(() => boardStops.evaluateAll((cards) => cards.map((card) => card.dataset.stop))).toEqual(stopIds);
  await expect(boardStops.nth(4)).toContainText("5. Pickup TECHO BLOC Vaughan");
  await expect(boardStops.nth(5)).toContainText(`6. ${orderRef}`);
  await expect(load.locator("article.inter-stop-travel")).toHaveCount(6);
  await expect(load.locator("article.inter-stop-travel").nth(3)).toContainText(
    "Travel | Oakville Stone to TECHO BLOC Vaughan"
  );
  await expect(load.locator("article.inter-stop-travel").nth(4)).toContainText(
    "Travel | TECHO BLOC Vaughan to 27 John Rolph StMarkham, ON L6B 1R8"
  );

  await load.locator(`[data-action="select-load"][data-load="${loadId}"]`).click();
  const preview = page.locator("[data-dispatch-load-preview-layer] .load-preview-panel");
  await expect(preview).toBeVisible();
  const previewStops = preview.locator("article.preview-stop[data-stop]");
  await expect(previewStops).toHaveCount(7);
  await expect.poll(() => previewStops.evaluateAll((cards) => cards.map((card) => card.dataset.stop))).toEqual(stopIds);
  await expect(previewStops.nth(4)).toContainText("5. Pickup | TECHO BLOC Vaughan");
  await expect(previewStops.nth(5)).toContainText(`6. Drop | ${orderRef}`);
  await expect(preview.locator("article.inter-stop-travel")).toHaveCount(6);

  const timing = preview.locator(".timing-detail-list");
  await expect(timing.getByText("Pickup TECHO BLOC Vaughan", { exact: true })).toBeVisible();
  await expect(timing.getByText(`Drop ${orderRef}`, { exact: true })).toBeVisible();
  await expect(timing.getByText(
    "Travel Oakville Stone to TECHO BLOC Vaughan",
    { exact: true }
  )).toBeVisible();
  await expect(timing.getByText(
    "Travel TECHO BLOC Vaughan to 27 John Rolph StMarkham, ON L6B 1R8",
    { exact: true }
  )).toBeVisible();
  expect(dispatchWrites).toEqual([]);

  const coverage = await page.coverage.stopJSCoverage();
  const dispatchCoverage = coverage.find((entry) => new URL(entry.url).pathname === "/dispatch.js");
  expect(dispatchCoverage, "dispatch.js must be present in Chromium coverage").toBeTruthy();
  for (const functionName of [
    "dispatchRelationshipPickupLocations",
    "activeTransitPickupLocations",
    "normalizeOrder",
    "applyTransitPickupToOrder"
  ]) {
    const functionCoverage = dispatchCoverage.functions.find((entry) => entry.functionName === functionName);
    expect(functionCoverage, `${functionName} must be instrumented`).toBeTruthy();
    expect(
      functionCoverage.ranges.some((range) => Number(range.count) > 0),
      `${functionName} must execute in the incident replay`
    ).toBe(true);
  }
});
