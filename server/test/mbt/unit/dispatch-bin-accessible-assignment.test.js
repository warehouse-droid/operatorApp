import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [dispatchSource, dispatchCss] = await Promise.all([
  readFile(new URL("../../../public/dispatch.js", import.meta.url), "utf8"),
  readFile(new URL("../../../public/dispatch.css", import.meta.url), "utf8")
]);

const dispatchServiceSource = await readFile(
  new URL("../../../src/mbt/bin-dispatch-service.js", import.meta.url),
  "utf8"
);

test("MBT Dispatch keeps drag assignment and adds an accessible exact-load assignment path", () => {
  assert.match(
    dispatchSource,
    /class="order-card mbt-bin-front-leg"\s+draggable="\$\{draggable\}"/u,
    "The existing drag path must remain available."
  );
  assert.match(dispatchSource, /data-mbt-load-choice="\$\{escapeHtml\(mbt\.visitId\)\}"/u);
  assert.match(dispatchSource, /data-action="assign-mbt-bin-front-leg"/u);
  assert.match(dispatchSource, /data-mbt-assign-visit-id="\$\{escapeHtml\(mbt\.visitId\)\}"/u);
  assert.doesNotMatch(
    dispatchSource,
    /data-action="assign-mbt-bin-front-leg"[^>]*data-mbt-visit-id=/u,
    "Only the draggable card may expose data-mbt-visit-id so card lookups remain unambiguous."
  );
  assert.match(dispatchSource, /aria-label="Target load for/u);
  assert.match(dispatchSource, /Assign to load/u);
});

test("accessible assignment presents the plan-date truck and load identity and reuses atomic assignment", () => {
  assert.match(dispatchSource, /function\s+mbtAssignableLoadChoices\s*\(/u);
  assert.match(dispatchSource, /truck[^\n]{0,160}(plate|name)[\s\S]{0,300}load[^\n]{0,160}name/u);
  assert.match(dispatchSource, /const\s+mbtBinLoadSelectionByVisit\s*=\s*new Map\(\)/u);
  assert.match(
    dispatchSource,
    /action\s*===\s*"assign-mbt-bin-front-leg"[\s\S]{0,200}dataset\.mbtAssignVisitId[\s\S]{0,700}assignMbtBinFrontLegToLoad\(/u
  );
  assert.match(
    dispatchSource,
    /dataset\?\.mbtLoadChoice[\s\S]{0,700}mbtBinLoadSelectionByVisit/u
  );
});

test("target choices retain and enforce both projected and canonical BIN truck capabilities", () => {
  const makeTruckStart = dispatchSource.indexOf("function makeTruckFromFleet");
  const makeTruckEnd = dispatchSource.indexOf("function trucksFromFleetAndSavedPlan", makeTruckStart);
  assert.ok(makeTruckStart >= 0 && makeTruckEnd > makeTruckStart);
  const makeTruck = dispatchSource.slice(makeTruckStart, makeTruckEnd);
  for (const field of ["truckType", "binServiceEnabled", "binSlotCapacity", "supportedBinTypeCodes"]) {
    assert.match(makeTruck, new RegExp(`${field}:`, "u"), `${field} must survive plan hydration.`);
  }

  const choiceStart = dispatchSource.indexOf("function mbtAssignableLoadChoices");
  const choiceEnd = dispatchSource.indexOf("function mbtSelectedAssignableLoad", choiceStart);
  assert.ok(choiceStart >= 0 && choiceEnd > choiceStart);
  const choices = dispatchSource.slice(choiceStart, choiceEnd);
  assert.match(choices, /truckType[\s\S]{0,300}===\s*"bin"/u);
  assert.match(choices, /binServiceEnabled\s*===\s*true/u);
  assert.match(choices, /binSlotCapacity[\s\S]{0,100}>=\s*1/u);
  assert.match(choices, /supportedBinTypes\.has\(requiredBinType\)/u);
  assert.match(choices, /!loadHasDriverActivity\(load\)/u);
  assert.match(choices, /loadHasAssignedDriver\(truck,\s*load\)/u);

  const serverGuardStart = dispatchServiceSource.indexOf("async function assertBinTruck");
  const serverGuardEnd = dispatchServiceSource.indexOf("async function materializedStops", serverGuardStart);
  assert.ok(serverGuardStart >= 0 && serverGuardEnd > serverGuardStart);
  const serverGuard = dispatchServiceSource.slice(serverGuardStart, serverGuardEnd);
  assert.match(serverGuard, /String\(row\.truck_type\)\s*!==\s*"bin"/u);
  assert.match(serverGuard, /row\.bin_service_enabled\s*!==\s*true/u);
  assert.match(serverGuard, /projectedTruck\.truckType/u);
  assert.match(serverGuard, /projectedCodes\.includes\(requiredBinTypeCode\)/u);
  assert.match(dispatchServiceSource, /function\s+requiredLoadDriverId\s*\(/u);
  assert.match(dispatchServiceSource, /MBT_BIN_DRIVER_REQUIRED/u);
  assert.match(
    dispatchServiceSource,
    /const\s+driverId\s*=\s*requiredLoadDriverId\(located\)/u,
    "The server must reject a direct assignment request that bypasses the UI's driver guard."
  );
  assert.match(dispatchServiceSource, /const\s+targetDriverId\s*=\s*requiredLoadDriverId\(target\)/u);
});

test("accessible assignment is disabled until both an exact asset and target load are selected", () => {
  assert.match(dispatchSource, /const\s+assignable\s*=\s*draggable\s*&&\s*Boolean\(selectedLoadId\)/u);
  assert.match(
    dispatchSource,
    /data-action="assign-mbt-bin-front-leg"[\s\S]{0,300}\$\{assignable\s*\?\s*""\s*:\s*"disabled"\}/u
  );
  assert.match(dispatchSource, /Choose the exact BIN asset and target load/u);
  assert.match(dispatchCss, /\.mbt-bin-assignment-controls/u);
  assert.match(dispatchCss, /\.mbt-bin-assignment-controls\s+(select|button)/u);
});
