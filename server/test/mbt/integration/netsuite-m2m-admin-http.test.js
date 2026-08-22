import assert from "node:assert/strict";
import crypto from "node:crypto";
import { unlink } from "node:fs/promises";
import path from "node:path";
import test, { after, before } from "node:test";

import { createOperator } from "../../../src/auth-repository.js";
import { config } from "../../../src/config.js";
import { closeDb, query } from "../../../src/db.js";
import { app } from "../../../src/server.js";

const RUN_ID = crypto.randomUUID().replaceAll("-", "");
const LOGIN_PASSWORD = "p3-m2m-http-test-password";
const RECOVERY_PASSPHRASE = "M2M encrypted recovery test 2026";
const USERS = Object.freeze({
  admin: `m2m-admin-${RUN_ID}`,
  dispatcher: `m2m-dispatcher-${RUN_ID}`
});

let baseUrl = "";
let server;
const tokens = new Map();
const operatorIds = new Map();

function assertDisposableCredentialPath(filePath) {
  assert.equal(process.env.MBT_TEST_ISOLATED, "1");
  assert.equal(path.dirname(path.resolve(filePath)), "/app/data");
}

async function removeRuntimeCredentialFiles() {
  for (const filePath of [config.netsuite.m2mSettingsPath, config.netsuite.m2mMasterKeyPath]) {
    assertDisposableCredentialPath(filePath);
    await unlink(filePath).catch((error) => {
      if (error?.code !== "ENOENT") {throw error;}
    });
  }
}

async function request(urlPath, { token = "", method = "GET", body } = {}) {
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error"
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  return { response, payload, text };
}

async function login(username) {
  const result = await request("/api/auth/login", {
    method: "POST",
    body: { username, password: LOGIN_PASSWORD }
  });
  assert.equal(result.response.status, 200, result.text);
  return result.payload.token;
}

before(async () => {
  await removeRuntimeCredentialFiles();
  for (const [role, username] of Object.entries(USERS)) {
    const created = await createOperator({
      username,
      displayName: username,
      password: LOGIN_PASSWORD,
      role,
      roles: [role]
    });
    operatorIds.set(role, created.id);
  }
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  for (const [role, username] of Object.entries(USERS)) {
    tokens.set(role, await login(username));
  }
});

after(async () => {
  if (server) {await new Promise((resolve) => server.close(resolve));}
  await closeDb();
  await removeRuntimeCredentialFiles();
});

test("M2M-H1: credential administration is admin-only, non-cacheable, and status never exposes credential material", async () => {
  const anonymous = await request("/api/admin/netsuite-m2m");
  assert.equal(anonymous.response.status, 401);

  const denied = await request("/api/admin/netsuite-m2m", { token: tokens.get("dispatcher") });
  assert.equal(denied.response.status, 403);
  assert.equal(denied.payload.error, "Admin account required");

  const allowed = await request("/api/admin/netsuite-m2m", { token: tokens.get("admin") });
  assert.equal(allowed.response.status, 200, allowed.text);
  assert.match(allowed.response.headers.get("cache-control") || "", /no-store/u);
  assert.equal(allowed.payload.authMode, "authorization_code");
  assert.equal(allowed.payload.configured, false);
  assert.equal(allowed.payload.pendingApprovalReconciliationRunning, false);
  assert.doesNotMatch(
    allowed.text,
    /BEGIN (?:ENCRYPTED )?PRIVATE KEY|ciphertext|recoveryPassphrase|clientSecret|accessToken/i
  );
});

test("M2M-H2: certificate generation delivers one encrypted recovery backup and only the public certificate remains downloadable", async () => {
  const generated = await request("/api/admin/netsuite-m2m/certificates", {
    token: tokens.get("admin"),
    method: "POST",
    body: {
      commonName: "MBBS NetSuite M2M HTTP test",
      recoveryPassphrase: RECOVERY_PASSPHRASE
    }
  });
  assert.equal(generated.response.status, 201, generated.text);
  assert.match(generated.response.headers.get("cache-control") || "", /no-store/u);
  assert.match(generated.payload.publicCertificatePem, /BEGIN CERTIFICATE/u);
  assert.match(generated.payload.recoveryPrivateKeyPem, /BEGIN ENCRYPTED PRIVATE KEY/u);
  assert.doesNotMatch(generated.text, new RegExp(RECOVERY_PASSPHRASE, "u"));

  const publicDownload = await request("/api/admin/netsuite-m2m/certificates/staged/public", {
    token: tokens.get("admin")
  });
  assert.equal(publicDownload.response.status, 200, publicDownload.text);
  assert.match(publicDownload.response.headers.get("cache-control") || "", /no-store/u);
  assert.match(publicDownload.response.headers.get("content-disposition") || "", /attachment/u);
  assert.match(publicDownload.text, /BEGIN CERTIFICATE/u);
  assert.doesNotMatch(publicDownload.text, /PRIVATE KEY/u);

  for (const guessedPath of [
    "/api/admin/netsuite-m2m/certificates/staged/private",
    "/api/admin/netsuite-m2m/certificates/staged/recovery"
  ]) {
    const unavailable = await request(guessedPath, { token: tokens.get("admin") });
    assert.equal(unavailable.response.status, 404);
    assert.doesNotMatch(unavailable.text, /BEGIN (?:ENCRYPTED )?PRIVATE KEY/u);
  }

  const status = await request("/api/admin/netsuite-m2m", { token: tokens.get("admin") });
  assert.equal(status.response.status, 200, status.text);
  assert.ok(status.payload.staged?.fingerprint256);
  assert.doesNotMatch(status.text, /PRIVATE KEY|ciphertext|recoveryPassphrase/i);

  const audit = await query(
    `SELECT details::text AS details
       FROM delivery_audit_log
      WHERE action = 'netsuite.m2m.certificate_staged'
        AND actor_operator_id = $1
      ORDER BY id DESC
      LIMIT 1`,
    [operatorIds.get("admin")]
  );
  assert.equal(audit.rowCount, 1);
  assert.doesNotMatch(audit.rows[0].details, /PRIVATE KEY|ciphertext|passphrase|recovery key/i);
});

test("M2M-H3: invalid activation is atomic and browser OAuth fallback retains the staged setup", async () => {
  const invalid = await request("/api/admin/netsuite-m2m/activate", {
    token: tokens.get("admin"),
    method: "POST",
    body: { clientId: "", certificateId: "", scopes: ["rest_webservices"] }
  });
  assert.equal(invalid.response.status, 400, invalid.text);

  const afterFailure = await request("/api/admin/netsuite-m2m", { token: tokens.get("admin") });
  assert.equal(afterFailure.response.status, 200, afterFailure.text);
  assert.equal(afterFailure.payload.authMode, "authorization_code");
  assert.equal(afterFailure.payload.active, null);
  assert.ok(afterFailure.payload.staged?.fingerprint256);

  const fallback = await request("/api/admin/netsuite-m2m/fallback", {
    token: tokens.get("admin"),
    method: "POST",
    body: {}
  });
  assert.equal(fallback.response.status, 200, fallback.text);
  assert.equal(fallback.payload.authMode, "authorization_code");
  assert.ok(fallback.payload.staged?.fingerprint256);
});
