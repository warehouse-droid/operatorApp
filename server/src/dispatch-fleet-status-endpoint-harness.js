import assert from "node:assert/strict";
import { app } from "./server.js";
import { closeDb, query } from "./db.js";
import { createOperator, loginOperator } from "./auth-repository.js";
import { replaceDispatchFleetSetup } from "./dispatch-setup-repository.js";
import { createDispatchPlan, getDispatchPlan, saveDispatchPlanSnapshot } from "./dispatch-plan-repository.js";

const suffix = Date.now().toString(36);
const testYear = 2200 + (Date.now() % 7000);
const legacyPlanDate = `${testYear}-12-28`;
const racePlanDate = `${testYear}-12-29`;
const endpointPlanDate = `${testYear}-12-30`;
const dispatcherUsername = `fleet-dispatcher-${suffix}`;
const salesUsername = `fleet-sales-${suffix}`;
const password = "fleet-test-password";
const driverLogin = `fleet-driver-${suffix}`;
const truckPlate = `FLEET-${suffix}`.toUpperCase();
const raceDriverLogin = `fleet-race-driver-${suffix}`;
const raceTruckPlate = `RACE-${suffix}`.toUpperCase();
let server;

async function cleanupFleetFixtures() {
  const planResult = await query(
    `SELECT id
       FROM dispatch_plans
      WHERE plan_date = ANY($1::date[])
        AND note IN ($2, $3, $4)`,
    [
      [legacyPlanDate, racePlanDate, endpointPlanDate],
      `legacy driver rename guard ${suffix}`,
      `fleet endpoint harness ${suffix}`,
      `fleet lock race harness ${suffix}`
    ]
  );
  const planIds = planResult.rows.map((row) => Number(row.id)).filter(Number.isInteger);
  if (planIds.length) {
    await query("DELETE FROM dispatch_audit_log WHERE plan_id = ANY($1::bigint[])", [planIds]);
    await query("DELETE FROM dispatch_plans WHERE id = ANY($1::bigint[])", [planIds]);
  }
  const driverResult = await query(
    "SELECT id::text FROM dispatch_drivers WHERE login = ANY($1::text[])",
    [[driverLogin, raceDriverLogin]]
  );
  const truckResult = await query(
    "SELECT id::text FROM dispatch_trucks WHERE upper(btrim(plate)) = ANY($1::text[])",
    [[truckPlate, raceTruckPlate]]
  );
  const driverEntityIds = driverResult.rows.map((row) => row.id);
  const truckEntityIds = truckResult.rows.map((row) => row.id);
  if (driverEntityIds.length) {
    await query("DELETE FROM dispatch_audit_log WHERE entity_type = 'dispatch_driver' AND entity_id = ANY($1::text[])", [driverEntityIds]);
  }
  if (truckEntityIds.length) {
    await query("DELETE FROM dispatch_audit_log WHERE entity_type = 'dispatch_truck' AND entity_id = ANY($1::text[])", [truckEntityIds]);
  }
  await query("DELETE FROM dispatch_drivers WHERE login = ANY($1::text[])", [[driverLogin, raceDriverLogin]]);
  await query("DELETE FROM dispatch_trucks WHERE upper(btrim(plate)) = ANY($1::text[])", [[truckPlate, raceTruckPlate]]);
  await query("DELETE FROM operators WHERE username = ANY($1::text[])", [[dispatcherUsername, salesUsername]]);
}

async function request(baseUrl, path, { token = "", method = "GET", body = undefined } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, payload };
}

try {
  await createOperator({ username: dispatcherUsername, displayName: "Fleet Dispatcher", password, role: "dispatcher" });
  await createOperator({ username: salesUsername, displayName: "Fleet Sales", password, role: "sales" });
  const dispatcher = await loginOperator(dispatcherUsername, password);
  const sales = await loginOperator(salesUsername, password);
  const fleet = await replaceDispatchFleetSetup({
    drivers: [
      { name: "Fleet Endpoint Driver", login: driverLogin, license: "AZ", number: "ENDPOINT", active: true },
      { name: "Fleet Race Driver", login: raceDriverLogin, license: "AZ", number: "RACE", active: true }
    ],
    trucks: [
      { plate: truckPlate, capacityLbs: 48000, active: true },
      { plate: raceTruckPlate, capacityLbs: 48000, active: true }
    ]
  }, { activeOnly: false, deactivateMissing: false });
  const driver = fleet.drivers.find((item) => item.login === driverLogin);
  const truck = fleet.trucks.find((item) => item.plate === truckPlate);
  const raceDriver = fleet.drivers.find((item) => item.login === raceDriverLogin);
  const raceTruck = fleet.trucks.find((item) => item.plate === raceTruckPlate);
  assert(driver && truck && raceDriver && raceTruck);

  server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  let result = await request(baseUrl, "/api/dispatch/setup?includeInactive=true", { token: sales.token });
  assert.equal(result.status, 403, "Sales user accessed inactive fleet management.");
  result = await request(baseUrl, "/api/dispatch/setup?includeInactive=true", { token: dispatcher.token });
  assert.equal(result.status, 200);
  assert(result.payload.drivers.some((item) => item.id === driver.id && item.active === true));

  const driverLoginResult = await request(baseUrl, "/api/driver/login", {
    method: "POST",
    body: { username: driverLogin, password: "" }
  });
  assert.equal(driverLoginResult.status, 200, "Active driver could not sign in.");

  result = await request(baseUrl, `/api/dispatch/setup/drivers/${driver.id}/active`, {
    token: dispatcher.token,
    method: "PATCH",
    body: { active: false }
  });
  assert.equal(result.status, 200);
  assert.equal(result.payload.driver.active, false);
  const revoked = await request(baseUrl, "/api/driver/me", { token: driverLoginResult.payload.token });
  assert.equal(revoked.status, 401, "Disabled driver's existing session was not revoked.");

  const activeSetup = await request(baseUrl, "/api/dispatch/setup", { token: dispatcher.token });
  assert.equal(activeSetup.status, 200);
  assert(!activeSetup.payload.drivers.some((item) => item.id === driver.id), "Disabled driver leaked into planner setup.");
  const managementSetup = await request(baseUrl, "/api/dispatch/setup?includeInactive=true", { token: dispatcher.token });
  assert(managementSetup.payload.drivers.some((item) => item.id === driver.id && item.active === false), "Disabled driver disappeared from setup management.");

  const bulkBody = { ...managementSetup.payload };
  bulkBody.drivers = bulkBody.drivers.map((item) => item.id === driver.id ? { ...item, active: true } : item);
  result = await request(baseUrl, "/api/dispatch/setup", {
    token: dispatcher.token,
    method: "PUT",
    body: bulkBody
  });
  assert.equal(result.status, 200);
  assert.equal(result.payload.drivers.find((item) => item.id === driver.id)?.active, false, "Bulk setup bypassed the targeted enable endpoint.");

  result = await request(baseUrl, `/api/dispatch/setup/drivers/${driver.id}/active`, {
    token: dispatcher.token,
    method: "PATCH",
    body: { active: true }
  });
  assert.equal(result.status, 200);
  const legacyPlan = await createDispatchPlan({ planDate: legacyPlanDate, note: `legacy driver rename guard ${suffix}` });
  await query(
    `UPDATE dispatch_plan_snapshots
        SET trucks = $2::jsonb, saved_at = now()
      WHERE plan_id = $1`,
    [legacyPlan.id, JSON.stringify([{
      id: truck.id,
      plate: truck.plate,
      driver: driver.name,
      loads: [{
        id: "FLEET-LEGACY-NAME",
        name: "Fleet legacy name load",
        driver: driver.name,
        orders: ["SO-LEGACY-NAME"]
      }]
    }])]
  );
  const renameSetup = await request(baseUrl, "/api/dispatch/setup?includeInactive=true", { token: dispatcher.token });
  const renameBody = {
    ...renameSetup.payload,
    drivers: renameSetup.payload.drivers.map((item) => item.id === driver.id
      ? { ...item, name: "Fleet Endpoint Driver Renamed" }
      : item)
  };
  result = await request(baseUrl, "/api/dispatch/setup", {
    token: dispatcher.token,
    method: "PUT",
    body: renameBody
  });
  assert.equal(result.status, 409, "Legacy name-only assignment was orphaned by a driver rename.");
  assert.equal(result.payload.code, "DISPATCH_DRIVER_LEGACY_NAME_IN_USE");
  result = await request(baseUrl, `/api/dispatch/setup/trucks/${truck.id}/active`, {
    token: dispatcher.token,
    method: "PATCH",
    body: { active: "false" }
  });
  assert.equal(result.status, 400, "Non-boolean active status was accepted.");
  result = await request(baseUrl, "/api/dispatch/setup/trucks/999999999/active", {
    token: dispatcher.token,
    method: "PATCH",
    body: { active: false }
  });
  assert.equal(result.status, 404, "Unknown truck did not return 404.");

  const planDate = endpointPlanDate;
  const plan = await createDispatchPlan({ planDate, note: `fleet endpoint harness ${suffix}` });
  await saveDispatchPlanSnapshot(plan.id, {
    planDate,
    baseRevision: plan.revision,
    orders: [],
    trucks: [{
      id: truck.id,
      plate: truck.plate,
      driverLogin: driver.login,
      loads: [{
        id: "FLEET-ENDPOINT-LOAD",
        name: "Fleet endpoint load",
        returnOnly: true,
        driverLogin: driver.login,
        truckId: truck.id,
        truckPlate: truck.plate,
        stops: []
      }]
    }]
  });
  result = await request(baseUrl, `/api/dispatch/setup/trucks/${truck.id}/active`, {
    token: dispatcher.token,
    method: "PATCH",
    body: { active: false }
  });
  assert.equal(result.status, 409, "Assigned future truck was disabled.");
  assert.equal(result.payload.code, "DISPATCH_FLEET_IN_USE");
  assert(result.payload.conflicts.some((conflict) => conflict.loadId === "FLEET-ENDPOINT-LOAD"));

  const racePlan = await createDispatchPlan({ planDate: racePlanDate, note: `fleet lock race harness ${suffix}` });
  const raceSave = saveDispatchPlanSnapshot(racePlan.id, {
    planDate: racePlanDate,
    baseRevision: racePlan.revision,
    orders: [],
    trucks: [{
      id: raceTruck.id,
      plate: raceTruck.plate,
      driverLogin: raceDriver.login,
      loads: [{
        id: "FLEET-RACE-LOAD",
        name: "Fleet race load",
        returnOnly: true,
        driverLogin: raceDriver.login,
        truckId: raceTruck.id,
        truckPlate: raceTruck.plate,
        stops: []
      }]
    }]
  });
  const raceDisable = request(baseUrl, `/api/dispatch/setup/trucks/${raceTruck.id}/active`, {
    token: dispatcher.token,
    method: "PATCH",
    body: { active: false }
  });
  const [raceSaveResult, raceDisableResult] = await Promise.allSettled([raceSave, raceDisable]);
  const racePlanAfter = await getDispatchPlan(racePlan.id);
  const raceManagement = await request(baseUrl, "/api/dispatch/setup?includeInactive=true", { token: dispatcher.token });
  const raceTruckAfter = raceManagement.payload.trucks.find((item) => item.id === raceTruck.id);
  const raceAssignmentSaved = (racePlanAfter.trucks || []).some((parentTruck) =>
    (parentTruck.loads || []).some((load) => load.id === "FLEET-RACE-LOAD")
  );
  assert(!(raceTruckAfter?.active === false && raceAssignmentSaved), "Concurrent plan save left a disabled truck assigned.");
  if (raceDisableResult.status === "fulfilled" && raceDisableResult.value.status === 200) {
    assert.equal(raceSaveResult.status, "rejected", "Plan save did not reject after the truck won the disable race.");
    assert.equal(raceSaveResult.reason?.code, "DISPATCH_TRUCK_DISABLED");
  } else {
    assert.equal(raceSaveResult.status, "fulfilled", "Plan save failed without the truck being disabled first.");
    assert.equal(raceDisableResult.status, "fulfilled");
    assert.equal(raceDisableResult.value.status, 409, "Disable did not report the concurrently saved assignment.");
  }

  const audit = await query(
    `SELECT action
       FROM dispatch_audit_log
      WHERE entity_id = $1
        AND action IN ('dispatch_driver_disabled', 'dispatch_driver_enabled')
      ORDER BY id`,
    [driver.id]
  );
  assert.deepEqual(audit.rows.map((row) => row.action), ["dispatch_driver_disabled", "dispatch_driver_enabled"]);

  console.log(JSON.stringify({
    ok: true,
    tests: 18,
    roleProtection: true,
    targetedDisableEnable: true,
    sessionRevocation: true,
    bulkStatusNeutrality: true,
    legacyDriverRenameProtection: true,
    activePlanProtection: true,
    concurrentMutationInvariant: true,
    auditTrail: true
  }));
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  await cleanupFleetFixtures();
  await closeDb();
}
