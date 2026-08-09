import assert from "node:assert/strict";
import fs from "node:fs";

const readPublic = (name) => fs.readFileSync(new URL(`../public/${name}`, import.meta.url), "utf8");
const driverSource = readPublic("driver.js");
const driverHtml = readPublic("driver.html");
const driverCss = readPublic("driver.css");
const driverWorker = readPublic("driver-service-worker.js");
const operatorWorker = readPublic("service-worker.js");
const offlineDbSource = readPublic("driver-offline-db.js");
const offlineSyncSource = readPublic("driver-offline-sync.js");
const dispatchOfflineReviewSource = readPublic("dispatch-offline-review.js");
const serverSource = fs.readFileSync(new URL("./server.js", import.meta.url), "utf8");
const offlineRepositorySource = fs.readFileSync(new URL("./driver-offline-repository.js", import.meta.url), "utf8");
const offlineServiceSource = fs.readFileSync(new URL("./driver-offline-service.js", import.meta.url), "utf8");
const offlinePhotoVerificationMigration = fs.readFileSync(
  new URL("../migrations/093_driver_offline_photo_verification_attempts.sql", import.meta.url),
  "utf8"
);

function sourceSection(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0 && endIndex > startIndex, `Could not isolate ${start}.`);
  return source.slice(startIndex, endIndex);
}

function actionSection(start, end) {
  return sourceSection(driverSource, start, end);
}

function assertLocalFirst(section, label, mutationMarkers) {
  const gateIndex = section.indexOf("await prepareOfflineRecord()");
  assert.ok(gateIndex >= 0, `${label} must wait for the offline ledger.`);
  for (const marker of mutationMarkers) {
    const mutationIndex = section.indexOf(marker);
    if (mutationIndex >= 0) {
      assert.ok(gateIndex < mutationIndex, `${label} can reach ${marker} before its offline record is ready.`);
    }
  }
}

const protectedActionSetSource = sourceSection(
  driverSource,
  "const DRIVER_ROUTE_PROTECTED_ACTIONS = new Set([",
  "let activeDriverMutationToken"
);
for (const action of [
  "start-rest",
  "end-rest",
  "show-photo",
  "take-photo",
  "choose-gallery-photo",
  "take-dvir-photo",
  "choose-dvir-gallery-photo",
  "add-job-photo",
  "remove-job-photo",
  "add-dvir-photo",
  "remove-dvir-photo",
  "submit-dvir",
  "skip-dvir",
  "start-job",
  "confirm-truck-switch",
  "skip-samsara-switch",
  "complete-job"
]) {
  assert.match(
    protectedActionSetSource,
    new RegExp(`"${action}"`),
    `${action} must be blocked until its local route identity is protected.`
  );
}
const routeProtectionStateSource = sourceSection(
  driverSource,
  "function driverActionProtectionState()",
  "function routeProtectedControlAttributes()"
);
assert.match(
  routeProtectionStateSource,
  /offlineStorageAvailable[\s\S]*driverIdentityValidated[\s\S]*offlinePartition\?\.partitionKey[\s\S]*offlineShellReady[\s\S]*offlineManifest\?\.manifestId[\s\S]*offlineManifest\.complete[\s\S]*routeManifestExpired\(\)/,
  "The visible action gate must require local storage, the authenticated partition, a controlled app shell, and a complete current manifest."
);
assert.match(
  routeProtectionStateSource,
  /const savedJob = manifestJobFor\(currentJob\.jobId\);[\s\S]*!savedJob\?\.jobId[\s\S]*!savedJob\.fingerprint[\s\S]*!savedJob\.predecessorFingerprint/,
  "A current stop must remain locked until its immutable manifest identity is stored."
);
assert.match(
  routeProtectionStateSource,
  /String\(savedJob\.fingerprint\) !== currentFingerprint[\s\S]*String\(savedJob\.predecessorFingerprint\) !== currentPredecessor[\s\S]*savedContentFingerprint !== currentContentFingerprint/,
  "An older same-job manifest must not unlock controls when the live route or stop details changed."
);
const manifestIdentityMergeSource = sourceSection(
  driverSource,
  "function withManifestJobIdentity(",
  "function stableComparableValue("
);
assert.ok(
  manifestIdentityMergeSource.indexOf("routeBootstrap?.currentJobFingerprint")
    < manifestIdentityMergeSource.indexOf("manifestJob?.fingerprint"),
  "The authoritative next-job bootstrap identity must take precedence over an older saved manifest."
);
const routeProtectionGateSource = sourceSection(
  driverSource,
  "function applyDriverActionProtectionGate()",
  "function withManifestJobIdentity("
);
assert.match(
  routeProtectionGateSource,
  /querySelectorAll\("\[data-route-record-control\]"\)[\s\S]*control\.disabled = true[\s\S]*aria-describedby[\s\S]*routeProtectionDisabled[\s\S]*control\.disabled = false/,
  "Protected controls must be visibly disabled and unlock only if this gate disabled them."
);
assert.match(
  driverSource,
  /function renderDriverActionProtectionNotice[\s\S]*Maps, Refresh, History, Sync, language, and Logout remain available/,
  "The Driver must see why action controls are locked and which recovery/navigation controls remain available."
);
assert.match(driverCss, /\.driver-action-protection/, "The route-preparation notice must have visible styling.");
assert.match(
  driverCss,
  /\[data-route-record-control\]\[aria-disabled="true"\]/,
  "Locked route controls must have visible disabled styling."
);
const readinessClickGate = driverSource.indexOf("DRIVER_ROUTE_PROTECTED_ACTIONS.has(action)");
const clickMutationGate = driverSource.indexOf("beginDriverMutation(action, button)", readinessClickGate);
assert.ok(
  readinessClickGate >= 0 && clickMutationGate > readinessClickGate,
  "The handler must reject an unprotected action before entering any mutation path."
);
const photoChangeSection = sourceSection(
  driverSource,
  'app.addEventListener("change"',
  'app.addEventListener("submit"'
);
assert.ok(
  photoChangeSection.indexOf("!driverActionProtectionState().ready")
    < photoChangeSection.indexOf("DriverOfflinePhotos.captureAndStore"),
  "Camera and gallery input changes must be rejected before writing a photo draft when the route is unprotected."
);
const renderedJobControls = sourceSection(driverSource, "function renderJob()", "function renderRestModal()");
assert.match(
  renderedJobControls,
  /data-action="refresh" type="button"/,
  "Refresh must remain usable while record-producing controls are locked."
);
assert.match(
  renderedJobControls,
  /<a class="map-button"[\s\S]*target="_blank"/,
  "Maps must remain usable while record-producing controls are locked."
);

assertLocalFirst(
  actionSection('if (action === "start-rest")', 'if (action === "end-rest")'),
  "Rest start",
  ["queueDriverEvent(", "request("]
);
assertLocalFirst(
  actionSection('if (action === "end-rest")', 'if (action === "close-photo")'),
  "Rest end",
  ["queueDriverEvent(", "request("]
);
assertLocalFirst(
  actionSection('if (action === "submit-dvir")', 'if (action === "skip-dvir")'),
  "DVIR submission",
  ["queueOfflineDvir(", "request(", "uploadDriverPhotos("]
);
const dvirSection = actionSection('if (action === "submit-dvir")', 'if (action === "skip-dvir")');
assert.ok(
  dvirSection.indexOf("registerForegroundEvent")
    < dvirSection.indexOf("uploadDriverPhotos")
    && dvirSection.indexOf("uploadDriverPhotos")
      < dvirSection.indexOf("confirmForegroundEvidence")
    && dvirSection.indexOf("confirmForegroundEvidence")
      < dvirSection.indexOf('request("/api/driver/dvir"'),
  "Foreground DVIR evidence must be registered, uploaded, and durably confirmed before Samsara."
);
assert.match(dvirSection, /offlineEventUpload:\s*true/);
assert.match(
  offlineSyncSource,
  /async function registerForegroundEvent[\s\S]*buildEventPayload\(event\)[\s\S]*postSync\(manifest, currentProfile, \[payload\], \[\]\)/,
  "Foreground event registration must use the same authenticated offline envelope."
);
assert.match(
  offlineSyncSource,
  /async function confirmForegroundEvidence[\s\S]*postSync\(manifest, currentProfile, \[\], receipts\)[\s\S]*status !== "applied"/,
  "Foreground evidence confirmation must require durable receipts and an applied server event."
);
const rawOfflinePhotoUploadSource = sourceSection(
  offlineSyncSource,
  "async function uploadPhoto(",
  "async function registerForegroundEvent("
);
assert.match(
  rawOfflinePhotoUploadSource,
  /headers:\s*\{[\s\S]*Authorization:[\s\S]*"Content-Type":\s*photo\.mimeType[\s\S]*"X-File-Name":\s*uploadName/,
  "Offline evidence uploads must declare the registered MIME type and deterministic file name."
);
assert.match(
  rawOfflinePhotoUploadSource,
  /body:\s*photo\.blob/,
  "Offline evidence uploads must send the registered Blob bytes as the raw request body."
);
assert.doesNotMatch(
  rawOfflinePhotoUploadSource,
  /\bFormData\b/,
  "Offline evidence uploads must not wrap the Blob in multipart FormData."
);
assert.match(
  rawOfflinePhotoUploadSource,
  /reportedBytes[\s\S]*reportedBytes !== expectedBytes[\s\S]*Photo upload stored/,
  "The Driver must reject an upload acknowledgement whose stored byte count differs from the registered Blob."
);
assertLocalFirst(
  actionSection('if (action === "start-job"', 'if (action === "confirm-truck-switch"'),
  "Job start",
  ['queueDriverEvent("job_started"', "request("]
);
assertLocalFirst(
  actionSection('if (action === "confirm-truck-switch"', 'if (action === "skip-samsara-switch"'),
  "Truck switch",
  ["queuePhysicalTruckSwitch(", "runForegroundTruckSwitch(", "request("]
);
assertLocalFirst(
  actionSection('if (action === "skip-samsara-switch"', 'if (action === "complete-job"'),
  "Skipped Samsara truck switch",
  ["queuePhysicalTruckSwitch(", "runForegroundTruckSwitch(", "request("]
);
assertLocalFirst(
  actionSection('if (action === "complete-job"', '\n});\n\napp.addEventListener("input"'),
  "Job completion",
  ['queueDriverEvent("job_completed"', "request(", "uploadDriverPhotos("]
);

const driverMutationStart = driverSource.indexOf("function beginDriverMutation");
const driverMutationEnd = driverSource.indexOf("function routeRefreshWasSuperseded", driverMutationStart);
const driverMutationSource = driverSource.slice(driverMutationStart, driverMutationEnd);
assert.ok(driverMutationStart >= 0 && driverMutationEnd > driverMutationStart, "Could not isolate the Driver mutation lock.");
assert.match(
  driverMutationSource,
  /activeDriverMutationToken[\s\S]*return false;[\s\S]*activeDriverMutationToken = token;[\s\S]*button\.disabled = true/,
  "A second route mutation must be rejected and its button disabled synchronously."
);
const driverClickStart = driverSource.indexOf('app.addEventListener("click"');
const completionStart = driverSource.indexOf('if (action === "complete-job"', driverClickStart);
assert.ok(
  driverSource.indexOf("beginDriverMutation(action, button)", driverClickStart) < completionStart,
  "The mutation lock must be acquired at click entry, before completion can await route validation."
);
const completionConcurrencySource = actionSection('if (action === "complete-job"', '\n  } finally {\n    endDriverMutation(mutationToken);');
assert.ok(
  completionConcurrencySource.indexOf("const completedJob = currentJob")
    < completionConcurrencySource.indexOf("await ensureAuthoritativeJobBeforeAction")
    && completionConcurrencySource.indexOf("const submittedJobPhotos = photos.filter(Boolean).slice()")
      < completionConcurrencySource.indexOf("await ensureAuthoritativeJobBeforeAction"),
  "Completion must snapshot its job and photo evidence before the first network await."
);

const queueEventStart = driverSource.indexOf("async function queueDriverEvent");
const queueEventEnd = driverSource.indexOf("async function queuePhysicalTruckSwitch", queueEventStart);
const queueEventSource = driverSource.slice(queueEventStart, queueEventEnd);
assert.ok(queueEventStart >= 0 && queueEventEnd > queueEventStart, "Could not isolate the local event transaction.");
assert.ok(
  queueEventSource.indexOf("DriverOfflineDB.queueEvent")
    < queueEventSource.indexOf("renderOfflineProjection")
    && queueEventSource.indexOf("renderOfflineProjection")
      < queueEventSource.indexOf("triggerOfflineSync"),
  "A Driver action must commit locally, advance the projection, and only then synchronize."
);
assert.match(
  queueEventSource,
  /const manifestJob = manifestJobFor\(job\?\.jobId\);[\s\S]*jobEventRequiresManifestIdentity\(eventType\)[\s\S]*!manifestJob\?\.jobId[\s\S]*!manifestJob\.fingerprint[\s\S]*!manifestJob\.predecessorFingerprint[\s\S]*error\.code = "offline_event_identity_unavailable";[\s\S]*throw error;/,
  "A job-bound action must refuse to queue when its exact manifest snapshot identity is unavailable."
);
assert.match(
  queueEventSource,
  /jobId: manifestJob\?\.jobId \|\| job\?\.jobId \|\| null,[\s\S]*jobFingerprint: manifestJob\?\.fingerprint \|\| job\?\.fingerprint \|\| null,[\s\S]*predecessorFingerprint: manifestJob\?\.predecessorFingerprint \|\| job\?\.predecessorFingerprint \|\| null/,
  "Queued job identity must come from the exact active-manifest job before any live-job fallback."
);
assert.match(
  queueEventSource,
  /eventType === "dvir_captured"[\s\S]*eventType === "job_completed"[\s\S]*manifestJob\?\.requiredPhotos[\s\S]*requiredPhotoCount,/,
  "IndexedDB must receive the required count from the exact manifest job (or four for DVIR)."
);
assert.match(
  queueEventSource,
  /if \(navigator\.onLine\) void triggerOfflineSync\(\{ suppressHold: true \}\);/,
  "A normal local-first action must synchronize without interrupting the screen it just advanced."
);
assert.match(
  queueEventSource,
  /try \{[\s\S]*DriverOfflineDB\.queueEvent[\s\S]*catch \(error\)[\s\S]*offlineRetainedClientError = error[\s\S]*reportDriverClientSyncStatus\("error"[\s\S]*recordSyncError[\s\S]*throw error/,
  "An IndexedDB queue failure must retain drafts, persist and report the exact error, and abort the action."
);

const buildPayloadStart = offlineSyncSource.indexOf("async function buildEventPayload");
const buildPayloadEnd = offlineSyncSource.indexOf("async function postSync", buildPayloadStart);
const buildPayloadSource = offlineSyncSource.slice(buildPayloadStart, buildPayloadEnd);
assert.ok(buildPayloadStart >= 0 && buildPayloadEnd > buildPayloadStart, "Could not isolate offline event serialization.");
assert.match(
  buildPayloadSource,
  /const repaired = repair[\s\S]*DriverOfflineDB\.repairEventForSync\(event\.partitionKey, event\.eventId\)[\s\S]*JOB_BOUND_EVENT_TYPES\.has\(repaired\.eventType\)[\s\S]*!String\(repaired\.jobId \|\| ""\)\.trim\(\)[\s\S]*!String\(repaired\.jobFingerprint \|\| ""\)\.trim\(\)[\s\S]*!String\(repaired\.predecessorFingerprint \|\| ""\)\.trim\(\)[\s\S]*throw error;/,
  "Event serialization must repair saved identity and still refuse a malformed job event."
);
assert.ok(
  buildPayloadSource.indexOf("throw error;") < buildPayloadSource.indexOf("const payload = {"),
  "A malformed job event must be rejected before any sync payload is returned."
);
const syncPartitionStart = offlineSyncSource.indexOf("async function syncPartitionInternal");
const syncPartitionEnd = offlineSyncSource.indexOf("function syncPartition(", syncPartitionStart);
const syncPartitionSource = offlineSyncSource.slice(syncPartitionStart, syncPartitionEnd);
assert.ok(syncPartitionStart >= 0 && syncPartitionEnd > syncPartitionStart, "Could not isolate the partition sync.");
assert.ok(
  syncPartitionSource.indexOf("const storedEvents = await global.DriverOfflineDB.getPartitionEvents(partitionKey)")
    < syncPartitionSource.indexOf("repairEventForSync(")
    && syncPartitionSource.indexOf("repairEventForSync(")
      < syncPartitionSource.indexOf("const allPendingEvents")
    && syncPartitionSource.indexOf("const allPendingEvents")
      < syncPartitionSource.indexOf("buildEventPayload(event, { repair: false })"),
  "Partition sync must repair every stored event before filtering and serializing the batch."
);
const repairEventStart = offlineDbSource.indexOf("async function repairEventForSync");
const repairEventEnd = offlineDbSource.indexOf("async function getPartitionEvents", repairEventStart);
const repairEventSource = offlineDbSource.slice(repairEventStart, repairEventEnd);
assert.ok(repairEventStart >= 0 && repairEventEnd > repairEventStart, "Could not isolate stored-event identity repair.");
assert.match(
  repairEventSource,
  /const manifestKey = makeManifestKey\(expectedPartition, manifestId\);[\s\S]*manifestsStore\.get\(manifestKey\)[\s\S]*jobsStore\.index\("byManifest"\)[\s\S]*String\(job\.jobId \|\| ""\) === jobId/,
  "Stored job-event repair must use the event's exact partitioned manifest snapshot."
);
assert.match(
  repairEventSource,
  /if \(!eventFingerprint \|\| !eventPredecessor\)[\s\S]*jobFingerprint: manifestFingerprint[\s\S]*predecessorFingerprint: manifestPredecessor[\s\S]*eventsStore\.put\(repaired\)/,
  "Missing job fingerprints must be restored from the exact manifest job and persisted before sync."
);
assert.match(
  repairEventSource,
  /db\.transaction\(\["events", "manifests", "jobs", "photos"\], "readwrite"\)/,
  "Event repair must update duplicate events and their retained photo evidence atomically."
);
assert.match(
  repairEventSource,
  /const compatibleManifestIds = new Set\([\s\S]*candidate\.planId[\s\S]*candidate\.planDate[\s\S]*candidate\.planRevision[\s\S]*candidate\.eventType !== "job_completed"[\s\S]*candidate\.receivedAt[\s\S]*eventIsRetainedTerminal\(candidate\)[\s\S]*String\(candidate\.jobId \|\| ""\) !== expectedJobId/,
  "Duplicate-completion repair must be limited to unreceived, nonterminal events for the same job and compatible route revision."
);
assert.match(
  repairEventSource,
  /if \(photo\.eventId \|\| !photo\.draftKey\) return false;[\s\S]*draftParts\[0\] === "job"[\s\S]*compatibleManifestIds\.has\(draftParts\[1\]\)[\s\S]*draftParts\.slice\(2\)\.join\(":"\) === expectedJobId/,
  "Photo repair may recover only unbound job drafts for the exact job on a compatible manifest."
);
const completionEvidenceRepairStart = repairEventSource.indexOf('if (canonical && repairablePhotos.length >= requiredPhotoCount)');
const completionEvidenceRepairEnd = repairEventSource.indexOf("const currentRestId", completionEvidenceRepairStart);
const completionEvidenceRepairSource = repairEventSource.slice(
  completionEvidenceRepairStart,
  completionEvidenceRepairEnd
);
assert.ok(
  completionEvidenceRepairStart >= 0 && completionEvidenceRepairEnd > completionEvidenceRepairStart,
  "Could not isolate duplicate completion evidence repair."
);
assert.ok(
  completionEvidenceRepairSource.indexOf("photosStore.put(")
    < completionEvidenceRepairSource.indexOf("eventsStore.put(canonicalRepair)")
    && completionEvidenceRepairSource.indexOf("eventsStore.put(canonicalRepair)")
      < completionEvidenceRepairSource.indexOf("duplicateCompletions.slice(1)"),
  "A redundant completion may be cancelled only after enough evidence is rebound to a durable canonical event."
);
assert.match(
  completionEvidenceRepairSource,
  /Math\.min\(\.\.\.occurrenceTimes\)[\s\S]*occurredAt: earliestOccurredAt/,
  "Duplicate repair must preserve the earliest captured completion occurrence time."
);
assert.doesNotMatch(
  driverSource,
  /navigator\.geolocation|getCurrentPosition|watchPosition/,
  "The Driver PWA must not capture phone GPS for offline evidence."
);
const locationCheckStart = driverSource.indexOf("async function checkCurrentJobLocation");
const locationCheckEnd = driverSource.indexOf("async function ensureLocationApprovalBeforeConfirmation", locationCheckStart);
const locationCheckSource = driverSource.slice(locationCheckStart, locationCheckEnd);
assert.match(
  locationCheckSource,
  /catch \(error\)[\s\S]*isGenuineNetworkFailure\(error\)[\s\S]*status: "not_checked_offline"/,
  "Only a genuine connectivity failure may create the offline location marker."
);
assert.match(
  driverSource,
  /if \(error\.status === 401\)[\s\S]{0,500}lockPartition\([\s\S]{0,500}clearDriverSessionMemory\(\)/,
  "An authenticated 401 must lock cached Driver data instead of leaving it available to a later offline reopen."
);
assert.match(
  driverSource,
  /isGenuineNetworkFailure\(error\) && await loadCachedRoute\(\)/,
  "A genuine outage must retain the authenticated Driver session and fall back to its cached route."
);
const unitPillsSource = actionSection("function unitPills", "function orderKey");
assert.match(
  unitPillsSource,
  /unit\?\.unit \|\| unit\?\.label \|\| unit\?\.uom \|\| t\("driver\.uom", "UOM"\)/,
  "The Driver renderer must support canonical and cached legacy UOM fields with a localized fallback."
);
assert.match(
  unitPillsSource,
  /unit\?\.value \?\? unit\?\.quantity \?\? 0/,
  "The Driver renderer must support both canonical and legacy unit quantities."
);

const fetchHandler = driverWorker.slice(driverWorker.indexOf('self.addEventListener("fetch"'));
assert.doesNotMatch(
  driverWorker,
  /caches\.match\(/,
  "Driver shell reads must never search another application's cache namespace."
);
assert.match(fetchHandler, /url\.pathname\.startsWith\("\/api\/"\)\) return;/);
assert.ok(
  fetchHandler.indexOf('url.pathname.startsWith("/api/")') < fetchHandler.indexOf("event.respondWith("),
  "Private API requests must leave the service worker before cache handling."
);
assert.match(fetchHandler, /caches\.open\(DRIVER_CACHE_NAME\)[\s\S]*cache\.match\("\/driver"\)/);
assert.match(fetchHandler, /caches\.open\(DRIVER_CACHE_NAME\)[\s\S]*cache\.match\(request\)/);
assert.match(
  fetchHandler,
  /\["\/driver", "\/driver\.html"\]\.includes\(url\.pathname\)/,
  "Only an actual Driver document navigation may refresh the cached offline document."
);
assert.doesNotMatch(
  fetchHandler,
  /request\.mode === "navigate" && url\.pathname\.startsWith\("\/driver"\)/,
  "A direct navigation to a Driver asset must not overwrite the cached Driver document."
);
assert.match(
  operatorWorker,
  /url\.pathname === "\/driver"[\s\S]*url\.pathname\.startsWith\("\/driver-offline-"\)[\s\S]*driverAsset\) return;/,
  "The operator worker must not intercept driver shell requests."
);

const version = driverHtml.match(/driver\.js\?v=([^"]+)/)?.[1];
assert.ok(version, "The driver shell must version its main script.");
assert.match(driverWorker, new RegExp(`driver\\.js\\?v=${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
for (const shellUrl of driverHtml.matchAll(/(?:src|href)="(\/[^"]+)"/g)) {
  assert.ok(
    driverWorker.includes(`"${shellUrl[1]}"`),
    `The Driver worker shell is missing ${shellUrl[1]}.`
  );
}

const markUploadedStart = offlineDbSource.indexOf("async function markPhotoUploaded");
const markUploadedEnd = offlineDbSource.indexOf("async function markPhotoError", markUploadedStart);
const markUploadedSource = offlineDbSource.slice(markUploadedStart, markUploadedEnd);
assert.match(markUploadedSource, /status: "uploaded_unverified"/);
assert.doesNotMatch(markUploadedSource, /blobBytes:\s*null/, "Upload acknowledgement alone must retain photo evidence.");
assert.match(
  offlineDbSource,
  /const durable = Boolean\([\s\S]{0,800}blobBytes: durable \? null : existing\.blobBytes/,
  "Local photo bytes may be removed only after a durable server receipt."
);
assert.match(
  offlineDbSource,
  /const verificationFailed[\s\S]{0,240}objectReference: verificationFailed[\s\S]{0,80}\? null/,
  "Failed readback must clear the upload reference so the retained photo bytes can be re-uploaded."
);
assert.match(
  offlineDbSource,
  /async function getPendingPhotos[\s\S]{0,500}photo\.eventId && photo\.status !== "durably_received"/,
  "Unsynced photos must remain uploadable even when their duplicate event is already terminal evidence-only."
);
assert.match(
  offlineSyncSource,
  /for \(const photo of allPendingPhotos\)[\s\S]{0,500}eventsById\.get\(photo\.eventId\)[\s\S]{0,500}group\.eventIds\.add\(owner\.eventId\)/,
  "Terminal evidence-only events must still contribute retained photos to the upload drain."
);
const saveDraftStart = offlineDbSource.indexOf("async function saveDraftPhoto");
const saveDraftEnd = offlineDbSource.indexOf("async function getDraftPhotos", saveDraftStart);
const saveDraftSource = offlineDbSource.slice(saveDraftStart, saveDraftEnd);
assert.ok(
  saveDraftSource.indexOf('db.transaction("photos", "readwrite")')
    < saveDraftSource.indexOf("const photos = await getAll(store)")
    && saveDraftSource.indexOf("const photos = await getAll(store)")
      < saveDraftSource.indexOf("nextBytes > MAX_EVIDENCE_BYTES")
    && saveDraftSource.indexOf("nextBytes > MAX_EVIDENCE_BYTES")
      < saveDraftSource.indexOf("putPhotoRecord(store, record)"),
  "The evidence cap must be checked and written atomically in one IndexedDB transaction."
);
assert.match(
  saveDraftSource,
  /const slotReplacements = photos\.filter\(\(candidate\) =>[\s\S]*candidate\.partitionKey === partitionKey[\s\S]*!candidate\.eventId[\s\S]*String\(candidate\.draftKey \|\| ""\) === String\(draftKey \|\| ""\)[\s\S]*Number\(candidate\.ordinal \|\| 0\) === Number\(record\.ordinal \|\| 0\)/,
  "Saving a draft must find every unbound duplicate in the same partition, draft key, and ordinal."
);
assert.match(
  saveDraftSource,
  /const replacementIds = new Set\(\[[\s\S]*slotReplacements\.map\(\(candidate\) => candidate\.photoId\)[\s\S]*putPhotoRecord\(store, record\);[\s\S]*for \(const replacementId of replacementIds\)[\s\S]*store\.delete\(replacementId\)/,
  "Saving a draft slot must replace all unbound duplicates after writing the new record."
);
assert.match(
  saveDraftSource,
  /existingRecord[\s\S]*existingRecord\.eventId[\s\S]*throw new Error\("A photo already committed as event evidence cannot be replaced\."\)/,
  "Draft deduplication must never replace photo evidence already bound to an event."
);
assert.match(
  offlineDbSource,
  /input\.enforcePhotoCompletionLimit[\s\S]{0,800}evidenceBytes >= MAX_EVIDENCE_BYTES[\s\S]{0,300}unsyncedPhotos\.length >= MAX_UNSYNCED_PHOTOS/,
  "Photo-required event completion must recheck both hard limits inside its local transaction."
);
const queueDbStart = offlineDbSource.indexOf("async function queueEvent");
const queueDbEnd = offlineDbSource.indexOf("async function repairEventForSync", queueDbStart);
const queueDbSource = offlineDbSource.slice(queueDbStart, queueDbEnd);
assert.ok(queueDbStart >= 0 && queueDbEnd > queueDbStart, "Could not isolate IndexedDB event commit.");
assert.match(
  offlineDbSource,
  /const DB_VERSION = 2;[\s\S]*onupgradeneeded[\s\S]*upgrade\.objectStore\("events"\)[\s\S]*ensureIndex\(events, "byPartitionSequence"/,
  "IndexedDB v2 must add missing indexes to an existing Driver database without deleting its evidence stores."
);
assert.match(
  offlineDbSource,
  /transaction\.onerror = \(event\)[\s\S]*event\?\.target\?\.error[\s\S]*transaction\.onabort[\s\S]*indexedDbOperationError/,
  "Transaction failures must retain the underlying IndexedDB DOMException instead of replacing it with a generic error."
);
assert.match(
  queueDbSource,
  /highestStoredSequence[\s\S]*Number\.isSafeInteger\(candidate\)[\s\S]*storedSequence[\s\S]*Math\.max\(storedSequence, highestStoredSequence\)[\s\S]*clientSequence = lastSequence \+ 1/,
  "Event sequence allocation must reconcile stale metadata against every retained event in the same transaction."
);
assert.match(
  queueDbSource,
  /requestResult\(eventsStore\.add\(eventRecord\)\)[\s\S]*requestResult\(metaStore\.put[\s\S]*indexedDbOperationError\(error, "Saving this stop on the device"\)/,
  "Event and sequence writes must surface their exact request failure with stop-save context."
);
assert.match(
  queueDbSource,
  /const requiredPhotoCount = Number\(input\.requiredPhotoCount \?\? 0\)[\s\S]*photoIds\.includes\(photoId\)[\s\S]*photoOrdinals\.has\(ordinal\)[\s\S]*photoRecords\.length < requiredPhotoCount/,
  "The local event transaction must enforce unique evidence IDs, unique ordinals, and the manifest-required count."
);
assert.match(
  queueDbSource,
  /existing\.eventId && existing\.eventId !== eventId[\s\S]*already committed to another saved action/,
  "A second completion must never steal a photo already committed to another event."
);
assert.ok(
  queueDbSource.indexOf("photoRecords.length < requiredPhotoCount")
    < queueDbSource.indexOf("for (const existing of photoRecords)")
    && queueDbSource.indexOf("for (const existing of photoRecords)")
      < queueDbSource.indexOf("eventsStore.add(eventRecord)"),
  "All photo records and required counts must validate before evidence ownership or event state is mutated."
);
const photoChangeStart = driverSource.indexOf('app.addEventListener("change"');
const photoChangeEnd = driverSource.indexOf('app.addEventListener("submit"', photoChangeStart);
const photoChangeSource = driverSource.slice(photoChangeStart, photoChangeEnd);
assert.ok(
  photoChangeSource.indexOf("await prepareOfflineRecord()")
    < photoChangeSource.indexOf("captureAndStore"),
  "An expired or unavailable route must be rejected before a new photo Blob is stored."
);
assert.match(
  photoChangeSource,
  /markDriverInteraction\(\);[\s\S]*beginPhotoCapture\(\);[\s\S]*await window\.DriverOfflinePhotos\.captureAndStore\([\s\S]*const captureStillCurrent[\s\S]*captureJobId === String\(currentJob\?\.jobId \|\| ""\)/,
  "Asynchronous capture must stay bound to the current partition and job instead of a stale render."
);
assert.match(
  photoChangeSource,
  /if \(isDvir\) dvirPhotos\[index\] = captured;[\s\S]*else \{[\s\S]*photos\[index\] = captured;[\s\S]*photoPromptOpen = !isDriverBinJob\(\);[\s\S]*renderJob\(\);/,
  "A completed capture must update the current photo array, preserving the ordinary photo modal while BIN evidence stays inline."
);
assert.doesNotMatch(
  photoChangeSource,
  /\b(?:target|photoTarget|captureTarget)\s*\[index\]\s*=\s*captured/,
  "Asynchronous capture must not write through an array reference captured before awaiting compression/storage."
);
assert.match(
  photoChangeSource,
  /finally \{[\s\S]*selectedInput\.value = "";[\s\S]*finishPhotoCapture\(\);/,
  "The camera interaction guard must remain active until asynchronous capture cleanup finishes."
);

const cameraInputs = driverSource.match(/<input[^>]*data-photo-source="camera"[^>]*>/g) || [];
const galleryInputs = driverSource.match(/<input[^>]*data-photo-source="gallery"[^>]*>/g) || [];
assert.equal(cameraInputs.length, 3, "Ordinary job, BIN evidence, and DVIR slots must each retain a camera input.");
assert.equal(galleryInputs.length, 3, "Ordinary job, BIN evidence, and DVIR slots must each expose a gallery input.");
assert.ok(cameraInputs.every((input) => /\bcapture=/.test(input)), "Camera inputs must retain the mobile capture hint.");
assert.ok(galleryInputs.every((input) => !/\bcapture=/.test(input)), "Gallery inputs must omit capture so the native library can open.");
assert.match(
  driverCss,
  /\.photo-modal > \.photo-panel\s*\{[\s\S]*max-height:\s*calc\(100dvh - 24px\)[\s\S]*overflow-y:\s*auto/,
  "The expanded photo and remark popup must remain scrollable on short mobile screens."
);

const takePhotoSource = actionSection('if (action === "take-photo")', 'if (action === "choose-gallery-photo")');
const galleryPhotoSource = actionSection('if (action === "choose-gallery-photo")', 'if (action === "take-dvir-photo")');
const takeDvirPhotoSource = actionSection('if (action === "take-dvir-photo")', 'if (action === "choose-dvir-gallery-photo")');
const galleryDvirPhotoSource = actionSection('if (action === "choose-dvir-gallery-photo")', 'if (action === "add-job-photo")');
for (const [section, label] of [
  [takePhotoSource, "Job camera"],
  [galleryPhotoSource, "Job gallery"],
  [takeDvirPhotoSource, "DVIR camera"],
  [galleryDvirPhotoSource, "DVIR gallery"]
]) {
  assert.ok(
    section.indexOf("beginPhotoCapture()") >= 0
      && section.indexOf("beginPhotoCapture()") < section.indexOf("input.click()"),
    `${label} must mark capture active before opening the native camera.`
  );
}
assert.match(galleryPhotoSource, /data-photo-source="gallery"/);
assert.match(galleryDvirPhotoSource, /data-photo-source="gallery"/);
assert.match(
  photoChangeSource,
  /input\[type='file'\]\[data-photo-index\][\s\S]*input\[type='file'\]\[data-dvir-photo-index\][\s\S]*captureAndStore/,
  "Camera and gallery files must share the exact compression and IndexedDB evidence path."
);

assert.match(driverSource, /const DRIVER_REMARK_MAX_LENGTH = 1000/);
assert.match(
  driverSource,
  /data-driver-photo-remark[\s\S]{0,120}maxlength="\$\{DRIVER_REMARK_MAX_LENGTH\}"/,
  "The photo popup must expose a length-limited driver remark."
);
const remarkInputStart = driverSource.indexOf('app.addEventListener("input"');
const remarkInputEnd = driverSource.indexOf('app.addEventListener("change"', remarkInputStart);
const remarkInputSource = driverSource.slice(remarkInputStart, remarkInputEnd);
assert.match(
  remarkInputSource,
  /data-driver-photo-remark[\s\S]*markDriverInteraction\(\)[\s\S]*driverRemark =[\s\S]*persistDriverRemarkDraft/,
  "Typing a remark must protect the active modal and persist its draft locally."
);
assert.match(
  driverSource,
  /async function restoreDriverRemarkDraft[\s\S]*DriverOfflineDB\.getMeta[\s\S]*restoreEpoch !== driverInteractionEpoch/,
  "A saved remark must restore on reopen without overwriting a newer driver interaction."
);
const completionSource = actionSection('if (action === "complete-job"', '\n});\n\napp.addEventListener("input"');
assert.match(
  completionSource,
  /const submittedDriverRemark = normalizedDriverRemark\(\)[\s\S]*queueDriverEvent\("job_completed"[\s\S]*driverRemark: submittedDriverRemark/,
  "Offline completion must commit the remark in the same local event as its photo evidence."
);
assert.match(
  completionSource,
  /photoDataUrls: uploadedPhotos,[\s\S]*driverRemark: submittedDriverRemark/,
  "The legacy online completion path must also submit the driver remark."
);
assert.ok(
  completionSource.indexOf('queueDriverEvent("job_completed"') < completionSource.indexOf('driverRemark = ""'),
  "The offline UI must not clear a remark until its completion event is durable locally."
);
assert.match(
  serverSource,
  /completeDriverJobOperationalEffects\([\s\S]*driverRemark[\s\S]*recordDriverJobPhotos[\s\S]*driverRemark/,
  "Online and offline completion must pass the remark through their shared operational function."
);

const pageshowStart = driverSource.indexOf('window.addEventListener("pageshow"');
const pageshowEnd = driverSource.indexOf('document.addEventListener("visibilitychange"', pageshowStart);
const pageshowSource = driverSource.slice(pageshowStart, pageshowEnd);
const visibilityStart = pageshowEnd;
const visibilityEnd = driverSource.indexOf("window.setInterval(", visibilityStart);
const visibilitySource = driverSource.slice(visibilityStart, visibilityEnd);
const onlineResumeSource = sourceSection(
  driverSource,
  "async function resumeOnlineDriver",
  'window.addEventListener("online"'
);
assert.match(
  onlineResumeSource,
  /activeRest \|\| photoInteractionActive\(\)[\s\S]*quietSyncRefreshQueued = true;[\s\S]*onlineRouteRevalidationQueued = true;[\s\S]*if \(synchronizeProtectedScreen\)[\s\S]*triggerOfflineSync\(\{ suppressHold: true \}\)[\s\S]*else \{[\s\S]*triggerOfflineSync\(\)/,
  "Returning from the native camera or an active rest must defer page-show synchronization and route revalidation."
);
assert.match(
  pageshowSource,
  /navigator\.onLine[\s\S]*resumeOnlineDriver\("pageshow"\)/,
  "Page-show recovery must pass through the protected-screen-aware online resume gate."
);
assert.match(
  visibilitySource,
  /document\.visibilityState === "visible"[\s\S]*navigator\.onLine[\s\S]*resumeOnlineDriver\("visibility"\)/,
  "Visibility recovery must defer synchronization and route revalidation during a protected interaction."
);
assert.match(
  driverSource,
  /function photoInteractionActive\(\) \{[\s\S]*photoCaptureInProgress[\s\S]*photoPromptOpen[\s\S]*dvirMode/,
  "The DVIR screen itself must protect a long-running first camera capture from live refresh."
);
assert.match(
  driverSource,
  /function flushDeferredLiveRefresh[\s\S]*\|\| photoInteractionActive\(\)[\s\S]*queueLiveRefresh\(\);[\s\S]*if \(action === "close-photo"\)[\s\S]*flushDeferredLiveRefresh\(\);/,
  "Closing a protected photo modal must release any live update deferred during capture."
);
assert.match(
  driverSource,
  /routeManifestExpired\(\)[\s\S]{0,500}t\("driver\.offlineReadOnly", "Offline · Read-only"\)/
);
const offlineStatusSource = actionSection("function renderOfflineStatus", "async function refreshOfflineHealth");
assert.match(
  offlineStatusSource,
  /else if \(!navigator\.onLine\) \{[\s\S]*tf\("driver\.offlinePendingCount", "Offline · \{count\} pending"[\s\S]*else if \(pending\) \{[\s\S]*tf\("driver\.syncIssuePendingCount", "Sync issue · \{count\} pending"/,
  "Only a genuine browser-offline state may label pending synchronization as Offline."
);
const refreshOfflineHealthSource = actionSection("async function refreshOfflineHealth", "async function requestPersistentStorage");
assert.match(
  refreshOfflineHealthSource,
  /getSyncState[\s\S]*retainedWorkCount > 0 && \(offlineRetainedClientError \|\| offlineSyncState\?\.lastError\)[\s\S]*offlineRetainedClientError\?\.message \|\| offlineSyncState\.lastError/,
  "Pending saved work must retain an in-memory IndexedDB failure and restore its persisted copy after a page refresh."
);
assert.doesNotMatch(
  driverSource,
  /await window\.DriverOfflineSync\.registerBackgroundSync\(\)/,
  "Best-effort Background Sync registration must never stall immediate page-open synchronization."
);
assert.match(
  driverHtml,
  /id="driverSyncHold"[\s\S]*aria-modal="true"[\s\S]*aria-labelledby="driverSyncHoldTitle"[\s\S]*aria-describedby="driverSyncHoldMessage"[\s\S]*tabindex="-1"[\s\S]*data-driver-sync-title[\s\S]*data-driver-sync-message/
);
assert.match(
  driverCss,
  /\.driver-sync-hold\s*\{[\s\S]*position:\s*fixed[\s\S]*z-index:\s*10000/,
  "Quiet sync must cover and hold the complete Driver screen."
);
assert.match(
  driverCss,
  /prefers-reduced-motion:\s*reduce[\s\S]*\.driver-sync-spinner\s*\{[\s\S]*animation:\s*none/,
  "The quiet-sync hold must respect reduced-motion preferences."
);
const quietSyncStart = driverSource.indexOf("async function triggerOfflineSync");
const quietSyncEnd = driverSource.indexOf("async function queueDriverEvent", quietSyncStart);
const quietSyncSource = driverSource.slice(quietSyncStart, quietSyncEnd);
assert.match(
  quietSyncSource,
  /const holdAllowed = !suppressHold && !activeRest && !photoInteractionActive\(\);[\s\S]*holdScreen: navigator\.onLine && holdAllowed[\s\S]*if \(navigator\.onLine && holdAllowed[\s\S]*requestQuietSyncHold/,
  "Active rest, photo interaction, and explicitly suppressed local-first sync must never raise the blocking hold."
);
assert.ok(
  quietSyncSource.indexOf("beginQuietSync(")
    < quietSyncSource.indexOf("syncCapturedPartition(")
    && quietSyncSource.indexOf("syncCapturedPartition(")
      < quietSyncSource.indexOf("reconcilePendingDutyEvents(")
    && quietSyncSource.indexOf("reconcilePendingDutyEvents(")
      < quietSyncSource.indexOf("renderQuietSyncFinalState(")
    && quietSyncSource.indexOf("renderQuietSyncFinalState(")
      < quietSyncSource.lastIndexOf("endQuietSync("),
  "Quiet sync must hold the screen for the full batch and reveal only one final route refresh."
);
const quietSyncCatchStart = quietSyncSource.indexOf("} catch (error) {");
const quietSyncFinallyStart = quietSyncSource.indexOf("} finally {", quietSyncCatchStart);
const quietSyncCatchSource = quietSyncSource.slice(quietSyncCatchStart, quietSyncFinallyStart);
const quietSyncFinallySource = quietSyncSource.slice(quietSyncFinallyStart);
assert.ok(
  quietSyncCatchStart >= 0 && quietSyncFinallyStart > quietSyncCatchStart,
  "Could not isolate failed quiet-sync handling."
);
assert.doesNotMatch(
  quietSyncCatchSource,
  /renderQuietSyncFinalState|loadNextJob|queueLiveRefresh/,
  "A failed quiet sync must not replace local-first state with a live server refresh."
);
assert.match(
  quietSyncCatchSource,
  /if \(offlineManifest && activeView === "job" && !activeRest && !photoInteractionActive\(\)\)[\s\S]*renderOfflineProjection\(offlineManifest\)/,
  "Failed sync may re-project the retained ledger only when no active rest or photo interaction can be overwritten."
);
assert.match(
  quietSyncSource,
  /if \(offlineManifest && activeView === "job" && !activeRest && !photoInteractionActive\(\)\) \{[\s\S]*renderOfflineProjection\(offlineManifest\);[\s\S]*\} else \{[\s\S]*refreshPendingSamsaraReconciliations\(\);/,
  "Successful synchronization must also preserve a live server rest until the final authoritative refresh."
);
assert.match(
  quietSyncFinallySource,
  /if \(syncSucceeded && !quietSyncActive\(\) && quietSyncRefreshQueued\)[\s\S]*if \(!activeRest && !photoInteractionActive\(\)\)[\s\S]*queueLiveRefresh\(\)/,
  "A deferred live refresh must require successful sync and no active rest or photo interaction."
);
assert.match(
  quietSyncSource,
  /syncError = error[\s\S]*return \{[\s\S]*ok: syncSucceeded,[\s\S]*error: syncError/,
  "Quiet sync must return the exact failure to callers that guard destructive recovery."
);
assert.match(
  quietSyncSource,
  /syncResult\?\.reviewRequired[\s\S]*Synchronization needs Dispatch review\.[\s\S]*Synchronization complete/,
  "A synchronized event awaiting review must not be announced as complete."
);
const clientSyncReporterSource = actionSection(
  "async function reportDriverClientSyncStatus",
  "function quietFinalRefreshSafe"
);
assert.match(clientSyncReporterSource, /fetch\("\/api\/driver\/sync-status"/);
assert.match(clientSyncReporterSource, /Authorization:[\s\S]*X-MBBS-Driver-Device/);
assert.doesNotMatch(
  clientSyncReporterSource,
  /DriverOfflineDB|indexedDB/,
  "Client sync-error reporting must remain usable when IndexedDB itself is failing."
);
assert.match(quietSyncSource, /reportDriverClientSyncStatus\("ok"[\s\S]*reportDriverClientSyncStatus\("error"/);
assert.match(
  quietSyncSource,
  /retainedWorkCount > 0[\s\S]*getSyncState\(context\.partitionKey\)[\s\S]*offlineRetainedClientError[\s\S]*retainedError[\s\S]*reportDriverClientSyncStatus\("error"[\s\S]*else void reportDriverClientSyncStatus\("ok"/,
  "Retained local work with a persisted failure must not be overwritten by a healthy telemetry report."
);
const finishForegroundSource = actionSection(
  "async function finishForegroundEvent",
  "async function deferForegroundEvent"
);
assert.match(
  finishForegroundSource,
  /markForegroundApplied[\s\S]*catch \(error\)[\s\S]*offlineRetainedClientError = error[\s\S]*reportDriverClientSyncStatus\("error"[\s\S]*recordSyncError[\s\S]*foregroundLocalReceiptFailed = true[\s\S]*throw error/,
  "A server-applied foreground action whose local receipt transaction fails must retain and report the exact error for safe replay."
);
assert.match(
  driverSource,
  /function foregroundOutcomeUncertain\(error\)[\s\S]*foregroundLocalReceiptFailed[\s\S]*await deferForegroundEvent\(foregroundEvent\)/,
  "A failed local foreground receipt must remain pending for receipt reconciliation instead of being cancelled after the server action succeeded."
);
assert.match(
  driverSource,
  /function requestQuietSyncHold[\s\S]*setQuietSyncBackgroundInert\(true\)[\s\S]*setTimeout/,
  "Automatic quiet sync must block input immediately, even when the visual hold is briefly delayed."
);
assert.match(
  driverSource,
  /async function waitForForeignSyncLease[\s\S]*getLease\(context\.partitionKey\)[\s\S]*async function syncCapturedPartition[\s\S]*error\.code !== "sync_leased"[\s\S]*waitForForeignSyncLease\(context\)/,
  "The page must hold through a service-worker-owned synchronization lease and retry the final drain."
);
assert.match(offlineDbSource, /async function getLease\(partitionKey\)[\s\S]*getLease,[\s\S]*releaseLease/);
assert.match(
  driverSource,
  /function captureQuietSyncContext[\s\S]*sessionGeneration[\s\S]*async function assertQuietSyncContext[\s\S]*storedProfile\.sessionGeneration !== context\.sessionGeneration/,
  "Quiet sync must remain bound to the exact authenticated driver partition and session."
);
assert.match(
  driverSource,
  /rememberQuietSyncEvents\(savedEvents\)[\s\S]*syncCapturedPartition\(context\)/
);
assert.match(
  driverSource,
  /function isQuietSyncEcho[\s\S]*payload\?\.source !== "offline_sync"[\s\S]*if \(isQuietSyncEcho\(event\)\) return;[\s\S]{0,350}if \(quietSyncActive\(\)\)/,
  "Delayed SSE echoes for the locally synchronized batch must not replay route screens."
);
assert.match(
  driverSource,
  /event\.type === "driver\.offline\.review\.resolved"[\s\S]*triggerOfflineSync\(\);[\s\S]*return;/,
  "A Dispatch resolution must synchronize its terminal result back into the local review ledger."
);
const offlineApplySource = serverSource.slice(
  serverSource.indexOf("async function applyDriverOfflineEvent"),
  serverSource.indexOf("async function driverOfflineReviewWithCurrentPlan")
);
for (const marker of [
  'emitAppEvent("driver.job.started"',
  'emitAppEvent("driver.job.completed"',
  'emitAppEvent("driver.rest.started"',
  'emitAppEvent("driver.rest.ended"',
  '? "driver.truck.switch.attention"',
  'emitAppEvent("driver.dvir.pending_online"'
]) {
  const markerIndex = offlineApplySource.indexOf(marker);
  assert.ok(markerIndex >= 0, `Missing offline event emission: ${marker}`);
  assert.match(
    offlineApplySource.slice(markerIndex, markerIndex + 550),
    /eventId:\s*event\.eventId,[\s\S]*source:\s*emissionSource/,
    `${marker} must carry its originating event ID.`
  );
}
assert.match(
  serverSource,
  /applyDriverOfflineReviewResolution[\s\S]*emissionSource:\s*"offline_review_resolution"/
);
assert.match(
  serverSource,
  /replayBlocked:[\s\S]*emissionSource:\s*"offline_review_resolution"/
);
assert.match(
  driverSource,
  /async function renderQuietSyncFinalState[\s\S]*do \{[\s\S]*quietSyncRefreshQueued = false;[\s\S]*await loadNextJob\(\);[\s\S]*\} while \(quietSyncRefreshQueued/,
  "The final held refresh must repeat when a new live event arrives during its request."
);
const initSource = driverSource.slice(
  driverSource.indexOf("async function init()"),
  driverSource.indexOf('window.addEventListener("mbbs-language-changed"')
);
assert.ok(
  initSource.indexOf("prepareQuietSyncHoldForSavedWork()")
    < initSource.indexOf("await loadNextJob()"),
  "A reopened route with pending work must be held before the first server route render."
);
assert.match(
  driverSource,
  /if \(quietSyncActive\(\)\) \{\s*quietSyncRefreshQueued = true;\s*return;\s*\}[\s\S]{0,1200}queueLiveRefresh\(\)/,
  "Live server events must be coalesced while quiet synchronization is active."
);

const restEndSource = actionSection('if (action === "end-rest")', 'if (action === "close-photo")');
assert.match(
  restEndSource,
  /restId: activeRest\?\.restId \|\| activeRest\?\.id \|\| null/,
  "Rest end must prefer the server/local canonical restId before the legacy id alias."
);
const projectionStart = driverSource.indexOf("function projectOfflineRoute");
const projectionEnd = driverSource.indexOf("async function restoreDraftPhotos", projectionStart);
const projectionSource = driverSource.slice(projectionStart, projectionEnd);
assert.match(
  projectionSource,
  /event\.eventType === "rest_started"[\s\S]*projectedRest = \{[\s\S]*id: event\.details\?\.restId \|\| event\.eventId,[\s\S]*restId: event\.details\?\.restId \|\| event\.eventId/,
  "The local rest projection must retain canonical restId for a later end event."
);

assert.match(
  driverSource,
  /contentFingerprint: job\.contentFingerprint[\s\S]*routeBootstrap\?\.currentJobContentFingerprint/,
  "Live jobs must retain the server's full stop-content fingerprint in addition to operational identity."
);
assert.match(
  driverSource,
  /function authoritativeJobChanged[\s\S]*previousFingerprint[\s\S]*authoritative\.fingerprint[\s\S]*previousContent[\s\S]*authoritative\.contentFingerprint[\s\S]*comparableJobDetails/,
  "Online route checks must compare both fingerprints and a full stop-detail fallback."
);
const routeReconciliationSource = sourceSection(
  driverSource,
  "const DRIVER_ROUTE_RECONCILIATION = Object.freeze({",
  "function jobEventRequiresManifestIdentity("
);
const buildRouteReconciliationHarness = new Function(
  "manifestJobFor",
  "comparableJobDetails",
  "jobIsComplete",
  `${routeReconciliationSource}\nreturn { classifyAuthoritativeRoute };`
);
let routeReconciliationManifest = null;
const { classifyAuthoritativeRoute } = buildRouteReconciliationHarness(
  (jobId) => (routeReconciliationManifest?.jobs || []).find((job) => String(job.jobId) === String(jobId)) || null,
  (job) => ({
    jobId: job?.jobId || "",
    planId: job?.planId ?? null,
    planDate: job?.planDate || "",
    stopId: job?.stopId || "",
    address: job?.address || "",
    requiredPhotos: Number(job?.requiredPhotos || 0)
  }),
  (job) => ["complete", "completed", "done"].includes(String(job?.status || "").toLowerCase())
);
routeReconciliationManifest = {
  manifestId: "manifest-sety-r41",
  planId: 208,
  planDate: "2026-08-05",
  planRevision: 41,
  jobs: [
    {
      jobId: "sety-pickup",
      planId: 208,
      planDate: "2026-08-05",
      status: "in_progress",
      fingerprint: "pickup-fingerprint",
      predecessorFingerprint: "route-start",
      stopId: "pickup-stop",
      address: "12441 Woodbine Ave",
      requiredPhotos: 2
    },
    {
      jobId: "sety-dropoff",
      planId: 208,
      planDate: "2026-08-05",
      status: "pending",
      fingerprint: "dropoff-fingerprint",
      predecessorFingerprint: "pickup-fingerprint",
      stopId: "dropoff-stop",
      address: "8821 Weston Rd",
      requiredPhotos: 2
    },
    {
      jobId: "sety-later-stop",
      planId: 208,
      planDate: "2026-08-05",
      status: "pending",
      fingerprint: "later-fingerprint",
      predecessorFingerprint: "dropoff-fingerprint",
      stopId: "later-stop",
      address: "Later",
      requiredPhotos: 0
    }
  ]
};
const setyLocalSuccessor = { ...routeReconciliationManifest.jobs[1] };
const setyAuthoritativePredecessor = {
  job: { ...routeReconciliationManifest.jobs[0] },
  routeBootstrap: {
    currentJobFingerprint: "pickup-fingerprint",
    predecessorFingerprint: "route-start"
  }
};
const completionEvent = (status, overrides = {}) => ({
  eventId: `completion-${status}`,
  eventType: "job_completed",
  jobId: "sety-pickup",
  effectiveJobId: "sety-pickup",
  status,
  ...overrides
});
for (const status of ["pending", "registered", "waiting_photos", "foreground_pending", "receipt_pending"]) {
  assert.equal(
    classifyAuthoritativeRoute(setyLocalSuccessor, setyAuthoritativePredecessor, {
      manifest: routeReconciliationManifest,
      events: [completionEvent(status)],
      dispatchRouteChanged: false
    }),
    "local_progress_pending",
    `${status} predecessor completion must preserve Sety's locally projected successor.`
  );
}
for (const status of ["review_required", "blocked", "resolution_pending"]) {
  assert.equal(
    classifyAuthoritativeRoute(setyLocalSuccessor, setyAuthoritativePredecessor, {
      manifest: routeReconciliationManifest,
      events: [completionEvent(status)],
      dispatchRouteChanged: false
    }),
    "local_progress_review",
    `${status} predecessor completion must stop local progress for review without claiming Dispatch changed the route.`
  );
}
assert.equal(
  classifyAuthoritativeRoute(setyLocalSuccessor, setyAuthoritativePredecessor, {
    manifest: routeReconciliationManifest,
    events: [completionEvent("waiting_photos")],
    dispatchRouteChanged: true
  }),
  "dispatch_route_changed",
  "A real plan revision must take precedence over a same-device pending completion."
);
assert.equal(
  classifyAuthoritativeRoute(setyLocalSuccessor, setyAuthoritativePredecessor, {
    manifest: routeReconciliationManifest,
    events: [],
    dispatchRouteChanged: false
  }),
  "server_execution_changed",
  "A different server stop without a local completion bridge must be reported as unexplained server movement."
);
assert.equal(
  classifyAuthoritativeRoute(setyLocalSuccessor, setyAuthoritativePredecessor, {
    manifest: routeReconciliationManifest,
    events: [completionEvent("applied")],
    dispatchRouteChanged: false
  }),
  "server_execution_changed",
  "An already-applied completion cannot justify preserving a divergent local successor."
);
assert.equal(
  classifyAuthoritativeRoute(setyLocalSuccessor, setyAuthoritativePredecessor, {
    manifest: routeReconciliationManifest,
    events: [completionEvent("waiting_photos", { reviewRequired: true })],
    dispatchRouteChanged: false
  }),
  "local_progress_review",
  "An explicit review flag must override an otherwise retryable completion status."
);
const completedBaseManifest = {
  ...routeReconciliationManifest,
  jobs: routeReconciliationManifest.jobs.map((job, index) => index === 0 ? { ...job, status: "completed" } : job)
};
routeReconciliationManifest = completedBaseManifest;
assert.equal(
  classifyAuthoritativeRoute(setyLocalSuccessor, setyAuthoritativePredecessor, {
    manifest: completedBaseManifest,
    events: [],
    dispatchRouteChanged: false
  }),
  "server_execution_changed",
  "Completed base manifest rows without a retained completion event cannot fabricate a local-progress bridge."
);
routeReconciliationManifest = {
  ...completedBaseManifest,
  jobs: completedBaseManifest.jobs.map((job, index) => index === 0 ? { ...job, status: "in_progress" } : job)
};
assert.equal(
  classifyAuthoritativeRoute(routeReconciliationManifest.jobs[2], setyAuthoritativePredecessor, {
    manifest: routeReconciliationManifest,
    events: [completionEvent("waiting_photos")],
    dispatchRouteChanged: false
  }),
  "server_execution_changed",
  "A pending predecessor completion cannot skip an incomplete intervening stop."
);
assert.equal(
  classifyAuthoritativeRoute(routeReconciliationManifest.jobs[0], setyAuthoritativePredecessor, {
    manifest: routeReconciliationManifest,
    events: [],
    dispatchRouteChanged: false
  }),
  "unchanged",
  "Matching authoritative and local stops must remain unchanged."
);
const onlineRevalidationSource = driverSource.slice(
  driverSource.indexOf("async function revalidateOnlineRoute"),
  driverSource.indexOf("function captureQuietSyncContext")
);
assert.match(
  onlineRevalidationSource,
  /request\(`\/api\/driver\/next-job\?revalidate=[\s\S]*fetchDriverDayPlanPayload\(planDate,[\s\S]*saveDriverDayPlanPayload/,
  "Online route revalidation must check the current stop and refresh the complete day before allowing actions."
);
assert.match(
  onlineRevalidationSource,
  /protectedInteraction[\s\S]*requestedActivation[\s\S]*onlineRouteUpdatePending = true[\s\S]*return false/,
  "A changed stop must be held without replacing an active rest or photo screen."
);
assert.match(
  onlineRevalidationSource,
  /local_progress_pending[\s\S]*Previous stop saved locally[\s\S]*photos are still synchronizing[\s\S]*return true/,
  "A same-plan pending completion must keep the local successor actionable and explain that photo sync is still running."
);
assert.match(
  onlineRevalidationSource,
  /local_progress_review[\s\S]*needs Dispatch review[\s\S]*return false/,
  "A reviewed predecessor completion must block the successor with review wording rather than a false route-change warning."
);
assert.match(
  onlineRevalidationSource,
  /server_execution_changed[\s\S]*server is on a different stop/,
  "Unexplained server movement must use neutral server-state wording instead of blaming Dispatch."
);
for (const [start, end, label] of [
  ['if (action === "start-job"', 'if (action === "confirm-truck-switch"', "Job start"],
  ['if (action === "confirm-truck-switch"', 'if (action === "skip-samsara-switch"', "Truck switch"],
  ['if (action === "skip-samsara-switch"', 'if (action === "complete-job"', "Skipped truck switch"],
  ['if (action === "complete-job"', '\n});\n\napp.addEventListener("input"', "Job completion"]
]) {
  const section = actionSection(start, end);
  assert.ok(
    section.indexOf("ensureAuthoritativeJobBeforeAction") >= 0
      && section.indexOf("ensureAuthoritativeJobBeforeAction") < section.indexOf("prepareOfflineRecord"),
    `${label} must revalidate before committing an event to the local ledger.`
  );
}
const photoOpenSource = actionSection('if (action === "show-photo")', 'if (action === "recheck-location")');
assert.ok(
  photoOpenSource.indexOf("ensureAuthoritativeJobBeforeAction")
    < photoOpenSource.indexOf("photoPromptOpen = true"),
  "A photo-required stop must be revalidated before opening its protected photo workflow."
);
assert.match(
  driverSource,
  /ONLINE_ROUTE_REVALIDATE_MS = 45000[\s\S]*function scheduleOnlineRouteRevalidation[\s\S]*document\.visibilityState !== "visible"[\s\S]*activeRest \|\| photoInteractionActive\(\)[\s\S]*revalidateOnlineRoute/,
  "A visible online Driver tab must periodically recheck the route without interrupting protected screens."
);

const replaceCacheStart = offlineDbSource.indexOf("async function replaceTerminalRouteCache");
const replaceCacheEnd = offlineDbSource.indexOf("async function saveBootstrap", replaceCacheStart);
const replaceCacheSource = offlineDbSource.slice(replaceCacheStart, replaceCacheEnd);
assert.ok(replaceCacheStart >= 0 && replaceCacheEnd > replaceCacheStart, "Could not isolate safe route-cache replacement.");
assert.match(
  replaceCacheSource,
  /blockingEvents = events\.filter[\s\S]*!eventIsRetainedTerminal[\s\S]*protectedPhotos = photos\.filter[\s\S]*await completion;[\s\S]*driver_route_cache_not_clearable/,
  "Manual route clearing must refuse atomically while any unsynchronized event or evidence exists."
);
assert.ok(
  replaceCacheSource.indexOf("blockingEvents.length") < replaceCacheSource.indexOf("events.forEach"),
  "No terminal cache record may be deleted before the transaction proves that evidence is clearable."
);
assert.match(
  replaceCacheSource,
  /events\.forEach[\s\S]*manifests\.forEach[\s\S]*manifestsStore\.put\(manifestRecord\)[\s\S]*jobsStore\.put[\s\S]*activeManifest::\$\{partitionKey\}/,
  "Clearing must atomically replace the old terminal route with the already-fetched complete manifest."
);
assert.match(
  replaceCacheSource,
  /transaction\(\["profiles",[\s\S]*profilesStore\.get\(partitionKey\)[\s\S]*!profile[\s\S]*profile\.locked[\s\S]*driver_session_changed/,
  "Route-cache replacement must hold the Driver profile in the same transaction and refuse a logout or session change."
);
assert.doesNotMatch(replaceCacheSource, /profilesStore\.delete|DEVICE_ID_KEY|sequence::|deleteDatabase/);
const clearCacheSource = driverSource.slice(
  driverSource.indexOf("async function clearSavedRouteCache"),
  driverSource.indexOf("function escapeHtml")
);
assert.ok(
  clearCacheSource.indexOf("fetchDriverDayPlanPayload")
    < clearCacheSource.indexOf("replaceTerminalRouteCache"),
  "Clear saved route must fetch a complete replacement before the atomic IndexedDB replacement."
);
assert.match(clearCacheSource, /forceRefresh: true/);
assert.match(
  clearCacheSource,
  /const syncResult = await triggerOfflineSync[\s\S]*if \(!syncResult\?\.ok && syncResult\?\.error\) throw syncResult\.error[\s\S]*fetchDriverDayPlanPayload/,
  "Manual route clearing must stop on and preserve the exact synchronization error."
);
assert.match(clearCacheSource, /getSyncState\(partitionKey\)[\s\S]*persistedSyncState\?\.lastError/);
assert.match(
  clearCacheSource,
  /offlineRetainedClientError\?\.message[\s\S]*persistedSyncState\?\.lastError[\s\S]*Saved work is still pending/,
  "Clear saved route must preserve the exact in-memory failure even when IndexedDB cannot persist its own error metadata."
);
const driverLoginSource = actionSection('app.addEventListener("submit"', "async function initializeOfflineStorage");
assert.match(
  driverLoginSource,
  /initialSyncResult = await triggerOfflineSync[\s\S]*initialSyncResult\?\.error[\s\S]*initialSyncResult\?\.retainedError[\s\S]*Welcome/,
  "The login welcome toast must not mask an initial synchronization failure."
);
assert.match(
  clearCacheSource,
  /replaceTerminalRouteCache\(partitionKey, payload, \{[\s\S]*expectedSessionGeneration: clearContext\?\.sessionGeneration/,
  "Manual route clearing must bind the replacement to the session generation captured before synchronization."
);
assert.match(driverSource, /data-offline-action="clear"[\s\S]*Clear saved route/);
assert.match(
  driverSource,
  /"dispatch\.orders\.updated"[\s\S]*"driver\.job\.reopened"/,
  "Order updates and reopened stops must immediately refresh the online Driver route through SSE."
);
assert.match(
  serverSource,
  /app\.post\("\/api\/driver\/sync-status", requireDriver[\s\S]*driverDeviceId\(req, \{ required: true, allowBody: false \}\)[\s\S]*recordDriverClientSyncStatus/,
  "Only an authenticated Driver session may report client sync status."
);
assert.match(
  serverSource,
  /app\.get\("\/api\/dispatch\/driver-pwa\/stops"[\s\S]*listDriverClientSyncIssues[\s\S]*clientSyncIssues[\s\S]*clientSyncIssueCount/,
  "The Dispatch Driver-stops response must include current device-side sync errors."
);
assert.match(
  sourceSection(
    serverSource,
    'app.get("/api/dispatch/offline-review/count"',
    'app.get("/api/dispatch/driver-pwa/stops"'
  ),
  /getDriverOfflineReviewCounts\(\)[\s\S]*listDriverClientSyncIssues\(\{ limit: 500 \}\)[\s\S]*clientSyncIssueCount/,
  "The Dispatch Driver PWA badge must include device-only failures that have not produced a server event."
);
const offlineReviewListRouteSource = sourceSection(
  serverSource,
  'app.get("/api/dispatch/offline-review"',
  'app.get("/api/dispatch/offline-review/:eventId/photos/:photoId"'
);
assert.match(
  offlineReviewListRouteSource,
  /Promise\.all\([\s\S]*listDriverOfflineReviews\([\s\S]*listDriverClientSyncIssues\([\s\S]*clientSyncIssues[\s\S]*clientSyncIssueCount/,
  "Open Sync review must return device-only synchronization failures separately from server event cases."
);
assert.match(
  offlineReviewListRouteSource,
  /status === "open" \|\| status === "all"[\s\S]*planDate,[\s\S]*driverLogin,[\s\S]*limit: 500/,
  "Device sync issues in Sync review must support optional date and driver filters without hiding global warnings."
);
assert.match(
  offlineReviewListRouteSource,
  /:\s*Promise\.resolve\(\[\]\)/,
  "Resolved Sync review must not present active device telemetry as a resolved server case."
);
assert.match(dispatchOfflineReviewSource, /Driver device sync issues[\s\S]*Do not clear browser or site data[\s\S]*errorMessage[\s\S]*reviewRequiredCount/);
assert.match(
  dispatchOfflineReviewSource,
  /offlineReviewClientSyncIssues\s*=\s*driverPwaExtractClientSyncIssues\(payload\)[\s\S]*driverPwaRenderClientSyncIssues\(deviceIssues,\s*\{\s*showStopShortcut:\s*true,\s*allowDismiss:\s*true\s*\}\)/,
  "Sync review must render device-reported failures separately from server review cases."
);
assert.match(
  dispatchOfflineReviewSource,
  /data-form="device-sync-dismiss"[\s\S]*Mandatory audit note[\s\S]*confirmDismiss[\s\S]*Dismiss device warning[\s\S]*expectedReportedAt:\s*reportedAt,[\s\S]*auditNote/,
  "Dispatch must explicitly confirm and audit a device warning dismissal against the exact report timestamp."
);
assert.match(
  dispatchOfflineReviewSource,
  /\$\{OFFLINE_REVIEW_LIST_ENDPOINT\}\/device-issues\/\$\{encodeURIComponent\(sessionId\)\}\/dismiss/,
  "The device warning dismissal must use the dispatcher-only endpoint."
);
assert.match(
  driverSource,
  /lastError \? t\("driver\.retrySync", "Retry sync"\) : t\("driver\.syncNow", "Sync now"\)/
);
assert.match(driverHtml, /driver-offline-db\.js\?v=20260808-yard-dependency-v1/);
assert.match(driverHtml, /driver-photo-hash\.js\?v=20260808-yard-dependency-v1/);
assert.match(driverHtml, /driver-offline-photos\.js\?v=20260808-yard-dependency-v1/);
assert.match(driverHtml, /driver-offline-sync\.js\?v=20260808-yard-dependency-v1/);
assert.match(driverHtml, /driver-bin-ui\.js\?v=20260803-bin-pwa-v1/);
assert.match(driverHtml, /driver\.js\?v=20260808-yard-dependency-v1/);
assert.match(driverWorker, /DRIVER_CACHE_NAME = `\$\{DRIVER_CACHE_PREFIX\}v20`/);
assert.match(driverWorker, /driver-offline-db\.js\?v=20260808-yard-dependency-v1/);
assert.match(driverWorker, /driver-photo-hash\.js\?v=20260808-yard-dependency-v1/);
assert.match(driverWorker, /driver-offline-photos\.js\?v=20260808-yard-dependency-v1/);
assert.match(driverWorker, /driver-offline-sync\.js\?v=20260808-yard-dependency-v1/);
assert.match(driverWorker, /driver-bin-ui\.js\?v=20260803-bin-pwa-v1/);
assert.match(driverWorker, /driver\.js\?v=20260808-yard-dependency-v1/);
assert.match(
  offlineSyncSource,
  /if \(!response\.ok\)[\s\S]*error\.status = response\.status;[\s\S]*error\.code = String\(payload\.code \|\| ""\)/,
  "Device telemetry must retain the server error code for actionable sync diagnostics."
);
assert.match(
  offlineSyncSource,
  /repaired\.syncPayload[\s\S]*return repaired\.syncPayload;[\s\S]*sealEventSyncPayload\([\s\S]*repaired\.partitionKey,[\s\S]*repaired\.eventId,[\s\S]*payload/,
  "The first submitted event payload must be sealed locally and reused for every exact retry."
);
assert.match(
  offlineDbSource,
  /lost[\s\S]*HTTP response[\s\S]*event\.syncPayload[\s\S]*return event;[\s\S]*candidate\.syncPayload[\s\S]*candidate\.receivedAt/,
  "Local repair must never mutate a sealed event, including while repairing later duplicate completions."
);
assert.match(
  offlineDbSource,
  /async function sealEventSyncPayload[\s\S]*event\.syncPayload[\s\S]*return event\.syncPayload;[\s\S]*syncPayload:\s*payload[\s\S]*syncPayloadSealedAt/,
  "Concurrent sync attempts must converge on the first sealed payload."
);
assert.match(
  offlineDbSource,
  /const syncPayload = \{[\s\S]*eventId,[\s\S]*clientSequence,[\s\S]*photos: photoRecords[\s\S]*syncPayload,[\s\S]*syncPayloadSealedAt: createdAt[\s\S]*eventsStore\.add\(eventRecord\)/,
  "New events must seal their exact payload atomically with their local-first evidence transaction."
);
assert.match(
  offlineDbSource,
  /eventType === "job_completed"[\s\S]*localPayloadRepairSafe === true[\s\S]*eventType === "rest_ended"[\s\S]*localPayloadRepairSafe === true/,
  "Legacy unsealed events must not undergo payload-changing duplicate or rest repair after a possibly lost acknowledgement."
);
assert.match(
  dispatchOfflineReviewSource,
  /data-action="view-device-issue"[\s\S]*data-plan-date=[\s\S]*action === "view-device-issue"[\s\S]*driverPwaStopsDate = planDate/,
  "A device failure in Sync review must link Dispatch to the affected Driver stops date."
);
assert.match(
  dispatchOfflineReviewSource,
  /No server-side review cases\. The device sync issues above still need attention\./,
  "A device-only failure must not leave Sync review showing a misleading wholly-empty state."
);
assert.match(
  dispatchOfflineReviewSource,
  /DRIVER_OFFLINE_OPEN_STATUSES[\s\S]*registered[\s\S]*waiting_photos[\s\S]*resolution_pending[\s\S]*status: offlineReviewFilter/,
  "Open Sync review must include every nonterminal server status."
);
assert.match(
  dispatchOfflineReviewSource,
  /function offlineReviewCanRecover\(value\)[\s\S]{0,300}\["registered", "waiting_photos", "pending", "blocked"\]/,
  "Only stranded states with no active server transaction may expose manual recovery controls."
);
assert.doesNotMatch(
  sourceSection(
    dispatchOfflineReviewSource,
    "function offlineReviewCanRecover(value)",
    "function offlineReviewRecoveryCopy(record)"
  ),
  /applying|resolution_pending/,
  "Applying and resolution-pending records must not enter the manual recovery path."
);
assert.match(
  sourceSection(
    dispatchOfflineReviewSource,
    "function offlineReviewRenderRecovery(record)",
    "function offlineReviewReadOnlyMessage(record)"
  ),
  /data-form=['"]offline-review-recovery['"][\s\S]*data-action=['"]retry-case['"][\s\S]*Close as evidence only/,
  "Stranded registered, waiting-photo, pending, and blocked records must expose retry and audited evidence-only recovery controls."
);
assert.match(
  dispatchOfflineReviewSource,
  /data-form=['"]offline-review-recovery['"][\s\S]*name=['"]auditNote['"][\s\S]*name=['"]confirmEvidenceOnly['"]/,
  "Evidence-only recovery must require both an audit note and an explicit destructive-action confirmation."
);
assert.match(
  dispatchOfflineReviewSource,
  /function offlineReviewRetry\(\)[\s\S]*\$\{OFFLINE_REVIEW_LIST_ENDPOINT\}\/\$\{encodeURIComponent\(eventId\)\}\/retry/,
  "Dispatch retry must call the event-scoped recovery endpoint."
);
assert.match(
  dispatchOfflineReviewSource,
  /offlineReviewResolve\(\{[\s\S]*actionOverride:\s*['"]evidence_only['"][\s\S]*requireEvidenceConfirmation:\s*true/,
  "The recovery form must use the guarded, audited evidence-only resolution path."
);
assert.match(
  dispatchOfflineReviewSource,
  /applying[\s\S]*Server application in progress[\s\S]*resolution_pending[\s\S]*Resolution in progress|resolution_pending[\s\S]*Resolution in progress[\s\S]*applying[\s\S]*Server application in progress/,
  "Applying and resolution-pending records must remain explicitly read-only while their server transaction is in progress."
);

const offlineQueueRepositorySource = sourceSection(
  offlineRepositorySource,
  "export async function getDriverOfflineSyncQueue",
  "async function updateOfflineEventStatus"
);
assert.match(offlineQueueRepositorySource, /deviceId\s*=\s*['"]/);
assert.match(
  offlineQueueRepositorySource,
  /device_id\s*=\s*\$\{?[^\n]+|device_id\s*=\s*\$\d/,
  "The durable queue query must be scoped to the originating browser device when a device ID is supplied."
);
assert.match(
  offlineServiceSource,
  /export async function processDriverOfflineQueue\(\{[\s\S]{0,300}deviceId\s*=\s*['"][\s\S]{0,900}getDriverOfflineSyncQueue\(driverLogin, planDate, \{[\s\S]{0,250}deviceId/,
  "Queue processing must carry the device stream through to its durable queue lookup."
);

const driverOfflineSyncRouteSource = sourceSection(
  serverSource,
  'app.post("/api/driver/offline-sync"',
  'app.get("/api/driver/day-state"'
);
assert.match(
  driverOfflineSyncRouteSource,
  /processDriverOfflineQueue\(\{[\s\S]{0,500}\bdeviceId\b/,
  "A Driver sync request must process only the authenticated browser device's event stream."
);
assert.match(
  serverSource,
  /app\.post\("\/api\/dispatch\/offline-review\/:eventId\/retry", requireDispatcher[\s\S]{0,10000}verifyDriverOfflinePhotoObject[\s\S]{0,10000}recordDriverOfflinePhotoVerificationFailure[\s\S]{0,10000}processDriverOfflineQueue\(\{[\s\S]{0,500}\bdeviceId\b/,
  "Dispatch retry must re-verify uploaded evidence, durably record failures, and drain only the affected device queue."
);
const offlineRetryRouteSource = sourceSection(
  serverSource,
  'app.post("/api/dispatch/offline-review/:eventId/retry"',
  'app.post("/api/dispatch/offline-review/:eventId/resolve"'
);
assert.match(
  offlineRetryRouteSource,
  /if \(!photo\.objectReference\)[\s\S]{0,1800}status:\s*"missing_upload"[\s\S]{0,800}continue;[\s\S]{0,500}verifyDriverOfflinePhotoObject/,
  "A missing upload must be reported and persisted without attempting an object-store read-back."
);
assert.match(
  offlineRepositorySource,
  /function mapOfflinePhoto[\s\S]{0,1200}verificationAttemptCount[\s\S]{0,500}lastVerificationAttemptAt[\s\S]{0,500}lastVerificationErrorCode[\s\S]{0,500}lastVerificationError/,
  "Offline review photo details must expose durable verification-attempt diagnostics."
);
assert.match(
  offlineRepositorySource,
  /export async function recordDriverOfflinePhotoVerificationFailure[\s\S]{0,2200}verification_attempt_count\s*=\s*verification_attempt_count\s*\+\s*1[\s\S]{0,1000}last_verification_error_code[\s\S]{0,500}last_verification_error/,
  "A failed read-back must persist its exact code, message, timestamp, and attempt count."
);
for (const column of [
  "verification_attempt_count",
  "last_verification_attempt_at",
  "last_verification_error_code",
  "last_verification_error"
]) {
  assert.match(
    offlinePhotoVerificationMigration,
    new RegExp(`ADD COLUMN IF NOT EXISTS[\\s\\S]{0,500}\\b${column}\\b`),
    `The upgrade migration must add ${column} to already-installed offline photo tables.`
  );
}
const evidenceOnlyStatusSource = sourceSection(
  offlineRepositorySource,
  "const EVIDENCE_ONLY_RESOLVABLE_STATUSES",
  "const RETRYABLE_OFFLINE_STATUSES"
);
for (const status of ["registered", "waiting_photos", "pending", "blocked", "review_required"]) {
  assert.match(
    evidenceOnlyStatusSource,
    new RegExp(`"${status}"`),
    `Audited evidence-only recovery must allow ${status}.`
  );
}
assert.doesNotMatch(
  evidenceOnlyStatusSource,
  /"applying"|"resolution_pending"/,
  "Evidence-only recovery must not race an applying or resolution-pending transaction."
);
const offlineResolutionRepositorySource = sourceSection(
  offlineRepositorySource,
  "export async function resolveDriverOfflineReview",
  "export async function createDriverLocationVerification"
);
assert.match(
  offlineResolutionRepositorySource,
  /const evidenceOnly = resolutionInput\.action === "evidence_only"[\s\S]{0,500}EVIDENCE_ONLY_RESOLVABLE_STATUSES\.has\(sourceStatus\)[\s\S]{0,300}sourceStatus === "review_required"/,
  "Operational apply/reattach resolution must remain restricted to review-required events."
);
assert.match(
  serverSource,
  /app\.post\("\/api\/dispatch\/offline-review\/:eventId\/resolve", requireDispatcher[\s\S]{0,1500}confirmed:\s*req\.body\?\.confirmed\s*===\s*true/,
  "The Dispatcher resolution route must forward explicit evidence-only confirmation to the guarded repository boundary."
);
assert.match(
  driverWorker,
  /DRIVER_REFRESH_SHELL[\s\S]*DRIVER_REFRESH_CACHE_NAME[\s\S]*cache\.addAll[\s\S]*active\.put[\s\S]*caches\.delete\(DRIVER_REFRESH_CACHE_NAME\)/,
  "Driver shell refresh must stage a complete replacement before touching the active offline shell."
);
assert.match(
  driverWorker,
  /name\.startsWith\(DRIVER_CACHE_PREFIX\)[\s\S]*name !== DRIVER_CACHE_NAME/,
  "Driver shell cleanup must remain scoped to obsolete Driver caches."
);
assert.doesNotMatch(
  driverWorker.slice(driverWorker.indexOf('event.data?.type === "DRIVER_REFRESH_SHELL"')),
  /caches\.delete\([^)]*(?:operator|yard-operator)/,
  "Manual Driver shell refresh must remain inside the Driver cache namespace."
);

console.log("Driver offline client harness passed.");
