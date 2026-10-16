import assert from "node:assert/strict";
import test from "node:test";
import {loadDriverRequest} from "../../support/driver-upload-fixtures.mjs";

test("the API deadline includes a response body that never finishes", async () => {
  let signal;
  const context = loadDriverRequest({fetch: async (_path, options) => {
    signal = options.signal;
    return {ok: true, text: () => new Promise(() => {})};
  }});
  await assert.rejects(context.request("/api/driver/photo-upload-token", {timeoutMs: 10}), error => error.code === "driver_upload_timeout" && error.isNetworkError);
  assert.equal(signal.aborted, true);
});

test("an unreadable successful API response cannot confirm a save", async () => {
  const context = loadDriverRequest({fetch: async () => ({ok: true, status: 200, text: async () => "invalid-json"})});
  await assert.rejects(context.request("/api/driver/jobs/fixture-job/photos"), error => error.code === "driver_request_invalid_response" && error.status === 200);
});

test("API cancellation preserves its cause while successful requests retain authenticated headers", async () => {
  const controller = new AbortController();
  const cancelled = loadDriverRequest({driverRequestController: controller, fetch: () => new Promise(() => {})});
  const pending = cancelled.request("/api/driver/photo-upload-token");
  controller.abort();
  await assert.rejects(pending, error => error.code === "driver_upload_cancelled" && !error.isNetworkError);
  let options;
  const context = loadDriverRequest({authToken: "fixture-only", fetch: async (_path, input) => { // secret-scan: allow -- fixed synthetic token to assert request headers.
    options = input;
    return {ok: true, text: async () => '{"ok":true}'};
  }});
  assert.equal((await context.request("/api/driver/upload-failures", {method: "POST", timeoutMs: 1000})).ok, true);
  assert.equal(options.headers.Authorization, "Bearer fixture-only");
  assert.equal(options.headers["X-MBBS-Driver-Version"], "2026.08.12.3");
  assert.equal(options.headers["X-MBBS-Driver-Device"], "fixture-device");
  assert.equal(options.timeoutMs, undefined);
});
