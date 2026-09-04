import crypto from "node:crypto";
import { mkdir } from "node:fs/promises";

import { createOperator } from "../../../src/auth-repository.js";
import { query } from "../../../src/db.js";
import { insertDispatchLateOrder, splitDispatchPickupVisit } from "../../../src/dispatch-pickup-visits.js";
import { getNextDriverJob, planJobsForDriver } from "../../../src/driver-repository.js";
import { expect, test } from "./mbt-e2e-test.js";

const planDate = "2026-09-03";
const runId = crypto.randomUUID().slice(0, 8);
const browserLeaseToken = crypto.randomUUID();
const username = `dispatch-repeat-pickup-${runId}`;
const password = "dispatch-repeat-pickup-test";
const artifactDirectory = "/app/test-artifacts/dispatch-repeat-pickup";
const driverPwaClientVersion = "2026.08.12.3";
const driverPwaLogin = `repeat-pickup-driver-${runId}`;
const driverPwaPlanNote = `repeat-pickup-driver-browser:${runId}`;

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: { "cache-control": "no-store" },
    body: JSON.stringify(body)
  });
}

function order(id, { yard = "3445", address = `${id} Customer Road` } = {}) {
  return {
    id,
    type: "SO",
    customer: `${id} customer`,
    sourceYard: yard,
    pickupLocations: [yard],
    address,
    destinationAddress: address,
    items: [{ lineRowId: `${id}-line`, sku: `${id}-item`, quantity: 1, salesQty: 1, pallets: 1 }],
    pallets: 1,
    weight: 1000,
    localDispatchStatus: "planned"
  };
}

function loadStop(id, type, orderId, location = "3445", orderRefs = [orderId]) {
  return { id, loadId: "L-REPEAT", type, orderId, orderRefs, location };
}

function planWithOrders({ id, orders, stops }) {
  return {
    id,
    planDate,
    revision: 8,
    status: "draft",
    pickupVisitSchemaVersion: 1,
    orders,
    assignedOrderSnapshots: orders,
    trucks: [{
      id: "T-REPEAT",
      plate: "REPEAT-1",
      driver: "Replay Driver",
      driverLogin: "replay-driver",
      license: "AZ",
      base: "3445",
      capacityLbs: 80000,
      ownYardFixedMinutes: 30,
      vendorFixedMinutes: 30,
      deliveryFixedMinutes: 10,
      minutesPerPallet: 1,
      travelTimePercent: 30,
      loads: [{
        id: "L-REPEAT",
        name: "Repeat Pickup Load",
        start: "07:00",
        startMode: "fixed",
        truckId: "T-REPEAT",
        truckPlate: "REPEAT-1",
        driverName: "Replay Driver",
        driverLogin: "replay-driver",
        switchYard: "3445",
        pickupVisitSchemaVersion: 1,
        stops
      }]
    }],
    summary: { driverLaneOrder: ["replay-driver"], ownYardCodes: ["3445", "2967", "12441", "150"] }
  };
}

function automaticRevisitPlan() {
  const original = order("SO-A", { address: "100 Shared Customer Road" });
  const vendor = order("SO-V", { yard: "Vendor Yard", address: "200 Vendor Customer Road" });
  vendor.poPickupManifest = [{
    poOrderRef: "PO-V",
    location: "Vendor Yard",
    items: [{ lineRowId: "SO-V-vendor-line", sku: "SO-V-item", quantity: 1, salesQty: 1, pallets: 1 }]
  }];
  const base = planWithOrders({
    id: "REPEAT-AUTO-PLAN",
    orders: [original, vendor],
    stops: [
      loadStop("P-A", "pick", original.id),
      loadStop("P-V", "pick", vendor.id, "Vendor Yard"),
      loadStop("D-V", "drop", vendor.id, "Vendor Yard"),
      loadStop("D-A", "drop", original.id)
    ]
  });
  const inserted = insertDispatchLateOrder({
    plan: base,
    loadId: "L-REPEAT",
    order: order("SO-LATE", { address: original.address }),
    activity: [{
      plan_id: base.id,
      load_id: "L-REPEAT",
      stop_id: "P-A",
      stop_type: "pickup",
      status: "complete",
      order_refs: [original.id]
    }, {
      plan_id: base.id,
      load_id: "L-REPEAT",
      stop_id: "travel-P-A-P-V",
      stop_type: "travel",
      status: "in_progress",
      job_details: { fromStopId: "P-A", toStopId: "P-V" }
    }],
    makeStopId: (kind) => `AUTO-${kind.toUpperCase()}`
  });
  return {
    ...inserted.plan,
    assignedOrderSnapshots: inserted.plan.orders
  };
}

function manualSplitPlan() {
  const orders = ["SO-A", "SO-B", "SO-C", "SO-D", "SO-E"].map((id) => order(id));
  return planWithOrders({
    id: "REPEAT-MANUAL-PLAN",
    orders,
    stops: [
      loadStop("P-ALL", "pick", "SO-A", "3445", orders.map(({ id }) => id)),
      ...orders.map(({ id }) => loadStop(`D-${id.slice(3)}`, "drop", id))
    ]
  });
}

function splitManualPickupPlan() {
  return splitDispatchPickupVisit({
    plan: manualSplitPlan(),
    loadId: "L-REPEAT",
    stopId: "P-ALL",
    orderRefs: ["SO-D", "SO-E"],
    makeStopId: () => "P-LATER"
  }).plan;
}

async function cleanupDriverPwaPlan() {
  await query(
    `DELETE FROM dispatch_actual_stop_arrivals
      WHERE driver_job_record_id IN (
        SELECT id FROM driver_job_records WHERE lower(driver_login) = lower($1)
      )`,
    [driverPwaLogin]
  );
  await query("DELETE FROM dispatch_actual_arrival_runs WHERE lower(driver_login) = lower($1)", [driverPwaLogin]);
  await query("DELETE FROM driver_job_records WHERE lower(driver_login) = lower($1)", [driverPwaLogin]);
  await query("DELETE FROM dispatch_plans WHERE note = $1", [driverPwaPlanNote]);
  await query("DELETE FROM dispatch_drivers WHERE lower(login) = lower($1)", [driverPwaLogin]);
}

async function seedDriverPwaPlan(sourcePlan) {
  await cleanupDriverPwaPlan();
  const existingPlan = await query(
    "SELECT note FROM dispatch_plans WHERE plan_date = $1::date",
    [planDate]
  );
  if (existingPlan.rowCount) {
    throw new Error(`Driver PWA browser fixture refuses to replace plan ${planDate}: ${existingPlan.rows[0].note || "untitled"}`);
  }
  await query(
    `INSERT INTO dispatch_drivers (name, login, license_class, active, samsara_enabled)
     VALUES ('Repeat Pickup Browser Driver', $1, 'AZ', true, false)`,
    [driverPwaLogin]
  );
  const inserted = await query(
    `INSERT INTO dispatch_plans (plan_date, status, note, confirmed_at, revision)
     VALUES ($1::date, 'confirmed', $2, now(), $3)
     RETURNING id::text`,
    [planDate, driverPwaPlanNote, Number(sourcePlan.revision || 1)]
  );
  const planId = Number(inserted.rows[0].id);
  const trucks = structuredClone(sourcePlan.trucks || []).map((truck) => ({
    ...truck,
    driver: "Repeat Pickup Browser Driver",
    driverLogin: driverPwaLogin,
    loads: (truck.loads || []).map((load) => ({
      ...load,
      driverName: "Repeat Pickup Browser Driver",
      driverLogin: driverPwaLogin
    }))
  }));
  await query(
    `INSERT INTO dispatch_plan_snapshots (plan_id, orders, trucks, summary)
     VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb)`,
    [
      planId,
      JSON.stringify(sourcePlan.orders || []),
      JSON.stringify(trucks),
      JSON.stringify(sourcePlan.summary || {})
    ]
  );
  return { ...sourcePlan, id: planId, status: "confirmed", trucks };
}

async function withDriverPwaPlan(sourcePlan, callback) {
  const persistedPlan = await seedDriverPwaPlan(sourcePlan);
  try {
    return await callback(persistedPlan);
  } finally {
    await cleanupDriverPwaPlan();
  }
}

function driverJobText(value) {
  return String(value ?? "");
}

function completedDriverJobPhotos(job) {
  if (!(Number(job.requiredPhotos) > 0)) {
    return [];
  }
  return [`browser-proof/${job.jobId}/1.jpg`, `browser-proof/${job.jobId}/2.jpg`];
}

function completedDriverJobDetails(job) {
  return {
    fromStopId: driverJobText(job.fromStopId),
    toStopId: driverJobText(job.toStopId),
    location: driverJobText(job.location),
    address: driverJobText(job.address)
  };
}

function completedDriverJobValues(job) {
  return [
    job.jobId,
    job.planId,
    job.planDate,
    driverPwaLogin,
    driverJobText(job.truckId),
    driverJobText(job.truckPlate),
    driverJobText(job.loadId),
    driverJobText(job.loadName),
    driverJobText(job.stopId),
    driverJobText(job.stopType),
    JSON.stringify(Array.isArray(job.orderRefs) ? job.orderRefs : []),
    JSON.stringify(completedDriverJobPhotos(job)),
    JSON.stringify(completedDriverJobDetails(job))
  ];
}

async function recordDriverJobsComplete(jobs) {
  for (const job of jobs) {
    await query(
      `INSERT INTO driver_job_records (
         job_id, plan_id, plan_date, driver_login, truck_id, truck_plate,
         load_id, load_name, stop_id, stop_type, order_refs, photo_data_urls,
         status, started_at, completed_at, job_details
       ) VALUES (
         $1, $2, $3::date, $4, $5, $6,
         $7, $8, $9, $10, $11::jsonb, $12::jsonb,
         'complete', now() - interval '2 minutes', NULL, $13::jsonb
       )
       ON CONFLICT (job_id) DO UPDATE SET
         status = 'complete',
         completed_at = NULL,
         order_refs = EXCLUDED.order_refs,
         photo_data_urls = EXCLUDED.photo_data_urls,
         job_details = EXCLUDED.job_details`,
      completedDriverJobValues(job)
    );
  }
}

async function loginToken(request) {
  const response = await request.post("/api/auth/login", { data: { username, password } });
  expect(response.status()).toBe(200);
  return (await response.json()).token;
}

async function installBrowserState(page, token) {
  await page.addInitScript(({ authToken, date }) => {
    globalThis.localStorage.setItem("mbbs.staff.token", authToken);
    globalThis.localStorage.setItem("mbbs.staff.role", "dispatcher");
    globalThis.localStorage.setItem("mbbs.staff.roles", JSON.stringify(["dispatcher"]));
    globalThis.localStorage.setItem("mbbs.dispatch.token", authToken);
    globalThis.localStorage.setItem("mbbs.dispatch.planDate", date);
    globalThis.EventSource = class {
      addEventListener() {}
      close() {}
    };
  }, { authToken: token, date: planDate });
}

async function installDispatchFixtures(page, plan, { driverStatuses = [], savePayloads = [] } = {}) {
  await page.route("**/api/dispatch/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (method === "POST" && path === "/api/dispatch/plan-edit-lease/acquire") {
      const body = request.postDataJSON();
      return json(route, {
        editLeaseToken: browserLeaseToken,
        lease: {
          active: true,
          planDate,
          sessionId: body.sessionId,
          operatorName: "Repeat pickup browser test",
          expiresAt: "2099-01-01T00:00:00.000Z"
        }
      });
    }
    if (method === "PUT" && path === `/api/dispatch/plans/${plan.id}`) {
      const body = request.postDataJSON();
      savePayloads.push(body);
      return json(route, {
        ...body,
        id: plan.id,
        planDate,
        revision: Number(plan.revision) + savePayloads.length,
        savedAt: new Date().toISOString()
      });
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      return json(route, { error: `Unhandled repeat-pickup fixture ${method} ${path}` }, 404);
    }
    const fixture = new Map([
      ["/api/dispatch/config", {
        googleMapsApiKey: "",
        driverOrientedPlanning: true,
        plannerOrderPoolMode: "off",
        plannerCommandMode: "off"
      }],
      ["/api/dispatch/setup", {
        drivers: [{ login: "replay-driver", name: "Replay Driver", license: "AZ" }],
        trucks: [{ plate: "REPEAT-1", capacityLbs: 80000, baseYard: "3445" }],
        ownYards: [],
        planning: {}
      }],
      ["/api/dispatch/vendor-yards", [
        { vendor: "Replay Vendor", yard: "Vendor Yard", address: "Vendor Yard", active: true }
      ]],
      ["/api/dispatch/v2/bootstrap", { exists: true, plan }],
      ["/api/dispatch/orders", plan.orders],
      ["/api/dispatch/v2/order-pool", { orders: [], nextCursor: "" }],
      ["/api/dispatch/planned-assignments", []],
      ["/api/dispatch/plans", []],
      ["/api/dispatch/driver-job-statuses", driverStatuses],
      ["/api/dispatch/driver-truck-switches/attention", []],
      ["/api/dispatch/forecast", {
        planId: plan.id,
        planDate,
        planRevision: plan.revision,
        loads: [],
        stops: [],
        travelLegs: []
      }],
      ["/api/dispatch/plan-edit-lease", { lease: null }]
    ]).get(path);
    return json(route, fixture === undefined ? {} : fixture);
  });
  await page.route("**/api/mbt/status", (route) => json(route, {
    capabilities: { binDispatch: { enabled: false } }
  }));
}

async function installDriverPwaFixtures(page, initialJob) {
  let currentJob = initialJob;
  const servedJobIds = [];
  await page.addInitScript(() => {
    globalThis.localStorage.setItem("mbbs.driver.token", "repeat-pickup-driver-browser-token");
    Object.defineProperty(globalThis.navigator, "onLine", {
      configurable: true,
      get: () => true
    });
    globalThis.EventSource = class {
      addEventListener() {}
      close() {}
    };
  });
  await page.route("**/api/driver/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/driver/client-version") {
      return json(route, {
        currentVersion: driverPwaClientVersion,
        minimumVersion: driverPwaClientVersion,
        isCurrent: true,
        offlineEnabled: false,
        offlineModeRevision: "repeat-pickup-browser"
      });
    }
    if (path === "/api/driver/me") {
      return json(route, {
        driver: {
          id: "repeat-pickup-driver",
          login: "replay-driver",
          name: "Replay Driver",
          samsaraEnabled: false
        }
      });
    }
    if (path === "/api/driver/next-job") {
      servedJobIds.push(currentJob?.jobId || null);
      return json(route, {
        job: currentJob,
        rest: null,
        restSummary: null,
        state: {
          planDate,
          truckPlate: "REPEAT-1",
          samsaraEnabled: false,
          allJobsComplete: false
        }
      });
    }
    if (path === "/api/driver/history") {
      return json(route, { records: [] });
    }
    if (path === "/api/driver/route-change-requests") {
      return json(route, { requests: [] });
    }
    return json(route, {});
  });
  return {
    servedJobIds,
    show(job) {
      currentJob = job;
    }
  };
}

async function expectRenderedDriverPickup(page, orderRefs) {
  await expect(page.locator(".job-panel")).toBeVisible();
  await expect(page.locator(".job-type")).toHaveText("Pickup");
  await expect(page.locator(".job-title-row h2")).toHaveText("3445");
  await expect(page.locator(".address-block strong")).toContainText("3445");
  await expect.poll(() => page.locator(".order-card h3").allTextContents()).toEqual(orderRefs);
}

async function removeOperator() {
  await query(
    "DELETE FROM operator_sessions WHERE operator_id IN (SELECT id FROM operators WHERE username = $1)",
    [username]
  );
  await query("DELETE FROM operators WHERE username = $1", [username]);
}

test.beforeAll(async () => {
  await mkdir(artifactDirectory, { recursive: true });
  await createOperator({
    username,
    password,
    displayName: "Dispatch repeat pickup browser test",
    role: "dispatcher",
    roles: ["dispatcher"]
  });
});

test.afterAll(removeOperator);

test("active-load fake order renders a second scoped yard visit after protected travel", async ({ page, request }, testInfo) => {
  const plan = automaticRevisitPlan();
  const load = plan.trucks[0].loads[0];
  expect(load.stops.map(({ id }) => id)).toEqual(["P-A", "P-V", "D-V", "AUTO-PICK", "D-A", "AUTO-DROP"]);
  await installDispatchFixtures(page, plan, {
    driverStatuses: [{
      plan_id: plan.id,
      load_id: load.id,
      stop_id: "P-A",
      stop_type: "pickup",
      status: "complete",
      order_refs: ["SO-A"]
    }, {
      plan_id: plan.id,
      load_id: load.id,
      stop_id: "travel-P-A-P-V",
      stop_type: "travel",
      status: "in_progress",
      job_details: { fromStopId: "P-A", toStopId: "P-V" }
    }]
  });
  await installBrowserState(page, await loginToken(request));

  await page.goto("/dispatch/planning?repeatPickupBrowser=automatic");
  const route = page.locator(`[data-load-card="${load.id}"]`);
  await expect(route).toBeVisible();
  const physicalStops = route.locator("article.stop-card[data-stop]");
  await expect(physicalStops).toHaveCount(5);
  await expect.poll(() => physicalStops.evaluateAll((cards) => cards.map((card) => card.dataset.stop)))
    .toEqual(["P-A", "P-V", "D-V", "AUTO-PICK", "D-A"]);
  await expect(physicalStops.nth(0)).toContainText("1. Pickup 3445 · Visit 1/2 · 1 order");
  await expect(physicalStops.nth(3)).toContainText("4. Pickup 3445 · Visit 2/2 · 1 order");
  await expect(physicalStops.nth(4)).toContainText("5-6. SO-A + SO-LATE");
  await physicalStops.nth(3).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: `${artifactDirectory}/frontend-automatic-revisit-${testInfo.project.name}.png`,
    fullPage: true
  });
});

test("manual browser split preserves automatic 5-order grouping and renders a saved 3+2 revisit", async ({ page, request }, testInfo) => {
  const plan = manualSplitPlan();
  const savePayloads = [];
  await installDispatchFixtures(page, plan, { savePayloads });
  await installBrowserState(page, await loginToken(request));

  await page.goto("/dispatch/planning?repeatPickupBrowser=manual");
  const route = page.locator('[data-load-card="L-REPEAT"]');
  await expect(route).toBeVisible();
  const originalPickup = route.locator('article.stop-card[data-stop="P-ALL"]');
  await expect(originalPickup).toContainText("1. Pickup 3445 · 5 orders");
  const enterEditButton = page.locator('[data-action="enter-edit-mode"]');
  await expect(enterEditButton).toBeVisible();
  await enterEditButton.evaluate((button) => button.click());
  await expect(page.locator('[data-action="exit-edit-mode"]')).toBeVisible();
  const splitButton = originalPickup.locator('[data-action="open-pickup-visit-split"]');
  await expect(splitButton).toBeVisible();
  await splitButton.evaluate((button) => button.click());

  const modal = page.locator('form[data-form="pickup-visit-split"]');
  await expect(modal).toBeVisible();
  await expect(modal.locator('input[name="pickupOrderRef"]')).toHaveCount(5);
  await expect.poll(() => modal.locator('input[name="pickupOrderRef"]:checked').evaluateAll((inputs) =>
    inputs.map((input) => input.value)
  )).toEqual(["SO-D", "SO-E"]);
  await modal.getByRole("button", { name: "Create Later Pickup" })
    .evaluate((button) => button.click());

  const firstPickupVisit = route.getByText("Pickup 3445 · Visit 1/2 · 3 orders", { exact: false });
  const laterPickupVisit = route.getByText("Pickup 3445 · Visit 2/2 · 2 orders", { exact: false });
  await expect(firstPickupVisit).toBeVisible();
  await expect(laterPickupVisit).toBeVisible();
  await expect.poll(() => savePayloads.length).toBe(1);
  const savedLoad = savePayloads[0].trucks[0].loads[0];
  const pickupAllocations = savedLoad.stops
    .filter((stop) => stop.type === "pick")
    .map((stop) => stop.orderRefs);
  expect(pickupAllocations).toEqual([
    ["SO-A", "SO-B", "SO-C"],
    ["SO-D", "SO-E"]
  ]);
  expect(savedLoad.pickupVisitSchemaVersion).toBe(1);
  expect(savePayloads[0].pickupVisitSchemaVersion).toBe(1);
  expect(savedLoad.stops.filter((stop) => stop.type === "drop").map((stop) => stop.orderId))
    .toEqual(["SO-A", "SO-B", "SO-C", "SO-D", "SO-E"]);
  await laterPickupVisit.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: `${artifactDirectory}/frontend-manual-3-plus-2-${testInfo.project.name}.png`,
    fullPage: true
  });
});

test.describe("Driver PWA repeated pickup output", () => {
  test.use({ serviceWorkers: "block" });

  test("renders the automatic first and late 3445 pickups as distinct scoped jobs", async ({ page }, testInfo) => {
    await withDriverPwaPlan(automaticRevisitPlan(), async (persistedPlan) => {
      const jobs = planJobsForDriver(persistedPlan, driverPwaLogin);
      const firstPickup = await getNextDriverJob(driverPwaLogin, { date: planDate });
      const laterPickup = jobs.find((job) => job.stopId === "AUTO-PICK");
      expect(firstPickup).toBeTruthy();
      expect(laterPickup).toBeTruthy();
      expect(firstPickup.stopId).toBe("P-A");
      expect(firstPickup.jobId).not.toBe(laterPickup.jobId);
      expect(firstPickup.orderRefs).toEqual(["SO-A"]);
      expect(laterPickup.orderRefs).toEqual(["SO-LATE"]);

      const fixture = await installDriverPwaFixtures(page, firstPickup);
      await page.goto("/driver", { waitUntil: "domcontentloaded" });
      await expectRenderedDriverPickup(page, ["SO-A"]);
      await page.screenshot({
        path: `${artifactDirectory}/driver-automatic-visit-1-${testInfo.project.name}.png`,
        fullPage: true
      });

      const laterPickupIndex = jobs.findIndex((job) => job.jobId === laterPickup.jobId);
      expect(laterPickupIndex).toBeGreaterThan(0);
      await recordDriverJobsComplete(jobs.slice(0, laterPickupIndex));
      const nextPickup = await getNextDriverJob(driverPwaLogin, { date: planDate });
      expect(nextPickup.jobId).toBe(laterPickup.jobId);
      fixture.show(nextPickup);
      await page.locator('[data-action="refresh"]').click();
      await expectRenderedDriverPickup(page, ["SO-LATE"]);
      expect(fixture.servedJobIds).toContain(firstPickup.jobId);
      expect(fixture.servedJobIds.at(-1)).toBe(laterPickup.jobId);
      await page.screenshot({
        path: `${artifactDirectory}/driver-automatic-visit-2-${testInfo.project.name}.png`,
        fullPage: true
      });
    });
  });

  test("renders a manually split 3445 pickup as separate 3-order and 2-order jobs", async ({ page }, testInfo) => {
    await withDriverPwaPlan(splitManualPickupPlan(), async (persistedPlan) => {
      const jobs = planJobsForDriver(persistedPlan, driverPwaLogin);
      const firstPickup = await getNextDriverJob(driverPwaLogin, { date: planDate });
      const laterPickup = jobs.find((job) => job.stopId === "P-LATER");
      expect(firstPickup).toBeTruthy();
      expect(laterPickup).toBeTruthy();
      expect(firstPickup.stopId).toBe("P-ALL");
      expect(firstPickup.jobId).not.toBe(laterPickup.jobId);
      expect(firstPickup.orderRefs).toEqual(["SO-A", "SO-B", "SO-C"]);
      expect(laterPickup.orderRefs).toEqual(["SO-D", "SO-E"]);

      const fixture = await installDriverPwaFixtures(page, firstPickup);
      await page.goto("/driver", { waitUntil: "domcontentloaded" });
      await expectRenderedDriverPickup(page, ["SO-A", "SO-B", "SO-C"]);

      const laterPickupIndex = jobs.findIndex((job) => job.jobId === laterPickup.jobId);
      expect(laterPickupIndex).toBeGreaterThan(0);
      await recordDriverJobsComplete(jobs.slice(0, laterPickupIndex));
      const nextPickup = await getNextDriverJob(driverPwaLogin, { date: planDate });
      expect(nextPickup.jobId).toBe(laterPickup.jobId);
      fixture.show(nextPickup);
      await page.locator('[data-action="refresh"]').click();
      await expectRenderedDriverPickup(page, ["SO-D", "SO-E"]);
      expect(fixture.servedJobIds).toContain(firstPickup.jobId);
      expect(fixture.servedJobIds.at(-1)).toBe(laterPickup.jobId);
      await page.screenshot({
        path: `${artifactDirectory}/driver-manual-visit-2-${testInfo.project.name}.png`,
        fullPage: true
      });
    });
  });
});
