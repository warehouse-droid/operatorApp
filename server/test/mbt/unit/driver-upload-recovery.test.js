import assert from "node:assert/strict";
import test from "node:test";
import {loadDriverHelpers, xhrFixture, photo} from "../../support/driver-upload-fixtures.mjs";

const job = {jobId: "recovery-job", planDate: "2026-10-15", status: "in_progress"};
const path = "/api/driver/jobs/recovery-job/photos";
const owner = {login: "fixture-driver", deviceId: "fixture-device"};
const saved = {records: [{status: "complete", details: {jobId: job.jobId}}]};
const lost = () => Object.assign(new Error("lost response"), {isNetworkError: true});
const timers = budgets => ({setTimeout: (callback, milliseconds) => {
  budgets.push(milliseconds);
  return setTimeout(callback, Math.min(milliseconds, 20));
}});
async function settles(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Action remained blocked")), 250);
    })]);
  } finally { clearTimeout(timer); }
}

for (const failure of [lost(), {code: "driver_upload_timeout"}, {code: "driver_request_invalid_response"}, {status: 503}, {status: 409}]) {
  test(`confirmed stop recovers automatically after ${failure.code || failure.status || "connection loss"}`, async () => {
    let writes = 0;
    const context = loadDriverHelpers({request: async (_path, options) => {
      if (options?.method === "POST") {writes += 1; throw failure;}
      return saved;
    }});
    assert.equal((await context.saveDriverPhotoAction(path, {}, job)).reconciled, true);
    assert.equal(writes, 1);
    assert.equal(context.driverUploadSaveChecks.size, 0);
    assert.equal(context.driverUploadFailures.pending(owner).length, 1);
  });
}

test("empty successful save response also recovers from confirmed history", async () => {
  const context = loadDriverHelpers({request: async (_path, options) => options?.method === "POST" ? {} : saved});
  assert.equal((await context.saveDriverPhotoAction(path, {}, job)).reconciled, true);
});

test("a stalled automatic confirmation is bounded and retains pending evidence without another write", async () => {
  let writes = 0;
  const budgets = [];
  const context = loadDriverHelpers({...timers(budgets), request: async (_path, options) => {
    if (options?.method === "POST") {writes += 1; throw lost();}
    return new Promise(() => {});
  }});
  await assert.rejects(settles(context.saveDriverPhotoAction(path, {}, job)), /lost response/u);
  assert.ok(budgets.includes(15000));
  assert.equal(writes, 1);
  assert.equal(context.driverUploadSaveChecks.size, 1);
  assert.ok(context.driverUploadFailures.pending(owner).some(record => record.stage === "reconciling"));
});

test("manual reconciliation is bounded too and never submits when its read hangs", async () => {
  const budgets = [];
  let writes = 0;
  const context = loadDriverHelpers({...timers(budgets), request: async (_path, options) => {
    if (options?.method === "POST") writes += 1;
    return new Promise(() => {});
  }});
  context.driverUploadSaveChecks.set(context.driverPhotoSaveKey(path, {}, job), true);
  await assert.rejects(settles(context.saveDriverPhotoAction(path, {}, job)), error => error.code === "driver_upload_timeout");
  assert.ok(budgets.includes(15000));
  assert.equal(writes, 0);
  assert.equal(context.driverUploadSaveChecks.size, 1);
});

for (const records of [[], [{status: "complete", details: {jobId: "other-job"}}], [{status: "in_progress", details: {jobId: job.jobId}}]]) {
  test(`unconfirmed history ${JSON.stringify(records)} cannot advance or replay automatically`, async () => {
    let writes = 0;
    let reads = 0;
    const context = loadDriverHelpers({request: async (url, options) => {
      if (options?.method === "POST") {writes += 1; throw lost();}
      reads += 1;
      return url.includes("/history") ? {records} : {job};
    }});
    await assert.rejects(context.saveDriverPhotoAction(path, {}, job));
    assert.ok(reads > 0);
    assert.equal(writes, 1);
    assert.equal(context.driverUploadSaveChecks.size, 1);
  });
}

test("an uncompleted conflict remains an error and keeps its reconciliation check", async () => {
  const error = Object.assign(new Error("This is no longer the next assigned job"), {status: 409});
  const context = loadDriverHelpers({request: async (_url, options) => {
    if (options?.method === "POST") throw error;
    return {records: [], job: {jobId: "other-job"}};
  }});
  await assert.rejects(context.saveDriverPhotoAction(path, {}, job), value => value === error);
  assert.equal(context.driverUploadSaveChecks.size, 1);
});

test("logout while confirming a saved stop cannot advance after a late response", async () => {
  const context = loadDriverHelpers({request: async (_url, options) => {
    if (options?.method === "POST") throw lost();
    context.driverRequestController.abort();
    return saved;
  }});
  await assert.rejects(context.saveDriverPhotoAction(path, {}, job), error => error.code === "driver_upload_cancelled");
});

test("stalled photo bookkeeping preserves confirmed references and continues the batch within five seconds per write", async () => {
  const budgets = [];
  const fixture = xhrFixture(xhr => xhr.respond(200, {key: "fixture/saved.jpg"}));
  const context = loadDriverHelpers({...fixture, ...timers(budgets), offlineStorageAvailable: true,
    DriverOfflineDB: {markPhotoUploaded: () => new Promise(() => {})},
    request: async () => ({uploadUrl: "https://fixture.invalid/upload", token: "fixture-only"})}); // secret-scan: allow -- synthetic upload ticket.
  const values = [photo(100, "first"), photo(100, "second")];
  const result = await settles(context.uploadDriverPhotos(values));
  assert.equal(result.length, 2);
  assert.equal(fixture.requests.length, 2);
  assert.ok(values.every(value => value.objectReference === "r2://fixture/saved.jpg"));
  assert.equal(budgets.filter(value => value === 5000).length, 2);
  const failures = context.driverUploadFailures.pending(owner);
  assert.equal(failures.length, 2);
  assert.ok(failures.every(value => value.errorCode === "driver_photo_cache_timeout"));
});

test("stalled draft cleanup has one five-second budget for the entire batch", async () => {
  const budgets = [];
  const deleted = [];
  const revoked = [];
  const context = loadDriverHelpers({...timers(budgets), offlineStorageAvailable: true,
    DriverOfflineDB: {deleteDraftPhoto: value => {deleted.push(value); return new Promise(() => {});}},
    DriverOfflinePhotos: {revokePhoto: value => revoked.push(value.photoId)}});
  const values = [photo(100, "first"), photo(100, "second")];
  await settles(context.clearLegacyDraftPhotos(values));
  assert.deepEqual(deleted.sort(), ["first", "second"]);
  assert.deepEqual(revoked.sort(), ["first", "second"]);
  assert.deepEqual(budgets, [5000]);
  assert.equal(context.driverUploadFailures.pending(owner)[0].errorCode, "driver_photo_cache_timeout");
});

test("logout during stalled cleanup aborts before releasing the old draft URLs", async () => {
  let revocations = 0;
  const context = loadDriverHelpers({offlineStorageAvailable: true,
    DriverOfflineDB: {deleteDraftPhoto: () => {context.driverRequestController.abort(); return new Promise(() => {});}},
    DriverOfflinePhotos: {revokePhoto: () => {revocations += 1;}}});
  await assert.rejects(settles(context.clearLegacyDraftPhotos([photo()])), error => error.code === "driver_upload_cancelled");
  assert.equal(revocations, 0);
});

for (const state of [
  {planDate: "2026-10-16", truckPlate: "EXPECTED", preDvirCompletedAt: "2026-10-16T13:00:00Z"},
  {planDate: "2026-10-15", truckPlate: "OTHER", preDvirCompletedAt: "2026-10-15T13:00:00Z"}
]) {
  test(`DVIR confirmation for another day or truck cannot advance or permit a repeated write: ${JSON.stringify(state)}`, async () => {
    let writes = 0;
    const context = loadDriverHelpers({dayState: {planDate: "2026-10-15", truckPlate: "EXPECTED"}, request: async (_url, options) => {
      if (options?.method === "POST") {writes += 1; throw lost();}
      return {state};
    }});
    await assert.rejects(context.saveDriverPhotoAction("/api/driver/dvir", {type: "pre"}));
    await assert.rejects(context.saveDriverPhotoAction("/api/driver/dvir", {type: "pre"}));
    assert.equal(writes, 1);
    assert.equal(context.driverUploadSaveChecks.size, 1);
  });
}

test("local storage rejection preserves the reference and logs a redacted diagnostic", async () => {
  const fixture = xhrFixture(xhr => xhr.respond(200, {key: "fixture/saved.jpg"}));
  const context = loadDriverHelpers({...fixture, offlineStorageAvailable: true,
    DriverOfflineDB: {markPhotoUploaded: async () => {throw new Error("token=private-value local storage closed");}},
    request: async () => ({uploadUrl: "https://fixture.invalid/upload", token: "fixture-only"})}); // secret-scan: allow -- synthetic upload ticket.
  const value = photo();
  assert.equal(await context.uploadDriverPhoto(value), "r2://fixture/saved.jpg");
  const [failure] = context.driverUploadFailures.pending(owner);
  assert.equal(failure.errorCode, "driver_photo_cache_failed");
  assert.doesNotMatch(failure.message, /private-value/u);
  assert.equal(value.objectReference, "r2://fixture/saved.jpg");
});
