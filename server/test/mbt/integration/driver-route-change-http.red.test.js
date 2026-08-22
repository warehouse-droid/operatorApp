import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before } from "node:test";

import { closeDb, query } from "../../../src/db.js";
import {
  createDriverSession,
  persistDriverOfflineDayPlan
} from "../../../src/driver-offline-repository.js";
import { createScmDependencyChangeRequest } from "../../../src/scm-dependency-management-repository.js";
import { app } from "../../../src/server.js";

const suffix = crypto.randomBytes(6).toString("hex");
const driverLogin = `route-http-${suffix}`;
const deviceId = `route-device-${suffix}`;
const manifestId = crypto.randomUUID();
const requestId = crypto.randomUUID();
let planDate = "";
let token = "";
let baseUrl = "";
let server;

function sha(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function http(path, { method = "GET", device = deviceId, body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "x-mbbs-driver-device": device,
      "x-mbbs-driver-version": "2026.08.12.3",
      ...(body === undefined ? {} : { "content-type": "application/json" })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  return { response, text, payload: text ? JSON.parse(text) : null };
}

before(async () => {
  await query(
    "INSERT INTO dispatch_drivers (name, login, active) VALUES ($1, $2, true)",
    [`Route HTTP ${suffix}`, driverLogin]
  );
  const plan = await query(
    `INSERT INTO dispatch_plans (plan_date, status, revision)
     SELECT candidate.day::date, 'confirmed', 4
       FROM generate_series(date '2090-01-01', date '2290-01-01', interval '1 day') AS candidate(day)
      WHERE NOT EXISTS (
        SELECT 1 FROM dispatch_plans existing WHERE existing.plan_date = candidate.day::date
      )
      ORDER BY candidate.day
      LIMIT 1
     RETURNING id, plan_date::text AS plan_date`
  );
  const planId = Number(plan.rows[0].id);
  planDate = plan.rows[0].plan_date;
  await persistDriverOfflineDayPlan({
    manifestId,
    driverLogin,
    deviceId,
    planMetadata: { planId, planDate, planRevision: 4 },
    jobs: [{
      jobId: `route-job-${suffix}`,
      planId,
      planDate,
      driverLogin,
      truckId: "TRUCK-ROUTE-HTTP",
      truckPlate: "TEST-HTTP",
      loadId: "LOAD-1",
      loadName: "HTTP route",
      stopId: "STOP-1",
      stopType: "pickup",
      location: "12441",
      pickupLocation: "12441",
      orderRefs: ["TOB00937"],
      orderTypes: ["TO"],
      lineRowIds: ["1"],
      requiredPhotos: 0
    }],
    driverProfile: { login: driverLogin, name: `Route HTTP ${suffix}` },
    dayState: { planDate, truckPlate: "TEST-HTTP", preDvirStatus: "complete" },
    samsaraWorkflowEnabled: false
  });
  await createScmDependencyChangeRequest({
    requestId,
    payloadHash: sha("route-http-payload"),
    action: "link_to",
    payload: { transferOrderRef: "TOB00937" },
    targetRef: `SOB-${suffix}`,
    targetSignature: sha("route-http-target"),
    planId,
    planDate,
    expectedPlanRevision: 4,
    expectedPlanDigest: sha("route-http-plan"),
    requestedBy: "scm-http-test",
    devices: [{ driverLogin, deviceId, manifestId }]
  });
  token = (await createDriverSession(driverLogin, { deviceId, metadata: { test: true } })).token;
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  await closeDb();
});

test("authenticated presence and readiness stay device-bound and never auto-apply", async () => {
  const wrongDevice = await http("/api/driver/route-presence", {
    method: "POST",
    device: `${deviceId}-wrong`,
    body: { visible: true, manifestId, syncState: "clean" }
  });
  assert.equal(wrongDevice.response.status, 409);
  assert.equal(wrongDevice.payload.code, "DRIVER_SESSION_DEVICE_MISMATCH");

  const hidden = await http("/api/driver/route-presence", {
    method: "POST",
    body: {
      visible: false,
      manifestId,
      syncState: "clean",
      pendingEventCount: 0,
      pendingPhotoCount: 0,
      activeJobId: ""
    }
  });
  assert.equal(hidden.response.status, 200, hidden.text);
  const hiddenAck = await http(`/api/driver/route-change-requests/${requestId}/ready`, {
    method: "POST",
    body: {}
  });
  assert.equal(hiddenAck.response.status, 409);
  assert.equal(hiddenAck.payload.code, "DRIVER_ROUTE_DEVICE_NOT_VISIBLE");

  const visible = await http("/api/driver/route-presence", {
    method: "POST",
    body: {
      visible: true,
      manifestId,
      syncState: "clean",
      pendingEventCount: 0,
      pendingPhotoCount: 0,
      activeJobId: ""
    }
  });
  assert.equal(visible.response.status, 200, visible.text);
  const acknowledged = await http(`/api/driver/route-change-requests/${requestId}/ready`, {
    method: "POST",
    body: {}
  });
  assert.equal(acknowledged.response.status, 200, acknowledged.text);
  assert.equal(acknowledged.payload.routeChanged, false);
  assert.equal(acknowledged.payload.request.status, "driver_ready");
  assert.equal(acknowledged.payload.request.appliedAt, null);

  const receipt = await query(
    "SELECT status FROM scm_dependency_action_receipts WHERE request_id = $1::uuid",
    [requestId]
  );
  assert.equal(receipt.rowCount, 0, "Driver acknowledgement cannot reserve or execute the SCM command.");
});
