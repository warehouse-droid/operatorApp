import assert from "node:assert/strict";
import test from "node:test";
import {waitingUpload, flushUploadTasks} from "../../support/driver-upload-wait-fixture.mjs";

test("W1: no first byte times out after 30 seconds and retains the original photo", async t => {
  const h = await waitingUpload(); t.after(() => h.stop());
  const blob = h.value.blob;
  assert.equal(h.xhr.timeout, 30000);
  await h.advance(29999);
  assert.deepEqual(h.result, {});
  await h.advance(1);
  assert.equal(h.result.error?.code, "driver_upload_timeout");
  assert.equal(h.result.error?.isNetworkError, true);
  assert.equal(h.xhr.aborted, true);
  assert.equal(h.failures.length, 1);
  assert.equal(h.failures[0].timeoutMs, 30000);
  assert.match(h.failures[0].message, /progress/iu);
  assert.equal(h.value.blob, blob);
  assert.equal(h.value.objectReference, undefined);
});

test("W2: sent bytes get a separate 15 second confirmation deadline and full cleanup", async t => {
  const h = await waitingUpload(); t.after(() => h.stop());
  await h.advance(7000);
  h.xhr.upload.onload();
  assert.equal(h.xhr.timeout, 22000);
  await h.advance(14999);
  assert.deepEqual(h.result, {});
  await h.advance(1);
  assert.equal(h.result.error?.code, "driver_upload_timeout");
  assert.equal(h.failures[0].stage, "confirming");
  assert.equal(h.failures[0].percentage, 100);
  assert.equal(h.failures[0].timeoutMs, 15000);
  assert.match(h.failures[0].message, /confirm/iu);
  assert.equal(h.phases.some(value => value.phase === "uploaded"), false);
  assert.equal(h.timers.size, 0);
  assert.equal(h.document.count() + h.windowEvents.count(), 0);
});

test("W3: repeated progress without new bytes cannot keep a broken connection alive", async t => {
  const h = await waitingUpload(); t.after(() => h.stop());
  await h.advance(10000);
  h.xhr.upload.onprogress({lengthComputable: true, loaded: 25, total: 100});
  assert.equal(h.xhr.timeout, 40000);
  await h.advance(10000);
  h.xhr.upload.onprogress({lengthComputable: true, loaded: 25, total: 100});
  assert.equal(h.xhr.timeout, 40000);
  await h.advance(19999);
  assert.deepEqual(h.result, {});
  await h.advance(1);
  assert.equal(h.failures[0]?.transferredBytes, 250000);
  assert.equal(h.failures[0]?.stage, "uploading");
});

test("W2/W3: late progress cannot reset the shorter confirmation deadline", async t => {
  const h = await waitingUpload(); t.after(() => h.stop());
  h.xhr.upload.onload();
  await h.advance(14000);
  h.xhr.upload.onprogress({lengthComputable: true, loaded: 100, total: 100});
  await h.advance(1000);
  assert.equal(h.failures[0]?.stage, "confirming");
  assert.equal(h.failures[0]?.timeoutMs, 15000);
});

for (const event of ["pageshow", "visibilitychange"]) {
  test(`W4: ${event} catches an expired confirmation despite suspended timers`, async t => {
    const h = await waitingUpload(); t.after(() => h.stop());
    h.xhr.upload.onload();
    h.document.visibilityState = "hidden";
    await h.advance(60000, false);
    h.document.visibilityState = "visible";
    (event === "pageshow" ? h.windowEvents : h.document).fire(event);
    await flushUploadTasks();
    assert.equal(h.result.error?.code, "driver_upload_timeout");
    assert.equal(h.failures[0]?.timeoutMs, 15000);
    assert.equal(h.failures[0]?.timerDelayMs, 45000);
    assert.equal(h.xhr.aborted, true);
  });
}

test("W4: the native transport timeout reports its active phase budget", async t => {
  const h = await waitingUpload(); t.after(() => h.stop());
  h.xhr.upload.onload();
  h.xhr.ontimeout();
  await flushUploadTasks();
  assert.equal(h.failures[0]?.timeoutMs, 15000);
  assert.equal(h.failures[0]?.stage, "confirming");
  assert.equal(h.timers.size, 0);
});

test("W5: upload requests a wake lock and releases it on completion", async t => {
  let requests = 0;
  let released = 0;
  const h = await waitingUpload({navigator: {wakeLock: {request: async kind => {
    assert.equal(kind, "screen"); requests++; return {release: async () => {released++;}};
  }}}}); t.after(() => h.stop());
  assert.equal(requests, 1);
  assert.equal(released, 0);
  h.xhr.respond(200, {key: "fixture/confirmed.jpg"});
  await h.operation;
  assert.equal(released, 1);
  assert.equal(h.document.count(), 0);
});

test("W5: returning to the page reacquires a system-released screen wake lock", async t => {
  const locks = [];
  const h = await waitingUpload({navigator: {wakeLock: {request: async () => {
    const lock = {released: false, release: async () => {lock.released = true;}};
    locks.push(lock); return lock;
  }}}}); t.after(() => h.stop());
  assert.equal(locks.length, 1);
  h.document.visibilityState = "hidden";
  h.document.fire("visibilitychange");
  locks[0].released = true;
  h.document.visibilityState = "visible";
  h.document.fire("visibilitychange");
  await flushUploadTasks();
  assert.equal(locks.length, 2);
  await h.stop();
  assert.equal(locks[1].released, true);
});

test("W5: a wake lock acquired after cancellation is immediately released", async t => {
  let deliver;
  let requested = false;
  let released = 0;
  const h = await waitingUpload({navigator: {wakeLock: {request: () => {
    requested = true; return new Promise(resolve => {deliver = resolve;});
  }}}}); t.after(() => h.stop());
  assert.equal(requested, true);
  await h.stop();
  deliver({release: async () => {released++;}});
  await flushUploadTasks();
  assert.equal(released, 1);
  assert.equal(h.result.error.code, "driver_upload_cancelled");
  assert.equal(h.document.count(), 0);
});

test("W5: wake lock denial does not block upload or its phase deadline", async t => {
  let requested = false;
  const h = await waitingUpload({navigator: {wakeLock: {request: async () => {
    requested = true; throw new Error("Screen wake lock denied");
  }}}}); t.after(() => h.stop());
  assert.equal(requested, true);
  h.xhr.upload.onload();
  await h.advance(15000);
  assert.equal(h.result.error?.code, "driver_upload_timeout");
  assert.equal(h.failures[0]?.timeoutMs, 15000);
});
