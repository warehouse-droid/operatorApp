import { ce94489Replay } from "../../support/dispatch-map-driver-replay-fixture.mjs";
import { expect, test } from "./mbt-e2e-test.js";

test.use({ serviceWorkers: "block" });

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

const pins = [
  { lat: 43.82, lng: -79.3 }, { lat: 43.3, lng: -80.45 }, { lat: 43.405, lng: -80.3 },
  { lat: 43.65, lng: -79.91 }, { lat: 43.8, lng: -79.3 }, { lat: 43.82, lng: -79.3 }
];

test("CE94489 road preview redraws and survives page reload without another route request or plan write", async ({ page, browserName }, testInfo) => {
  if (browserName === "chromium") { await page.coverage.startJSCoverage({ resetOnNavigation: false }); }
  await page.setViewportSize({ width: 1440, height: 1000 });
  const plan = { ...structuredClone(ce94489Replay.plan), assignedOrderSnapshots: ce94489Replay.plan.orders };
  const load = plan.trucks[0].loads[0];
  const writes = [];
  const estimates = [];
  const errors = [];
  let admissions = 0;
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const observed = { maps: [], markers: [], paths: [] };
    globalThis.__mapReplay = observed;
    globalThis.localStorage.setItem("mbbs.staff.token", "isolated-map-fixture-token");
    globalThis.localStorage.setItem("mbbs.staff.role", "dispatcher");
    globalThis.localStorage.setItem("mbbs.staff.roles", JSON.stringify(["dispatcher"]));
    globalThis.localStorage.setItem("mbbs.dispatch.planDate", "2026-09-11");
    globalThis.localStorage.setItem("mbbs.dispatch.previewWidth", "390");
    globalThis.EventSource = class { addEventListener() {} close() {} };
    globalThis.google = { maps: {
      Map: class {
        constructor(canvas) { this.canvas = canvas; canvas.textContent = "Google SDK boundary substitute"; observed.maps.push(this); }
        fitBounds() {}
      },
      Marker: class {
        constructor(options) { Object.assign(this, options); observed.markers.push(this); }
        getPosition() { return this.position; }
        setMap(map) { this.map = map; }
        addListener() {}
      },
      Polyline: class {
        constructor(options) { Object.assign(this, options); observed.paths.push(this); }
        setMap(map) { this.map = map; }
      },
      InfoWindow: class { open() {} close() {} },
      LatLngBounds: class { points = []; extend(point) { this.points.push(point); } isEmpty() { return this.points.length === 0; } },
      Size: class {}, Point: class {}
    } };
  });
  await page.route("**/api/**", (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/dispatch/maps/browser-session") {
      admissions += 1;
      return json(route, { available: true, googleMapsApiKey: "test-browser-boundary" });
    }
    if (path === "/api/dispatch/maps/route-estimate") {
      const body = request.postDataJSON();
      estimates.push(body);
      const routePath = [pins[0], { lat: 43.5 + estimates.length / 100, lng: -80.2 }, ...pins.slice(1)];
      return json(route, {
        source: "google_routes_v2", routePath, stopCoordinates: pins,
        legMinutes: [105, 20, 69, 99, 5], rawLegMinutes: [81, 15, 53, 76, 4],
        driveMinutes: 298, rawDriveMinutes: 229, stayMinutes: 245, totalMinutes: 543,
        routeSignature: body.routeSignature, routeEstimateId: body.routeEstimateId, travelTimePercent: 30
      });
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      writes.push({ method: request.method(), path });
      return json(route, {}, 409);
    }
    const fixtures = {
      "/api/auth/me": { operator: { id: "isolated", username: "map-replay", display_name: "Map replay", role: "dispatcher", roles: ["dispatcher"] } },
      "/api/dispatch/config": { googleMapsEnabled: true, driverOrientedPlanning: true, plannerOrderPoolMode: "off", plannerCommandMode: "off" },
      "/api/dispatch/setup": { drivers: [{ login: "sety", name: "Sety", license: "AZ" }], trucks: [{ plate: "CE94489", capacityLbs: 83000, baseYard: "3445" }], ownYards: [], planning: {} },
      "/api/dispatch/vendor-yards": ce94489Replay.vendorYards,
      "/api/dispatch/v2/bootstrap": { exists: true, plan },
      "/api/dispatch/orders": [], "/api/dispatch/v2/order-pool": { orders: [], nextCursor: "" },
      "/api/dispatch/planned-assignments": [], "/api/dispatch/plans": [], "/api/dispatch/driver-job-statuses": [],
      "/api/dispatch/driver-truck-switches/attention": [], "/api/dispatch/plan-edit-lease": { lease: null },
      "/api/dispatch/forecast": { planId: plan.id, planDate: plan.planDate, loads: [], stops: [], travelLegs: [] },
      "/api/mbt/status": { capabilities: { binDispatch: { enabled: false } } }
    };
    return json(route, fixtures[path] ?? {});
  });
  await page.goto("/dispatch/planning");
  await page.locator(`[data-action="select-load"][data-load="${load.id}"]`).click();
  const preview = page.locator(".load-preview-panel");
  const button = preview.locator('[data-action="refresh-google-route"]');
  await expect(button).toHaveCount(1);
  await expect(preview.locator(".fallback-map-preview")).toHaveCount(0);
  await expect(preview.locator(".preview-section-title").filter({ has: page.locator('[data-action="refresh-google-route"]') })).toContainText("Maps Preview");
  const titleBox = await preview.getByText("Maps Preview", { exact: true }).boundingBox();
  const buttonBox = await button.boundingBox();
  expect(buttonBox.x).toBeGreaterThan(titleBox.x + titleBox.width);
  expect(Math.abs(buttonBox.y + buttonBox.height / 2 - titleBox.y - titleBox.height / 2)).toBeLessThan(3);
  await expect.poll(() => page.evaluate(() => globalThis.__mapReplay.maps.length)).toBe(1);
  await page.evaluate(() => { globalThis.__retainedMapCanvas = globalThis.document.getElementById("googleMapPreview"); });
  for (let refresh = 1; refresh <= 2; refresh += 1) {
    await button.click();
    await expect(preview.locator("#googleMapPreview")).toHaveAttribute("data-dispatch-geometry-source", "google_route");
    await expect.poll(() => estimates.length).toBe(refresh);
    await expect.poll(() => page.evaluate(() => globalThis.__mapReplay.paths.filter((path) => path.map).at(-1)?.path[1]?.lat)).toBe(43.5 + refresh / 100);
    const state = await page.evaluate(() => ({
      sameCanvas: globalThis.__retainedMapCanvas === globalThis.document.getElementById("googleMapPreview"),
      mapCount: globalThis.__mapReplay.maps.length,
      positions: globalThis.__mapReplay.markers.filter((marker) => marker.map).map((marker) => marker.position),
      paths: globalThis.__mapReplay.paths.filter((path) => path.map).length
    }));
    expect(state.sameCanvas).toBe(true);
    expect(state.mapCount).toBe(1);
    expect(state.paths).toBe(1);
    // Overlap fan-out may change iteration order but never the real coordinates.
    expect(state.positions.map(JSON.stringify).sort()).toEqual(pins.map(JSON.stringify).sort());
    expect(admissions).toBe(1);
  }
  expect(estimates[0].stops).toHaveLength(6);
  expect(estimates[0].stops.slice(1, 4).map((stop) => stop.location)).toEqual(ce94489Replay.vendorYards.map((yard) => yard.address));
  await expect.poll(() => page.evaluate(() => Object.values(JSON.parse(globalThis.localStorage.getItem("mbbs.dispatch.routeEstimates.v1") || "{}"))[0]?.estimate?.routePath?.[1]?.lat)).toBe(43.52);
  const cached = await page.evaluate(() => Object.values(JSON.parse(globalThis.localStorage.getItem("mbbs.dispatch.routeEstimates.v1")))[0].estimate);
  for (const savedTimingOnly of [false, true]) {
    // An older confirmed plan can contain valid timing without the newer map
    // geometry. Its timing must not prevent the browser restoring the preview.
    if (savedTimingOnly) { load.routeEstimate = { ...cached, routePath: [], stopCoordinates: [] }; }
    await page.reload();
    await page.locator(`[data-action="select-load"][data-load="${load.id}"]`).click();
    await expect(preview.locator("#googleMapPreview")).toHaveAttribute("data-dispatch-geometry-source", "google_route");
    await expect.poll(() => page.evaluate(() => globalThis.__mapReplay.paths.filter((path) => path.map).at(-1)?.path)).toEqual(cached.routePath);
    expect(estimates).toHaveLength(2);
    const positions = await page.evaluate(() => globalThis.__mapReplay.markers.filter((marker) => marker.map).map((marker) => marker.position));
    expect(positions.map(JSON.stringify).sort()).toEqual(pins.map(JSON.stringify).sort());
  }
  // A route-setting change must not relabel the old road preview as current.
  load.allowTolls = true;
  await page.reload();
  await page.locator(`[data-action="select-load"][data-load="${load.id}"]`).click();
  await expect(preview.locator("#googleMapPreview")).toHaveAttribute("data-dispatch-geometry-source", "local_approximate");
  expect(estimates).toHaveLength(2);
  expect(admissions).toBe(4);
  expect(writes).toEqual([]);
  expect(errors).toEqual([]);
  await testInfo.attach("map-redraw-and-header", { body: await preview.screenshot(), contentType: "image/png" });
  if (browserName === "chromium") {
    const coverage = await page.coverage.stopJSCoverage();
    const dispatch = coverage.find((entry) => new URL(entry.url).pathname === "/dispatch.js");
    expect(dispatch).toBeTruthy();
    await testInfo.attach("map-v8-coverage", { body: JSON.stringify(dispatch), contentType: "application/json" });
  }
});
