import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before } from "node:test";

import { closeDb, query } from "../../../src/db.js";
import { replaceDispatchFleetSetup } from "../../../src/dispatch-setup-repository.js";
import {
  DRIVER_PWA_CURRENT_VERSION,
  DRIVER_PWA_VERSION_HEADER
} from "../../../src/driver-client-version.js";
import {
  getDriverOfflineEvent,
  markDriverOfflinePhotoDurable,
  recordDriverOfflinePhotoReceipts
} from "../../../src/driver-offline-repository.js";
import {
  getDirectPickupDependencyExecutionBlock,
  markDirectDependencyPickupCompleted
} from "../../../src/order-dependency-repository.js";
import { app } from "../../../src/server.js";

const MODE = String(process.env.DIRECT_PICKUP_REPRO_MODE || "online").trim().toLowerCase();
const DRIVER_LOGIN = "tob00870-driver";
const DEVICE_ID = "90f4892d-37e6-418e-b84a-e3c98b54fe43";
const SALES_ORDER_ID = 949804;
const SALES_ORDER_REF = "SOB117719";
const TRANSFER_ORDER_ID = 949816;
const TRANSFER_ORDER_REF = "TOB00870";
const PLAN_ID = 230;
const PLAN_REVISION = 88;
const TRUCK_ID = "T3";
const TRUCK_PLATE = "BC71838";
const LOAD_ID = "T3-L1786563401860-00cca9a1a43b9";
const LOAD_NAME = "Load 3";
const PICKUP_STOP_ID = "stop-169657ba-3a40-4c47-b997-8a8359ba937f";
const DROP_STOP_ID = "T3-L1786563401860-00cca9a1a43b9-SOB117719-1786563525005-0733052c426958";

let server;
let baseUrl;
let token;
let planDate;
let manifest;
let pickupJob;

async function request(path, { method = "GET", body, offlineGrant = "" } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "x-mbbs-driver-device": DEVICE_ID,
      [DRIVER_PWA_VERSION_HEADER]: DRIVER_PWA_CURRENT_VERSION,
      ...(offlineGrant ? { "x-mbbs-offline-grant": offlineGrant } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

async function seedProductionDerivedFixture() {
  const today = await query(
    "SELECT (now() AT TIME ZONE 'America/Toronto')::date::text AS plan_date"
  );
  planDate = today.rows[0].plan_date;

  await replaceDispatchFleetSetup({
    drivers: [{
      name: "TOB00870 Isolated Driver",
      login: DRIVER_LOGIN,
      license: "AZ",
      number: "TOB00870",
      samsaraEnabled: false,
      active: true
    }],
    trucks: [{ plate: TRUCK_PLATE, capacityLbs: 40000, active: true }]
  }, { activeOnly: false, deactivateMissing: false });

  await query(
    `INSERT INTO sales_orders (
       netsuite_id, tranid, trandate, customer, status, status_text,
       outbound_location_id, outbound_location, dispatch_address,
       operator_status, local_yard_order_status, fulfillment_status,
       netsuite_active, is_test_fixture
     ) VALUES (
       $1, $2, $3::date, 'Isolated historical-route fixture', 'B', 'Pending Fulfillment',
       15, '12441', 'Isolated customer destination',
       'open', 'Open', 'not_fulfilled', true, true
     )`,
    [SALES_ORDER_ID, SALES_ORDER_REF, planDate]
  );
  await query(
    `INSERT INTO sales_order_lines (
       id, sales_order_id, line_id, item_id, item_name, sku, quantity, unit,
       piece_qty, loaded_qty, netsuite_active
     ) VALUES (218719, $1, 1, 5055, 'PER-MEL60-COP-AB', 'PER-MEL60-COP-AB', 19, 'PC', 19, 0, true)`,
    [SALES_ORDER_ID]
  );
  await query(
    `INSERT INTO transfer_orders (
       netsuite_id, tranid, trandate, status, status_text,
       from_location_id, from_location, to_location_id, to_location,
       outbound_operator_status, local_yard_order_status, fulfillment_status,
       dispatch_planned, dispatch_plan_date, dispatch_truck_plate,
       dispatch_load_name, netsuite_active
     ) VALUES (
       $1, $2, $3::date, 'B', 'Pending Fulfillment',
       28, '2967', 15, '12441',
       'open', 'Open', 'not_fulfilled', true, $3::date, $4, $5, true
     )`,
    [TRANSFER_ORDER_ID, TRANSFER_ORDER_REF, planDate, TRUCK_PLATE, LOAD_NAME]
  );

  const directPickupManifest = [{
    transferOrderRef: TRANSFER_ORDER_REF,
    salesOrderRef: SALES_ORDER_REF,
    location: "2967",
    items: [
      {
        sku: "PER-MEL60-COP-AB",
        itemName: "PER-MEL60-COP-AB",
        unit: "PC",
        quantity: 19,
        palletQty: 0,
        layerQty: 0,
        sectionQty: 0,
        pieceQty: 19
      },
      {
        sku: "PALLET",
        itemName: "PALLET",
        unit: "EACH",
        quantity: 1,
        palletQty: 0,
        layerQty: 0,
        sectionQty: 0,
        pieceQty: 1
      }
    ]
  }];
  const orders = [{
    id: SALES_ORDER_REF,
    type: "SO",
    customer: "Isolated historical-route fixture",
    sourceYard: "12441",
    outboundLocation: "12441",
    pickupLocations: ["2967"],
    address: "Isolated customer destination",
    directPickupManifest
  }];
  const trucks = [{
    id: TRUCK_ID,
    plate: TRUCK_PLATE,
    base: "2967",
    driver: "TOB00870 Isolated Driver",
    driverLogin: DRIVER_LOGIN,
    loads: [{
      id: LOAD_ID,
      name: LOAD_NAME,
      driverLogin: DRIVER_LOGIN,
      driverName: "TOB00870 Isolated Driver",
      truckId: TRUCK_ID,
      truckPlate: TRUCK_PLATE,
      stops: [
        { id: PICKUP_STOP_ID, type: "pick", orderId: SALES_ORDER_REF, location: "2967" },
        {
          id: DROP_STOP_ID,
          type: "drop",
          orderId: SALES_ORDER_REF,
          location: "Isolated customer destination",
          dropLocation: "Isolated customer destination"
        }
      ]
    }]
  }];

  await query(
    `INSERT INTO dispatch_plans (
       id, plan_date, status, note, confirmed_at, revision
     ) VALUES ($1, $2::date, 'confirmed', 'TOB00870 production-derived isolated reproduction', now(), $3)`,
    [PLAN_ID, planDate, PLAN_REVISION]
  );
  await query(
    `INSERT INTO dispatch_plan_snapshots (
       plan_id, orders, trucks, summary, schema_version, plan_digest,
       order_count, truck_count, load_count, stop_count
     ) VALUES ($1, $2::jsonb, $3::jsonb, '{}'::jsonb, 2, 'tob00870-isolated', 1, 1, 1, 2)`,
    [PLAN_ID, JSON.stringify(orders), JSON.stringify(trucks)]
  );
  const dependency = await query(
    `INSERT INTO order_dependencies (
       sales_order_id, sales_order_ref, transfer_order_id, transfer_order_ref,
       dependency_mode, same_load_required, status,
       source_location_id, source_location,
       accounting_destination_location_id, accounting_destination_location,
       planned_plan_id, planned_date, planned_truck_plate, planned_load_id, planned_load_name,
       reconciliation_status, dispatch_target_ref, dispatch_target_kind
     ) VALUES (
       $1, $2, $3, $4,
       'direct_to_customer', true, 'active',
       28, '2967', 15, '12441',
       $5, $6::date, $7, $8, $9,
       'pending', $2, 'normal'
     ) RETURNING id`,
    [
      SALES_ORDER_ID,
      SALES_ORDER_REF,
      TRANSFER_ORDER_ID,
      TRANSFER_ORDER_REF,
      PLAN_ID,
      planDate,
      TRUCK_PLATE,
      LOAD_ID,
      LOAD_NAME
    ]
  );
  await query(
    `INSERT INTO order_dependency_lines (
       dependency_id, sales_line_id, transfer_outbound_line_id, transfer_receiving_line_id,
       item_id, item_name, unit, allocated_quantity,
       piece_qty, loaded_quantity, line_role, dispatch_target_line_key
     ) VALUES
       ($1, 218719, 218936, 218938, 5055, 'PER-MEL60-COP-AB', 'PC', 19, 19, 0,
        'sales_allocation', 'SOB117719::SOB117719::218719'),
       ($1, null, 218937, 218939, 1784, 'PALLET', 'EACH', 1, 1, 0, 'pallet', null)`,
    [dependency.rows[0].id]
  );
  await query(
    `UPDATE mbt_feature_flags
        SET enabled = true, revision = revision + 1, updated_at = now()
      WHERE flag_key = 'driver_offline_mode'`
  );
}

async function downloadRoute() {
  const login = await request("/api/driver/login", {
    method: "POST",
    body: { username: DRIVER_LOGIN, password: "", deviceId: DEVICE_ID }
  });
  assert.equal(login.response.status, 200, JSON.stringify(login.payload));
  token = login.payload.token;

  const route = await request(`/api/driver/day-plan?date=${planDate}&forceRefresh=1`);
  assert.equal(route.response.status, 200, JSON.stringify(route.payload));
  manifest = route.payload;
  pickupJob = manifest.jobs.find((job) =>
    (job.dependencyPickupManifests || []).some((entry) => entry.transferOrderRef === TRANSFER_ORDER_REF)
  );
  assert.ok(pickupJob, "The isolated manifest did not contain the TOB00870 direct pickup.");
  assert.equal(manifest.jobs[0].jobId, pickupJob.jobId, "TOB00870 must be the exact next route job.");
  assert.equal(pickupJob.jobId, `${PLAN_ID}:${TRUCK_ID}:${LOAD_ID}:${PICKUP_STOP_ID}`);
  assert.deepEqual(pickupJob.orderRefs, [TRANSFER_ORDER_REF]);
}

async function assertStartDidNotForgeOperatorProgress() {
  const state = await query(
    `SELECT d.status,
            COALESCE(sum(dl.loaded_quantity), 0)::text AS loaded_quantity,
            (SELECT count(*)::int FROM operator_load_records WHERE order_id = $2) AS operator_records,
            (SELECT count(*)::int
               FROM driver_job_records
              WHERE job_id = $3 AND status = 'in_progress') AS in_progress_jobs
       FROM order_dependencies d
       JOIN order_dependency_lines dl ON dl.dependency_id = d.id
      WHERE d.transfer_order_ref = $1
      GROUP BY d.id, d.status`,
    [TRANSFER_ORDER_REF, TRANSFER_ORDER_ID, pickupJob.jobId]
  );
  assert.deepEqual(state.rows[0], {
    status: "active",
    loaded_quantity: "0",
    operator_records: 0,
    in_progress_jobs: 1
  });
}

async function assertCompletionAdvancedOnlyDriverDependency() {
  const state = await query(
    `SELECT d.status,
            COALESCE(sum(dl.loaded_quantity), 0)::text AS dependency_loaded_quantity,
            t.outbound_operator_status,
            t.local_yard_order_status,
            (SELECT count(*)::int FROM operator_load_records WHERE order_id = $2) AS operator_records,
            (SELECT count(*)::int
               FROM driver_job_records
              WHERE job_id = $3
                AND status = 'complete'
                AND jsonb_array_length(photo_data_urls) = 2) AS completed_jobs,
            (SELECT count(*)::int
               FROM dispatch_audit_log
              WHERE action = 'driver.direct_dependency.picked_up'
                AND entity_id = d.id::text) AS pickup_audits
       FROM order_dependencies d
       JOIN order_dependency_lines dl ON dl.dependency_id = d.id
       JOIN transfer_orders t ON t.netsuite_id = d.transfer_order_id
      WHERE d.transfer_order_ref = $1
      GROUP BY d.id, d.status, t.outbound_operator_status, t.local_yard_order_status`,
    [TRANSFER_ORDER_REF, TRANSFER_ORDER_ID, pickupJob.jobId]
  );
  assert.deepEqual(state.rows[0], {
    status: "in_transit",
    dependency_loaded_quantity: "20",
    outbound_operator_status: "open",
    local_yard_order_status: "Open",
    operator_records: 0,
    completed_jobs: 1,
    pickup_audits: 1
  });
}

function offlineCompletionEvidence() {
  return [0, 1].map((ordinal) => {
    const bytes = Buffer.from(`TOB00870-isolated-evidence-${ordinal}`);
    return {
      photoId: crypto.randomUUID(),
      ordinal,
      recordType: "driver-stop-photo",
      mimeType: "image/jpeg",
      byteSize: bytes.byteLength,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex")
    };
  });
}

async function completeOnline() {
  await query(
    "UPDATE driver_job_records SET started_at = now() - interval '11 seconds' WHERE job_id = $1",
    [pickupJob.jobId]
  );
  const completed = await request(`/api/driver/jobs/${encodeURIComponent(pickupJob.jobId)}/photos`, {
    method: "POST",
    body: {
      photoDataUrls: [
        "data:image/jpeg;base64,/9j/2Q==",
        "data:image/jpeg;base64,/9j/2Q=="
      ],
      locationOverride: true,
      autoStartNext: false
    }
  });
  assert.equal(completed.response.status, 200, JSON.stringify(completed.payload));
}

async function completeOffline() {
  const completionEventId = crypto.randomUUID();
  const photos = offlineCompletionEvidence();
  const registered = await request("/api/driver/offline-sync", {
    method: "POST",
    offlineGrant: manifest.offlineSyncGrant,
    body: {
      manifestId: manifest.manifestId,
      deviceId: DEVICE_ID,
      offlineSyncGrant: manifest.offlineSyncGrant,
      events: [{
        eventId: completionEventId,
        manifestId: manifest.manifestId,
        deviceId: DEVICE_ID,
        clientSequence: 2,
        eventType: "job_completed",
        jobId: pickupJob.jobId,
        jobFingerprint: pickupJob.fingerprint,
        predecessorFingerprint: pickupJob.predecessorFingerprint,
        occurredAt: new Date().toISOString(),
        locationStatus: "not_checked_offline",
        locationDetails: { warningCode: "", overrideReason: "" },
        details: {},
        photos
      }],
      photoReceipts: []
    }
  });
  assert.equal(registered.response.status, 200, JSON.stringify(registered.payload));
  assert.equal(registered.payload.events?.[0]?.status, "waiting_photos", JSON.stringify(registered.payload));

  const receipts = photos.map((photo) => ({
    photoId: photo.photoId,
    byteSize: photo.byteSize,
    sha256: photo.sha256,
    objectReference: `r2://driver/driver-stop-photo/2026/08/13/${photo.photoId}/evidence.jpg`
  }));
  await recordDriverOfflinePhotoReceipts({
    driverLogin: DRIVER_LOGIN,
    deviceId: DEVICE_ID,
    manifestId: manifest.manifestId,
    photoReceipts: receipts
  });
  for (const receipt of receipts) {
    await markDriverOfflinePhotoDurable(receipt.photoId, {
      objectReference: receipt.objectReference,
      verifiedByteSize: receipt.byteSize,
      verifiedSha256: receipt.sha256,
      receipt: { provider: "isolated-readback-proof" }
    });
  }
  const drained = await request("/api/driver/offline-sync", {
    method: "POST",
    offlineGrant: manifest.offlineSyncGrant,
    body: {
      manifestId: manifest.manifestId,
      deviceId: DEVICE_ID,
      offlineSyncGrant: manifest.offlineSyncGrant,
      events: [],
      photoReceipts: []
    }
  });
  assert.equal(drained.response.status, 200, JSON.stringify(drained.payload));
  const completionEvent = await getDriverOfflineEvent(completionEventId);
  assert.equal(completionEvent?.status, "applied", JSON.stringify(completionEvent));
}

before(async () => {
  assert.ok(["online", "offline"].includes(MODE), "Set DIRECT_PICKUP_REPRO_MODE=online or offline.");
  await seedProductionDerivedFixture();
  server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    listener.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  await downloadRoute();
});

after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  await closeDb();
});

test("TOB00870 keeps route-identity and review guards without using operator progress", async () => {
  const execution = {
    planId: PLAN_ID,
    planDate,
    truckPlate: TRUCK_PLATE,
    loadId: LOAD_ID
  };
  assert.equal(
    await getDirectPickupDependencyExecutionBlock([TRANSFER_ORDER_REF], execution),
    null,
    "Zero operator-loaded quantity must not block the assigned Driver pickup."
  );
  const wrongLoad = await getDirectPickupDependencyExecutionBlock(
    [TRANSFER_ORDER_REF],
    { ...execution, loadId: `${LOAD_ID}-WRONG` }
  );
  assert.equal(wrongLoad?.code, "DIRECT_TRANSFER_ROUTE_MISMATCH");

  await query(
    "UPDATE order_dependencies SET status = 'attention', attention_reason = 'isolated review guard' WHERE transfer_order_ref = $1",
    [TRANSFER_ORDER_REF]
  );
  const attention = await getDirectPickupDependencyExecutionBlock([TRANSFER_ORDER_REF], execution);
  assert.equal(attention?.code, "DIRECT_TRANSFER_REVIEW_REQUIRED");
  await query(
    "UPDATE order_dependencies SET status = 'active', attention_reason = null WHERE transfer_order_ref = $1",
    [TRANSFER_ORDER_REF]
  );

  await assert.rejects(
    markDirectDependencyPickupCompleted({
      transferOrderRefs: [TRANSFER_ORDER_REF],
      driverJobId: pickupJob.jobId,
      driverLogin: DRIVER_LOGIN,
      ...execution
    }),
    /completed Driver pickup evidence/i
  );
});

test(`TOB00870 direct pickup starts in ${MODE} mode without operator loading`, async () => {
  const eventId = crypto.randomUUID();
  const occurredAt = new Date().toISOString();
  if (MODE === "online") {
    const started = await request(`/api/driver/jobs/${encodeURIComponent(pickupJob.jobId)}/start`, {
      method: "POST",
      body: {
        eventId,
        manifestId: manifest.manifestId,
        clientSequence: 1,
        jobFingerprint: pickupJob.fingerprint,
        predecessorFingerprint: pickupJob.predecessorFingerprint,
        truckPlate: pickupJob.truckPlate,
        deviceOccurredAt: occurredAt
      }
    });
    assert.equal(started.response.status, 200, JSON.stringify(started.payload));
  } else {
    const synced = await request("/api/driver/offline-sync", {
      method: "POST",
      offlineGrant: manifest.offlineSyncGrant,
      body: {
        manifestId: manifest.manifestId,
        deviceId: DEVICE_ID,
        offlineSyncGrant: manifest.offlineSyncGrant,
        events: [{
          eventId,
          manifestId: manifest.manifestId,
          deviceId: DEVICE_ID,
          clientSequence: 1,
          eventType: "job_started",
          jobId: pickupJob.jobId,
          jobFingerprint: pickupJob.fingerprint,
          predecessorFingerprint: pickupJob.predecessorFingerprint,
          occurredAt,
          locationStatus: "not_required",
          locationDetails: { warningCode: "", overrideReason: "" },
          details: {},
          photos: []
        }],
        photoReceipts: []
      }
    });
    assert.equal(synced.response.status, 200, JSON.stringify(synced.payload));
    assert.equal(synced.payload.events?.[0]?.status, "applied", JSON.stringify(synced.payload));
  }
  await assertStartDidNotForgeOperatorProgress();
  await assert.rejects(
    markDirectDependencyPickupCompleted({
      transferOrderRefs: [TRANSFER_ORDER_REF],
      driverJobId: pickupJob.jobId,
      driverLogin: DRIVER_LOGIN,
      planId: PLAN_ID,
      planDate,
      truckPlate: TRUCK_PLATE,
      loadId: LOAD_ID
    }),
    /completed Driver pickup evidence/i,
    "Starting a job must not be sufficient to advance direct inventory."
  );

  if (MODE === "online") {
    await completeOnline();
  } else {
    await completeOffline();
  }
  await assertCompletionAdvancedOnlyDriverDependency();

  const replayed = await markDirectDependencyPickupCompleted({
    transferOrderRefs: [TRANSFER_ORDER_REF],
    driverJobId: pickupJob.jobId,
    driverLogin: DRIVER_LOGIN,
    planId: PLAN_ID,
    planDate,
    truckPlate: TRUCK_PLATE,
    loadId: LOAD_ID
  });
  assert.equal(replayed[0]?.alreadyCompleted, true);
  await assertCompletionAdvancedOnlyDriverDependency();
});
