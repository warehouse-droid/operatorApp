import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { closeDb, query } from "../../../src/db.js";
import { getDriverNextJobContext } from "../../../src/driver-repository.js";
import { materializeMbtDriverBinJob } from "../../../src/mbt/driver-bin-execution-service.js";
import { createAssignedDriverBinFixture } from "../support/driver-bin-fixtures.js";

const authorization = /** @type {Record<string, Function>} */ (await import(
  "../../../src/mbt/driver-bin-authorization.js"
).catch((error) => {
  if (error?.code !== "ERR_MODULE_NOT_FOUND") {throw error;}
  return {};
}));

function operation(name) {
  assert.equal(typeof authorization[name], "function", `P3.9 requires ${name}.`);
  return authorization[name];
}

after(async () => closeDb());

test("P3-F18: every released BIN job requires an exact active driver/date/truck/contract/visit pilot row", async () => {
  const authorize = operation("authorizeMbtDriverBinProjection");
  const assertScope = operation("assertMbtDriverBinProjectionScope");
  const fixture = await createAssignedDriverBinFixture("pilot-scope", { includePilotScope: false });
  const jobs = await Promise.all(fixture.jobs.map((job) => materializeMbtDriverBinJob(job, {
    clientVersion: "2026.08.03.1",
    minimumClientVersion: "2026.08.03.1"
  })));
  const capabilityAuthorizer = async ({ capability, pilotAuthorized }) => {
    assert.equal(capability, "driverExecution");
    if (!pilotAuthorized) {throw Object.assign(new Error("disabled"), { code: "MBT_CAPABILITY_DISABLED" });}
    return { enabled: true };
  };

  await assert.rejects(
    authorize({
      driverLogin: fixture.driverLogin,
      planDate: fixture.planDate,
      capabilityAuthorizer
    }),
    (error) => error?.code === "MBT_CAPABILITY_DISABLED"
  );

  await query(
    `INSERT INTO mbt_driver_pilot_scope (
       pilot_scope_id, plan_date, driver_login, truck_id, contract_id,
       service_visit_id, authorized_by, expires_at
     ) VALUES ($1, $2::date, $3, $4, $5, $6, 'p3-test', now() + interval '30 days')`,
    [crypto.randomUUID(), fixture.planDate, fixture.driverLogin, fixture.binTruckId, fixture.contractId, fixture.frontVisitId]
  );
  const boundary = await authorize({
    driverLogin: fixture.driverLogin,
    planDate: fixture.planDate,
    capabilityAuthorizer
  });
  assert.equal(boundary.pilotAuthorized, true);
  assert.equal(boundary.scopes.length, 1);
  assert.equal(assertScope(jobs, boundary), true);

  assert.throws(
    () => assertScope([{ ...jobs[0], truckId: "999999999" }], boundary),
    (error) => error?.code === "MBT_DRIVER_PILOT_SCOPE_MISMATCH"
  );
  assert.throws(
    () => assertScope([{ ...jobs[0], mbt: { ...jobs[0].mbt, contractId: crypto.randomUUID() } }], boundary),
    (error) => error?.code === "MBT_DRIVER_PILOT_SCOPE_MISMATCH"
  );
});

test("P3-F18: expired or revoked pilot rows never authorize new BIN materialization", async () => {
  const authorize = operation("authorizeMbtDriverBinProjection");
  const fixture = await createAssignedDriverBinFixture("pilot-expired", { includePilotScope: false });
  const scopeId = crypto.randomUUID();
  await query(
    `INSERT INTO mbt_driver_pilot_scope (
       pilot_scope_id, plan_date, driver_login, truck_id, contract_id,
       service_visit_id, active, authorized_by, authorized_at, expires_at,
       revoked_at, revoke_reason
     ) VALUES
       ($1, $2::date, $3, $4, $5, $6, true, 'p3-test', now() - interval '2 days', now() - interval '1 day', NULL, NULL)`,
    [scopeId, fixture.planDate, fixture.driverLogin, fixture.binTruckId, fixture.contractId, fixture.frontVisitId]
  );
  const attempt = () => authorize({
      driverLogin: fixture.driverLogin,
      planDate: fixture.planDate,
      capabilityAuthorizer: async ({ pilotAuthorized }) => {
        if (!pilotAuthorized) {throw Object.assign(new Error("disabled"), { code: "MBT_CAPABILITY_DISABLED" });}
      }
    });
  await assert.rejects(
    attempt(),
    (error) => error?.code === "MBT_CAPABILITY_DISABLED"
  );
  await query(
    `UPDATE mbt_driver_pilot_scope
        SET expires_at = now() + interval '1 day',
            revoked_at = now(), revoke_reason = 'test revoke'
      WHERE pilot_scope_id = $1`,
    [scopeId]
  );
  await assert.rejects(
    attempt(),
    (error) => error?.code === "MBT_CAPABILITY_DISABLED"
  );
});

test("P3-F18: next-job first paint materializes only the actionable BIN stop", async () => {
  const fixture = await createAssignedDriverBinFixture("fast-first-paint");
  const context = await getDriverNextJobContext(fixture.driverLogin, {
    date: fixture.planDate,
    allowBin: true,
    clientVersion: "2026.08.03.1",
    minimumClientVersion: "2026.08.03.1"
  });
  assert.equal(context.job?.mbt?.schemaVersion, "mbt-driver-bin-job-v1");
  assert.equal(context.jobs.length >= 2, true);
  assert.equal(
    context.jobs.some((job) => job.mbt?.schemaVersion === "mbt-driver-bin-job-v1"),
    false,
    "the route list stays raw so /next-job does not materialize the whole day"
  );
});
