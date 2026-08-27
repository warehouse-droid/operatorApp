// @ts-check

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { scanTextForSecrets } from "../../../test/support/scan-diff-secrets.mjs";

const read = (relativePath) => readFile(new URL(`../../../${relativePath}`, import.meta.url), "utf8");

test("S9: ordinary online and offline starts enforce the policy before side effects", async () => {
  const [server, repository] = await Promise.all([
    read("src/server.js"),
    read("src/driver-repository.js")
  ]);
  assert.match(server, /import \{ assertDriverPlanExecutionDate \} from "\.\/driver-plan-date-policy\.js";/u);

  const offline = server.slice(
    server.indexOf("async function applyDriverOfflineEvent"),
    server.indexOf('if (event.eventType === "job_completed")', server.indexOf("async function applyDriverOfflineEvent"))
  );
  assert.ok(offline.indexOf("assertDriverPlanExecutionDate(job.planDate)") >= 0);
  assert.ok(offline.indexOf("assertDriverPlanExecutionDate(job.planDate)") < offline.indexOf("applyMbtDriverBinOfflineEvent"));
  assert.ok(offline.indexOf("assertDriverPlanExecutionDate(job.planDate)") < offline.indexOf("reconcileCompletedYardTransfersForSalesOrderStart"));

  const online = server.slice(
    server.indexOf('app.post("/api/driver/jobs/:jobId/start"'),
    server.indexOf('app.post("/api/driver/jobs/:jobId/confirm-truck-switch"')
  );
  assert.ok((online.match(/assertDriverPlanExecutionDate\(/gu) || []).length >= 2);
  assert.ok(online.indexOf("assertDriverPlanExecutionDate(job.planDate)") < online.indexOf("reconcileCompletedYardTransfersForSalesOrderStart"));
  assert.match(online, /assertDriverPlanExecutionDate\(liveJob\.planDate\)/u);

  const persistence = repository.slice(
    repository.indexOf("export async function startDriverJob"),
    repository.indexOf("export async function startDriverRest")
  );
  assert.ok(persistence.indexOf("assertDriverPlanExecutionDate(job.planDate)") >= 0);
  assert.ok(persistence.indexOf("assertDriverPlanExecutionDate(job.planDate)") < persistence.indexOf("assertNoClosedNetSuiteOrders"));
});

test("S10: the PWA blocks future recording before an offline Start can be queued", async () => {
  const driver = await read("public/driver.js");
  const protection = driver.slice(
    driver.indexOf("function driverActionProtectionState"),
    driver.indexOf("function routeProtectedControlAttributes")
  );
  assert.match(protection, /driverPlanExecutionDecision\(currentJob\?\.planDate \|\| dayState\?\.planDate\)/u);
  assert.match(protection, /\(currentJob \|\| dvirMode\) && !planExecution\.allowed/u);
  assert.match(driver, /code: "DRIVER_PLAN_NOT_STARTED"/u);
  assert.match(driver, /Number\.isFinite\(parsedPlanDate\?\.getTime\(\)\)/u);

  const startAction = driver.slice(
    driver.indexOf('if (action === "start-job"'),
    driver.indexOf('if (action === "confirm-truck-switch"', driver.indexOf('if (action === "start-job"'))
  );
  assert.ok(startAction.indexOf("driverPlanExecutionDecision(currentJob.planDate)") >= 0);
  assert.ok(startAction.indexOf("driverPlanExecutionDecision(currentJob.planDate)") < startAction.indexOf('queueDriverEvent("job_started"'));
});

test("S11: the guarded client ships in a new atomic Driver shell generation", async () => {
  const [html, worker, driver] = await Promise.all([
    read("public/driver.html"),
    read("public/driver-service-worker.js"),
    read("public/driver.js")
  ]);
  assert.match(html, /driver\.js\?v=20260819-driver-route-readiness-v1/u);
  assert.match(worker, /DRIVER_CACHE_NAME = `\$\{DRIVER_CACHE_PREFIX\}v38`/u);
  assert.match(worker, /driver\.js\?v=20260819-driver-route-readiness-v1/u);
  assert.match(driver, /serviceWorker\.register\("\/driver-service-worker\.js\?v=20260819-driver-route-readiness-v1"/u);
});

test("S17: the newly added Driver client policy and action slices contain no credential assignments", async () => {
  const driver = await read("public/driver.js");
  const slices = [
    driver.slice(
      driver.indexOf("function driverActionProtectionState"),
      driver.indexOf("function routeProtectedControlAttributes")
    ),
    driver.slice(
      driver.indexOf("function driverCompanyDate"),
      driver.indexOf("function dateTimeText")
    ),
    driver.slice(
      driver.indexOf('if (action === "start-job"'),
      driver.indexOf('if (action === "confirm-truck-switch"', driver.indexOf('if (action === "start-job"'))
    )
  ];
  assert.ok(slices.every(Boolean));
  assert.deepEqual(
    slices.flatMap((source) => scanTextForSecrets(source, "public/driver-plan-date-change.js")),
    []
  );
});
