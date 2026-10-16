import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {failure} from "../../support/driver-upload-fixtures.mjs";

assert.equal(process.env.MBT_TEST_ISOLATED, "1", "Upload logging integration requires the isolated test environment");
assert.match(process.env.DATABASE_URL || "", /\/mbt_test(?:_file_[a-f0-9]{12}_[a-z0-9]+)?(?:\?|$)/u);
const {query, closeDb} = await import("../../../src/db.js");
const {createDriverSession} = await import("../../../src/driver-offline-repository.js");
const {recordDriverUploadFailure} = await import("../../../src/driver-upload-failure-repository.js");
const {app} = await import("../../../src/server.js");
let server;
let base;
let session;
const deviceId = crypto.randomUUID();
const login = `upload-test-${crypto.randomUUID().slice(0, 8)}`;

test.before(async () => {
  await query("INSERT INTO dispatch_drivers (name, login, active, samsara_enabled) VALUES ($1, $2, true, false)", ["Upload fixture", login]);
  session = await createDriverSession(login, {deviceId});
  server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await closeDb();
});

function report(body, {authorized = true, device = deviceId, version = "2026.08.12.3"} = {}) {
  return fetch(`${base}/api/driver/upload-failures`, {
    method: "POST", headers: {"content-type": "application/json",
      "x-mbbs-driver-device": device, "x-mbbs-driver-version": version,
      ...(authorized ? {authorization: `Bearer ${session.token}`} : {})}, body: JSON.stringify(body)
  });
}

test("a failure is retained in the audit log under its authenticated identity", async () => {
  const body = failure({failureId: crypto.randomUUID(), driverLogin: "spoof", deviceId: "spoof", message: "Bearer private-credential data:image/jpeg;base64,private-image"});
  const response = await report(body);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).recorded, true);
  const rows = await query("SELECT details FROM delivery_audit_log WHERE action = 'driver.photo_upload.failed' AND details->>'failureId' = $1", [body.failureId]);
  assert.equal(rows.rowCount, 1);
  const details = rows.rows[0].details;
  assert.equal(details.driverLogin, login);
  assert.equal(details.deviceId, deviceId);
  assert.equal(details.stage, "uploading");
  assert.equal(details.percentage, 50);
  assert.equal(details.httpStatus, 503);
  assert.doesNotMatch(details.message, /private-credential|private-image/u);
  await query("UPDATE driver_sessions SET metadata = jsonb_set(metadata, '{offlineSync}', '{\"state\":\"ok\"}'::jsonb) WHERE session_id = $1", [session.session.sessionId]);
  assert.equal((await query("SELECT count(*)::int AS count FROM delivery_audit_log WHERE details->>'failureId' = $1", [body.failureId])).rows[0].count, 1);
});

test("concurrent diagnostic retries retain exactly one immutable audit entry", async () => {
  const body = failure({failureId: crypto.randomUUID()});
  const responses = await Promise.all(Array.from({length: 8}, () => report(body)));
  assert.ok(responses.every(response => response.status === 200));
  assert.equal((await Promise.all(responses.map(response => response.json()))).filter(result => result.recorded).length, 1);
  const retried = await report({...body, message: "Changed retry"});
  assert.equal((await retried.json()).recorded, false);
  const rows = await query("SELECT details FROM delivery_audit_log WHERE details->>'failureId' = $1", [body.failureId]);
  assert.equal(rows.rowCount, 1);
  assert.equal(rows.rows[0].details.message, "Storage unavailable");
});

test("recovery outcomes preserve correlated step and suspension diagnostics exactly once", async () => {
  const recoveryId = crypto.randomUUID();
  const body = failure({failureId: crypto.randomUUID(), outcome: "recovered", recoveryId, requestId: crypto.randomUUID(),
    browserOnline: false, visibilityState: "hidden", timeoutMs: 4000, timerDelayMs: 7000});
  const responses = await Promise.all([report(body), report(body)]);
  assert.ok(responses.every(response => response.status === 200));
  const rows = await query("SELECT action,details FROM delivery_audit_log WHERE details->>'failureId'=$1", [body.failureId]);
  assert.equal(rows.rowCount, 1);
  assert.equal(rows.rows[0].action, "driver.photo_upload.recovered");
  for (const key of ["outcome", "recoveryId", "requestId", "browserOnline", "visibilityState", "timeoutMs", "timerDelayMs"]) {
    assert.equal(rows.rows[0].details[key], body[key]);
  }
});

test("authentication, device scope, malformed diagnostics and body size fail closed", async () => {
  assert.equal((await report(failure(), {authorized: false})).status, 401);
  assert.equal((await report(failure(), {device: crypto.randomUUID()})).status, 401);
  assert.equal((await report(failure({stage: "unrecognized"}))).status, 400);
  assert.equal((await report(failure({message: "x".repeat(20000)}))).status, 413);
  assert.equal((await query("SELECT count(*)::int AS count FROM delivery_audit_log WHERE details->>'failureId' = $1", [failure().failureId])).rows[0].count, 0);
});

test("diagnostic metadata and the authoritative version header cannot retain credentials", async () => {
  const body = failure({failureId: crypto.randomUUID(), jobId: "Bearer synthetic-private-value", errorCode: "data:image/jpeg;base64,synthetic-image"});
  const response = await report(body, {version: "Bearer synthetic-header-value"});
  assert.equal(response.status, 200);
  const rows = await query("SELECT details FROM delivery_audit_log WHERE details->>'failureId' = $1", [body.failureId]);
  assert.equal(rows.rowCount, 1);
  assert.doesNotMatch(JSON.stringify(rows.rows[0].details), /synthetic-private-value|synthetic-image|synthetic-header-value/u);
});

test("a session revoked after authentication cannot persist a diagnostic", async () => {
  const revoked = await createDriverSession(login, {deviceId});
  await query("UPDATE driver_sessions SET revoked_at = now() WHERE session_id = $1", [revoked.session.sessionId]);
  const body = failure({failureId: crypto.randomUUID()});
  await assert.rejects(recordDriverUploadFailure({sessionId: revoked.session.sessionId, driverLogin: login, deviceId, failure: body,
    clientVersion: "2026.08.12.3"}), error => error.status === 401);
  assert.equal((await query("SELECT count(*)::int AS count FROM delivery_audit_log WHERE details->>'failureId' = $1", [body.failureId])).rows[0].count, 0);
});
