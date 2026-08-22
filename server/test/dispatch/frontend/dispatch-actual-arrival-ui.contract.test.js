// @ts-check

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

function source(relativePath) {
  return fs.readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const server = source("../../../src/server.js");
const service = source("../../../src/dispatch-actual-arrival-service.js");
const repository = source("../../../src/dispatch-actual-arrival-repository.js");
const forecast = source("../../../src/dispatch-forecast-service.js");
const samsara = source("../../../src/samsara.js");
const setupUi = source("../../../public/dispatch-setup.js");
const driverUi = source("../../../public/driver.js");
const migration = source("../../../migrations/167_dispatch_actual_stop_arrivals.sql");

test("the gate defaults off and can be changed from Dispatch Setup without a Driver PWA release", () => {
  assert.match(server, /actualStopArrivalEnabled:\s*false/u);
  assert.match(server, /patch\.samsara \? \{ \.\.\.current\.samsara, \.\.\.patch\.samsara \}/u);
  assert.match(setupUi, /name="actualStopArrivalEnabled"/u);
  assert.match(setupUi, /Historical Route Arrival Calculation/u);
  assert.match(setupUi, /Calculate Preview/u);
  assert.match(setupUi, /Apply resolved arrivals/u);
  assert.doesNotMatch(driverUi, /actual-arrivals|actualStopArrivalEnabled/u);
});

test("calculation runs only in the server worker and historical APIs are dispatcher-protected", () => {
  assert.match(server, /setInterval\(\(\) => void dispatchActualArrivalTick\(\), 15000\)/u);
  assert.match(server, /app\.get\("\/api\/dispatch\/actual-arrivals\/drivers", requireOperator, requireDispatcher/u);
  assert.match(server, /app\.post\("\/api\/dispatch\/actual-arrivals\/runs", requireOperator, requireDispatcher/u);
  assert.match(server, /app\.post\("\/api\/dispatch\/actual-arrivals\/runs\/:runId\/apply", requireOperator, requireDispatcher/u);
  assert.match(service, /localActualArrivalPoints/u);
  assert.match(service, /listSamsaraVehicleGpsHistory/u);
  assert.match(service, /SAMSARA_STOP_HISTORY_BUDGET_MS = 10_000/u);
  assert.match(service, /deadlineAt: historyDeadlineAt/u);
  assert.match(service, /nextTorontoElevenPm/u);
  assert.match(samsara, /\/fleet\/vehicles\/stats\/history/u);
  assert.doesNotMatch(samsara, /stats\/history[\s\S]{0,800}limit:\s*"512"/u);
});

test("the canonical arrival is separate from immutable Driver evidence and feeds stop plus travel timing", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS dispatch_actual_stop_arrivals/u);
  assert.match(migration, /AFTER INSERT OR UPDATE OF status, completed_at ON driver_job_records/u);
  assert.doesNotMatch(repository, /UPDATE driver_job_records[\s\S]{0,300}started_at/u);
  assert.match(repository, /INSERT INTO dispatch_actual_stop_arrivals/u);
  assert.match(forecast, /actual_arrival_at/u);
  assert.match(forecast, /source: destinationArrivalApplied[\s\S]*"destination_stop_arrival"/u);
});
