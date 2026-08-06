import crypto from "node:crypto";

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./mbt-e2e-test.js";

import { createOperator } from "../../../src/auth-repository.js";
import { query } from "../../../src/db.js";

const RUN_ID = crypto.randomUUID().slice(0, 8);
const USERNAME = `p3-bin-dispatch-e2e-${RUN_ID}`;
const PASSWORD = "p3-bin-dispatch-synthetic-browser";
const PLAN_ID = "900137";
const PLAN_DATE = "2037-08-03";
const LOAD_ID = "P3-BIN-LOAD-1";
const TRUCK_ID = "900138";
const DRIVER_ID = "900139";
const CONTRACT_ID = "00000000-0000-4000-8000-000000000804";
const FRONT_VISIT_ID = "00000000-0000-4000-8000-000000000801";
const FUTURE_VISIT_ID = "00000000-0000-4000-8000-000000000802";
const ASSET_ID = "00000000-0000-4000-8000-000000000806";
const SECOND_ASSET_ID = "00000000-0000-4000-8000-000000000807";

const FRONT_STOPS = Object.freeze([
  {
    id: "BIN-MBT-P3-0001-V1-S1",
    sequence: 1,
    type: "pickup",
    actionCode: "collect_empty_bin",
    locationRole: "origin_yard",
    yardId: "00000000-0000-4000-8000-000000012441",
    yardCode: "12441",
    siteProfileId: null,
    evidenceRequirements: [{ code: "outgoing_bin_scan", type: "bin_scan", minimumCount: 1 }]
  },
  {
    id: "BIN-MBT-P3-0001-V1-S2",
    sequence: 2,
    type: "drop",
    actionCode: "deliver_bin",
    locationRole: "customer_site",
    yardId: null,
    yardCode: null,
    siteProfileId: "00000000-0000-4000-8000-000000000803",
    evidenceRequirements: [{ code: "placement_photo", type: "photo", minimumCount: 1 }]
  }
]);

const FRONT_CARD = Object.freeze({
  id: "BIN-MBT-P3-0001-V1",
  type: "BIN",
  serviceAction: "delivery",
  customer: "Synthetic Pilot Customer",
  address: "100 Test Route, Toronto, ON",
  scheduledWindow: {
    startAt: "2037-08-03T12:00:00.000Z",
    endAt: "2037-08-03T16:00:00.000Z"
  },
  stops: FRONT_STOPS,
  mbt: {
    snapshotVersion: 1,
    contractId: CONTRACT_ID,
    contractNumber: "MBT-P3-0001",
    visitId: FRONT_VISIT_ID,
    visitReference: "BIN-MBT-P3-0001-V1",
    visitNumber: 1,
    visitRevision: 1,
    status: "ready",
    frontLeg: {
      predecessorVisitId: null,
      predecessorTerminal: true,
      dispatchable: true
    },
    templateVersionId: "00000000-0000-4000-8000-000000000805",
    templateRevision: 2,
    binTypeId: "00000000-0000-4000-8000-000000000014",
    binTypeCode: "14YD",
    assetRequirements: [{
      reservationSlot: "outgoing",
      exactAssetId: ASSET_ID,
      exactAssetCode: "P3-BIN-0001",
      expectedStateRevision: 1
    }],
    truckRequirements: {
      truckType: "bin",
      minimumSlots: 1,
      supportedBinTypeCode: "14YD"
    },
    sharedYards: [{
      role: "origin",
      yardId: "00000000-0000-4000-8000-000000012441",
      yardCode: "12441",
      dispatchLocationId: 15
    }],
    timeline: [
      {
        visitId: FRONT_VISIT_ID,
        visitNumber: 1,
        serviceAction: "delivery",
        status: "ready",
        relation: "current",
        locked: false
      },
      {
        visitId: FUTURE_VISIT_ID,
        visitNumber: 2,
        serviceAction: "return_bin",
        status: "tentative",
        relation: "future",
        locked: true
      }
    ]
  }
});

function unboundFrontCard(eligibleAssets) {
  const card = structuredClone(FRONT_CARD);
  card.mbt.assetRequirements = [];
  card.mbt.assetChoices = [{ reservationSlot: "outgoing", eligibleAssets }];
  return card;
}

function returnFrontCard() {
  const card = structuredClone(FRONT_CARD);
  card.id = "BIN-MBT-P3-0001-V2";
  card.serviceAction = "return_bin";
  card.stops = [
    {
      ...structuredClone(FRONT_STOPS[1]),
      id: "BIN-MBT-P3-0001-V2-S1",
      sequence: 1,
      type: "pickup",
      actionCode: "pickup_bin"
    },
    {
      ...structuredClone(FRONT_STOPS[0]),
      id: "BIN-MBT-P3-0001-V2-S2",
      sequence: 2,
      type: "drop",
      actionCode: "return_bin",
      locationRole: "return_yard"
    }
  ];
  return card;
}

function dispatchTruck() {
  return {
    id: TRUCK_ID,
    plate: "P3-BIN-TRUCK",
    active: true,
    capacityLbs: 48_000,
    baseYard: "12441",
    baseYardId: "00000000-0000-4000-8000-000000012441",
    truckType: "bin",
    binServiceEnabled: true,
    binSlotCapacity: 1,
    supportedBinTypeCodes: ["14YD"],
    driverId: DRIVER_ID,
    driverLogin: "p3-bin-driver",
    driver: "Synthetic BIN Driver",
    loads: [{
      id: LOAD_ID,
      name: "Load 1",
      truckId: TRUCK_ID,
      truckPlate: "P3-BIN-TRUCK",
      driverId: DRIVER_ID,
      driverLogin: "p3-bin-driver",
      driverName: "Synthetic BIN Driver",
      plannedStartMinute: 420,
      plannedFinishMinute: 450,
      startTime: "07:00",
      stops: []
    }]
  };
}

function currentPlan() {
  return {
    id: PLAN_ID,
    planId: PLAN_ID,
    planDate: PLAN_DATE,
    status: "draft",
    revision: 1,
    orders: [],
    trucks: [dispatchTruck()],
    summary: { dispatchPlanFormat: { version: 2, source: "p3-bin-dispatch-e2e" } },
    savedAt: "2037-08-03T06:00:00.000Z"
  };
}

function dispatchSetup() {
  return {
    drivers: [{
      id: DRIVER_ID,
      name: "Synthetic BIN Driver",
      login: "p3-bin-driver",
      active: true
    }],
    ownYards: [{
      yardId: "00000000-0000-4000-8000-000000012441",
      code: "12441",
      name: "12441",
      locationId: 15,
      address: "12441 Woodbine Avenue, Whitchurch-Stouffville, ON"
    }],
    trucks: [dispatchTruck()],
    planning: {}
  };
}

async function removeFixture() {
  await query(
    "DELETE FROM operator_sessions WHERE operator_id IN (SELECT id FROM operators WHERE username = $1)",
    [USERNAME]
  );
  await query("DELETE FROM operators WHERE username = $1", [USERNAME]);
}

async function tokenFor(request) {
  const response = await request.post("/api/auth/login", {
    data: { username: USERNAME, password: PASSWORD }
  });
  expect(response.status()).toBe(200);
  return (await response.json()).token;
}

function fulfillJson(route, status, body, extras = {}) {
  return route.fulfill({
    status,
    headers: { "cache-control": "no-store", ...extras },
    contentType: "application/json",
    body: JSON.stringify(body)
  });
}

const DISPATCH_API_FIXTURES = new Map([
  ["GET /api/dispatch/config", () => ({})],
  ["GET /api/dispatch/vendor-yards", () => []],
  ["GET /api/dispatch/setup", dispatchSetup],
  ["GET /api/dispatch/orders", () => []],
  ["GET /api/dispatch/planned-assignments", () => []],
  ["GET /api/dispatch/plans", () => [currentPlan()]],
  ["GET /api/dispatch/plans/current", currentPlan],
  ["GET /api/dispatch/driver-job-statuses", () => []],
  ["GET /api/dispatch/forecast", () => ({ loads: [] })],
  ["GET /api/dispatch/plan-edit-lease", () => ({ lease: null })],
  ["POST /api/dispatch/plan-edit-lease/acquire", (request) => ({
    lease: {
      active: true,
      sessionId: request.postDataJSON().sessionId,
      operatorName: "Synthetic dispatcher"
    },
    editLeaseToken: `p3-bin-lease-${RUN_ID}`
  })],
  ["POST /api/dispatch/plan-edit-lease/heartbeat", (request) => ({
    lease: {
      active: true,
      sessionId: request.postDataJSON().sessionId,
      operatorName: "Synthetic dispatcher"
    }
  })],
  ["POST /api/dispatch/plan-edit-lease/release", () => ({ released: true })]
]);

async function fulfillDispatchApi(route) {
  const request = route.request();
  const key = `${request.method()} ${new URL(request.url()).pathname}`;
  const fixture = DISPATCH_API_FIXTURES.get(key) || (() => ({}));
  await fulfillJson(route, 200, fixture(request));
}

async function installDispatchApi(page, { frontCard = FRONT_CARD } = {}) {
  const calls = [];
  const state = { assigned: false };
  await page.route("**/api/mbt/status", (route) => fulfillJson(route, 200, {
    schemaVersion: "mbt-v1",
    phase: 3,
    foundationEnabled: true,
    operational: true,
    capabilities: {
      binDispatch: { enabled: true, code: "MBT_CAPABILITY_ENABLED", reason: "pilot_scope" },
      driverExecution: { enabled: false, code: "MBT_CAPABILITY_DISABLED", reason: "phase_3_8" },
      netSuiteWrites: { enabled: false, code: "MBT_CAPABILITY_DISABLED", reason: "phase_3" }
    }
  }));
  await page.route("**/api/mbt/dispatch/front-legs**", async (route) => {
    await fulfillJson(route, 200, {
      schemaVersion: "mbt-bin-dispatch-feed-v1",
      planDate: PLAN_DATE,
      items: state.assigned ? [] : [frontCard]
    });
  });
  await page.route("**/api/mbt/dispatch/assignments", async (route) => {
    const request = route.request();
    const body = request.postDataJSON();
    calls.push({
      method: request.method(),
      path: new URL(request.url()).pathname,
      body,
      idempotencyKey: request.headers()["idempotency-key"]
    });
    state.assigned = true;
    await fulfillJson(route, 201, {
      schemaVersion: "mbt-bin-dispatch-assignment-v1",
      planId: PLAN_ID,
      planDate: PLAN_DATE,
      planRevision: 2,
      loadId: LOAD_ID,
      visitId: FRONT_VISIT_ID,
      visitRevision: 2,
      contractId: CONTRACT_ID,
      assetReservations: body.assetAssignments.map(({ reservationSlot, assetId }) => ({
        reservationSlot,
        assetId
      })),
      stops: FRONT_STOPS.map((stop) => ({
        ...stop,
        mbt: {
          visitId: FRONT_VISIT_ID,
          stopGroupId: FRONT_VISIT_ID,
          stopSequence: stop.sequence,
          mandatory: true,
          capabilitySnapshot: {
            truckType: "bin",
            binTypeCode: "14YD",
            baseYardId: "00000000-0000-4000-8000-000000012441",
            baseYardCode: "12441"
          }
        }
      }))
    }, { "x-mbt-idempotent-replay": "false" });
  });
  await page.route("**/api/dispatch/**", fulfillDispatchApi);
  return { calls, state };
}

async function openDispatch(page, request) {
  const token = await tokenFor(request);
  await page.goto("/");
  await page.evaluate(({ planDate, value }) => {
    globalThis.localStorage.clear();
    globalThis.localStorage.setItem("mbbs.staff.token", value);
    globalThis.localStorage.setItem("mbbs.staff.role", "dispatcher");
    globalThis.localStorage.setItem("mbbs.staff.roles", JSON.stringify(["dispatcher"]));
    globalThis.localStorage.setItem("mbbs.dispatch.token", value);
    globalThis.localStorage.setItem("mbbs.dispatch.planDate", planDate);
  }, { planDate: PLAN_DATE, value: token });
  await page.goto("/dispatch/planning");
  await expect(page.getByRole("heading", { name: "Dispatch Planning" })).toBeVisible();
}

async function enterDispatchEditMode(page) {
  const button = page.getByRole("button", { name: "Enter Edit Mode" });
  if ((page.viewportSize()?.width || 0) >= 1180) {
    await button.click();
  } else {
    await button.focus();
    await button.press("Enter");
  }
  await expect(page.getByText("Edit mode", { exact: true })).toBeVisible();
}

async function dragMbtFrontLegToLoad(page, card, load) {
  if ((page.viewportSize()?.width || 0) >= 1180) {
    await card.dragTo(load);
    return;
  }
  await page.evaluate(({ loadId, visitId }) => {
    const source = globalThis.document.querySelector(
      `[data-mbt-visit-id="${globalThis.CSS.escape(visitId)}"]`
    );
    const target = globalThis.document.querySelector(
      `[data-load-card="${globalThis.CSS.escape(loadId)}"]`
    );
    if (
      !(source instanceof globalThis.HTMLElement)
      || !(target instanceof globalThis.HTMLElement)
    ) {
      throw new Error("The BIN front leg and target load must both be rendered before dragging.");
    }
    const dataTransfer = new globalThis.DataTransfer();
    const dragEvent = (type) => new globalThis.DragEvent(type, {
      bubbles: true,
      cancelable: true,
      dataTransfer
    });
    source.dispatchEvent(dragEvent("dragstart"));
    target.dispatchEvent(dragEvent("dragover"));
    target.dispatchEvent(dragEvent("drop"));
    source.dispatchEvent(dragEvent("dragend"));
  }, { loadId: LOAD_ID, visitId: FRONT_VISIT_ID });
}

test.beforeAll(async () => {
  await removeFixture();
  await createOperator({
    username: USERNAME,
    displayName: "P3 BIN Dispatch browser",
    password: PASSWORD,
    role: "dispatcher",
    roles: ["dispatcher"]
  });
});

test.afterAll(async () => {
  await removeFixture().catch(() => null);
});

test("P3-F15: Dispatch renders one draggable front-leg card with complete route and a locked future timeline", async ({ page, request }) => {
  await installDispatchApi(page);
  await openDispatch(page, request);

  const binTab = page.locator("[data-action='order-type-tab'][data-type='BIN']");
  await expect(binTab).toHaveAccessibleName("BIN");
  await binTab.click();
  const pool = page.getByRole("region", { name: "BIN contract legs" });
  await expect(pool).toBeVisible();
  const card = pool.locator(`[data-mbt-visit-id='${FRONT_VISIT_ID}']`);
  await expect(card).toHaveCount(1);
  await expect(card).toHaveAttribute("draggable", "true");
  await expect(card.getByRole("heading", {
    name: "BIN Contract MBT-P3-0001 · Leg 1"
  })).toBeVisible();
  await expect(card).toContainText("Deliver empty 14YD");
  await expect(card).toContainText("12441 → 100 Test Route, Toronto, ON");
  await expect(card.locator("[data-mbt-route-stop]"))
    .toHaveText(["Collect empty 14YD bin", "Deliver empty 14YD bin"]);
  await expect(card.locator(`[data-mbt-timeline-visit='${FRONT_VISIT_ID}']`))
    .toHaveAttribute("data-relation", "current");
  const future = card.locator(`[data-mbt-timeline-visit='${FUTURE_VISIT_ID}']`);
  await expect(future).toContainText("Final pickup");
  await expect(future).toHaveAttribute("aria-disabled", "true");
  await expect(future).toHaveAttribute("data-locked", "true");
  await expect(card.getByRole("button", {
    name: /split|link po|set yard|receive|fulfill|scm/i
  })).toHaveCount(0);

  const accessibility = await new AxeBuilder({ page })
    .include("[aria-label='BIN contract legs']")
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(accessibility.violations.filter(({ impact }) =>
    impact === "critical" || impact === "serious"
  )).toEqual([]);
});

test("P3-F15 seam: route label follows ordered server-owned stop locations for a return leg", async ({ page, request }) => {
  await installDispatchApi(page, { frontCard: returnFrontCard() });
  await openDispatch(page, request);
  await page.locator("[data-action='order-type-tab'][data-type='BIN']").click();
  const card = page.locator(`[data-mbt-visit-id='${FRONT_VISIT_ID}']`);
  await expect(card).toContainText("100 Test Route, Toronto, ON → 12441");
  await expect(card.locator(".mbt-bin-route")).not.toContainText("Synthetic service site");
});

test("P3-F16: dragging the front-leg card sends one visit command and materializes every mandatory stop in one BIN load", async ({ page, request }) => {
  const api = await installDispatchApi(page);
  await openDispatch(page, request);
  await enterDispatchEditMode(page);
  const binTab = page.locator("[data-action='order-type-tab'][data-type='BIN']");
  await expect(binTab).toBeVisible();
  await binTab.click();
  const card = page.locator(`[data-mbt-visit-id='${FRONT_VISIT_ID}']`);
  const load = page.locator(`[data-load-card='${LOAD_ID}']`);
  await expect(card).toHaveAttribute("draggable", "true");
  await expect(load).toBeVisible();
  await dragMbtFrontLegToLoad(page, card, load);

  await expect.poll(() => api.calls.length).toBe(1);
  expect(api.calls[0]).toMatchObject({
    method: "POST",
    path: "/api/mbt/dispatch/assignments",
    body: {
      planId: PLAN_ID,
      planDate: PLAN_DATE,
      loadId: LOAD_ID,
      visitId: FRONT_VISIT_ID,
      expectedVisitRevision: 1,
      expectedPlanRevision: 1,
      assetAssignments: [{
        reservationSlot: "outgoing",
        assetId: ASSET_ID,
        expectedStateRevision: 1
      }]
    }
  });
  expect(api.calls[0].idempotencyKey).toEqual(expect.any(String));
  const projected = load.locator(`[data-mbt-stop-group='${FRONT_VISIT_ID}']`);
  await expect(projected).toHaveCount(2);
  expect(await projected.evaluateAll((nodes) => nodes.every(
    (node) => node.getAttribute("data-mbt-mandatory") === "true"
  ))).toBe(true);
  await expect(projected).toHaveText(["Collect empty 14YD bin", "Deliver empty 14YD bin"]);
  await expect(page.getByRole("region", { name: "BIN contract legs" })
    .locator(`[data-mbt-visit-id='${FRONT_VISIT_ID}']`)).toHaveCount(0);
});

test("P3-F16: accessible assignment sends the exact visit, load, and asset without dragging", async ({ page, request }) => {
  const api = await installDispatchApi(page);
  await openDispatch(page, request);
  await enterDispatchEditMode(page);
  await page.locator("[data-action='order-type-tab'][data-type='BIN']").click();

  const card = page.locator(`.mbt-bin-front-leg[data-mbt-visit-id='${FRONT_VISIT_ID}']`);
  const targetLoad = card.getByRole("combobox", {
    name: "Target load for MBT-P3-0001 leg 1"
  });
  await expect(targetLoad).toHaveValue(LOAD_ID);
  await expect(targetLoad.locator("option:checked")).toHaveText("P3-BIN-TRUCK · Load 1");
  await card.getByRole("button", { name: "Assign to load" }).click();

  await expect.poll(() => api.calls.length).toBe(1);
  expect(api.calls[0].body).toMatchObject({
    planId: PLAN_ID,
    loadId: LOAD_ID,
    visitId: FRONT_VISIT_ID,
    assetAssignments: [{
      reservationSlot: "outgoing",
      assetId: ASSET_ID,
      expectedStateRevision: 1
    }]
  });
  await expect(page.getByRole("region", { name: "BIN contract legs" })
    .locator(`[data-mbt-visit-id='${FRONT_VISIT_ID}']`)).toHaveCount(0);
});

test("P3-F16 seam: accessible asset choice survives rerenders and the selected exact revision is assigned without a prompt", async ({ page, request }) => {
  let dialogCount = 0;
  page.on("dialog", async (dialog) => {
    dialogCount += 1;
    await dialog.dismiss();
  });
  const eligibleAssets = [
    { assetId: ASSET_ID, assetCode: "P3-BIN-0001", stateRevision: 1 },
    { assetId: SECOND_ASSET_ID, assetCode: "P3-BIN-0002", stateRevision: 4 }
  ];
  const api = await installDispatchApi(page, {
    frontCard: unboundFrontCard(eligibleAssets)
  });
  await openDispatch(page, request);
  await enterDispatchEditMode(page);
  await page.locator("[data-action='order-type-tab'][data-type='BIN']").click();

  const selector = page.getByRole("combobox", { name: "Asset for MBT-P3-0001 leg 1" });
  await expect(selector).toBeVisible();
  await expect(selector).toHaveValue("");
  await expect(selector.locator("option")).toHaveText([
    "Choose exact asset",
    "P3-BIN-0001",
    "P3-BIN-0002"
  ]);
  await expect(page.locator(`[data-mbt-visit-id='${FRONT_VISIT_ID}']`))
    .toHaveAttribute("draggable", "false");
  await selector.selectOption(SECOND_ASSET_ID);
  await page.locator("[data-action='order-type-tab'][data-type='SO']").click();
  await page.locator("[data-action='order-type-tab'][data-type='BIN']").click();
  await expect(page.getByRole("combobox", { name: "Asset for MBT-P3-0001 leg 1" }))
    .toHaveValue(SECOND_ASSET_ID);
  await expect(page.locator(`[data-mbt-visit-id='${FRONT_VISIT_ID}']`))
    .toHaveAttribute("draggable", "true");

  await dragMbtFrontLegToLoad(
    page,
    page.locator(`[data-mbt-visit-id='${FRONT_VISIT_ID}']`),
    page.locator(`[data-load-card='${LOAD_ID}']`)
  );
  await expect.poll(() => api.calls.length).toBe(1);
  expect(api.calls[0].body.assetAssignments).toEqual([{
    reservationSlot: "outgoing",
    assetId: SECOND_ASSET_ID,
    expectedStateRevision: 4
  }]);
  expect(dialogCount).toBe(0);
});

test("P3-F16 seam: one eligible asset is safely selected by default and can be assigned", async ({ page, request }) => {
  const api = await installDispatchApi(page, {
    frontCard: unboundFrontCard([{
      assetId: SECOND_ASSET_ID,
      assetCode: "P3-BIN-ONLY",
      stateRevision: 7
    }])
  });
  await openDispatch(page, request);
  await enterDispatchEditMode(page);
  await page.locator("[data-action='order-type-tab'][data-type='BIN']").click();
  const selector = page.getByRole("combobox", { name: "Asset for MBT-P3-0001 leg 1" });
  await expect(selector).toHaveValue(SECOND_ASSET_ID);
  await dragMbtFrontLegToLoad(
    page,
    page.locator(`[data-mbt-visit-id='${FRONT_VISIT_ID}']`),
    page.locator(`[data-load-card='${LOAD_ID}']`)
  );
  await expect.poll(() => api.calls.length).toBe(1);
  expect(api.calls[0].body.assetAssignments).toEqual([{
    reservationSlot: "outgoing",
    assetId: SECOND_ASSET_ID,
    expectedStateRevision: 7
  }]);
});
