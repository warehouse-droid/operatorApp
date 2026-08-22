import { expect, test } from "./mbt-e2e-test.js";

/* global localStorage, window */

test.use({ serviceWorkers: "block" });

const STATE_HASH = "a".repeat(64);

function fulfillJson(route, value, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(value)
  });
}

test("dispatcher retains compressed photos across failure and completes only the earliest historical visit", async ({ page }) => {
  const state = {
    completeBodies: [],
    ticketBodies: [],
    uploadActive: 0,
    uploadMaximum: 0,
    uploadCalls: 0,
    completed: false
  };
  const historicalPayload = {
    planId: 174,
    planDate: "2026-08-19",
    revision: 9,
    timeZone: "America/Toronto",
    count: 2,
    routes: [{
      driverLogin: "li",
      driverName: "Li Driver",
      blockers: [],
      warnings: [],
      visits: [{
        jobId: "historical-drop-1",
        jobIds: ["historical-drop-1"],
        stopId: "drop-1",
        stopType: "dropoff",
        driverLogin: "li",
        driverName: "Li Driver",
        truckPlate: "CE94489",
        loadId: "load-1",
        loadName: "Load 1",
        location: "12441",
        address: "12441 Highway 50, Bolton, ON",
        orderRefs: ["SO-E2E-HISTORICAL"],
        consolidatedPhysicalVisit: false,
        status: "pending",
        startedAt: null,
        previousCompletedAt: "2026-08-19T13:00:00.000Z",
        nextStartedAt: "2026-08-19T16:00:00.000Z",
        nextCompletedAt: null,
        requiredPhotos: 2,
        maxPhotos: 20,
        actionable: true,
        blockedByJobId: "",
        blockers: [],
        warnings: [],
        stateHash: STATE_HASH
      }, {
        jobId: "historical-drop-2",
        jobIds: ["historical-drop-2"],
        stopId: "drop-2",
        stopType: "dropoff",
        driverLogin: "li",
        driverName: "Li Driver",
        truckPlate: "CE94489",
        loadId: "load-1",
        loadName: "Load 1",
        location: "2967",
        orderRefs: ["TO-E2E-BLOCKED"],
        consolidatedPhysicalVisit: false,
        status: "pending",
        startedAt: null,
        previousCompletedAt: null,
        nextStartedAt: null,
        nextCompletedAt: null,
        requiredPhotos: 2,
        maxPhotos: 20,
        actionable: false,
        blockedByJobId: "historical-drop-1",
        blockers: [{
          code: "HISTORICAL_ASSIST_EARLIER_VISIT_REQUIRED",
          message: "Complete the earlier incomplete physical visit first."
        }],
        warnings: [],
        stateHash: "b".repeat(64)
      }]
    }]
  };

  await page.addInitScript(() => {
    window.EventSource = class {
      addEventListener() {}
      close() {}
    };
    localStorage.setItem("mbbs.staff.token", "historical-assist-e2e-token");
    localStorage.setItem("mbbs.staff.role", "dispatcher");
    localStorage.setItem("mbbs.staff.roles", JSON.stringify(["dispatcher"]));
  });
  await page.route("**/test-upload/**", async (route) => {
    const photoId = new URL(route.request().url()).pathname.split("/").pop();
    state.uploadCalls += 1;
    state.uploadActive += 1;
    state.uploadMaximum = Math.max(state.uploadMaximum, state.uploadActive);
    await new Promise((resolve) => setTimeout(resolve, 60));
    state.uploadActive -= 1;
    const requestId = state.ticketBodies[0].requestId;
    return fulfillJson(route, {
      key: `dispatch-assist/driver-dropoff-photo/2026/08/19/${requestId}-${photoId}/evidence.jpg`
    }, 201);
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const routeKey = `${request.method()} ${url.pathname}`;
    if (routeKey === "GET /api/auth/me") {
      return fulfillJson(route, {
        operator: {
          id: "dispatcher-174",
          username: "historical-dispatcher",
          display_name: "Historical Dispatcher",
          role: "dispatcher",
          roles: ["dispatcher"]
        }
      });
    }
    if (routeKey === "GET /api/dispatch/driver-pwa/stops") {
      return fulfillJson(route, { stops: [], clientSyncIssues: [] });
    }
    if (routeKey === "GET /api/dispatch/offline-review/count") {
      return fulfillJson(route, { count: 0 });
    }
    if (routeKey === "GET /api/dispatch/driver-pwa/historical-assist") {
      return fulfillJson(route, state.completed
        ? { ...historicalPayload, routes: [], count: 0 }
        : historicalPayload);
    }
    if (routeKey === "POST /api/dispatch/driver-pwa/historical-assist/historical-drop-1/photo-tickets") {
      const body = request.postDataJSON();
      state.ticketBodies.push(body);
      return fulfillJson(route, {
        requestId: body.requestId,
        planId: 174,
        planDate: body.planDate,
        planRevision: 9,
        jobId: "historical-drop-1",
        recordType: "driver-dropoff-photo",
        tickets: body.photos.map((photo) => ({
          photoId: photo.photoId,
          ordinal: photo.ordinal,
          upload: {
            uploadUrl: `/test-upload/${photo.photoId}`,
            token: `ticket-${photo.photoId}`
          }
        }))
      }, 201);
    }
    if (routeKey === "POST /api/dispatch/driver-pwa/historical-assist/historical-drop-1/complete") {
      const body = request.postDataJSON();
      state.completeBodies.push(body);
      if (state.completeBodies.length === 1) {
        return fulfillJson(route, { error: "simulated transient commit failure" }, 503);
      }
      state.completed = true;
      return fulfillJson(route, {
        completed: true,
        requestId: body.requestId,
        jobId: "historical-drop-1",
        jobIds: ["historical-drop-1"],
        driverLogin: "li",
        planId: 174,
        planDate: body.planDate,
        assistEventId: "33333333-3333-4333-8333-333333333333"
      });
    }
    return fulfillJson(route, { error: `Unhandled fixture ${routeKey}` }, 404);
  });

  await page.goto("/dispatch/driver-pwa");
  await page.getByRole("tab", { name: "Historical completion" }).click();
  await expect(page.getByRole("heading", { name: "Li Driver" })).toBeVisible();
  await expect(page.locator(".historical-assist-visit")).toHaveCount(2);
  await expect(page.locator(".historical-assist-visit").nth(1)).toContainText("Blocked");
  await expect(page.locator(".historical-assist-visit").nth(1).locator("form")).toHaveCount(0);

  const photo = await page.screenshot({ type: "jpeg", quality: 60 });
  await page.locator("input[data-action='historical-assist-photos']").setInputFiles([{
    name: "historical-one.jpg",
    mimeType: "image/jpeg",
    buffer: photo
  }, {
    name: "historical-two.jpg",
    mimeType: "image/jpeg",
    buffer: photo
  }]);
  await expect(page.locator(".historical-assist-section-head")).toContainText("2/20 prepared");

  await page.locator("input[name='arrivalTime']").fill("10:00:00");
  await page.locator("input[name='arrivalTime']").press("Tab");
  await page.locator("input[name='completionTime']").fill("10:05:00");
  await page.locator("input[name='completionTime']").press("Tab");
  await page.locator("textarea[name='reason']").fill("Driver device failed after this completed delivery.");
  await page.locator("input[name='confirmCompletion']").check();
  await page.getByRole("button", { name: "Complete physical visit" }).click();

  await expect(page.locator(".offline-review-notice")).toContainText("simulated transient commit failure");
  await expect(page.locator(".historical-assist-photo-grid figure")).toHaveCount(2);
  expect(state.ticketBodies).toHaveLength(1);
  expect(state.uploadCalls).toBe(2);
  expect(state.uploadMaximum).toBe(2);
  expect(state.completeBodies).toHaveLength(1);

  await page.getByRole("button", { name: "Complete physical visit" }).click();
  await expect(page.locator(".offline-review-notice")).toContainText("Completed SO-E2E-HISTORICAL");
  await expect(page.locator("#historicalAssistPanel")).toContainText("No incomplete physical visits were found");

  expect(state.ticketBodies).toHaveLength(1);
  expect(state.uploadCalls).toBe(2);
  expect(state.completeBodies).toHaveLength(2);
  expect(state.completeBodies[1].requestId).toBe(state.completeBodies[0].requestId);
  expect(state.completeBodies[1].photos.map((item) => item.objectReference)).toEqual(
    state.completeBodies[0].photos.map((item) => item.objectReference)
  );
  expect(state.completeBodies[1]).toEqual(expect.objectContaining({
    expectedStateHash: STATE_HASH,
    reason: "Driver device failed after this completed delivery.",
    arrival: { localTime: "10:00:00", offset: "-04:00" },
    completion: { localTime: "10:05:00", offset: "-04:00" }
  }));
});
