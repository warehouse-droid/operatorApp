import { expect, test } from "./mbt-e2e-test.js";

/* global atob, DataTransfer, DragEvent, File, localStorage, Uint8Array, window */

test.use({ serviceWorkers: "block" });

const FIRST_HASH = "a".repeat(64);
const SECOND_HASH = "b".repeat(64);
const REMOTE_HASH = "c".repeat(64);

function fulfillJson(route, value, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(value)
  });
}

async function dropJpeg(locator, buffer, name) {
  await locator.evaluate((zone, payload) => {
    const bytes = Uint8Array.from(atob(payload.base64), (character) => character.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], payload.name, { type: "image/jpeg" }));
    zone.dispatchEvent(new DragEvent("dragover", { bubbles: true, dataTransfer: transfer }));
    zone.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: transfer }));
  }, { base64: buffer.toString("base64"), name });
}

test("dispatcher filters, drops, appends, and revalidates a retained draft after a remote photo event", async ({ page }) => {
  const state = {
    stateHash: FIRST_HASH,
    photoCount: 2,
    visitsQueries: [],
    ticketBodies: [],
    appendBodies: [],
    uploads: 0,
    photos: [{
      ordinal: 1,
      objectReference: "r2://driver/driver-dropoff-photo/2026/09/02/one/evidence.jpg",
      source: "driver_online",
      addedAt: null,
      addedBy: "",
      additionReason: ""
    }, {
      ordinal: 2,
      objectReference: "r2://driver/driver-dropoff-photo/2026/09/02/two/evidence.jpg",
      source: "driver_online",
      addedAt: null,
      addedBy: "",
      additionReason: ""
    }]
  };

  const visitPayload = () => ({
    planDate: "2026-09-02",
    filters: {},
    count: 1,
    nextCursor: null,
    facets: {
      drivers: [{ driverLogin: "li", driverName: "Li Driver", count: 1 }],
      statuses: [{ status: "complete", count: 1 }],
      stopTypes: [{ stopType: "dropoff", count: 1 }],
      completionSources: [{ completionSource: "driver_online", count: 1 }]
    },
    visits: [{
      recordId: 410,
      recordIds: [410, 411],
      jobId: "completed-drop-a",
      jobIds: ["completed-drop-a", "completed-drop-b"],
      planId: 194,
      planDate: "2026-09-02",
      driverLogin: "li",
      driverName: "Li Driver",
      truckId: "truck-1",
      truckPlate: "PHOTO-1",
      loadId: "load-1",
      loadName: "Completed evidence load",
      stopIds: ["drop-a", "drop-b"],
      stopType: "dropoff",
      orderRefs: ["SOA07894", "SOA07895"],
      location: "2967",
      address: "2967 Highway 50",
      status: "complete",
      startedAt: "2026-09-02T13:00:00.000Z",
      completedAt: "2026-09-02T13:15:00.000Z",
      completionSource: "driver_online",
      requiredPhotos: 2,
      photoCount: state.photoCount,
      maxPhotos: 20,
      remainingPhotoSlots: 20 - state.photoCount,
      photos: state.photos,
      consolidatedPhysicalVisit: true,
      declarationValid: true,
      blockCode: "",
      blockReason: "",
      appendable: state.photoCount < 20,
      stateHash: state.stateHash,
      expectedStateHash: state.stateHash
    }]
  });

  await page.addInitScript(() => {
    let listener = null;
    window.EventSource = class {
      addEventListener(type, nextListener) {
        if (type === "app-event") {
          listener = nextListener;
        }
      }
      close() {}
    };
    window.__emitDriverPhotoEvent = (event) => listener?.({ data: JSON.stringify(event) });
    localStorage.setItem("mbbs.staff.token", "completed-stop-e2e-token");
    localStorage.setItem("mbbs.staff.role", "dispatcher");
    localStorage.setItem("mbbs.staff.roles", JSON.stringify(["dispatcher"]));
  });

  await page.route("**/test-completed-upload/**", async (route) => {
    const photoId = new URL(route.request().url()).pathname.split("/").pop();
    const requestId = state.ticketBodies.at(-1).requestId;
    state.uploads += 1;
    return fulfillJson(route, {
      key: `dispatch-stop-evidence/driver-dropoff-photo/2026/09/02/${requestId}-${photoId}/evidence.jpg`
    }, 201);
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const routeKey = `${request.method()} ${url.pathname}`;
    if (routeKey === "GET /api/auth/me") {
      return fulfillJson(route, {
        operator: {
          id: "dispatcher-photo-194",
          username: "photo-dispatcher",
          display_name: "Photo Dispatcher",
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
    if (routeKey === "GET /api/dispatch/driver-pwa/visits") {
      state.visitsQueries.push(Object.fromEntries(url.searchParams));
      return fulfillJson(route, visitPayload());
    }
    if (routeKey === "POST /api/dispatch/driver-pwa/visits/410/photo-tickets") {
      const body = request.postDataJSON();
      state.ticketBodies.push(body);
      return fulfillJson(route, {
        requestId: body.requestId,
        recordId: 410,
        recordIds: [410, 411],
        jobId: "completed-drop-a",
        jobIds: ["completed-drop-a", "completed-drop-b"],
        recordType: "driver-dropoff-photo",
        tickets: body.photos.map((photo) => ({
          photoId: photo.photoId,
          ordinal: photo.ordinal,
          upload: {
            uploadUrl: `/test-completed-upload/${photo.photoId}`,
            token: `ticket-${photo.photoId}`
          }
        }))
      }, 201);
    }
    if (routeKey === "POST /api/dispatch/driver-pwa/visits/410/photos") {
      const body = request.postDataJSON();
      state.appendBodies.push(body);
      state.photos.push(...body.photos.map((photo, index) => ({
        ordinal: state.photos.length + index + 1,
        objectReference: photo.objectReference,
        source: "dispatch_stop_evidence",
        addedAt: "2026-09-02T18:00:00.000Z",
        addedBy: "Photo Dispatcher",
        additionReason: body.reason
      })));
      state.photoCount = state.photos.length;
      state.stateHash = state.appendBodies.length === 1 ? SECOND_HASH : "d".repeat(64);
      return fulfillJson(route, {
        requestId: body.requestId,
        additionEventId: body.additionEventId,
        recordId: 410,
        recordIds: [410, 411],
        jobId: "completed-drop-a",
        jobIds: ["completed-drop-a", "completed-drop-b"],
        addedPhotoCount: body.photos.length,
        photoCount: state.photoCount,
        stateHash: state.stateHash,
        completed: true
      });
    }
    return fulfillJson(route, { error: `Unhandled fixture ${routeKey}` }, 404);
  });

  await page.goto("/dispatch/driver-pwa");
  await page.getByRole("tab", { name: "Completed stop photos" }).click();
  await expect(page.getByRole("heading", { name: "Completed-stop evidence" })).toBeVisible();
  await expect(page.locator("[data-form='completed-stop-filters'] select[name='driverLogin']")).toContainText("Li Driver");
  await expect(page.locator(".offline-review-detail-panel")).toContainText("Photos already committed are read only");
  await expect(page.locator(".driver-pwa-completed-photo-card")).toHaveCount(2);

  await page.locator("[data-form='completed-stop-filters'] input[name='q']").fill("SOA07894");
  await page.locator("[data-form='completed-stop-filters'] select[name='photoState']").selectOption("has_photos");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect.poll(() => state.visitsQueries.at(-1)?.q).toBe("SOA07894");
  expect(state.visitsQueries.at(-1)?.photoState).toBe("has_photos");

  const jpeg = await page.screenshot({ type: "jpeg", quality: 60 });
  await dropJpeg(page.locator("[data-photo-drop-zone='completed-stop']"), jpeg, "completed-extra.jpg");
  await expect(page.locator("[aria-label='Prepared appended photos'] figure")).toHaveCount(1);
  await page.locator("[data-form='completed-stop-photo-append'] textarea[name='reason']")
    .fill("Customer requested a clearer completed-stop condition photo.");
  await page.locator("[data-form='completed-stop-photo-append'] input[name='confirmAddition']").check();
  await page.getByRole("button", { name: "Append photos" }).click();
  await expect(page.locator(".offline-review-notice")).toContainText("1 photo appended");
  expect(state.ticketBodies).toHaveLength(1);
  expect(state.appendBodies).toHaveLength(1);
  expect(state.uploads).toBe(1);
  expect(state.appendBodies[0]).toEqual(expect.objectContaining({
    expectedStateHash: FIRST_HASH,
    reason: "Customer requested a clearer completed-stop condition photo."
  }));
  await expect(page.locator("[data-form='completed-stop-photo-append'] textarea[name='reason']"))
    .toHaveValue("");
  await expect(page.locator("[data-form='completed-stop-photo-append'] input[name='confirmAddition']"))
    .not.toBeChecked();

  await page.evaluate(() => {
    const compress = window.DriverOfflinePhotos.compress.bind(window.DriverOfflinePhotos);
    let releaseCompression;
    const compressionGate = new Promise((resolve) => {
      releaseCompression = resolve;
    });
    window.__releaseCompletedPhotoCompression = releaseCompression;
    window.DriverOfflinePhotos.compress = async (file) => {
      await compressionGate;
      return compress(file);
    };
  });
  await dropJpeg(page.locator("[data-photo-drop-zone='completed-stop']"), jpeg, "retained-draft.jpg");
  await expect(page.locator(".offline-review-notice")).toContainText("Preparing 1 photo");
  await page.locator("[data-form='completed-stop-photo-append'] textarea[name='reason']")
    .fill("Second requested angle retained through a remote refresh.");
  state.photos.push({
    ordinal: 4,
    objectReference: "r2://dispatch-stop-evidence/driver-dropoff-photo/2026/09/02/remote/evidence.jpg",
    source: "dispatch_stop_evidence",
    addedAt: "2026-09-02T18:02:00.000Z",
    addedBy: "Other Dispatcher",
    additionReason: "Remote workstation evidence"
  });
  state.photoCount = 4;
  state.stateHash = REMOTE_HASH;
  await page.evaluate(() => window.__emitDriverPhotoEvent({
    id: 42,
    type: "driver.stop.photos_added",
    payload: { driverLogin: "li", planDate: "2026-09-02", recordId: 410 }
  }));
  await page.waitForTimeout(500);
  await page.evaluate(() => window.__releaseCompletedPhotoCompression());
  await expect(page.locator(".driver-pwa-completed-stale")).toContainText("changed on another computer");
  await expect(page.locator("[aria-label='Prepared appended photos'] figure")).toHaveCount(1);
  await expect(page.locator("[data-form='completed-stop-photo-append'] textarea[name='reason']"))
    .toHaveValue("Second requested angle retained through a remote refresh.");

  await page.getByRole("button", { name: "Revalidate retained draft" }).click();
  await expect(page.locator(".driver-pwa-completed-stale")).toHaveCount(0);
  await page.locator("[data-form='completed-stop-photo-append'] input[name='confirmAddition']").check();
  await page.getByRole("button", { name: "Append photos" }).click();
  await expect.poll(() => state.appendBodies.length).toBe(2);
  expect(state.appendBodies[1].expectedStateHash).toBe(REMOTE_HASH);
  expect(state.appendBodies[1].reason).toBe("Second requested angle retained through a remote refresh.");
});
