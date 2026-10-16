import assert from "node:assert/strict";
import test from "node:test";
import {loadUpload, memoryStorage, xhrFixture, photo, failure} from "../../support/driver-upload-fixtures.mjs";

const owner = {login: "fixture-driver", deviceId: "fixture-device"};
const ticket = async () => ({uploadUrl: "https://fixture.invalid/upload", token: "fixture-only"}); // secret-scan: allow -- fixed synthetic ticket for the fake transport.

test("weighted progress reports measured current and overall percentages", () => {
  const upload = loadUpload();
  const progress = upload.batchProgress([photo(100), photo(300)]);
  const value = progress(0, {phase: "uploading", percentage: 50});
  assert.equal(value.percentage, 50);
  assert.equal(value.overallPercentage, 12);
  assert.equal(value.photoNumber, 1);
  assert.equal(value.photoCount, 2);
});

test("retry progress credits only previously confirmed references", () => {
  const first = {...photo(100), objectReference: "r2://fixture/first.jpg"};
  const progress = loadUpload().batchProgress([first, photo(300)]);
  assert.equal(progress(1, {phase: "uploading", percentage: 50}).overallPercentage, 62);
});

test("unknown upload length stays indeterminate", () => {
  const value = loadUpload().batchProgress([photo()])(0, {phase: "uploading", percentage: null});
  assert.equal(value.percentage, null);
  assert.equal(value.overallPercentage, null);
});

test("a single photo at five percent cannot round overall progress down to four", () => {
  const progress = loadUpload().batchProgress([{byteSize: 822119}]);
  assert.equal(progress(0, {phase: "uploading", percentage: 5}).overallPercentage, 5);
});

test("size-based deadlines match retained photo transfer budgets", () => {
  const upload = loadUpload();
  assert.equal(upload.photoTimeoutMs(photo(1)), 90000);
  assert.equal(upload.photoTimeoutMs(photo(1024 * 1024)), 180000);
  assert.equal(upload.photoTimeoutMs(photo(2 * 1024 * 1024)), 300000);
  assert.equal(upload.photoTimeoutMs(photo(10 * 1024 * 1024)), 360000);
});

test("authorization and transfer each receive their own deadline budget", async () => {
  const timers = [];
  const cleared = [];
  const fixture = xhrFixture(xhr => xhr.respond(200, {key: "fixture/photo.jpg"}));
  const upload = loadUpload({...fixture,
    setTimeout: (callback, ms) => {const timer = {callback, ms}; timers.push(timer); return timer;},
    clearTimeout: timer => cleared.push(timer)
  });
  assert.equal(await upload.upload(photo(), {ticket}), "r2://fixture/photo.jpg");
  assert.deepEqual(timers.map(timer => timer.ms), [60000, 90000]);
  assert.equal(cleared.length, 2);
});

test("a deadline settles a task that ignores abort", async () => {
  let signal;
  await assert.rejects(loadUpload().deadline(inner => {signal = inner; return new Promise(() => {});}, {timeoutMs: 10}), error => error.code === "driver_upload_timeout");
  assert.equal(signal.aborted, true);
});

test("deadline cancellation stays distinguishable from a network failure", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(loadUpload().deadline(() => new Promise(() => {}), {signal: controller.signal, timeoutMs: 100}), error => error.code === "driver_upload_cancelled");
});

test("a successful transfer waits for a storage acknowledgement", async () => {
  const phases = [];
  const fixture = xhrFixture(xhr => {
    xhr.upload.onprogress({lengthComputable: true, loaded: 50, total: 100});
    xhr.upload.onload();
    assert.equal(phases.at(-1).phase, "confirming");
    xhr.respond(200, {key: "fixture/photo.jpg"});
  });
  const reference = await loadUpload(fixture).upload(photo(), {ticket, onProgress: value => phases.push(value)});
  assert.equal(reference, "r2://fixture/photo.jpg");
  assert.equal(phases.find(value => value.phase === "uploading").percentage, 50);
  assert.equal(phases.at(-1).phase, "uploaded");
  assert.equal(fixture.requests[0].headers.Authorization, "Bearer fixture-only");
  assert.ok(fixture.requests[0].body instanceof FormData);
});

for (const [name, status, payload, code] of [
  ["HTTP rejection", 503, {error: "Storage unavailable"}, "driver_photo_upload_http_error"],
  ["invalid JSON", 200, "not json", "driver_photo_upload_invalid_response"],
  ["missing object key", 200, {}, "driver_photo_upload_invalid_response"]
]) {
  test(`${name} records one failed attempt without confirming storage`, async () => {
    const failures = [];
    const fixture = xhrFixture(xhr => xhr.respond(status, payload));
    await assert.rejects(loadUpload(fixture).upload(photo(), {ticket, onFailure: value => failures.push(value)}), error => error.code === code);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].httpStatus, status);
    assert.equal(failures[0].byteSize, 100);
    assert.equal(failures[0].stage, "uploading");
  });
}

test("network failure reports the browser's limited explanation", async () => {
  const failures = [];
  const fixture = xhrFixture(xhr => xhr.onerror());
  await assert.rejects(loadUpload(fixture).upload(photo(), {ticket, onFailure: value => failures.push(value)}), error => error.code === "driver_photo_upload_network_error" && error.isNetworkError === true);
  assert.equal(failures[0].httpStatus, 0);
  assert.match(failures[0].message, /network|connection/iu);
});

test("an upload timeout aborts the transport and logs one failure", async () => {
  const failures = [];
  const fixture = xhrFixture(() => {});
  await assert.rejects(loadUpload(fixture).upload(photo(), {ticket, timeoutMs: 10, onFailure: value => failures.push(value)}), error => error.code === "driver_upload_timeout" && error.isNetworkError === true);
  assert.equal(fixture.requests[0].aborted, true);
  assert.equal(failures.length, 1);
});

test("diagnostic retry retains the same failure ID until acknowledged", async () => {
  const storage = memoryStorage();
  const queue = loadUpload().failureQueue(storage);
  queue.enqueue(owner, failure());
  await queue.flush(owner, async () => {throw new Error("offline");});
  const received = [];
  await loadUpload().failureQueue(storage).flush(owner, async item => received.push(item));
  assert.equal(received.length, 1);
  assert.equal(received[0].failureId, failure().failureId);
  assert.equal(queue.pending(owner).length, 0);
});

test("diagnostic queue partitions identity and caps pending records", async () => {
  const queue = loadUpload().failureQueue(memoryStorage());
  for (let index = 0; index < 102; index += 1) {queue.enqueue(owner, failure({failureId: `failure-${index}`}));}
  const entries = queue.pending(owner);
  assert.equal(entries.length, 100);
  assert.equal(entries[0].failureId, "failure-2");
  const other = {login: "other", deviceId: owner.deviceId};
  let sent = 0;
  await queue.flush(other, async () => {sent += 1;});
  assert.equal(sent, 0);
  await queue.flush(owner, async item => {assert.equal(item.droppedLogCount, sent === 0 ? 2 : 0); sent += 1;});
  assert.equal(sent, 100);
});

test("storage denial leaves in-memory diagnostics usable", async () => {
  const storage = {getItem() {throw new Error("denied");}, setItem() {throw new Error("denied");}};
  const queue = loadUpload().failureQueue(storage);
  queue.enqueue(owner, failure());
  assert.equal(queue.pending(owner).length, 1);
  await queue.flush(owner, async () => {});
  assert.equal(queue.pending(owner).length, 0);
});

test("storage quota failure cannot replace new diagnostics with an older persisted queue", async () => {
  const storage = {getItem: () => JSON.stringify({items: [], dropped: 0}), setItem() {throw new Error("Quota exceeded");}};
  const queue = loadUpload().failureQueue(storage);
  queue.enqueue(owner, failure());
  assert.equal(queue.pending(owner).length, 1);
  const sent = [];
  await queue.flush(owner, async value => sent.push(value));
  assert.equal(sent.length, 1);
  assert.equal(queue.pending(owner).length, 0);
});

test("clock changes cannot make a failure diagnostic duration invalid", async () => {
  for (const duration of [-1000, 90000000]) {
    let calls = 0;
    class FixtureDate extends Date { static now() {return calls++ === 0 ? 10000 : 10000 + duration;} }
    const failures = [];
    const fixture = xhrFixture(xhr => xhr.onerror());
    await assert.rejects(loadUpload({...fixture, Date: FixtureDate}).upload(photo(), {ticket, onFailure: value => failures.push(value)}));
    assert.equal(failures[0].elapsedMs, Math.max(0, Math.min(86400000, duration)));
  }
});

test("diagnostics redact credentials and image data", () => {
  const message = loadUpload().safeMessage("Authorization: Bearer abc-secret https://fixture.invalid?token=private-token data:image/jpeg;base64,private-image");
  assert.doesNotMatch(message, /abc-secret|private-token|private-image/u);
});

test("queued diagnostics contain only bounded safe metadata", () => {
  const queue = loadUpload().failureQueue(memoryStorage());
  queue.enqueue(owner, failure({jobId: "x".repeat(3000), errorCode: "Bearer synthetic-private-token", imageDataUrl: "private-image"}));
  const [entry] = queue.pending(owner);
  assert.equal(entry.jobId.length, 1000);
  assert.doesNotMatch(entry.errorCode, /synthetic-private-token/u);
  assert.equal(entry.imageDataUrl, undefined);
});

test("overflow during an in-memory diagnostic send is reported on the next acknowledgement", async () => {
  const queue = loadUpload().failureQueue({getItem() {throw new Error("denied");}, setItem() {throw new Error("denied");}});
  queue.enqueue(owner, failure());
  let release;
  let started;
  const ready = new Promise(resolve => {started = resolve;});
  const sent = [];
  const flushing = queue.flush(owner, async value => {
    sent.push(value);
    if (sent.length === 1) {started(); await new Promise(resolve => {release = resolve;});}
  });
  await ready;
  for (let index = 0; index < 100; index += 1) queue.enqueue(owner, failure({failureId: `failure-${index}`}));
  release();
  await flushing;
  assert.equal(sent[0].droppedLogCount, 0);
  assert.equal(sent[1].droppedLogCount, 1);
  assert.equal(queue.pending(owner).length, 0);
});

test("incomplete authorization cannot start a transfer and records the failed stage", async () => {
  const failures = [];
  const fixture = xhrFixture(() => {});
  await assert.rejects(loadUpload(fixture).upload(photo(), {ticket: async () => ({}), onFailure: value => failures.push(value)}), error => error.code === "driver_photo_upload_invalid_response");
  assert.equal(fixture.requests.length, 0);
  assert.equal(failures[0].stage, "authorizing");
});

test("cancellation of an active transport settles and records once", async () => {
  const controller = new AbortController();
  const failures = [];
  const fixture = xhrFixture(() => controller.abort());
  await assert.rejects(loadUpload(fixture).upload(photo(), {ticket, signal: controller.signal, onFailure: value => failures.push(value)}), error => error.code === "driver_upload_cancelled");
  assert.equal(fixture.requests[0].aborted, true);
  assert.equal(failures.length, 1);
});

test("unmeasurable transport progress does not manufacture a percentage", async () => {
  const values = [];
  const fixture = xhrFixture(xhr => {
    xhr.upload.onprogress({lengthComputable: false, loaded: 10, total: 0});
    xhr.respond(200, {key: "fixture/photo.jpg"});
  });
  await loadUpload(fixture).upload(photo(), {ticket, onProgress: value => values.push(value)});
  assert.equal(values.find(value => value.phase === "uploading").percentage, null);
});

test("transport timeout and invalid URL setup remain visible failures", async () => {
  const timed = xhrFixture(xhr => xhr.ontimeout());
  await assert.rejects(loadUpload(timed).upload(photo(), {ticket}), error => error.code === "driver_upload_timeout");
  const invalid = xhrFixture(() => {});
  invalid.XMLHttpRequest.prototype.open = () => {throw new Error("Invalid URL");};
  await assert.rejects(loadUpload(invalid).upload(photo(), {ticket}), /Invalid URL/u);
});

test("deadline success and duplicate diagnostics leave no pending work", async () => {
  const upload = loadUpload();
  assert.equal(await upload.deadline(async () => "done", {timeoutMs: 20}), "done");
  assert.throws(() => upload.batchProgress([photo()])(-1, {percentage: 10}), /progress index/u);
  const queue = upload.failureQueue(memoryStorage());
  queue.enqueue(owner, failure());
  queue.enqueue(owner, failure());
  assert.equal(queue.pending(owner).length, 1);
  let sent = 0;
  await Promise.all([queue.flush(owner, async () => {sent += 1;}), queue.flush(owner, async () => {sent += 1;})]);
  assert.equal(sent, 1);
});
