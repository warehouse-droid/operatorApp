import assert from "node:assert/strict";
import test from "node:test";
import {loadDriverHelpers, loadUpload, xhrFixture, photo, memoryStorage, failure} from "../../support/driver-upload-fixtures.mjs";

const job = {jobId: "reconnect-job", planDate: "2026-10-15", status: "in_progress"};
const path = "/api/driver/jobs/reconnect-job/photos";
const owner = {login: "fixture-driver", deviceId: "fixture-device"};
const saved = {records: [{status: "complete", details: {jobId: job.jobId}}]};
const lost = () => Object.assign(new Error("Connection interrupted"), {isNetworkError: true});
const fastClock = {setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 5))};
const ticket = {uploadUrl: "https://fixture.invalid/upload", token: "fixture-only"}; // secret-scan: allow -- synthetic transport ticket.

test("R1 a connection failure retries the unfinished photo automatically and logs recovery", async () => {
  let transfers = 0;
  const fixture = xhrFixture(xhr => ++transfers === 1 ? xhr.onerror() : xhr.respond(200, {key: "fixture/reconnected.jpg"}));
  const context = loadDriverHelpers({...fixture, ...fastClock, request: async () => ticket});
  const value = photo();
  assert.equal(await context.uploadDriverPhoto(value, {jobId: job.jobId}), "r2://fixture/reconnected.jpg");
  assert.equal(transfers, 2);
  assert.equal(value.objectReference, "r2://fixture/reconnected.jpg");
  const records = context.driverUploadFailures.pending(owner);
  assert.equal(records.filter(record => record.outcome === "failed").length, 1);
  assert.equal(records.filter(record => record.outcome === "recovered").length, 1);
  assert.ok(records[0].recoveryId);
  assert.equal(records[0].recoveryId, records[1].recoveryId);
});

test("R2 loss of both save response and first history response recovers without another POST", async () => {
  let writes = 0;
  let reads = 0;
  const context = loadDriverHelpers({...fastClock, request: async (_url, options) => {
    if (options?.method === "POST") {writes++; throw lost();}
    if (++reads === 1) throw lost();
    return saved;
  }});
  assert.equal((await context.saveDriverPhotoAction(path, {}, job, {reconnect: true})).reconciled, true);
  assert.equal(writes, 1);
  assert.equal(reads, 2);
  assert.ok(context.driverUploadFailures.pending(owner).some(record => record.outcome === "recovered"));
});

test("R3 a request lost before saving automatically replays only after authoritative current-job confirmation", async () => {
  const calls = [];
  let writes = 0;
  const context = loadDriverHelpers({...fastClock, request: async (url, options) => {
    calls.push(options?.method === "POST" ? "write" : url.includes("history") ? "history" : "next");
    if (options?.method === "POST") {
      if (++writes === 1) throw lost();
      assert.equal(options.timeoutMs, 4000);
      return {record: {status: "complete"}};
    }
    return url.includes("history") ? {records: []} : {job};
  }});
  assert.equal((await context.saveDriverPhotoAction(path, {}, job, {reconnect: true})).record.status, "complete");
  assert.equal(writes, 2);
  assert.deepEqual(calls, ["write", "history", "history", "next", "write"]);
});

test("R4 automatic DVIR recovery never repeats a write while the first save is unconfirmed", async () => {
  let writes = 0;
  let reads = 0;
  const state = {planDate: "2026-10-15", truckPlate: "FIXTURE"};
  const context = loadDriverHelpers({...fastClock, dayState: state, request: async (_url, options) => {
    if (options?.method === "POST") {writes++; throw lost();}
    return {state: {...state, ...(++reads >= 3 ? {preDvirCompletedAt: "2026-10-15T20:00:00Z"} : {})}};
  }});
  assert.equal((await context.saveDriverPhotoAction("/api/driver/dvir", {type: "pre"}, null, {reconnect: true})).reconciled, true);
  assert.equal(writes, 1);
  assert.equal(reads, 3);
});

test("R5 an old driver session cannot retry after it is cancelled", async () => {
  const controller = new AbortController();
  let writes = 0;
  const context = loadDriverHelpers({...fastClock, driverRequestController: controller, request: async (_url, options) => {
    if (options?.method === "POST") {writes++; throw lost();}
    controller.abort();
    throw lost();
  }});
  await assert.rejects(context.saveDriverPhotoAction(path, {}, job, {reconnect: true}), error => error.code === "driver_upload_cancelled");
  assert.equal(writes, 1);
});

test("R6 a permanent upload authorization rejection does not reconnect or lose the photo", async () => {
  let calls = 0;
  const context = loadDriverHelpers({...fastClock, request: async () => {calls++; throw Object.assign(new Error("Sign in again"), {status: 401});}});
  const value = photo();
  await assert.rejects(context.uploadDriverPhoto(value), /Sign in again/u);
  assert.equal(calls, 1);
  assert.equal(value.objectReference, undefined);
  assert.equal(value.blob.size, 100);
});

test("R7 queued failure and recovery metadata survive reload and a lost log acknowledgement", async () => {
  const storage = memoryStorage();
  const queue = loadUpload().failureQueue(storage);
  queue.enqueue(owner, failure({outcome: "failed", recoveryId: "operation-1", browserOnline: false, visibilityState: "hidden", timeoutMs: 15000, timerDelayMs: 1200}));
  queue.enqueue(owner, failure({failureId: "109f7225-b931-4df6-8dca-ed474bc560da", outcome: "recovered", recoveryId: "operation-1", attempt: 2}));
  await queue.flush(owner, async () => {throw lost();});
  const sent = [];
  await loadUpload().failureQueue(storage).flush(owner, async value => sent.push(value));
  assert.equal(sent.length, 2);
  assert.equal(sent[0].browserOnline, false);
  assert.equal(sent[0].visibilityState, "hidden");
  assert.equal(sent[0].timerDelayMs, 1200);
  assert.equal(sent[1].outcome, "recovered");
  assert.equal(queue.pending(owner).length, 0);
});

test("R8 an overdue deadline is detected on foreground resume even when its timer did not run", async () => {
  let now = 1000;
  let requestedSignal;
  const events = new EventTarget();
  const document = new EventTarget();
  document.visibilityState = "visible";
  class ClockDate extends Date {static now() {return now;}}
  const upload = loadUpload({Date: ClockDate, document, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
    setTimeout: () => 1, clearTimeout: () => {}});
  const pending = upload.deadline(signal => {requestedSignal = signal; return new Promise(() => {});}, {timeoutMs: 15000});
  await Promise.resolve();
  now += 26 * 60000;
  events.dispatchEvent(new Event("pageshow"));
  let guard;
  try {
    await assert.rejects(Promise.race([pending, new Promise((_resolve, reject) => {guard = setTimeout(() => reject(new Error("Resume left the request hanging")), 100);})]),
      error => error.code === "driver_upload_timeout" && error.timerDelayMs === 1545000);
  } finally {clearTimeout(guard);}
  assert.equal(requestedSignal.aborted, true);
});

test("R9 background photo cleanup errors remain attached to the completed job after the screen advances", async () => {
  const context = loadDriverHelpers({currentJob: job});
  let rejectCache;
  const pending = context.updateDriverPhotoCache(() => new Promise((_resolve, reject) => {rejectCache = reject;}));
  await Promise.resolve();
  context.currentJob = {...job, jobId: "next-job"};
  rejectCache(new Error("Photo cache unavailable"));
  await pending;
  const diagnostic = context.driverUploadFailures.pending(owner)[0];
  assert.equal(diagnostic.jobId, job.jobId);
  assert.equal(diagnostic.errorCode, "driver_photo_cache_failed");
});
