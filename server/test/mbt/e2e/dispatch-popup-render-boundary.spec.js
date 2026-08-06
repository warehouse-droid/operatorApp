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
