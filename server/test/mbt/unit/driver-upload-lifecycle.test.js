import assert from "node:assert/strict";
import test from "node:test";
import {loadDriverHelpers, xhrFixture, photo} from "../../support/driver-upload-fixtures.mjs";

test("logout between photos cannot upload the remaining photo under another driver", async () => {
  const fixture = xhrFixture(xhr => xhr.respond(200, {key: "fixture/first.jpg"}));
  let tickets = 0;
  const context = loadDriverHelpers({...fixture, offlineStorageAvailable: true, request: async () => {
    tickets += 1;
    return {uploadUrl: "https://fixture.invalid/upload", token: "fixture-only"}; // secret-scan: allow -- fixed synthetic ticket for the fake transport.
  }});
  context.DriverOfflineDB.markPhotoUploaded = async () => {
    context.driverRequestController.abort();
    context.driverRequestController = new AbortController();
    context.driver = {login: "another-driver"};
  };
  const photos = [photo(100, "first"), photo(100, "second")];
  await assert.rejects(context.uploadDriverPhotos(photos), error => error.code === "driver_upload_cancelled");
  assert.equal(tickets, 1);
  assert.equal(photos[0].objectReference, "r2://fixture/first.jpg");
  assert.equal(photos[1].objectReference, undefined);
});

test("a lost save response is reconciled without repeating a completed stop", async () => {
  let writes = 0;
  const job = {jobId: "fixture-job", planDate: "2026-10-13"};
  const context = loadDriverHelpers({request: async (path, options) => {
    if (options?.method === "POST") { writes += 1; throw Object.assign(new Error("lost response"), {isNetworkError: true}); }
    if (path.includes("/history")) return {records: [{status: "complete", details: {jobId: job.jobId}}]};
    throw new Error("Unexpected request");
  }});
  assert.equal((await context.saveDriverPhotoAction("/api/driver/jobs/fixture-job/photos", {}, job)).reconciled, true);
  assert.equal(writes, 1);
});

test("an unconfirmed changed route cannot receive a repeated completion", async () => {
  let writes = 0;
  const job = {jobId: "fixture-job", planDate: "2026-10-13"};
  const context = loadDriverHelpers({request: async (path, options) => {
    if (options?.method === "POST") { writes += 1; throw Object.assign(new Error("lost response"), {isNetworkError: true}); }
    if (path.includes("/history")) return {records: []};
    return {job: {jobId: "different-job", status: "in_progress"}};
  }, t: (_key, fallback) => fallback});
  await assert.rejects(context.saveDriverPhotoAction("/api/driver/jobs/fixture-job/photos", {}, job));
  await assert.rejects(context.saveDriverPhotoAction("/api/driver/jobs/fixture-job/photos", {}, job), /could not be confirmed/u);
  assert.equal(writes, 1);
});

test("an empty successful save response is treated as an uncertain outcome", async () => {
  const context = loadDriverHelpers({request: async () => ({})});
  await assert.rejects(context.saveDriverPhotoAction("/api/driver/jobs/fixture-job/photos", {}, {jobId: "fixture-job", planDate: "2026-10-13"}), error => error.code === "driver_photo_save_not_confirmed");
  assert.equal(context.driverUploadSaveChecks.size, 1);
});

test("BIN photo slots retain their positions while retry uploads only unfinished evidence", async () => {
  const fixture = xhrFixture(xhr => xhr.respond(200, {key: "fixture/bin.jpg"}));
  let tickets = 0;
  const context = loadDriverHelpers({...fixture, request: async () => {
    tickets += 1;
    return {uploadUrl: "https://fixture.invalid/upload", token: "fixture-only"}; // secret-scan: allow -- fixed synthetic ticket for the fake transport.
  }});
  const values = [null, {...photo(), objectReference: "r2://fixture/confirmed.jpg"}, null, photo()];
  const result = await context.uploadDriverPhotos(values, {recordType: "driver-bin-photo"});
  assert.deepEqual(Array.from(result), [null, "r2://fixture/confirmed.jpg", null, "r2://fixture/bin.jpg"]);
  assert.equal(tickets, 1);
});

for (const type of ["pre", "post"]) {
  test(`a lost ${type}-DVIR save response checks day state before repeating its write`, async () => {
    let writes = 0;
    const state = {planDate: "2026-10-13", truckPlate: "FIXTURE", [`${type}DvirCompletedAt`]: "2026-10-13T14:00:00Z"};
    const context = loadDriverHelpers({dayState: {planDate: "2026-10-13", truckPlate: "FIXTURE"}, request: async (path, options) => {
      if (options?.method === "POST") {writes += 1; throw Object.assign(new Error("lost response"), {isNetworkError: true});}
      assert.equal(path, "/api/driver/day-state");
      return {state};
    }});
    const result = await context.saveDriverPhotoAction("/api/driver/dvir", {type});
    assert.equal(result.reconciled, true);
    assert.equal(result.state, state);
    assert.equal(writes, 1);
  });
}

test("an unconfirmed stop may be explicitly retried only while it remains the current started job", async () => {
  const job = {jobId: "fixture-job", planDate: "2026-10-13", status: "in_progress"};
  let writes = 0;
  const context = loadDriverHelpers({request: async (path, options) => {
    if (options?.method === "POST") {
      writes += 1;
      if (writes === 1) throw Object.assign(new Error("lost response"), {isNetworkError: true});
      assert.equal(options.timeoutMs, 120000);
      return {record: {status: "complete"}};
    }
    return path.includes("/history") ? {records: []} : {job};
  }});
  await assert.rejects(context.saveDriverPhotoAction("/api/driver/jobs/fixture-job/photos", {}, job));
  assert.equal((await context.saveDriverPhotoAction("/api/driver/jobs/fixture-job/photos", {}, job)).record.status, "complete");
  assert.equal(writes, 2);
});

test("a missing DVIR confirmation allows an explicit retry with the retained references", async () => {
  const body = {type: "pre", photoDataUrls: ["r2://fixture/dvir.jpg"]};
  let writes = 0;
  const context = loadDriverHelpers({dayState: {planDate: "2026-10-13", truckPlate: "FIXTURE"}, request: async (_path, options) => {
    if (options?.method === "POST") {
      writes += 1;
      if (writes === 1) throw Object.assign(new Error("lost response"), {isNetworkError: true});
      assert.deepEqual(JSON.parse(options.body), body);
    }
    return {state: {planDate: "2026-10-13", truckPlate: "FIXTURE"}};
  }});
  await assert.rejects(context.saveDriverPhotoAction("/api/driver/dvir", body));
  assert.equal((await context.saveDriverPhotoAction("/api/driver/dvir", body)).state.planDate, "2026-10-13");
  assert.equal(writes, 2);
});

test("BIN completion requires a confirmed state and bounds its save request", async () => {
  let options;
  const context = loadDriverHelpers({request: async (_path, input) => {options = input; return {state: {planDate: "2026-10-13", truckPlate: "FIXTURE"}};}});
  const result = await context.saveDriverPhotoAction("/api/driver/jobs/fixture-job/bin/complete", {eventId: "fixture-event"}, {jobId: "fixture-job", planDate: "2026-10-13"});
  assert.equal(result.state.planDate, "2026-10-13");
  assert.equal(options.timeoutMs, 120000);
});

test("signature preparation is bounded and records a safe diagnostic on failure", async () => {
  const saved = {photo: photo(), signature: {}};
  const context = loadDriverHelpers({SorDriverSignature: {onlinePayload: async () => {throw new Error("Signature token=private-value could not be read");}}});
  assert.equal(await context.driverSignaturePayload(null, {}), undefined);
  await assert.rejects(context.driverSignaturePayload(saved, {jobId: "fixture-job", planDate: "2026-10-13"}));
  const [record] = context.driverUploadFailures.pending({login: "fixture-driver", deviceId: "fixture-device"});
  assert.equal(record.stage, "signature");
  assert.equal(record.photoId, saved.photo.photoId);
  assert.doesNotMatch(record.message, /private-value/u);
});

test("current progress becomes indeterminate only when the browser cannot measure bytes", () => {
  const label = {};
  const overall = {};
  const meter = {value: 0, removeAttribute(name) {delete this[name];}};
  const status = {querySelector: selector => ({"[data-driver-upload-label]": label, "[data-driver-upload-current]": meter, "[data-driver-upload-overall]": overall})[selector]};
  const context = loadDriverHelpers({uploadStatus: status, t: (_key, fallback) => fallback, tf: (_key, fallback, values) => fallback.replace(/\{(\w+)\}/gu, (_match, key) => values[key])});
  for (const phase of ["authorizing", "confirming", "saving", "reconciling"]) {
    context.renderDriverUploadProgress({phase, percentage: 100, overallPercentage: 50, photoNumber: 1, photoCount: 2});
    assert.equal(status.hidden, false);
    assert.equal(meter.value, 100);
    assert.equal(overall.textContent, "Overall: 50%");
  }
  context.renderDriverUploadProgress({phase: "uploading", percentage: 37, overallPercentage: 18, photoNumber: 1, photoCount: 2});
  assert.equal(label.textContent, "Photo 1 of 2: 37%");
  context.renderDriverUploadProgress({phase: "uploading", percentage: null, overallPercentage: null, photoNumber: 1, photoCount: 2});
  assert.equal(meter.value, undefined);
  assert.equal(overall.textContent, "Overall: uploading...");
});
