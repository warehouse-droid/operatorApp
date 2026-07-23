import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../public/dispatch.js", import.meta.url), "utf8");

function sourceSlice(startMarker, endMarker, description = startMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `Expected ${description} source was not found.`);
  return source.slice(start, end);
}

const fingerprintSource = sourceSlice("function compactStringFingerprint", "function payloadRequiresSave", "compact save fingerprint helpers");
const makeFingerprintHelpers = Function(
  "currentPlanDate",
  "currentPlan",
  `"use strict"; ${fingerprintSource}; return { compactStringFingerprint, stablePlanHashPayload, savedPlanHash };`
);
const fingerprints = makeFingerprintHelpers("2026-07-23", { id: "plan-1" });

const largeText = "dispatch-payload:" + "x".repeat(1024 * 1024);
const largeFingerprint = fingerprints.compactStringFingerprint(largeText);
assert.equal(largeFingerprint, fingerprints.compactStringFingerprint(largeText), "Fingerprints must be deterministic.");
assert.notEqual(largeFingerprint, fingerprints.compactStringFingerprint(`${largeText}!`), "A payload mutation must change its fingerprint.");
assert.ok(largeFingerprint.length < 64, "The saved fingerprint must remain compact even for a one-megabyte payload.");
assert.ok(largeFingerprint.startsWith(`${largeText.length.toString(36)}:`), "The compact fingerprint must retain the source length as collision evidence.");

const basePayload = {
  planId: "plan-1",
  planDate: "2026-07-23",
  orders: [{ id: "SO1", qty: 1 }],
  trucks: [{ id: "T1", loads: [] }],
  summary: { driverLaneOrder: ["driver-a"] }
};
const baseHash = fingerprints.stablePlanHashPayload(basePayload);
assert.equal(baseHash, fingerprints.stablePlanHashPayload(structuredClone(basePayload)));
assert.notEqual(baseHash, fingerprints.stablePlanHashPayload({ ...basePayload, orders: [{ id: "SO1", qty: 2 }] }), "Order changes must invalidate the save hash.");
assert.notEqual(baseHash, fingerprints.stablePlanHashPayload({ ...basePayload, trucks: [{ id: "T2", loads: [] }] }), "Truck/load changes must invalidate the save hash.");
assert.notEqual(baseHash, fingerprints.stablePlanHashPayload({ ...basePayload, summary: { driverLaneOrder: ["driver-b"] } }), "Lane sequence changes must invalidate the save hash.");

const errorReporterSource = sourceSlice("function reportDispatchSaveError", "function minutes", "browser save error reporter");
const makeErrorReporter = Function(
  "console",
  "currentPlan",
  "currentPlanDate",
  "dispatchSessionId",
  `"use strict"; ${errorReporterSource}; return reportDispatchSaveError;`
);
const errors = [];
const reportDispatchSaveError = makeErrorReporter(
  { error: (...args) => errors.push(args) },
  { id: "plan-7", revision: 19 },
  "2026-07-23",
  "session-3"
);
const originalError = new Error("quota or network failure");
reportDispatchSaveError("exception", originalError, { status: 503, retryOnStale: false });
assert.equal(errors.length, 1);
assert.equal(errors[0][0], "[dispatch-save]");
assert.deepEqual(errors[0][1], {
  event: "exception",
  planId: "plan-7",
  planDate: "2026-07-23",
  revision: 19,
  sessionId: "session-3",
  message: "quota or network failure",
  status: 503,
  retryOnStale: false
});
assert.equal(errors[0][2], originalError, "The original Error must remain available for a browser-console stack trace.");

const queueSource = sourceSlice("async function flushPlanSaveQueue", "function historySnapshot", "serialized plan-save queue");
assert.match(queueSource, /if \(saveInFlight\)[\s\S]*?saveQueued\s*=\s*true;[\s\S]*?return saveFlushPromise;/, "A concurrent flush must join the active save and preserve a queued follow-up.");
assert.match(queueSource, /while \(saveQueued\)/, "Queued mutations must be drained serially.");
assert.match(queueSource, /const saveGeneration\s*=\s*localPlanGeneration;/, "Each payload must capture its local edit generation.");
assert.match(queueSource, /await savePlanToServer\(payload,[\s\S]*?saveGeneration[\s\S]*?\);/, "The captured generation must travel with the awaited save.");
assert.match(queueSource, /const forceSave\s*=\s*forceNextPlanSave;[\s\S]*?forceNextPlanSave\s*=\s*false;/, "Save Now must consume a one-shot force flag inside the serialized queue.");
assert.match(queueSource, /forceSave[\s\S]*?await savePlanToServer\(payload,[\s\S]*?forceSave/, "The serialized queue must forward the Save Now force flag to the server.");
assert.match(queueSource, /return finalResult;/, "The queue must return the actual final save result to Save Now.");
assert.doesNotMatch(queueSource, /Promise\.all/, "Plan writes must never race through Promise.all.");

const dirtySource = sourceSlice("function markLocalPlanDirty", "function resetLocalPlanDirty", "local save-generation guards");
assert.match(dirtySource, /localPlanGeneration\s*\+=\s*1/, "Every local mutation must advance the generation.");
assert.match(dirtySource, /if \(savedGeneration !== localPlanGeneration\) return;/, "An older response must not clear newer local edits.");
assert.match(dirtySource, /new Date\(savedAt\) < new Date\(lastLocalPlanEditAt\)/, "A response older than the latest edit must not clear the dirty flag.");

const saveSource = sourceSlice("async function savePlanToServer", "function queueServerSave", "plan save response coordination");
assert.match(saveSource, /const savedLatestLocal\s*=\s*saveGeneration\s*===\s*localPlanGeneration;/, "Save completion must be compared with the latest local generation.");
assert.match(saveSource, /if \(savedLatestLocal\)[\s\S]*?clearLocalPlanDirty\([^;]*saveGeneration\);[\s\S]*?else\s*{\s*saveQueued\s*=\s*true;/, "A superseded save must queue a new save instead of clearing local state.");
assert.match(saveSource, /minimumPlanRevisionToApply\.planId[\s\S]*?===\s*String\(targetPlanId\)/, "The minimum accepted revision must be scoped to the plan being saved.");
assert.match(saveSource, /resultRevision\s*<\s*guardedRevision/, "A response older than the guarded revision must be ignored.");

const confirmSource = sourceSlice("async function confirmCurrentPlanAtomic", "function commitPlanMutation", "confirm revision hand-off");
assert.match(confirmSource, /minimumPlanRevisionToApply\s*=\s*{\s*planId:\s*String\(plan\.id\s*\|\|\s*""\),\s*revision:\s*Number\(plan\.revision\s*\|\|\s*0\)\s*}/, "Confirmation must establish a per-plan minimum revision before older autosaves can return.");

const restoreSource = sourceSlice("async function restoreServerPlan", "async function pollServerPlan", "remote-newer restore guard");
assert.match(restoreSource, /const requestedPlanId\s*=\s*currentPlan\.id;/, "Restore must pin the requested plan before awaiting the server.");
assert.match(restoreSource, /fetch\(`\/api\/dispatch\/plans\/\$\{encodeURIComponent\(requestedPlanId\)}`\)/, "Restore must fetch the pinned plan identifier.");
assert.match(restoreSource, /const newerRevision\s*=\s*savedRevision\s*>\s*localRevision;/, "Restore must compare server and local revisions.");
assert.match(restoreSource, /const newerSavedAt\s*=/, "Restore must also compare save timestamps for same-revision updates.");
assert.match(restoreSource, /if \(!newerRevision && !newerSavedAt\) return false;/, "Only a genuinely newer server plan may replace the local view.");

const liveEventSource = sourceSlice("function connectEvents", "function findLoad", "dispatch live-event coordination");
const planEventSource = liveEventSource.slice(liveEventSource.indexOf('if (["dispatch.plan.saved"'));
assert.match(planEventSource, /pollServerPlan\(\);/, "A plan event must verify the server revision before refreshing or warning.");
assert.doesNotMatch(planEventSource.slice(0, planEventSource.indexOf('if (event.type === "dispatch.setup.updated")')), /sse:blockedByDirty|Remote update available/,
  "A source event alone must not claim that another editor changed the plan.");

for (const eventName of ["conflict", "server-response", "saved-with-followup-warning", "exception"]) {
  assert.match(saveSource, new RegExp(`reportDispatchSaveError\\(\\s*"${eventName}"`), `The ${eventName} path must report actionable details in the browser console.`);
}

console.log("Dispatch save coordination and browser diagnostics checks passed.");
