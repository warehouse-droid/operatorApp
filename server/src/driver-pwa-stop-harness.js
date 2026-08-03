import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { closeDb } from "./db.js";
import {
  driverPwaStopStateHash,
  mapDriverPwaStopRecord,
  validateDriverPwaStopReopen
} from "./driver-pwa-repository.js";
import {
  driverOfflineManifestMatchesJobs,
  fingerprintDriverOfflineJobContent,
  materializeDriverOfflineJobs
} from "./driver-offline-repository.js";
import { planJobsForDriver } from "./driver-repository.js";

const sourceUrl = (name) => new URL(name, import.meta.url);
const serverSource = await fs.readFile(sourceUrl("./server.js"), "utf8");
const stopRepositorySource = await fs.readFile(sourceUrl("./driver-pwa-repository.js"), "utf8");
const offlineRepositorySource = await fs.readFile(sourceUrl("./driver-offline-repository.js"), "utf8");
const offlineServiceSource = await fs.readFile(sourceUrl("./driver-offline-service.js"), "utf8");
const stopUiSource = await fs.readFile(new URL("../public/dispatch-offline-review.js", import.meta.url), "utf8");
const migrationSource = await fs.readFile(new URL("../migrations/092_driver_pwa_stop_corrections.sql", import.meta.url), "utf8");

function sourceSection(source, start, end = "") {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `Missing source section: ${start}`);
  if (!end) return source.slice(startIndex);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `Missing source section terminator: ${end}`);
  return source.slice(startIndex, endIndex);
}

function assertBlocked(result, code, message) {
  assert.equal(result?.allowed, false, message);
  assert.equal(result?.code, code, message);
  assert.ok(String(result?.reason || "").trim(), `${message} A user-facing reason is required.`);
}

const startedAt = "2026-07-31T13:39:07.522Z";
const completedAt = "2026-07-31T13:41:15.736Z";
const sourceOfflineEventId = "cf805764-7ebe-4bdc-b115-ead38196a2d8";
const pickupRecord = {
  id: 291,
  job_id: "183:T5:T5-L1785447591839-95b64a1ce3d9c8:stop-91bf2bf1-b986-4f38-947f-f66de2a81ebe",
  plan_id: 183,
  plan_date: "2026-07-31",
  driver_login: "sety",
  truck_id: "T5",
  truck_plate: "CE94489",
  load_id: "T5-L1785447591839-95b64a1ce3d9c8",
  load_name: "Load 3",
  stop_id: "stop-91bf2bf1-b986-4f38-947f-f66de2a81ebe",
  stop_type: "pickup",
  order_refs: ["RP-BWS-WOODBRIGE-0730-2-v2"],
  status: "complete",
  started_at: startedAt,
  completed_at: completedAt,
  created_at: "2026-07-31T13:39:07.788Z",
  source_offline_event_id: sourceOfflineEventId,
  device_occurred_at: completedAt,
  server_received_at: "2026-07-31T13:41:15.885Z",
  server_applied_at: "2026-07-31T13:41:22.626Z",
  location_status: "warning_overridden",
  location_details: {
    source: "samsara",
    verificationId: "27acef6b-280f-470d-8e7f-a939e50b6d6b"
  },
  photo_data_urls: [
    "r2://driver/driver-pickup-photo/photo-1.jpg",
    "r2://driver/driver-pickup-photo/photo-2.jpg"
  ],
  job_details: {
    location: "3445",
    pickupLocation: "3445",
    address: "3445 Kennedy Road, Toronto, ON",
    requiredPhotos: 2,
    driverRemark: "Receiving door was closed."
  }
};

const stateHash = driverPwaStopStateHash(pickupRecord);
assert.match(stateHash, /^[0-9a-f]{64}$/);
assert.equal(
  driverPwaStopStateHash(structuredClone(pickupRecord)),
  stateHash,
  "Equivalent Driver stop evidence must produce the same state hash."
);
for (const changedRecord of [
  { ...pickupRecord, completed_at: "2026-07-31T13:41:16.736Z" },
  { ...pickupRecord, source_offline_event_id: crypto.randomUUID() },
  { ...pickupRecord, photo_data_urls: [...pickupRecord.photo_data_urls, "r2://driver/photo-3.jpg"] },
  { ...pickupRecord, job_details: { ...pickupRecord.job_details, location: "12441", pickupLocation: "12441" } }
]) {
  assert.notEqual(
    driverPwaStopStateHash(changedRecord),
    stateHash,
    "Changed timestamps, evidence, or mapped location must invalidate a stale Dispatcher screen."
  );
}

const clearEligibility = {
  record: pickupRecord,
  routeIndex: 5,
  laterJobs: [],
  nonterminalOfflineCount: 0,
  activeRestCount: 0,
  attentionTruckSwitchCount: 0,
  executingForegroundCount: 0
};
assert.deepEqual(
  validateDriverPwaStopReopen(clearEligibility),
  { allowed: true, code: "", reason: "" },
  "The newest completed pickup must be reopenable when its Driver day is quiet."
);
assert.equal(
  validateDriverPwaStopReopen({
    ...clearEligibility,
    record: { ...pickupRecord, stop_type: "dropoff" }
  }).allowed,
  true,
  "A completed dropoff is also a supported physical stop."
);

assertBlocked(
  validateDriverPwaStopReopen({ ...clearEligibility, record: null }),
  "DRIVER_PWA_STOP_NOT_FOUND",
  "A missing canonical stop must be blocked."
);
assertBlocked(
  validateDriverPwaStopReopen({ ...clearEligibility, record: { ...pickupRecord, stop_type: "travel" } }),
  "DRIVER_PWA_STOP_TYPE_BLOCKED",
  "Travel/rest/switch jobs must not be reopened as physical stops."
);
assert.equal(
  validateDriverPwaStopReopen({ ...clearEligibility, record: { ...pickupRecord, status: "in_progress" } }).allowed,
  true,
  "The current in-progress physical stop may be safely restarted by Dispatch."
);
assertBlocked(
  validateDriverPwaStopReopen({ ...clearEligibility, routeIndex: -1 }),
  "DRIVER_PWA_STOP_NO_LONGER_ASSIGNED",
  "A stop removed from the current confirmed route must not be recreated from stale evidence."
);

for (const laterStatus of ["in_progress", "complete"]) {
  assertBlocked(
    validateDriverPwaStopReopen({
      ...clearEligibility,
      laterJobs: [{ jobId: "later-job", loadName: "Load 4", status: laterStatus }]
    }),
    "DRIVER_PWA_LATER_STOP_ACTIVE",
    "Dispatcher must undo Driver activity newest-first."
  );
}
assert.equal(
  validateDriverPwaStopReopen({
    ...clearEligibility,
    laterJobs: [{ jobId: "later-pending-job", status: "pending" }]
  }).allowed,
  true,
  "A later untouched route stop is not newer Driver activity."
);

for (const [field, code, message] of [
  ["nonterminalOfflineCount", "DRIVER_PWA_UNSYNCED_SERVER_EVENTS", "Pending/review offline events must block reopen."],
  ["activeRestCount", "DRIVER_PWA_ACTIVE_REST", "An active rest must block reopen."],
  ["attentionTruckSwitchCount", "DRIVER_PWA_TRUCK_SWITCH_ATTENTION", "Truck-switch attention must block reopen."],
  ["executingForegroundCount", "DRIVER_PWA_ACTION_EXECUTING", "An executing foreground receipt must block reopen."]
]) {
  assertBlocked(
    validateDriverPwaStopReopen({ ...clearEligibility, [field]: 1 }),
    code,
    message
  );
}
assert.equal(
  validateDriverPwaStopReopen({
    ...clearEligibility,
    nonterminalOfflineCount: 2,
    targetNonterminalOfflineCount: 2
  }).allowed,
  true,
  "Pending records for the selected stop may be retained as evidence and superseded by its restart correction."
);
assertBlocked(
  validateDriverPwaStopReopen({
    ...clearEligibility,
    nonterminalOfflineCount: 2,
    targetNonterminalOfflineCount: 1
  }),
  "DRIVER_PWA_UNSYNCED_SERVER_EVENTS",
  "Pending records for another stop must continue to block restart."
);

assert.match(migrationSource, /CREATE TABLE IF NOT EXISTS\s+driver_job_corrections\b/i);
assert.match(migrationSource, /idempotency_id\s+uuid\s+NOT NULL\s+UNIQUE/i);
assert.match(migrationSource, /driver_job_record_id\s+bigint\s+NOT NULL\s+REFERENCES\s+driver_job_records\(id\)/i);
assert.match(migrationSource, /expected_state_hash\s+text\s+NOT NULL/i);
assert.match(migrationSource, /audit_note\s+text\s+NOT NULL/i);
assert.match(migrationSource, /before_state\s+jsonb\s+NOT NULL/i);
assert.match(migrationSource, /after_state\s+jsonb\s+NOT NULL/i);
assert.match(migrationSource, /CHECK\s*\(action IN \('reopen', 'map_location'\)\)/i);
assert.match(
  migrationSource,
  /BEFORE UPDATE OR DELETE ON driver_job_corrections/i,
  "The correction/evidence ledger must be immutable."
);

const evidenceSnapshotSource = sourceSection(
  stopRepositorySource,
  "function recordEvidenceSnapshot(row = {})",
  "export function driverPwaStopStateHash"
);
for (const evidenceField of [
  "photoDataUrls",
  "startedAt",
  "completedAt",
  "sourceOfflineEventId",
  "deviceOccurredAt",
  "serverReceivedAt",
  "serverAppliedAt",
  "locationStatus",
  "locationDetails",
  "jobDetails"
]) {
  assert.match(
    evidenceSnapshotSource,
    new RegExp(`\\b${evidenceField}\\b`),
    `Correction before_state must preserve ${evidenceField}.`
  );
}

const listSource = sourceSection(
  stopRepositorySource,
  "export async function listDriverPwaStops",
  "async function correctionByIdempotency"
);
assert.match(
  listSource,
  /ORDER BY r\.plan_date DESC, COALESCE\(r\.completed_at, r\.started_at, r\.created_at\) DESC, r\.id DESC/,
  "Dispatcher stop history must be deterministic and newest-first."
);
assert.match(listSource, /route\.jobs\.slice\(routeIndex \+ 1\)/);
assert.match(
  stopRepositorySource,
  /driverRemark: String\(evidence\.jobDetails\?\.driverRemark \|\| ""\)/,
  "Dispatcher Driver PWA records must expose the durable driver remark."
);
assert.match(
  stopUiSource,
  /offlineReviewSummaryItem\("Driver remark", driverRemark\)/,
  "The Dispatcher Driver PWA detail must display the driver's stop remark."
);

const blockerSource = sourceSection(
  stopRepositorySource,
  "async function driverDayBlockers",
  "async function currentDriverDayContext"
);
assert.match(blockerSource, /status = ANY\(\$3::text\[\]\)/);
assert.match(blockerSource, /status = 'active'[\s\S]{0,120}ended_at IS NULL/);
assert.match(blockerSource, /status = 'attention'/);
assert.match(blockerSource, /status = 'executing'/);

const reopenSource = sourceSection(
  stopRepositorySource,
  "export async function reopenDriverPwaStop",
  "export async function mapDriverPwaStopRecord"
);
assert.match(reopenSource, /uuidValue\(idempotencyId, "Idempotency ID"\)/);
assert.match(reopenSource, /requiredText\(auditNote, "Audit note"\)/);
assert.match(reopenSource, /assertExpectedState\(row, expectedStateHash\)/);
assert.match(reopenSource, /withTransaction\(async \(\) =>/);
assert.match(reopenSource, /pg_advisory_xact_lock/);
assert.match(reopenSource, /const before = recordEvidenceSnapshot\(row\)/);
assert.match(reopenSource, /status = 'pending'/);
assert.match(reopenSource, /started_at = NULL/);
assert.match(reopenSource, /completed_at = NULL/);
assert.match(reopenSource, /photo_data_urls = '\[\]'::jsonb/);
assert.match(reopenSource, /source_offline_event_id = NULL/);
assert.match(reopenSource, /const after = recordEvidenceSnapshot\(updated\.rows\[0\]\)/);
assert.match(reopenSource, /insertCorrection\(\{[\s\S]*?before,[\s\S]*?after,/);
assert.match(reopenSource, /supersedeDriverOfflineManifests\(\{/);
assert.match(
  reopenSource,
  /UPDATE driver_offline_events[\s\S]*status = 'evidence_only'[\s\S]*server_applied_at = COALESCE\(server_applied_at, now\(\)\)[\s\S]*original_job_id = \$3/,
  "Restart must close already-received target events as retained evidence instead of replaying them."
);
assert.match(
  stopRepositorySource,
  /targetNonterminalOfflineCount[\s\S]*nonterminalOfflineCount[\s\S]*DRIVER_PWA_UNSYNCED_SERVER_EVENTS/,
  "Only unrelated pending Driver events may block a selected-stop restart."
);
assert.match(
  stopRepositorySource,
  /pendingOfflineRecordCount: Math\.max/,
  "Dispatch must disclose how many selected-stop offline records the restart will retain as evidence."
);
assert.match(
  offlineServiceSource,
  /supersedingDriverPwaCorrection[\s\S]*manifest\?\.generatedAt[\s\S]*created_at > \$4::timestamptz/,
  "A late event from the pre-restart manifest must encounter the durable correction barrier."
);
assert.match(
  offlineServiceSource,
  /correctionDisposition[\s\S]*markDriverOfflineEventEvidenceOnly/,
  "The correction barrier must retain late saved work as evidence without replaying its operational action."
);
assert.match(
  stopUiSource,
  /const actionLabel = restarting \? "Restart" : "Reopen"[\s\S]*<strong>\$\{actionLabel\} blocked<\/strong>/,
  "An in-progress stop must be presented to Dispatch as Restart, including its blocker heading."
);

assert.equal(typeof mapDriverPwaStopRecord, "function");
const mappingSource = sourceSection(
  stopRepositorySource,
  "export async function mapDriverPwaStopRecord"
);
assert.match(mappingSource, /uuidValue\(idempotencyId, "Idempotency ID"\)/);
assert.match(mappingSource, /requiredText\(auditNote, "Audit note"\)/);
assert.match(mappingSource, /assertExpectedState\(row, expectedStateHash\)/);
assert.match(mappingSource, /const before = recordEvidenceSnapshot\(row\)/);
assert.match(mappingSource, /SET job_details = \$2::jsonb/);
assert.doesNotMatch(mappingSource, /started_at\s*=/);
assert.doesNotMatch(mappingSource, /completed_at\s*=/);
assert.doesNotMatch(mappingSource, /photo_data_urls\s*=/);
assert.doesNotMatch(mappingSource, /source_offline_event_id\s*=/);
assert.match(mappingSource, /arrivalTime: row\.started_at/);
assert.match(mappingSource, /leaveTime: row\.completed_at/);
assert.match(mappingSource, /photoCount: before\.photoDataUrls\.length/);
assert.match(mappingSource, /insertCorrection\(\{[\s\S]*?before,[\s\S]*?after,/);
assert.match(mappingSource, /supersedeDriverOfflineManifests\(\{/);

const listRouteSource = sourceSection(
  serverSource,
  'app.get("/api/dispatch/driver-pwa/stops"',
  'app.post("/api/dispatch/driver-pwa/stops/:recordId/reopen"'
);
assert.match(listRouteSource, /requireDispatcher/);
assert.match(listRouteSource, /req\.query\.planDate \|\| req\.query\.date/);
const reopenRouteSource = sourceSection(
  serverSource,
  'app.post("/api/dispatch/driver-pwa/stops/:recordId/reopen"',
  'app.get("/api/dispatch/offline-review"'
);
assert.match(reopenRouteSource, /requireDispatcher/);
assert.match(reopenRouteSource, /recordId: req\.params\.recordId/);
for (const field of ["auditNote", "idempotencyId", "expectedStateHash"]) {
  assert.match(reopenRouteSource, new RegExp(`req\\.body\\?\\.${field}`));
}

const manifestJob = {
  jobId: pickupRecord.job_id,
  planId: 183,
  planDate: "2026-07-31",
  driverLogin: "sety",
  truckId: "T5",
  truckPlate: "CE94489",
  loadId: pickupRecord.load_id,
  loadName: "Load 3",
  stopId: pickupRecord.stop_id,
  stopType: "pickup",
  location: "12441",
  pickupLocation: "12441",
  address: "12441 Woodbine Avenue, Whitchurch-Stouffville, ON",
  orderRefs: pickupRecord.order_refs,
  orderTypes: ["PO"],
  lineRowIds: [],
  requiredPhotos: 2,
  orders: [{
    orderRef: pickupRecord.order_refs[0],
    party: "BWS",
    source: "dispatch_plan",
    items: [{
      itemName: "**PALLET DEPOSIT**",
      description: "Pallet deposit",
      units: [{ unit: "PLT", label: "PLT", value: 300 }]
    }]
  }]
};
const contentFingerprint = fingerprintDriverOfflineJobContent(manifestJob);
assert.match(contentFingerprint, /^[0-9a-f]{64}$/);
assert.equal(fingerprintDriverOfflineJobContent(structuredClone(manifestJob)), contentFingerprint);
for (const changedJob of [
  { ...manifestJob, location: "3445", pickupLocation: "3445" },
  { ...manifestJob, address: "Changed pickup address" },
  {
    ...manifestJob,
    orders: [{
      ...manifestJob.orders[0],
      items: [{ ...manifestJob.orders[0].items[0], units: [{ unit: "PLT", label: "PLT", value: 301 }] }]
    }]
  }
]) {
  assert.notEqual(
    fingerprintDriverOfflineJobContent(changedJob),
    contentFingerprint,
    "Any changed Driver-visible stop detail must make same-revision manifest content stale."
  );
}
assert.equal(
  fingerprintDriverOfflineJobContent({
    ...manifestJob,
    status: "complete",
    startedAt,
    completedAt
  }),
  contentFingerprint,
  "Execution projection must not turn a routine start/complete into a dispatch-content change."
);

const materialized = materializeDriverOfflineJobs([manifestJob], "sety");
const storedManifest = {
  manifestId: crypto.randomUUID(),
  complete: true,
  jobs: materialized.map((entry) => ({
    ...entry.snapshot,
    fingerprint: entry.fingerprint,
    contentFingerprint: entry.contentFingerprint,
    predecessorFingerprint: entry.predecessorFingerprint
  }))
};
assert.equal(
  driverOfflineManifestMatchesJobs(storedManifest, [manifestJob], "sety"),
  true
);
assert.equal(
  driverOfflineManifestMatchesJobs(
    storedManifest,
    [{ ...manifestJob, location: "3445", pickupLocation: "3445" }],
    "sety"
  ),
  false,
  "A stale cached pickup location must prevent manifest reuse."
);
assert.equal(
  driverOfflineManifestMatchesJobs(
    storedManifest,
    [{ ...manifestJob, address: "Changed pickup address" }],
    "sety"
  ),
  false,
  "A display-detail change must prevent manifest reuse even when operational identity is unchanged."
);
assert.equal(
  driverOfflineManifestMatchesJobs(
    storedManifest,
    [{ ...manifestJob, status: "complete", startedAt, completedAt }],
    "sety"
  ),
  true,
  "Only volatile execution projection changed, so the same route manifest remains reusable."
);

const woodbridgeAddress = "8821 Weston Rd, Woodbridge, ON L4L 1A6";
const consecutiveWoodbridgePlan = {
  id: 183,
  planDate: "2026-07-31",
  revision: 37,
  orders: [
    {
      id: "PREVIOUS-WOODBRIDGE-DROP",
      type: "SO",
      address: woodbridgeAddress,
      dropAddress: woodbridgeAddress
    },
    {
      id: "PO-NEXT-WOODBRIDGE-PICKUP",
      type: "PO",
      sourceYard: "BWS Woodbridge",
      pickupLocations: ["BWS Woodbridge"],
      sourceAddress: woodbridgeAddress,
      defaultSourceAddress: woodbridgeAddress,
      address: "3445 Kennedy Road, Toronto, ON",
      destinationYard: "3445"
    }
  ],
  trucks: [{
    id: "T5",
    plate: "CE94489",
    driverLogin: "sety",
    driver: "Sety",
    base: "12441",
    loads: [
      {
        id: "LOAD-3",
        name: "Load 3",
        driverLogin: "sety",
        driverName: "Sety",
        plannedStartMinute: 675,
        plannedFinishMinute: 848,
        driverSequence: 0,
        stops: [{
          id: "PREVIOUS-WOODBRIDGE-DROP-STOP",
          type: "drop",
          orderId: "PREVIOUS-WOODBRIDGE-DROP",
          location: "BWS Woodbridge",
          dropLocation: "BWS Woodbridge",
          dropAddress: woodbridgeAddress
        }]
      },
      {
        id: "LOAD-4",
        name: "Load 4",
        driverLogin: "sety",
        driverName: "Sety",
        plannedStartMinute: 848,
        plannedFinishMinute: 1034,
        driverSequence: 1,
        stops: [
          {
            id: "NEXT-WOODBRIDGE-PICKUP-STOP",
            type: "pick",
            orderId: "PO-NEXT-WOODBRIDGE-PICKUP",
            location: "BWS Woodbridge"
          },
          {
            id: "NEXT-WOODBRIDGE-DROP-STOP",
            type: "drop",
            orderId: "PO-NEXT-WOODBRIDGE-PICKUP",
            location: "3445",
            dropLocation: "3445",
            dropAddress: "3445 Kennedy Road, Toronto, ON"
          }
        ]
      }
    ]
  }]
};
const sameAddressLoadJobs = planJobsForDriver(consecutiveWoodbridgePlan, "sety")
  .filter((job) => job.loadId === "LOAD-4");
assert.deepEqual(
  sameAddressLoadJobs.map((job) => job.stopType),
  ["pickup", "dropoff"],
  "A previous 8821 drop and next BWS Woodbridge pickup at the same sourceAddress must not create synthetic travel."
);

const differentAddressPlan = structuredClone(consecutiveWoodbridgePlan);
const changedPickupOrder = differentAddressPlan.orders.find((order) => order.id === "PO-NEXT-WOODBRIDGE-PICKUP");
changedPickupOrder.sourceAddress = "9000 Different Road, Vaughan, ON";
changedPickupOrder.defaultSourceAddress = changedPickupOrder.sourceAddress;
const differentAddressLoadJobs = planJobsForDriver(differentAddressPlan, "sety")
  .filter((job) => job.loadId === "LOAD-4");
assert.equal(
  differentAddressLoadJobs[0]?.stopType,
  "travel",
  "A genuinely different next pickup address must retain the inter-load travel job."
);
assert.equal(differentAddressLoadJobs[0]?.fromAddress, woodbridgeAddress);
assert.equal(differentAddressLoadJobs[0]?.toAddress, changedPickupOrder.sourceAddress);

assert.match(
  offlineRepositorySource,
  /export async function supersedeDriverOfflineManifests[\s\S]*?UPDATE driver_offline_manifests[\s\S]*?superseded_at = COALESCE\(superseded_at, now\(\)\)[\s\S]*?lower\(driver_login\)[\s\S]*?plan_date = \$2::date/,
  "Reopen and map-location actions must invalidate reusable manifests for exactly that Driver day."
);
const dayPlanRouteSource = sourceSection(
  serverSource,
  'app.get("/api/driver/day-plan"',
  'app.post("/api/driver/photo-upload-token"'
);
assert.match(dayPlanRouteSource, /const forceRefresh = String\(req\.query\.forceRefresh \|\| ""\) === "1"/);
assert.match(
  dayPlanRouteSource,
  /driverOfflineManifestMatchesJobs\([\s\S]{0,300}latest,[\s\S]{0,300}materialized\.jobs/,
  "Day-plan reuse must compare fresh materialized stop content with the stored manifest."
);
const nextJobBootstrapSource = sourceSection(
  serverSource,
  "async function nextJobOfflineRouteBootstrap",
  'app.get("/api/driver/next-job"'
);
assert.match(
  nextJobBootstrapSource,
  /const comparisonJobs = context\.job\?\.jobId[\s\S]*context\.jobs\.map[\s\S]*\{ \.\.\.job, \.\.\.context\.job \}/,
  "The fast next-job bootstrap must compare the already-materialized actionable job, not its raw route placeholder."
);
assert.match(
  nextJobBootstrapSource,
  /driverOfflineManifestMatchesJobs\([\s\S]*comparisonJobs[\s\S]*requireComplete: false, requiredJobId: context\.job\.jobId/,
  "Bootstrap reuse must validate the materialized current job and its canonical predecessor without materializing the whole day."
);
assert.match(
  nextJobBootstrapSource,
  /const bootstrapJobs =[\s\S]*comparisonJobs\.slice\(Math\.max\(0, currentIndex - 1\), currentIndex \+ 1\)/,
  "A rebuilt bootstrap must persist the raw predecessor with the materialized current job."
);

await closeDb();
console.log("Driver PWA stop reopen, evidence mapping, and manifest freshness harness passed.");
