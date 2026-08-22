import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import {
  createDriverSession,
  getDriverSession
} from "../../../src/driver-offline-repository.js";
import { app } from "../../../src/server.js";

let baseUrl;
let server;

async function request(path, { method = "GET", headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${path}`, { method, headers, redirect: "manual" });
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json")
    ? await response.json()
    : await response.text();
  return { response, payload };
}

before(async () => {
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
});

test("the standalone reset page is always network-only and cannot be framed", async () => {
  const result = await request("/reset-driver");
  assert.equal(result.response.status, 200);
  assert.match(result.response.headers.get("cache-control") || "", /no-store/u);
  assert.equal(result.response.headers.get("x-frame-options"), "DENY");
  assert.match(result.response.headers.get("content-security-policy") || "", /frame-ancestors 'none'/u);
  assert.match(result.payload, /Hard reset this Driver site/u);
  assert.match(result.payload, /Erase site data and open fresh login/u);
  assert.equal(result.response.headers.get("clear-site-data"), null, "Viewing the warning page must not clear anything.");
});

test("site-data deletion requires the explicit recovery-page header and rejects cross-site requests", async () => {
  const unconfirmed = await request("/api/driver/site-reset", { method: "POST" });
  assert.equal(unconfirmed.response.status, 400);
  assert.equal(unconfirmed.payload.code, "DRIVER_SITE_RESET_CONFIRMATION_REQUIRED");
  assert.equal(unconfirmed.response.headers.get("clear-site-data"), null);

  const crossSite = await request("/api/driver/site-reset", {
    method: "POST",
    headers: {
      "x-mbbs-driver-site-reset": "confirm",
      "sec-fetch-site": "cross-site"
    }
  });
  assert.equal(crossSite.response.status, 403);
  assert.equal(crossSite.payload.code, "DRIVER_SITE_RESET_CROSS_SITE_BLOCKED");
  assert.equal(crossSite.response.headers.get("clear-site-data"), null);
});

test("a confirmed same-origin reset returns the complete browser clearing policy and a fresh Driver URL", async () => {
  const sessionResult = await createDriverSession("driver-site-reset-http-test", {
    deviceId: "driver-site-reset-device",
    metadata: { test: true }
  });
  assert.ok(await getDriverSession(sessionResult.token, { touch: false }));

  const result = await request("/api/driver/site-reset", {
    method: "POST",
    headers: {
      authorization: `Bearer ${sessionResult.token}`,
      "x-mbbs-driver-device": "driver-site-reset-device",
      "x-mbbs-driver-site-reset": "confirm",
      "sec-fetch-site": "same-origin"
    }
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.equal(result.response.headers.get("clear-site-data"), '"cache", "cookies", "storage"');
  assert.match(result.response.headers.get("cache-control") || "", /no-store/u);
  assert.equal(result.payload.ok, true);
  assert.equal(result.payload.currentVersion, "2026.08.12.3");
  assert.match(result.payload.redirect, /^\/driver\?site-reset=[0-9a-f-]+$/u);
  assert.equal(
    await getDriverSession(sessionResult.token, { touch: false }),
    null,
    "The reset must revoke the live server session before local credentials disappear."
  );
});
