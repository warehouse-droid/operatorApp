import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const repositorySource = fs.readFileSync(
  new URL("../../../src/driver-offline-repository.js", import.meta.url),
  "utf8"
);
const serverSource = fs.readFileSync(new URL("../../../src/server.js", import.meta.url), "utf8");
const driverSource = fs.readFileSync(new URL("../../../public/driver.js", import.meta.url), "utf8");

function sourceSection(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `Missing source section: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `Missing source section terminator: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("repository finds only an open completion for the same authoritative job on another device", () => {
  const source = sourceSection(
    repositorySource,
    "export async function findOpenDriverOfflineJobCompletion(",
    "export async function getDriverOfflineSyncQueue("
  );

  assert.match(source, /event_type\s*=\s*'job_completed'/u);
  assert.match(source, /device_id\s*<>\s*\$\d+/u);
  assert.match(source, /lower\(driver_login\)\s*=\s*\$\d+/u);
  assert.match(source, /plan_date\s*=\s*\$\d+::date/u);
  assert.match(source, /original_job_id[\s\S]*job_fingerprint[\s\S]*predecessor_fingerprint/u);
  for (const status of [
    "registered",
    "waiting_photos",
    "pending",
    "applying",
    "review_required",
    "blocked",
    "resolution_pending"
  ]) {
    assert.match(source, new RegExp(`"${status}"`, "u"), `${status} must remain an open-completion state.`);
  }
  assert.doesNotMatch(source, /"applied"|"evidence_only"|"rejected"/u);
});

test("next-job reports the cross-device completion in success and pre-trip responses", () => {
  const source = sourceSection(
    serverSource,
    'app.get("/api/driver/next-job",',
    'app.post("/api/driver/rest/start",'
  );

  assert.match(source, /findOpenDriverOfflineJobCompletion/u);
  assert.match(source, /pendingCompletion/u);
  assert.match(source, /jobPredecessorFingerprint:\s*routeBootstrap\.predecessorFingerprint/u);
  assert.match(source, /status\(428\)[\s\S]*pendingCompletion/u);
  assert.match(source, /res\.json\(\{[\s\S]*pendingCompletion[\s\S]*routeBootstrap[\s\S]*\}\)/u);
});

test("client blocks the same job but never mistakes a pending predecessor for the successor", () => {
  const source = sourceSection(
    driverSource,
    "const DRIVER_CROSS_DEVICE_COMPLETION_STATUSES = new Set([",
    "function jobEventRequiresManifestIdentity("
  );
  const buildHarness = new Function(`${source}\nreturn { crossDevicePendingCompletionMatchesJob };`);
  const { crossDevicePendingCompletionMatchesJob } = buildHarness();
  const pendingPickup = {
    eventId: "event-pickup",
    eventType: "job_completed",
    jobId: "sety-pickup",
    jobFingerprint: "pickup-fingerprint",
    predecessorFingerprint: "route-start:v1",
    status: "waiting_photos"
  };

  assert.equal(
    crossDevicePendingCompletionMatchesJob(pendingPickup, {
      jobId: "sety-pickup",
      fingerprint: "pickup-fingerprint",
      predecessorFingerprint: "route-start:v1"
    }),
    true
  );
  assert.equal(
    crossDevicePendingCompletionMatchesJob(pendingPickup, {
      jobId: "sety-successor",
      fingerprint: "successor-fingerprint",
      predecessorFingerprint: "pickup-fingerprint"
    }),
    false,
    "A pending pickup on another device must not block its locally projected successor."
  );
  assert.equal(
    crossDevicePendingCompletionMatchesJob(pendingPickup, {
      jobId: "sety-pickup",
      fingerprint: "dispatch-revised-pickup",
      predecessorFingerprint: "route-start:v1"
    }),
    false,
    "An old snapshot must not block a revised authoritative job that reused an ID."
  );
  assert.equal(
    crossDevicePendingCompletionMatchesJob(pendingPickup, {
      jobId: "sety-pickup",
      fingerprint: "pickup-fingerprint",
      predecessorFingerprint: "reordered-predecessor"
    }),
    false,
    "A route reorder must not let an old predecessor identity block the moved job."
  );
  assert.equal(
    crossDevicePendingCompletionMatchesJob({ ...pendingPickup, status: "evidence_only" }, {
      jobId: "sety-pickup",
      fingerprint: "pickup-fingerprint",
      predecessorFingerprint: "route-start:v1"
    }),
    false,
    "Terminal evidence-only records must not block a later action."
  );

  const revalidation = sourceSection(
    driverSource,
    "async function revalidateOnlineRoute(",
    "function captureQuietSyncContext("
  );
  assert.match(
    revalidation,
    /crossDevicePendingCompletionMatchesJob\(authoritative\.pendingCompletion, expectedJob\)[\s\S]*another device storage ID[\s\S]*browser storage error[\s\S]*Dispatch review[\s\S]*return false/u
  );
  const completionAction = sourceSection(
    driverSource,
    'if (action === "complete-job"',
    '\n});\n\napp.addEventListener("input"'
  );
  assert.ok(
    completionAction.indexOf("ensureAuthoritativeJobBeforeAction")
      < completionAction.indexOf('queueDriverEvent("job_completed"'),
    "The cross-device check must run before the completion reaches the local ledger."
  );
});

test("registration has a stable cross-device conflict inside the locked driver-day transaction", () => {
  const source = sourceSection(
    repositorySource,
    "export async function registerDriverOfflineEvents(",
    "export async function getDriverOfflinePhotoRegistration("
  );
  const dayLockIndex = source.indexOf("await lockDriverDay(login, planDate)");
  const conflictIndex = source.indexOf("DRIVER_OFFLINE_CROSS_DEVICE_COMPLETION_CONFLICT");
  const insertIndex = source.indexOf("INSERT INTO driver_offline_events");

  assert.ok(dayLockIndex >= 0, "Registration must retain the driver-day transaction lock.");
  assert.ok(
    conflictIndex > dayLockIndex && conflictIndex < insertIndex,
    "The cross-device completion conflict must be checked under the day lock before insertion."
  );
  assert.match(
    source,
    /event\.eventType\s*===\s*"job_completed"[\s\S]*device_id\s*<>[\s\S]*original_job_id[\s\S]*job_fingerprint[\s\S]*predecessor_fingerprint/u
  );
});
