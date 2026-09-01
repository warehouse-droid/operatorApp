import crypto from "node:crypto";

import { createOperator } from "../../../src/auth-repository.js";
import { query } from "../../../src/db.js";
import { expect, test } from "./mbt-e2e-test.js";

const runId = crypto.randomUUID().slice(0, 8);
const username = `dispatch-lease-resume-${runId}`;
const password = "dispatch-lease-resume-test";
const planDate = "2038-11-18";

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

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: { "cache-control": "no-store" },
    body: JSON.stringify(body)
  });
}

test.beforeAll(async () => {
  await createOperator({
    username,
    password,
    displayName: "Dispatch lease resume",
    role: "dispatcher",
    roles: ["dispatcher"]
  });
});

test.afterAll(async () => {
  await removeOperator();
});

test("same-tab reload validates and resumes Edit Mode without releasing the lease", async ({ page, request }) => {
  let activeLease = null;
  let heartbeatCount = 0;
  let releaseCount = 0;
  const editLeaseToken = "test-dispatch-resume-browser";
  const expiresAt = "2038-11-18T23:59:00.000Z";
  const compactPlan = {
    exists: true,
    plan: {
      id: "dispatch-resume-plan",
      planId: "dispatch-resume-plan",
      planDate,
      status: "draft",
      revision: 4,
      digest: "dispatch-resume-digest",
      savedAt: "2038-11-18T12:00:00.000Z",
      schemaVersion: 2,
      summary: { driverLaneOrder: [] },
      trucks: [],
      assignedOrderSnapshots: []
    }
  };

  const dispatchResponders = new Map([
    ["GET /api/dispatch/plan-edit-lease", (route) => json(route, { lease: activeLease })],
    ["POST /api/dispatch/plan-edit-lease/acquire", (route, requestInfo) => {
      const body = requestInfo.postDataJSON();
      activeLease = {
        active: true,
        planDate,
        sessionId: body.sessionId,
        operatorName: "Dispatch lease resume",
        expiresAt
      };
      return json(route, { lease: activeLease, editLeaseToken });
    }],
    ["POST /api/dispatch/plan-edit-lease/heartbeat", (route, requestInfo) => {
      const body = requestInfo.postDataJSON();
      expect(body.sessionId).toBe(activeLease?.sessionId);
      expect(body.editLeaseToken).toBe(editLeaseToken);
      heartbeatCount += 1;
      return json(route, { lease: activeLease });
    }],
    ["POST /api/dispatch/plan-edit-lease/release", (route) => {
      releaseCount += 1;
      activeLease = null;
      return json(route, { released: true });
    }],
    ["GET /api/dispatch/v2/bootstrap", (route) => json(route, compactPlan)],
    ["GET /api/dispatch/config", (route) => json(route, { driverOrientedPlanning: true })],
    ["GET /api/dispatch/setup", (route) => json(route, { drivers: [], trucks: [], ownYards: [], planning: {} })],
    ["GET /api/dispatch/vendor-yards", (route) => json(route, [])],
    ["GET /api/dispatch/orders", (route) => json(route, [])],
    ["GET /api/dispatch/planned-assignments", (route) => json(route, [])],
    ["GET /api/dispatch/plans", (route) => json(route, [])],
    ["GET /api/dispatch/driver-job-statuses", (route) => json(route, [])],
    ["GET /api/dispatch/driver-truck-switches/attention", (route) => json(route, [])],
    ["GET /api/dispatch/forecast", (route) => json(route, {
      planId: compactPlan.plan.id,
      planRevision: compactPlan.plan.revision,
      loads: [],
      stops: []
    })]
  ]);
  await page.route("**/api/dispatch/**", (route) => {
    const requestInfo = route.request();
    const path = new URL(requestInfo.url()).pathname;
    const responder = dispatchResponders.get(`${requestInfo.method()} ${path}`);
    return responder ? responder(route, requestInfo) : json(route, {});
  });
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

  const enterEditButton = page.getByRole("button", { name: "Enter Edit Mode" });
  await expect(enterEditButton).toBeEnabled();
  // This test owns lease lifecycle, not responsive-shell hit testing. Dispatch the
  // button event directly so WebKit's narrow viewport/sidebar cannot mask it.
  await enterEditButton.dispatchEvent("click");
  await expect(page.getByRole("button", { name: "Exit Edit" })).toBeVisible();
  const storedBeforeReload = await page.evaluate(() => JSON.parse(
    globalThis.sessionStorage.getItem("mbbs.dispatch.editLease.v1") || "null"
  ));
  expect(storedBeforeReload).toMatchObject({
    planDate,
    sessionId: activeLease.sessionId,
    editLeaseToken
  });

  await page.reload();
  await expect(page.getByRole("button", { name: "Exit Edit" })).toBeVisible();
  expect(heartbeatCount).toBeGreaterThanOrEqual(1);
  expect(releaseCount).toBe(0);

  await page.getByRole("button", { name: "Exit Edit" }).dispatchEvent("click");
  await expect(page.getByRole("button", { name: "Enter Edit Mode" })).toBeVisible();
  expect(releaseCount).toBe(1);
  expect(await page.evaluate(() => globalThis.sessionStorage.getItem("mbbs.dispatch.editLease.v1"))).toBeNull();
});
