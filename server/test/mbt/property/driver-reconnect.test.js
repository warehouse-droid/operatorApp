import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import {loadUpload} from "../../support/driver-upload-fixtures.mjs";

const runtime = () => loadUpload({setTimeout: fn => setTimeout(fn, 0)});
test("generated interruptions recover in order without overlapping attempts", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({min: 0, max: 4}), async failures => {
    const upload = runtime();
    let attempts = 0;
    let active = 0;
    const delays = [];
    const result = await upload.reconnect(async () => {
      assert.equal(++active, 1);
      await Promise.resolve();
      active--;
      if (++attempts <= failures) throw Object.assign(new Error("lost"), {isNetworkError: true});
      return "confirmed";
    }, {onRetry: value => delays.push(value.delayMs)});
    assert.equal(result, "confirmed");
    assert.equal(attempts, failures + 1);
    assert.deepEqual(delays, Array.from({length: failures}, (_, index) => Math.min(30000, 1000 * 2 ** index)));
  }), {numRuns: 40, seed: 20261016});
});
test("retry backoff grows from one second and caps at thirty seconds", () => {
  const upload = runtime();
  fc.assert(fc.property(fc.integer({min: 1, max: 1000000}), attempt => {
    assert.equal(upload.reconnectDelay(attempt), attempt >= 6 ? 30000 : 1000 * 2 ** (attempt - 1));
  }), {numRuns: 100, seed: 20261016});
});
test("authentication and validation failures never enter an automatic retry loop", async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom(400, 401, 403, 404, 409, 422), async status => {
    const upload = runtime();
    let calls = 0;
    await assert.rejects(upload.reconnect(async () => {
      if (++calls > 1) throw new Error("unexpected retry");
      throw Object.assign(new Error("rejected"), {status, isNetworkError: true});
    }), error => error.status === status);
    assert.equal(calls, 1);
  }), {numRuns: 30, seed: 20261016});
});
test("an aborted session never starts a retry or a new operation", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), async cancelBefore => {
    const controller = new AbortController();
    let calls = 0;
    if (cancelBefore) controller.abort();
    await assert.rejects(runtime().reconnect(async () => {
      calls++;
      controller.abort();
      throw Object.assign(new Error("lost"), {isNetworkError: true});
    }, {signal: controller.signal}), error => error.code === "driver_upload_cancelled");
    assert.equal(calls, cancelBefore ? 0 : 1);
  }), {numRuns: 20, seed: 20261016});
});
