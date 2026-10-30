import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import {waitingUpload, flushUploadTasks} from "../../support/driver-upload-wait-fixture.mjs";

const options = {numRuns: 40, seed: 23102026};

test("WP1: advancing bytes keep slow transfers alive within the original total budget", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.integer({min: 10000, max: 25000}), {minLength: 2, maxLength: 5}), async gaps => {
    const h = await waitingUpload();
    try {
      let elapsed = 0;
      for (const [index, gap] of gaps.entries()) {
        await h.advance(gap); elapsed += gap;
        assert.deepEqual(h.result, {});
        h.xhr.upload.onprogress({lengthComputable: true, loaded: (index + 1) * 10, total: 100});
        assert.equal(h.xhr.timeout, elapsed + 30000);
      }
      h.xhr.upload.onload();
      h.xhr.respond(200, {key: "fixture/slow-confirmed.jpg"});
      await h.operation;
      assert.equal(h.result.reference, "r2://fixture/slow-confirmed.jpg");
      assert.equal(h.failures.length, 0);
      assert.equal(h.timers.size, 0);
    } finally {await h.stop();}
  }), options);
});

test("WP2: repeated partial byte reports still expire 30 seconds after the last advance", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({min: 1, max: 99}), fc.integer({min: 1, max: 29999}), async (percent, pause) => {
    const h = await waitingUpload();
    try {
      h.xhr.upload.onprogress({lengthComputable: true, loaded: percent, total: 100});
      await h.advance(pause);
      h.xhr.upload.onprogress({lengthComputable: true, loaded: percent, total: 100});
      await h.advance(30000 - pause);
      assert.equal(h.result.error?.code, "driver_upload_timeout");
      assert.equal(h.failures[0]?.transferredBytes, Math.floor(1000000 * percent / 100));
      assert.equal(h.value.objectReference, undefined);
    } finally {await h.stop();}
  }), options);
});

test("WP3: confirmation is bounded independently of time spent transferring", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({min: 0, max: 29999}), async elapsed => {
    const h = await waitingUpload();
    try {
      await h.advance(elapsed);
      h.xhr.upload.onload();
      assert.equal(h.xhr.timeout, elapsed + 15000);
      await h.advance(14999);
      assert.deepEqual(h.result, {});
      await h.advance(1);
      assert.equal(h.result.error?.code, "driver_upload_timeout");
      assert.equal(h.failures.length, 1);
      assert.equal(h.failures[0].stage, "confirming");
    } finally {await h.stop();}
  }), options);
});

test("WP4: arbitrary suspended intervals are checked immediately on returning", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({min: 15000, max: 170000}), async suspended => {
    const h = await waitingUpload();
    try {
      h.xhr.upload.onload();
      h.document.visibilityState = "hidden";
      await h.advance(suspended, false);
      h.document.visibilityState = "visible";
      h.document.fire("visibilitychange");
      await flushUploadTasks();
      assert.equal(h.result.error?.code, "driver_upload_timeout");
      assert.equal(h.failures[0]?.timerDelayMs, suspended - 15000);
    } finally {await h.stop();}
  }), options);
});

test("WP5: delayed wake-lock acquisition never outlives cancellation", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({min: 0, max: 29000}), async delayed => {
    let acquired;
    let releases = 0;
    const h = await waitingUpload({navigator: {wakeLock: {request: () => new Promise(resolve => {acquired = resolve;})}}});
    try {
      assert.equal(typeof acquired, "function");
      await h.advance(delayed);
      await h.stop();
      acquired({release: async () => {releases++;}});
      await flushUploadTasks();
      assert.equal(releases, 1);
      assert.equal(h.document.count(), 0);
    } finally {await h.stop();}
  }), options);
});
