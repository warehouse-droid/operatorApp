import crypto from "node:crypto";
import { readFile } from "node:fs/promises";

import { createOperator } from "../../../src/auth-repository.js";
import { query } from "../../../src/db.js";
import { expect, test } from "./mbt-e2e-test.js";

const artifactPath = "/app/test-artifacts/dispatch-soa07894-event-replay.json";
const runId = crypto.randomUUID().slice(0, 8);
const username = `dispatch-soa07894-replay-${runId}`;
const password = "dispatch-soa07894-replay-test";

let replay;

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: { "cache-control": "no-store" },
    body: JSON.stringify(body)
  });
}

function stageSearchOrders(stage, term, refs) {
  if (Object.prototype.hasOwnProperty.call(stage.frontend.searches, term)) {
    return stage.frontend.searches[term];
  }
  if (term === refs.split) {
    return stage.frontend.targeted.split ? [stage.frontend.targeted.split] : [];
  }
  throw new Error(`Replay stage ${stage.number} has no search fixture for ${term}.`);
}

function targetedOrder(stage, orderRef, refs) {
  if (orderRef === refs.group) {
    return stage.frontend.targeted.group;
  }
  if (orderRef === refs.co) {
    return stage.frontend.targeted.co;
  }
  if (orderRef === refs.split) {
    return stage.frontend.targeted.split;
  }
  return stage.frontend.allOrders.find((order) => order.id === orderRef) || null;
}

function expectedPoolIds(orders) {
  return orders.map((order) => order.id);
}

function replayOrderSearchText(order) {
  return [
    order.id,
    order.type,
    order.sourceYard,
    order.destinationYard,
    order.originalOrderId,
    order.transitCo?.id,
    ...(order.childOrders || []),
    ...(order.childOrderDetails || []).flatMap((child) => [child?.id, child?.originalOrderId])
  ].join(" ").toLowerCase();
}

function renderedSearchOrders(stage, responseOrders, term) {
  const merged = new Map(stage.frontend.allOrders.map((order) => [order.id, order]));
  for (const order of responseOrders) {
    merged.set(order.id, order);
  }
  const normalizedTerm = term.trim().toLowerCase();
  return [...merged.values()].filter((order) => replayOrderSearchText(order).includes(normalizedTerm));
}

async function renderedPoolIds(page) {
  return page.locator("[data-dispatch-order-pool] .order-list [data-order]")
    .evaluateAll((cards) => cards.map((card) => card.dataset.order));
}

function effectivePickupLocations(order) {
  const relationshipPickups = [
    ...(order.poPickupManifest || []),
    ...(order.directPickupManifest || [])
  ].map((entry) => entry?.location).filter(Boolean);
  const candidates = order.transitCo?.toYard
    ? [order.transitCo.toYard, ...relationshipPickups]
    : [
        ...(order.pickupLocations?.length ? order.pickupLocations : order.sourceYard ? [order.sourceYard] : []),
        ...relationshipPickups
      ];
  const seen = new Set();
  return candidates.filter((location) => {
    const key = String(location || "").trim().split(/\s*:\s*/u, 1)[0].toLowerCase();
    if (!key || seen.has(key)) {return false;}
    seen.add(key);
    return true;
  });
}

async function expectRenderedOrder(page, order, context) {
  const card = page.locator(`[data-dispatch-order-pool] [data-order="${order.id}"]`);
  await expect(card, `${context}: ${order.id} must be visible`).toBeVisible();
  const pickups = effectivePickupLocations(order);
  await expect(
    card.getByText(`Pickup ${pickups.length ? pickups.join(", ") : "--"}`, { exact: false }),
    `${context}: ${order.id} pickup route`
  ).toBeVisible();
  if (order.type === "CO") {
    await expect(
      card.getByText(`${order.sourceYard || "source yard"} to ${order.destinationYard || "transit depot"}`, { exact: true }),
      `${context}: ${order.id} transfer route`
    ).toBeVisible();
  }
  if (order.childOrders?.length) {
    await expect(
      card.getByText(`Includes ${order.childOrders.join(", ")}`, { exact: true }),
      `${context}: ${order.id} grouped children`
    ).toBeVisible();
  }
  if (order.transitCo?.id) {
    await expect(
      card.getByText(`CO ${order.transitCo.id}`, { exact: true }),
      `${context}: ${order.id} active CO`
    ).toBeVisible();
  }
}

async function expectRenderedOrders(page, expectedOrders, context) {
  await expect.poll(
    () => renderedPoolIds(page),
    { message: `${context}: rendered order identities` }
  ).toEqual(expectedPoolIds(expectedOrders));

  for (const order of expectedOrders) {
    await expectRenderedOrder(page, order, context);
  }
}

function staticDispatchFixture(path, stage) {
  const plan = stage.frontend.bootstrap.plan;
  return new Map([
    ["/api/dispatch/config", {
      googleMapsApiKey: "",
      driverOrientedPlanning: true,
      plannerOrderPoolMode: "on",
      plannerCommandMode: "off"
    }],
    ["/api/dispatch/setup", { drivers: [], trucks: [], ownYards: [], planning: {} }],
    ["/api/dispatch/vendor-yards", []],
    ["/api/dispatch/v2/bootstrap", stage.frontend.bootstrap],
    ["/api/dispatch/orders", stage.frontend.allOrders],
    ["/api/dispatch/planned-assignments", []],
    ["/api/dispatch/plans", []],
    ["/api/dispatch/driver-job-statuses", []],
    ["/api/dispatch/driver-truck-switches/attention", []],
    ["/api/dispatch/forecast", {
      planId: plan.id,
      planRevision: plan.revision,
      loads: [],
      stops: []
    }],
    ["/api/dispatch/plan-edit-lease", { lease: null }]
  ]).get(path);
}

function serveOrderPool(route, url, stage, refs, servedSearches) {
  const term = String(url.searchParams.get("search") || "");
  const orders = term ? stageSearchOrders(stage, term, refs) : stage.frontend.allOrders;
  if (term) {
    servedSearches.push({ stage: stage.number, term });
  }
  return json(route, { orders, nextCursor: "" });
}

function serveTargetedOrder(route, path, stage, refs) {
  const prefix = "/api/dispatch/v2/order-feed/";
  const orderRef = decodeURIComponent(path.slice(prefix.length));
  return json(route, { order: targetedOrder(stage, orderRef, refs) });
}

function servePlanRevision(route, stage) {
  return json(route, {
    revision: stage.frontend.bootstrap.plan.revision,
    savedAt: replayPlanSavedAt(stage)
  });
}

function replayPlanSavedAt(stage) {
  return `2096-09-01T12:${String(stage.number).padStart(2, "0")}:00.000Z`;
}

function replaySavedPlan(stage) {
  const plan = stage.frontend.bootstrap.plan;
  return {
    ...plan,
    status: plan.status || "draft",
    savedAt: replayPlanSavedAt(stage),
    updatedAt: replayPlanSavedAt(stage),
    orders: plan.assignedOrderSnapshots || [],
    trucks: plan.trucks || []
  };
}

function serveDispatchApi(route, stage, refs, servedSearches) {
  const url = new URL(route.request().url());
  const path = url.pathname;
  const fixture = staticDispatchFixture(path, stage);
  if (fixture !== undefined) {
    return json(route, fixture);
  }
  if (path === "/api/dispatch/v2/order-pool") {
    return serveOrderPool(route, url, stage, refs, servedSearches);
  }
  if (path.startsWith("/api/dispatch/v2/order-feed/")) {
    return serveTargetedOrder(route, path, stage, refs);
  }
  if (/^\/api\/dispatch\/plans\/[^/]+\/revision$/u.test(path)) {
    return servePlanRevision(route, stage);
  }
  if (path === `/api/dispatch/plans/${stage.frontend.bootstrap.plan.id}`) {
    return json(route, replaySavedPlan(stage));
  }
  return json(route, {});
}

function replayEventTypes(stageNumber) {
  return new Map([
    [2, ["dispatch.plan.saved", "dispatch.orders.updated"]],
    [3, ["dispatch.orders.updated"]],
    [4, ["dispatch.co.updated"]],
    [5, ["dispatch.orders.updated"]],
    [6, ["dispatch.co.updated"]],
    [7, ["dispatch.co.updated"]],
    [8, ["dispatch.co.updated", "dispatch.plan.saved", "dispatch.orders.updated"]],
    [9, ["dispatch.plan.saved", "dispatch.orders.updated"]],
    [10, ["dispatch.orders.updated"]],
    [11, ["dispatch.plan.saved", "dispatch.orders.updated"]],
    [12, ["dispatch.plan.saved", "dispatch.orders.updated"]],
    [13, ["dispatch.co.updated"]]
  ]).get(stageNumber) || [];
}

function replayTransitionProbe(stageNumber, refs) {
  return new Map([
    [6, refs.co],
    [8, refs.group],
    [11, refs.split]
  ]).get(stageNumber) || "";
}

async function installReplayBrowserState(page, authToken, planDate) {
  await page.addInitScript(({ token, date }) => {
    globalThis.localStorage.setItem("mbbs.staff.token", token);
    globalThis.localStorage.setItem("mbbs.staff.role", "dispatcher");
    globalThis.localStorage.setItem("mbbs.staff.roles", JSON.stringify(["dispatcher"]));
    globalThis.localStorage.setItem("mbbs.dispatch.token", token);
    globalThis.localStorage.setItem("mbbs.dispatch.planDate", date);

    globalThis.__dispatchReplayEventSources = [];
    class DispatchReplayEventSource {
      constructor(url) {
        this.url = url;
        this.listeners = new Map();
        this.closed = false;
        globalThis.__dispatchReplayEventSources.push(this);
      }

      addEventListener(type, listener) {
        if (!this.listeners.has(type)) {
          this.listeners.set(type, []);
        }
        this.listeners.get(type).push(listener);
      }

      close() {
        this.closed = true;
      }

      emit(type, data) {
        if (this.closed) {
          return;
        }
        for (const listener of this.listeners.get(type) || []) {
          listener({ data });
        }
      }
    }

    globalThis.EventSource = DispatchReplayEventSource;
    globalThis.__emitDispatchReplayAppEvent = (event) => {
      const data = JSON.stringify(event);
      for (const source of globalThis.__dispatchReplayEventSources) {
        source.emit("app-event", data);
      }
    };
  }, { token: authToken, date: planDate });
}

async function emitReplayStageEvents(page, stage, eventTypes, refs) {
  await page.evaluate(({ nextStage, types, savedAt, orderRefs }) => {
    for (const type of types) {
      const coPayload = type === "dispatch.co.updated" ? {
        coRef: orderRefs.co,
        sourceOrderRef: orderRefs.group,
        cancelled: [6, 8].includes(nextStage.number)
      } : {};
      const planPayload = type === "dispatch.plan.saved" ? {
        affectedOrderRefs: Object.values(orderRefs),
        retiredGlobalOrderRefs: nextStage.number === 8
          ? [orderRefs.group]
          : nextStage.number === 11 ? [orderRefs.split] : [],
        reactivatedGlobalOrderRefs: [2, 12].includes(nextStage.number)
          ? [orderRefs.group]
          : nextStage.number === 9 ? [orderRefs.split] : []
      } : {};
      globalThis.__emitDispatchReplayAppEvent({
        type,
        payload: {
          source: "dispatch-soa07894-event-replay",
          sourceSessionId: "remote-dispatch-replay",
          planDate: nextStage.frontend.bootstrap.plan.planDate,
          planId: nextStage.frontend.bootstrap.plan.id,
          revision: nextStage.frontend.bootstrap.plan.revision,
          savedAt,
          replayStage: nextStage.number,
          ...planPayload,
          ...coPayload
        }
      });
    }
  }, { nextStage: stage, types: eventTypes, savedAt: replayPlanSavedAt(stage), orderRefs: refs });
}

async function advanceReplayStage(page, stage, eventTypes, refs) {
  const poolResponse = page.waitForResponse((candidate) => {
    const url = new URL(candidate.url());
    return url.pathname === "/api/dispatch/v2/order-pool" && !url.searchParams.has("search");
  });
  const planResponse = eventTypes.includes("dispatch.plan.saved")
    ? page.waitForResponse((candidate) => (
        new URL(candidate.url()).pathname === `/api/dispatch/plans/${stage.frontend.bootstrap.plan.id}`
      ))
    : Promise.resolve(null);
  await emitReplayStageEvents(page, stage, eventTypes, refs);
  const [pool, plan] = await Promise.all([poolResponse, planResponse]);
  await pool.finished();
  await plan?.finished();
}

async function assertExactDerivedIdentities(page, expectedOrders, refs) {
  const expectedIds = new Set(expectedOrders.map((order) => order.id));
  for (const identity of [refs.group, refs.co, refs.split]) {
    const exactCard = page.locator(`[data-dispatch-order-pool] [data-order="${identity}"]`);
    if (expectedIds.has(identity)) {
      await expect(exactCard).toBeVisible();
    } else {
      await expect(exactCard).toHaveCount(0);
    }
  }
}

async function selectReplaySearch(page, stage, term, refs) {
  const input = page.locator("#orderSearch");
  const responseOrders = stageSearchOrders(stage, term, refs);
  if (await input.inputValue() !== term) {
    const response = page.waitForResponse((candidate) => {
      const candidateUrl = new URL(candidate.url());
      return candidateUrl.pathname === "/api/dispatch/v2/order-pool"
        && candidateUrl.searchParams.get("search") === term;
    });
    await input.fill(term);
    await response;
  }
  const expectedOrders = renderedSearchOrders(stage, responseOrders, term);
  await expectRenderedOrders(page, expectedOrders, `stage ${stage.number} search ${term}`);
  await assertExactDerivedIdentities(page, expectedOrders, refs);
}

async function assertReplayStageSearches(page, stage, searchRefs, refs) {
  for (const term of searchRefs) {
    await selectReplaySearch(page, stage, term, refs);
  }
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
  replay = JSON.parse(await readFile(artifactPath, "utf8"));
  expect(replay.schemaVersion).toBe("dispatch-soa07894-event-replay-v1");
  expect(replay.stages).toHaveLength(13);
  expect(replay.stages.map((stage) => stage.number)).toEqual(
    Array.from({ length: 13 }, (_, index) => index + 1)
  );
  await createOperator({
    username,
    password,
    displayName: "Dispatch SOA07894 event replay",
    role: "dispatcher",
    roles: ["dispatcher"]
  });
});

test.afterAll(async () => {
  await removeOperator();
});

test("SOA07894/SOA07895 browser replay renders every NetSuite, group, CO, split, and retirement event", async ({ page, request }) => {
  test.setTimeout(120_000);

  let currentStage = replay.stages[0];
  const servedSearches = [];
  const eventRefreshStages = [];
  await page.route("**/api/dispatch/**", (route) =>
    serveDispatchApi(route, currentStage, replay.refs, servedSearches)
  );
  await page.route("**/api/mbt/status", (route) => json(route, {
    capabilities: { binDispatch: { enabled: false } }
  }));

  const token = await loginToken(request);
  const planDate = replay.stages[0].frontend.bootstrap.plan.planDate;
  await installReplayBrowserState(page, token, planDate);

  const searchRefs = [
    replay.refs.group,
    replay.refs.co,
    replay.refs.first,
    replay.refs.second,
    replay.refs.split
  ];

  await test.step(`stage 1: ${currentStage.event}`, async () => {
    await page.goto("/dispatch/planning?soa07894ReplayStage=1");
    await expect(page.locator("[data-dispatch-planner-root]")).toBeVisible();
    await expect(page.locator("#planDateInput")).toHaveValue(planDate);
    await expect.poll(() => page.evaluate(() =>
      globalThis.__dispatchReplayEventSources?.filter((source) => !source.closed).length || 0
    )).toBeGreaterThanOrEqual(1);
    const initiallyVisible = currentStage.frontend.allOrders.filter((order) => order.type === "SO");
    await expectRenderedOrders(page, initiallyVisible, "stage 1 initial pool");
    await assertReplayStageSearches(page, currentStage, searchRefs, replay.refs);
  });

  for (const stage of replay.stages.slice(1)) {
    await test.step(`stage ${stage.number}: ${stage.event}`, async () => {
      const previousStage = currentStage;
      const transitionProbe = replayTransitionProbe(stage.number, replay.refs);
      if (transitionProbe) {
        await selectReplaySearch(page, previousStage, transitionProbe, replay.refs);
      }

      currentStage = stage;
      const eventTypes = replayEventTypes(stage.number);
      await advanceReplayStage(page, stage, eventTypes, replay.refs);
      eventRefreshStages.push({ stage: stage.number, eventTypes });

      const activeTerm = await page.locator("#orderSearch").inputValue();
      const eventVisibleOrders = activeTerm
        ? renderedSearchOrders(stage, [], activeTerm)
        : stage.frontend.allOrders.filter((order) => order.type === "SO");
      await expectRenderedOrders(page, eventVisibleOrders, `stage ${stage.number} event refresh`);
      await assertExactDerivedIdentities(page, eventVisibleOrders, replay.refs);

      await page.locator("#orderSearch").fill("");
      await expect(page.locator("[data-dispatch-planner-root]")).toBeVisible();
      await expect(page.locator("#planDateInput")).toHaveValue(stage.frontend.bootstrap.plan.planDate);
      const initiallyVisible = stage.frontend.allOrders.filter((order) => order.type === "SO");
      await expectRenderedOrders(page, initiallyVisible, `stage ${stage.number} initial pool`);
      await assertReplayStageSearches(page, stage, searchRefs, replay.refs);
    });
  }

  for (const stage of replay.stages) {
    for (const term of searchRefs) {
      expect(servedSearches).toContainEqual({ stage: stage.number, term });
    }
  }
  expect(servedSearches).toHaveLength(67);
  expect(eventRefreshStages).toEqual(replay.stages.slice(1).map((stage) => ({
    stage: stage.number,
    eventTypes: replayEventTypes(stage.number)
  })));
});
