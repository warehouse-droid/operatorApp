import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  DRIVER_YARD_DEPENDENCY_SOFT_MODE_FLAG_KEY,
  evaluateDriverYardDependencyCompletion,
  evaluateDriverYardDependencyStart,
  getDriverYardDependencyMode
} from "../../../src/driver-yard-dependency-mode.js";

const serverSource = fs.readFileSync(new URL("../../../src/server.js", import.meta.url), "utf8");
const dependencySource = fs.readFileSync(
  new URL("../../../src/order-dependency-repository.js", import.meta.url),
  "utf8"
);
const driverSource = fs.readFileSync(new URL("../../../public/driver.js", import.meta.url), "utf8");
const catalogSource = fs.readFileSync(
  new URL("../../../src/mbt/feature-gate-catalog.js", import.meta.url),
  "utf8"
);
const migrationUrl = new URL(
  "../../../migrations/140_driver_yard_dependency_soft_mode.sql",
  import.meta.url
);

const yardBlock = Object.freeze({
  code: "DEPENDENT_TRANSFER_NOT_RECEIVED",
  salesOrderRef: "SOB-TEST",
  transferOrderRef: "TOB-TEST",
  message: "SOB-TEST is waiting for TOB-TEST to be received before delivery can start."
});

test("Driver yard-dependency setting fails closed to Hard and recognizes only an enabled database row", async () => {
  assert.equal(
    DRIVER_YARD_DEPENDENCY_SOFT_MODE_FLAG_KEY,
    "driver_yard_dependency_soft_mode"
  );
  assert.deepEqual(
    await getDriverYardDependencyMode({
      queryFn: async () => ({ rowCount: 0, rows: [] })
    }),
    { mode: "hard", soft: false, revision: null, updatedAt: null }
  );
  assert.deepEqual(
    await getDriverYardDependencyMode({
      queryFn: async () => ({
        rowCount: 1,
        rows: [{ enabled: true, revision: "8", updated_at: "2026-08-08T10:00:00.000Z" }]
      })
    }),
    {
      mode: "soft",
      soft: true,
      revision: 8,
      updatedAt: "2026-08-08T10:00:00.000Z"
    }
  );
  assert.equal((await getDriverYardDependencyMode({
    queryFn: async () => ({
      rowCount: 1,
      rows: [{ enabled: "true", revision: 9, updated_at: null }]
    })
  })).mode, "hard", "Non-boolean database values must fail closed.");
});

test("ordinary yard dependency blocks in Hard mode and becomes an explicit warning in Soft mode", () => {
  assert.deepEqual(
    evaluateDriverYardDependencyStart({ block: yardBlock, softMode: false }),
    { mode: "hard", blocking: yardBlock, warnings: [] }
  );
  const softened = evaluateDriverYardDependencyStart({ block: yardBlock, softMode: true });
  assert.equal(softened.mode, "soft");
  assert.equal(softened.blocking, null);
  assert.equal(softened.warnings.length, 1);
  assert.deepEqual(
    {
      code: softened.warnings[0].code,
      salesOrderRef: softened.warnings[0].salesOrderRef,
      transferOrderRef: softened.warnings[0].transferOrderRef,
      severity: softened.warnings[0].severity,
      softened: softened.warnings[0].softened
    },
    {
      code: "DEPENDENT_TRANSFER_NOT_RECEIVED",
      salesOrderRef: "SOB-TEST",
      transferOrderRef: "TOB-TEST",
      severity: "warning",
      softened: true
    }
  );
  assert.match(softened.warnings[0].message, /Soft testing mode/u);
  assert.deepEqual(
    evaluateDriverYardDependencyStart({ block: null, softMode: true }),
    { mode: "soft", blocking: null, warnings: [] }
  );
});

test("ordinary TO-drop dependency review blocks completion in Hard mode and warns in Soft mode", () => {
  const conflicts = [{ transferOrderRef: "TOB-TEST", reason: "dependency_plan_mismatch" }];
  assert.deepEqual(
    evaluateDriverYardDependencyCompletion({ conflicts, softMode: false }),
    { mode: "hard", blocking: conflicts, warnings: [] }
  );
  const softened = evaluateDriverYardDependencyCompletion({ conflicts, softMode: true });
  assert.equal(softened.mode, "soft");
  assert.deepEqual(softened.blocking, []);
  assert.equal(softened.warnings.length, 1);
  assert.equal(softened.warnings[0].code, "YARD_DEPENDENCY_DELIVERY_REVIEW_REQUIRED");
  assert.equal(softened.warnings[0].transferOrderRef, "TOB-TEST");
  assert.equal(softened.warnings[0].reason, "dependency_plan_mismatch");
  assert.equal(softened.warnings[0].softened, true);
  assert.match(softened.warnings[0].message, /Soft testing mode/u);
});

test("the audited Admin setting exists while Dispatch and direct-linked Driver rules remain hard", () => {
  assert.equal(fs.existsSync(migrationUrl), true, "The default-Hard setting migration is missing.");
  const migrationSource = fs.readFileSync(migrationUrl, "utf8");
  assert.match(migrationSource, /'driver_yard_dependency_soft_mode'\s*,\s*false/u);
  assert.match(
    catalogSource,
    /flagKey:\s*"driver_yard_dependency_soft_mode"[\s\S]{0,500}independent:\s*true/u
  );

  const offlineStart = serverSource.slice(
    serverSource.indexOf("async function applyDriverOfflineEvent"),
    serverSource.indexOf('if (event.eventType === "job_completed")', serverSource.indexOf("async function applyDriverOfflineEvent"))
  );
  const onlineStart = serverSource.match(
    /app\.post\("\/api\/driver\/jobs\/:jobId\/start"[\s\S]*?\n\}\);/u
  )?.[0] || "";
  assert.match(offlineStart, /evaluateDriverYardDependencyStart/u);
  assert.match(onlineStart, /evaluateDriverYardDependencyStart/u);
  assert.match(offlineStart, /getDirectPickupDependencyExecutionBlock/u);
  assert.match(onlineStart, /getDirectPickupDependencyExecutionBlock/u);

  const completionEffects = serverSource.slice(
    serverSource.indexOf("async function completeDriverJobOperationalEffects"),
    serverSource.indexOf("async function authorizedDriverDayJobs")
  );
  assert.match(completionEffects, /evaluateDriverYardDependencyCompletion/u);
  assert.match(completionEffects, /completeDirectDependenciesForSalesOrderDrop/u);

  const dispatchValidation = dependencySource.slice(
    dependencySource.indexOf("export async function validateDispatchPlanDependencies"),
    dependencySource.indexOf("export async function syncOrderDependenciesFromDispatchPlan")
  );
  assert.ok(dispatchValidation, "Dispatch dependency validation must remain present.");
  assert.doesNotMatch(dispatchValidation, /driver_yard_dependency_soft_mode|softMode/u);

  assert.match(driverSource, /function renderDriverDependencyWarnings/u);
  assert.match(driverSource, /dependencyWarnings/u);
});

test("automatic next-stop start applies the same yard policy and keeps direct pickup hard", () => {
  const completionRoute = serverSource.match(
    /app\.post\("\/api\/driver\/jobs\/:jobId\/photos"[\s\S]*?\n\}\);/u
  )?.[0] || "";
  const autoStartBranch = completionRoute.slice(
    completionRoute.indexOf("else if (nextJob"),
    completionRoute.indexOf("emitAppEvent(\"driver.job.completed\"")
  );
  assert.ok(autoStartBranch, "The ordinary auto-start-next branch must remain present.");
  assert.match(autoStartBranch, /evaluateDriverYardDependencyStart/u);
  assert.match(autoStartBranch, /getDirectPickupDependencyExecutionBlock/u);
  assert.ok(
    autoStartBranch.indexOf("evaluateDriverYardDependencyStart")
      < autoStartBranch.indexOf("startDriverJob"),
    "Dependency policy must run before the automatic start."
  );
  assert.ok(
    autoStartBranch.indexOf("getDirectPickupDependencyExecutionBlock")
      < autoStartBranch.indexOf("startDriverJob"),
    "Direct pickup must be checked before the automatic start."
  );
});
