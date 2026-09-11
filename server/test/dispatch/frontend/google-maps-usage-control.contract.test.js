import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = new URL("../../../", import.meta.url);
const dispatchSource = await readFile(new URL("public/dispatch.js", root), "utf8");
const monitorSource = await readFile(new URL("public/dispatch-monitor.js", root), "utf8");
const controlSource = await readFile(new URL("public/control.js", root), "utf8");
const serverSource = await readFile(new URL("src/server.js", root), "utf8");
const configSource = await readFile(new URL("src/config.js", root), "utf8");

function functionBody(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `Expected ${name} to exist.`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") {depth += 1;}
    if (source[index] === "}") {depth -= 1;}
    if (!depth) {return source.slice(start, index + 1);}
  }
  throw new Error(`Could not parse ${name}.`);
}

test("dispatch rendering and autosave never trigger route API work", () => {
  assert.doesNotMatch(functionBody(dispatchSource, "render"), /scheduleBackgroundRouteEstimates|googleRouteForLoad/u);
  assert.doesNotMatch(functionBody(dispatchSource, "renderDispatchPlannerPatch"), /scheduleBackgroundRouteEstimates|googleRouteForLoad/u);
  assert.doesNotMatch(functionBody(dispatchSource, "flushPlanSaveQueue"), /ensureGoogleRouteEstimatesBeforeSave/u);
  assert.match(functionBody(dispatchSource, "confirmCurrentPlanAtomic"), /refreshGoogleRouteEstimatesForConfirmation/u);
  assert.doesNotMatch(dispatchSource, /new google\.maps\.DirectionsService/u);
});

test("monitor polling never fans out Google Directions requests", () => {
  assert.doesNotMatch(functionBody(monitorSource, "renderMap"), /refreshTruckEtas|DirectionsService/u);
  assert.doesNotMatch(functionBody(monitorSource, "loadMonitor"), /refreshTruckEtas|DirectionsService/u);
  assert.doesNotMatch(monitorSource, /new google\.maps\.DirectionsService/u);
  assert.match(monitorSource, /data-action="refresh-monitor-eta"/u);
  assert.match(monitorSource, /\/api\/dispatch\/maps\/monitor-eta/u);
});

test("browser receives only the dedicated browser key and server calls are centralized", async () => {
  const configRoute = serverSource.slice(
    serverSource.indexOf('app.get("/api/dispatch/config"'),
    serverSource.indexOf("});", serverSource.indexOf('app.get("/api/dispatch/config"')) + 3
  );
  assert.doesNotMatch(configRoute, /config\.googleMapsApiKey/u);
  assert.doesNotMatch(configRoute, /googleMapsServerApiKey/u);
  assert.match(configSource, /configuredBrowserApiKey !== googleMapsServerApiKey/u);
  assert.match(serverSource, /\/api\/dispatch\/maps\/browser-session/u);
  assert.match(serverSource, /\/api\/dispatch\/maps\/route-estimate/u);
  assert.ok(
    functionBody(dispatchSource, "renderGoogleMapPreview").indexOf("await loadGoogleMaps")
      < functionBody(dispatchSource, "renderGoogleMapPreview").indexOf("new google.maps.Map"),
    "Every billable Dispatch map construction must obtain a metered admission first."
  );
  assert.match(functionBody(monitorSource, "renderMap"), /monitorMap \? Boolean\(window\.google\?\.maps\) : await loadGoogleMaps/u);

  const sourceDir = new URL("src/", root);
  const directCallFiles = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
      if (entry.isDirectory()) {
        await walk(target);
      } else if (entry.name.endsWith(".js")) {
        const source = await readFile(target, "utf8");
        if (source.includes("maps.googleapis.com") && entry.name !== "google-maps-gateway.js") {
          directCallFiles.push(path.basename(target.pathname));
        }
      }
    }
  }
  await walk(sourceDir);
  assert.deepEqual(directCallFiles, []);
});

test("online photo completion consumes a recent location verification before geocoding", () => {
  const photosStart = serverSource.indexOf('app.post("/api/driver/jobs/:jobId/photos"');
  const photosEnd = serverSource.indexOf('\napp.', photosStart + 10);
  const route = serverSource.slice(photosStart, photosEnd);
  assert.match(route, /consumeDriverLocationVerification/u);
  assert.ok(
    route.indexOf("consumeDriverLocationVerification") < route.indexOf("checkDriverJobLocation"),
    "Receipt reuse must be attempted before a new geocode-backed check."
  );
});

test("admin Maps Usage panel attributes daily and per-action usage", () => {
  assert.match(controlSource, /\/api\/admin\/maps-usage/u);
  assert.match(controlSource, /data-maps-usage-chart/u);
  assert.match(controlSource, /admittedUnits/u);
  assert.match(controlSource, /deniedCount/u);
  assert.match(controlSource, /failedCount/u);
  assert.match(controlSource, /Highest usage action/u);
  assert.match(serverSource, /app\.get\("\/api\/admin\/maps-usage", requireOperator, requireAdmin/u);
});
