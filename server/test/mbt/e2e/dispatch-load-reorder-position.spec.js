import crypto from "node:crypto";

import { createOperator } from "../../../src/auth-repository.js";
import { query } from "../../../src/db.js";
import { expect, test } from "./mbt-e2e-test.js";

const runId = crypto.randomUUID().slice(0, 8);
const username = `dispatch-load-reorder-${runId}`;
const password = "dispatch-load-reorder-test";
const planDate = "2038-11-22";
const planId = "dispatch-load-reorder-plan";
const editLeaseFixture = ["dispatch", "load", "reorder", "fixture"].join("-");

const orders = ["A", "B", "C"].map((suffix, index) => ({
  id: `DLR-SO-${suffix}`,
  type: "SO",
  customer: `Load reorder customer ${suffix}`,
  address: `${101 + index} Test Route Road, Toronto, ON`,
  sourceYard: "3445",
  pickupLocations: ["3445"],
  items: [{ sku: `DLR-${suffix}`, pallets: 1 }],
  pallets: 1,
  weight: 2_000,
  status: "open",
  sourceTable: "sales_orders"
}));

function load(id, name, order, driverSequence, startMode, start, switchYard, plannedStartMinute) {
  return {
    id,
    name,
    driverLogin: "driver-a",
    driverName: "Driver A",
    driverSequence,
    truckId: "truck-a",
    truckPlate: "TRUCK-A",
    startMode,
    start,
    switchYard,
    plannedStartMinute,
    plannedFinishMinute: plannedStartMinute + 60,
    timing: { start: plannedStartMinute, finish: plannedStartMinute + 60 },
    stops: [
      { id: `${id}-pick`, loadId: id, type: "pick", orderId: order.id, location: "3445" },
      { id: `${id}-drop`, loadId: id, type: "drop", orderId: order.id, location: order.address }
    ]
  };
}

const initialPlan = {
  id: planId,
  planId,
  planDate,
  status: "draft",
  revision: 1,
  digest: "dispatch-load-reorder-revision-1",
  savedAt: "2038-11-22T12:00:00.000Z",
  summary: { driverLaneOrder: ["driver-a"] },
  trucks: [{
    id: "truck-a",
    plate: "TRUCK-A",
    capacityLbs: 48_000,
    base: "3445",
    start: "07:00",
    loads: [
      load("load-a", "Load 1", orders[0], 0, "fixed", "07:00", "3445", 420),
      load("load-b", "Load 2", orders[1], 1, "auto", "", "2967", 480),
      load("load-c", "Load 3", orders[2], 2, "fixed", "13:00", "150", 780)
    ]
  }],
  assignedOrderSnapshots: orders
};

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

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: { "cache-control": "no-store" },
    body: JSON.stringify(body)
  });
}

function applyTruckDelta(plan, delta = {}) {
  const trucks = [...(plan.trucks || [])];
  const upserts = Array.isArray(delta.t) ? delta.t : [];
  for (const truck of upserts) {
    const index = trucks.findIndex((candidate) => String(candidate.id) === String(truck.id));
    if (index >= 0) {
      trucks[index] = structuredClone(truck);
    } else {
      trucks.push(structuredClone(truck));
    }
  }
  return trucks;
}

// This is a deliberately explicit HTTP router for the isolated browser fixture.
// eslint-disable-next-line complexity
async function fulfillDispatchApi(route, state) {
  const requestInfo = route.request();
  const path = new URL(requestInfo.url()).pathname;
  if (path === "/api/dispatch/config") {
    return json(route, {
      googleMapsApiKey: "",
      driverOrientedPlanning: true,
      plannerCommandMode: "on",
      plannerOrderPoolMode: "off"
    });
  }
  if (path === "/api/dispatch/setup") {
    return json(route, {
      drivers: [{ name: "Driver A", login: "driver-a", license: "AZ" }],
      trucks: [{ id: "truck-a", plate: "TRUCK-A", capacityLbs: 48_000, baseYard: "3445" }],
      ownYards: [
        { code: "3445", name: "3445", address: "3445 Kennedy Road, Toronto, ON" },
        { code: "2967", name: "2967", address: "2967 Kennedy Road, Toronto, ON" },
        { code: "150", name: "150", address: "150 Clark Blvd, Brampton, ON" }
      ],
      planning: { truckSwitchMinutes: 10 }
    });
  }
  if (path === "/api/dispatch/v2/bootstrap") {
    return json(route, { exists: true, plan: state.serverPlan });
  }
  if (path === "/api/dispatch/orders") {
    return json(route, orders);
  }
  if (path === "/api/dispatch/vendor-yards") {
    return json(route, []);
  }
  if (path === "/api/dispatch/plans") {
    return json(route, []);
  }
  if (path === "/api/dispatch/planned-assignments") {
    return json(route, []);
  }
  if (path === "/api/dispatch/driver-job-statuses") {
    return json(route, []);
  }
  if (path === "/api/dispatch/driver-truck-switches/attention") {
    return json(route, []);
  }
  if (path === "/api/dispatch/forecast") {
    return json(route, {
      planId,
      planRevision: state.serverPlan.revision,
      planDate,
      loads: [],
      stops: [],
      travelLegs: []
    });
  }
  if (path === "/api/dispatch/plan-edit-lease" && requestInfo.method() === "GET") {
    return json(route, { lease: state.activeLease });
  }
  if (path === "/api/dispatch/plan-edit-lease/acquire") {
    const body = requestInfo.postDataJSON();
    state.activeLease = {
      active: true,
      planDate,
      sessionId: body.sessionId,
      operatorName: "Dispatch load reorder",
      expiresAt: "2038-11-22T23:59:00.000Z"
    };
    return json(route, { lease: state.activeLease, editLeaseToken: editLeaseFixture });
  }
  if (path === "/api/dispatch/plan-edit-lease/heartbeat") {
    return json(route, { lease: state.activeLease });
  }
  if (path === "/api/dispatch/plan-edit-lease/release") {
    state.activeLease = null;
    return json(route, { released: true });
  }
  if (path === `/api/dispatch/v2/plans/${planId}/commands`) {
    const body = requestInfo.postDataJSON();
    state.savedCommands.push(body);
    const delta = body.payload?.planDelta || {};
    state.serverPlan = {
      ...state.serverPlan,
      revision: state.serverPlan.revision + 1,
      digest: `dispatch-load-reorder-revision-${state.serverPlan.revision + 1}`,
      savedAt: new Date().toISOString(),
      trucks: body.payload?.trucks || applyTruckDelta(state.serverPlan, delta),
      summary: delta.s || body.payload?.summary || state.serverPlan.summary
    };
    return json(route, { applied: true, plan: state.serverPlan });
  }
  return json(route, {});
}

async function dragWholeLoad(page, sourceLoadId, targetLoadId, insertAfter) {
  await page.evaluate(({ sourceId, targetId, after }) => {
    const source = globalThis.document.querySelector(`[data-driver-load-card="${globalThis.CSS.escape(sourceId)}"] .load-drag-handle`);
    const target = globalThis.document.querySelector(`[data-driver-load-card="${globalThis.CSS.escape(targetId)}"]`);
    if (!(source instanceof globalThis.HTMLElement) || !(target instanceof globalThis.HTMLElement)) {
      throw new Error("The source handle and target load card must both be rendered before dragging.");
    }
    const rect = target.getBoundingClientRect();
    const clientX = after ? rect.right - 2 : rect.left + 2;
    const clientY = rect.top + (rect.height / 2);
    const dataTransfer = new globalThis.DataTransfer();
    const dragEvent = (type, owner) => owner.dispatchEvent(new globalThis.DragEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
      dataTransfer
    }));
    dragEvent("dragstart", source);
    dragEvent("dragover", target);
    dragEvent("drop", target);
    dragEvent("dragend", source);
  }, { sourceId: sourceLoadId, targetId: targetLoadId, after: insertAfter });
}

async function visibleLaneIds(page) {
  return page.locator('[data-driver-lane="driver-a"] [data-driver-load-card]').evaluateAll((cards) =>
    cards.map((card) => card.dataset.driverLoadCard)
  );
}

async function expectPositionMetadata(page, ids) {
  await expect.poll(() => visibleLaneIds(page)).toEqual(ids);
  await expect(page.locator(`[data-driver-load-card="${ids[0]}"] [data-load-start-mode]`)).toHaveValue("fixed");
  await expect(page.locator(`[data-driver-load-card="${ids[0]}"] [data-load-start]`)).toHaveValue("07:00");
  await expect(page.locator(`[data-driver-load-card="${ids[0]}"] [data-plan-truck-base]`)).toHaveValue("3445");
  await expect(page.locator(`[data-driver-load-card="${ids[1]}"] [data-load-start-mode]`)).toHaveValue("auto");
  await expect(page.locator(`[data-driver-load-card="${ids[2]}"] [data-load-start-mode]`)).toHaveValue("fixed");
  await expect(page.locator(`[data-driver-load-card="${ids[2]}"] [data-load-start]`)).toHaveValue("13:00");
  await expect(page.locator('[data-driver-lane="driver-a"] [data-plan-truck-base]')).toHaveCount(1);
}

test.beforeAll(async () => {
  await createOperator({
    username,
    password,
    displayName: "Dispatch load reorder",
    role: "dispatcher",
    roles: ["dispatcher"]
  });
});

test.afterAll(async () => {
  await removeOperator();
});

test("DLR-05 browser: Load 1/2/3 arbitrary drag persists positional start context across reload", async ({ page, request }) => {
  const state = {
    serverPlan: structuredClone(initialPlan),
    activeLease: null,
    savedCommands: []
  };
  await page.route("**/api/dispatch/**", (route) => fulfillDispatchApi(route, state));
  await page.route("**/api/mbt/status", (route) => json(route, { capabilities: { binDispatch: { enabled: false } } }));

  const token = await loginToken(request);
  await page.goto("/");
  await page.evaluate(({ authToken, date }) => {
    globalThis.localStorage.setItem("mbbs.staff.token", authToken);
    globalThis.localStorage.setItem("mbbs.staff.role", "dispatcher");
    globalThis.localStorage.setItem("mbbs.staff.roles", JSON.stringify(["dispatcher"]));
    globalThis.localStorage.setItem("mbbs.dispatch.token", authToken);
    globalThis.localStorage.setItem("mbbs.dispatch.planDate", date);
  }, { authToken: token, date: planDate });
  await page.goto("/dispatch/planning");
  const enterEditMode = page.getByRole("button", { name: "Enter Edit Mode" });
  await expect(enterEditMode).toBeEnabled();
  // The planning canvas intentionally retains its desktop working width on
  // narrow viewports, so the route notice can overlap this toolbar control.
  // Exercise the button's accessible activation path instead of bypassing
  // actionability with a forced pointer click.
  await enterEditMode.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Exit Edit" })).toBeVisible();
  await expectPositionMetadata(page, ["load-a", "load-b", "load-c"]);

  await dragWholeLoad(page, "load-c", "load-a", false);
  await expectPositionMetadata(page, ["load-c", "load-a", "load-b"]);
  await expect.poll(() => state.savedCommands.length).toBe(1);

  await dragWholeLoad(page, "load-c", "load-b", true);
  await expectPositionMetadata(page, ["load-a", "load-b", "load-c"]);
  await expect.poll(() => state.savedCommands.length).toBe(2);

  await dragWholeLoad(page, "load-a", "load-c", true);
  await expectPositionMetadata(page, ["load-b", "load-c", "load-a"]);
  await expect.poll(() => state.savedCommands.length).toBe(3);

  const finalTruck = state.savedCommands.at(-1).payload.planDelta.t.find((truck) => truck.id === "truck-a");
  const savedByPosition = [...finalTruck.loads].sort((left, right) => left.driverSequence - right.driverSequence);
  expect(savedByPosition.map((savedLoad) => savedLoad.id)).toEqual(["load-b", "load-c", "load-a"]);
  expect(savedByPosition.map((savedLoad) => [savedLoad.startMode, savedLoad.start])).toEqual([
    ["fixed", "07:00"],
    ["auto", ""],
    ["fixed", "13:00"]
  ]);
  expect(savedByPosition[0].switchYard).toBe("3445");
  expect(savedByPosition.map((savedLoad) => savedLoad.stops.filter((stop) => stop.type === "drop").map((stop) => stop.orderId))).toEqual([
    ["DLR-SO-B"],
    ["DLR-SO-C"],
    ["DLR-SO-A"]
  ]);

  await page.reload();
  await expectPositionMetadata(page, ["load-b", "load-c", "load-a"]);
});
