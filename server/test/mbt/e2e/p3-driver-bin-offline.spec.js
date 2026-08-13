import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./mbt-e2e-test.js";

const TOKEN = "p3-driver-bin-browser-token";
const PLAN_DATE = "2039-08-03";
const MANIFEST_ID = "00000000-0000-4000-8000-000000000911";
const ASSET_ID = "00000000-0000-4000-8000-000000000912";
const JOB_ID = "BIN-P3-PWA-JOB-1";
const FINGERPRINT = "a".repeat(64);
const PREDECESSOR = "b".repeat(64);

function job(status = "pending") {
  return {
    jobId: JOB_ID,
    sequenceIndex: 0,
    planId: "900911",
    planDate: PLAN_DATE,
    loadId: "P3-BIN-LOAD",
    loadName: "BIN Load 1",
    stopId: "P3-BIN-STOP",
    stopType: "pickup",
    status,
    startedAt: status === "in_progress" ? new Date(Date.now() - 60_000).toISOString() : null,
    location: "12441",
    address: "12441 Woodbine Avenue, Whitchurch-Stouffville, ON",
    truckPlate: "P3-BIN-TRUCK",
    driverName: "P3 BIN Driver",
    requiredPhotos: 1,
    fingerprint: FINGERPRINT,
    predecessorFingerprint: PREDECESSOR,
    contentFingerprint: "c".repeat(64),
    orderRefs: [],
    orderTypes: ["BIN"],
    orders: [],
    mbt: {
      schemaVersion: "mbt-driver-bin-job-v1",
      minimumClientVersion: "2026.08.03.1",
      contractNumber: "MBT-P3-PWA-1",
      visitReference: "BIN-MBT-P3-PWA-1-V1",
      serviceAction: "delivery",
      actionCode: "collect_empty_bin",
      binTypeCode: "14YD",
      exactAssets: {
        expected: null,
        outgoing: {
          assetId: ASSET_ID,
          assetCode: "BIN-PWA-14-001",
          qrCode: "QR-BIN-PWA-14-001",
          binTypeCode: "14YD"
        },
        incoming: null
      },
      dumpSiteId: null,
      materialId: null,
      evidenceRequirements: [
        { evidenceCode: "outgoing_bin_scan", evidenceType: "bin_scan", minimumCount: 1, required: true },
        { evidenceCode: "placement_photo", evidenceType: "photo", minimumCount: 1, required: true },
        { evidenceCode: "condition_note", evidenceType: "note", minimumCount: 1, required: true }
      ]
    }
  };
}

function state() {
  return {
    planDate: PLAN_DATE,
    truckPlate: "P3-BIN-TRUCK",
    samsaraEnabled: false,
    preDvirStatus: "complete",
    postDvirStatus: "pending",
    samsaraOnDutyConfirmed: true,
    samsaraPreDvirConfirmed: true,
    allJobsComplete: false
  };
}

function bootstrap() {
  return {
    schemaVersion: 2,
    manifestId: MANIFEST_ID,
    planId: "900911",
    planDate: PLAN_DATE,
    planRevision: 1,
    generatedAt: "2039-08-03T10:00:00.000Z",
    expiresAt: "2039-08-04T16:00:00.000Z",
    offlineSyncGrant: "p3-browser-grant",
    currentJobFingerprint: FINGERPRINT,
    predecessorFingerprint: PREDECESSOR,
    currentJobContentFingerprint: "c".repeat(64),
    sequenceIndex: 0
  };
}

async function mockDriver(page, context, {
  initialStatus = "pending",
  holdDayPlan = false,
  offlineEnabled = true
} = {}) {
  let authoritativeStatus = initialStatus;
  const calls = [];
  const syncBodies = [];
  const onlineBinBodies = [];
  let reconnectAt = null;
  let releaseHeldDayPlan = () => {};
  const heldDayPlan = holdDayPlan
    ? new Promise((resolve) => { releaseHeldDayPlan = resolve; })
    : Promise.resolve();

  /* eslint-disable complexity -- This synthetic endpoint multiplexer deliberately models the complete Driver API boundary in one observable seam. */
  await page.exposeFunction("__p3DriverMockFetch", async ({
    url: requestUrl,
    method = "GET",
    bodyText = "",
    headers = {},
    byteSize = 0
  }) => {
    const url = new URL(requestUrl);
    calls.push({ method, path: url.pathname, at: Date.now() });
    const json = (body, status = 200, responseHeaders = {}) => ({
      status,
      headers: { "Content-Type": "application/json", ...responseHeaders },
      body
    });
    let body = {};
    if (bodyText) {
      try {
        body = JSON.parse(bodyText);
      } catch {
        body = {};
      }
    }
    if (url.pathname === "/api/driver/client-version") {
      return json({ currentVersion: "2026.08.12.3", minimumVersion: "2026.08.12.3", isCurrent: true, offlineEnabled, offlineModeRevision: 1 }, 200, {
        "X-MBBS-Driver-Current-Version": "2026.08.12.3",
        "X-MBBS-Driver-Minimum-Version": "2026.08.12.3"
      });
    }
    if (url.pathname === "/api/driver/me") {
      return json({ driver: { id: "900913", login: "p3-bin-driver", name: "P3 BIN Driver", samsaraEnabled: false }, offlineEnabled, offlineModeRevision: 1 });
    }
    if (url.pathname === "/api/driver/next-job") {
      return json({ job: job(authoritativeStatus), state: state(), rest: null, restSummary: null, routeBootstrap: bootstrap(), offlineEnabled, offlineModeRevision: 1 });
    }
    if (url.pathname === "/api/driver/day-plan") {
      await heldDayPlan;
      return json({ ...bootstrap(), complete: true, driver: { login: "p3-bin-driver" }, dayState: state(), jobs: [job(authoritativeStatus)] });
    }
    if (url.pathname === "/api/driver/offline-sync") {
      syncBodies.push(body);
      for (const event of body.events || []) {
        if (event.eventType === "job_started") {
          authoritativeStatus = "in_progress";
        }
        if (event.eventType === "job_completed") {
          authoritativeStatus = "completed";
        }
      }
      return json({
        events: (body.events || []).map((event) => ({
          eventId: event.eventId,
          status: "applied",
          appliedAt: new Date().toISOString(),
          result: { status: event.eventType === "job_completed" ? "completed" : "in_progress" }
        })),
        photos: (body.photoReceipts || []).map((receipt) => ({ ...receipt, status: "durably_received", durableReceipt: true }))
      });
    }
    if (url.pathname === "/api/driver/photo-upload-token") {
      return json({ uploadUrl: `${url.origin}/api/driver/test-photo-upload/${body.photoId}`, token: "upload-token" });
    }
    if (url.pathname.startsWith("/api/driver/test-photo-upload/")) {
      const photoId = url.pathname.split("/").pop();
      return json({
        key: `driver/driver-stop-photo/2039/08/03/${photoId}/evidence.jpg`,
        byteSize: Number(headers["content-length"] || byteSize || 0)
      });
    }
    if (url.pathname.endsWith(`/jobs/${JOB_ID}/bin/start`)) {
      onlineBinBodies.push({ type: "job_started", body });
      authoritativeStatus = "in_progress";
      return json({ job: job(authoritativeStatus), state: state(), eventId: body.eventId, offlineEnabled, offlineModeRevision: 1 });
    }
    if (url.pathname.endsWith(`/jobs/${JOB_ID}/bin/complete`)) {
      onlineBinBodies.push({ type: "job_completed", body });
      authoritativeStatus = "completed";
      return json({ job: null, state: { ...state(), allJobsComplete: true }, eventId: body.eventId, offlineEnabled, offlineModeRevision: 1 });
    }
    if (url.pathname === "/api/driver/sync-status") {
      return json({ ok: true });
    }
    if (url.pathname === "/api/driver/network-health") {
      return json({ ok: true });
    }
    if (url.pathname.endsWith("/location-check")) {
      return json({ status: "ok", message: "Synthetic GPS accepted" });
    }
    return json({ ok: true });
  });
  /* eslint-enable complexity */

  await page.addInitScript(({ token }) => {
    globalThis.localStorage.setItem("mbbs.driver.token", token);
    const isWebKitTestRuntime = /AppleWebKit/i.test(globalThis.navigator.userAgent)
      && !/(Chrome|Chromium|CriOS)/i.test(globalThis.navigator.userAgent);
    let logicalOnline = globalThis.sessionStorage.getItem("p3.driver.logicalOnline") !== "0";
    if (isWebKitTestRuntime) {
      Object.defineProperty(globalThis.navigator, "onLine", {
        configurable: true,
        get: () => logicalOnline
      });
    }
    globalThis.__p3SetLogicalOnline = (online) => {
      logicalOnline = Boolean(online);
      globalThis.sessionStorage.setItem("p3.driver.logicalOnline", logicalOnline ? "1" : "0");
      globalThis.dispatchEvent(new globalThis.Event(logicalOnline ? "online" : "offline"));
    };
    class SilentEventSource {
      addEventListener() {}
      close() {}
    }
    globalThis.EventSource = SilentEventSource;
    const browserFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = async (input, init = {}) => {
      const request = new globalThis.Request(input, init);
      const url = new URL(request.url);
      if (!url.pathname.startsWith("/api/driver/")) {
        return browserFetch(input, init);
      }
      if (!globalThis.navigator.onLine || globalThis.sessionStorage.getItem("p3.driver.networkOffline") === "1") {
        throw new TypeError("Failed to fetch");
      }
      const headers = Object.fromEntries(request.headers.entries());
      let bodyText = "";
      let byteSize = 0;
      if (!["GET", "HEAD"].includes(request.method)) {
        const bytes = await request.clone().arrayBuffer();
        byteSize = bytes.byteLength;
        if (String(headers["content-type"] || "").includes("application/json")) {
          bodyText = new globalThis.TextDecoder().decode(bytes);
        }
      }
      const mocked = await globalThis.__p3DriverMockFetch({
        url: request.url,
        method: request.method,
        bodyText,
        headers,
        byteSize
      });
      return new globalThis.Response(JSON.stringify(mocked.body), {
        status: mocked.status,
        headers: mocked.headers
      });
    };
  }, { token: TOKEN });

  return {
    calls,
    syncBodies,
    onlineBinBodies,
    releaseDayPlan() { releaseHeldDayPlan(); },
    markReconnect() { reconnectAt = Date.now(); },
    get reconnectAt() { return reconnectAt; }
  };
}

async function waitForProtectedRoute(page, controlSelector) {
  await page.evaluate(() => globalThis.navigator.serviceWorker?.ready);
  await expect.poll(() => page.evaluate(() => Boolean(globalThis.navigator.serviceWorker?.controller))).toBe(true);
  await expect(page.locator(controlSelector)).toBeEnabled();
}

async function createGalleryJpeg(page) {
  const bytes = await page.evaluate(async () => {
    const canvas = globalThis.document.createElement("canvas");
    canvas.width = 8;
    canvas.height = 8;
    const context = canvas.getContext("2d");
    context.fillStyle = "#007f78";
    context.fillRect(0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  return Buffer.from(bytes);
}

async function attachLocalGalleryPhoto(page, jpeg) {
  await page.evaluate((bytes) => {
    const input = globalThis.document.querySelector('[data-bin-evidence-code="placement_photo"][data-photo-source="gallery"]');
    const transfer = new globalThis.DataTransfer();
    transfer.items.add(new globalThis.File([new Uint8Array(bytes)], "placement.jpg", { type: "image/jpeg" }));
    input.files = transfer.files;
    input.dispatchEvent(new globalThis.Event("change", { bubbles: true }));
  }, Array.from(jpeg));
}

async function setDriverLogicalOffline(page, offline) {
  await page.evaluate((networkOffline) => {
    if (networkOffline) {
      globalThis.sessionStorage.setItem("p3.driver.networkOffline", "1");
    } else {
      globalThis.sessionStorage.removeItem("p3.driver.networkOffline");
    }
    globalThis.__p3SetLogicalOnline?.(!networkOffline);
  }, offline);
}

async function setDriverNetworkOffline(page, context, offline) {
  await setDriverLogicalOffline(page, offline);
  const isPlaywrightWebKit = await page.evaluate(() => (
    /AppleWebKit/i.test(globalThis.navigator.userAgent)
    && !/(Chrome|Chromium|CriOS)/i.test(globalThis.navigator.userAgent)
  ));
  // Playwright's WebKit transport-offline switch makes even local File,
  // FileReader, Blob.stream(), and Blob.arrayBuffer() fail with
  // NotReadableError. API calls are still forced offline by the logical
  // network interceptor above. The Chromium projects retain transport-level
  // offline coverage for the same reload and service-worker path.
  if (!isPlaywrightWebKit) {
    await context.setOffline(offline);
  }
  await page.evaluate((online) => globalThis.__p3SetLogicalOnline?.(online), !offline);
}

test("P3-F18: the actionable Driver screen renders while the full BIN route is still downloading", async ({ page, context }) => {
  const observed = await mockDriver(page, context, { holdDayPlan: true });
  try {
    await page.goto("/driver");
    await expect(page.locator("[data-driver-bin-job]")).toBeVisible();
    await expect.poll(() => observed.calls.some(({ path }) => path === "/api/driver/day-plan")).toBe(true);
    await expect(page.locator('[data-action="start-job"]')).toBeVisible();
  } finally {
    observed.releaseDayPlan();
  }
});

test("P3-F18: an online BIN start is local-first and never invokes the legacy ordinary start endpoint", async ({ page, context }) => {
  const observed = await mockDriver(page, context);
  await page.goto("/driver");
  await expect(page.locator("[data-driver-bin-job]")).toBeVisible();
  await expect(page.locator('[data-bin-asset-role="outgoing"]')).toContainText("BIN-PWA-14-001");
  await waitForProtectedRoute(page, '[data-action="start-job"]');

  await page.locator('[data-action="start-job"]').click();
  await expect.poll(() => observed.syncBodies.flatMap((body) => body.events || []).some((event) => event.eventType === "job_started")).toBe(true);
  expect(observed.calls.some(({ path, method }) => method === "POST" && path === `/api/driver/jobs/${JOB_ID}/start`)).toBe(false);
});

test("Driver online-only mode starts a BIN stop directly and disables actions when connection is lost", async ({ page, context }) => {
  const observed = await mockDriver(page, context, { offlineEnabled: false });
  await page.goto("/driver");
  await expect(page.locator("[data-driver-bin-job]")).toBeVisible();
  await expect(page.locator("#driverOfflineStatus")).toContainText("Online only");
  await expect(page.locator('[data-action="start-job"]')).toBeEnabled();

  await page.locator('[data-action="start-job"]').click();
  await expect.poll(() => observed.onlineBinBodies.some(({ type }) => type === "job_started")).toBe(true);
  expect(observed.calls.some(({ path }) => path === "/api/driver/day-plan")).toBe(false);
  expect(observed.calls.some(({ path }) => path === "/api/driver/offline-sync")).toBe(false);

  await setDriverNetworkOffline(page, context, true);
  await expect(page.locator("#driverOfflineStatus")).toContainText("Connection required");
  await expect(page.locator('[data-action="complete-job"]')).toBeDisabled();
});

test("Driver online-only mode uploads and completes BIN evidence without creating IndexedDB evidence", async ({ page, context }) => {
  const observed = await mockDriver(page, context, {
    initialStatus: "in_progress",
    offlineEnabled: false
  });
  await page.goto("/driver");
  await expect(page.locator("[data-driver-bin-job]")).toBeVisible();
  const galleryJpeg = await createGalleryJpeg(page);
  await page.locator('[data-bin-scan="outgoing_bin_scan"]').fill("QR-BIN-PWA-14-001");
  await page.locator('[data-bin-note="condition_note"]').fill("Sent directly online");
  await attachLocalGalleryPhoto(page, galleryJpeg);
  await expect(page.locator('[data-bin-photo-slot="placement_photo"] img')).toBeVisible();

  await page.locator('[data-action="complete-job"]').click();
  await expect.poll(() => observed.onlineBinBodies.some(({ type }) => type === "job_completed")).toBe(true);
  const completion = observed.onlineBinBodies.find(({ type }) => type === "job_completed").body;
  expect(completion.photos).toHaveLength(1);
  expect(completion.photos[0].objectReference).toContain(completion.photos[0].photoId);
  expect(completion.photos[0].sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(observed.calls.some(({ path }) => path === "/api/driver/day-plan")).toBe(false);
  expect(observed.calls.some(({ path }) => path === "/api/driver/offline-sync")).toBe(false);

  const localEvidence = await page.evaluate(async () => {
    const db = await globalThis.DriverOfflineDB.open();
    const transaction = db.transaction(["events", "photos", "manifests"], "readonly");
    const count = (store) => new Promise((resolve, reject) => {
      const request = transaction.objectStore(store).count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const [events, photos, manifests] = await Promise.all([
      count("events"),
      count("photos"),
      count("manifests")
    ]);
    return { events, photos, manifests };
  });
  expect(localEvidence).toEqual({ events: 0, photos: 0, manifests: 0 });
});

test("P3-F18: the actionable BIN Driver screen has no serious or critical accessibility violations", async ({ page, context }) => {
  await mockDriver(page, context);
  await page.goto("/driver");
  await expect(page.locator("[data-driver-bin-job]")).toBeVisible();
  await waitForProtectedRoute(page, '[data-action="start-job"]');

  const accessibility = await new AxeBuilder({ page })
    .include("#driverApp")
    .analyze();
  expect(accessibility.violations.filter(({ impact }) => (
    impact === "critical" || impact === "serious"
  ))).toEqual([]);
});

test("P3-F19/P3-F20/P3-F22: airplane draft survives reload and reconnects with original occurrence time and exact evidence", async ({ page, context }) => {
  const observed = await mockDriver(page, context, { initialStatus: "in_progress" });
  await page.goto("/driver");
  await expect(page.locator("[data-driver-bin-job]")).toBeVisible();
  await waitForProtectedRoute(page, '[data-bin-scan="outgoing_bin_scan"]');
  const galleryJpeg = await createGalleryJpeg(page);
  const onlineLocationChecks = observed.calls.filter(({ path }) => (
    path.endsWith("/location-check") && path.includes(JOB_ID)
  )).length;

  await setDriverNetworkOffline(page, context, true);
  await page.locator('[data-bin-scan="outgoing_bin_scan"]').fill("QR-BIN-PWA-14-001");
  await page.locator('[data-bin-note="condition_note"]').fill("Saved in airplane mode");
  await attachLocalGalleryPhoto(page, galleryJpeg);
  await expect(page.locator('[data-bin-photo-slot="placement_photo"] img')).toBeVisible();

  await page.reload();
  await expect(page.locator('[data-bin-scan="outgoing_bin_scan"]')).toHaveValue("QR-BIN-PWA-14-001");
  await expect(page.locator('[data-bin-note="condition_note"]')).toHaveValue("Saved in airplane mode");
  await expect(page.locator('[data-bin-photo-slot="placement_photo"] img')).toBeVisible();

  await page.locator('[data-action="complete-job"]').click();
  await expect(page.locator(".no-job, [data-driver-no-job]")).toBeVisible();
  const offlineCompletionAt = Date.now();
  expect(observed.calls.filter(({ path }) => (
    path.endsWith("/location-check") && path.includes(JOB_ID)
  ))).toHaveLength(onlineLocationChecks);

  observed.markReconnect();
  await setDriverNetworkOffline(page, context, false);
  await expect.poll(() => observed.syncBodies.flatMap((body) => body.events || []).some((event) => event.eventType === "job_completed")).toBe(true);
  const completion = observed.syncBodies.flatMap((body) => body.events || []).find((event) => event.eventType === "job_completed");
  expect(Date.parse(completion.occurredAt)).toBeLessThanOrEqual(offlineCompletionAt);
  expect(Date.parse(completion.occurredAt)).toBeLessThanOrEqual(observed.reconnectAt);
  expect(completion.locationStatus).toBe("not_checked_offline");
  expect(completion.details.mbt).toMatchObject({
    schemaVersion: "mbt-driver-bin-event-v1",
    actionCode: "collect_empty_bin",
    scans: [{
      evidenceCode: "outgoing_bin_scan",
      assetRole: "outgoing",
      assetId: ASSET_ID,
      scannedValue: "QR-BIN-PWA-14-001"
    }],
    photoEvidence: [{ evidenceCode: "placement_photo", ordinal: 0 }],
    notes: [{ evidenceCode: "condition_note", text: "Saved in airplane mode" }]
  });
  expect(observed.calls.some(({ path, method }) => method === "POST" && (path.endsWith("/start") || path.endsWith("/photos")))).toBe(false);
});
