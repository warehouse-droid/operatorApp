import { closeDb, query, withTransaction } from "./db.js";
import { writeDispatchAudit } from "./dispatch-audit-repository.js";
import { DISPATCH_FLEET_PLANNING_LOCK } from "./dispatch-fleet-status.js";
import { getDriverDayJobs } from "./driver-repository.js";

const TARGET = Object.freeze({
  planId: 183,
  planDate: "2026-07-31",
  driverLogin: "sety",
  truckPlate: "CE94489",
  loadId: "T5-L1785447592270-8e748736c790a8",
  badJobId: "183:T5:T5-L1785447592270-8e748736c790a8:TRAVEL:BWS%20Woodbridge:BWS%20Woodbridge:",
  realPickupJobId: "183:T5:T5-L1785447592270-8e748736c790a8:stop-542b59aa-8509-465c-8ff6-cc2015c29a98",
  realPickupLocation: "BWS Woodbridge",
  realPickupAddress: "8821 Weston Rd, Woodbridge, ON L4L 1A6",
  recordId: 295,
  startEventId: "49d209d6-ecb1-473b-8a20-62bd3d0c0741",
  completionEventId: "b5ab5bde-1bae-4873-80b7-f98ce0ef8188",
  startedAt: "2026-07-31T13:46:22.264Z",
  completedAt: "2026-07-31T14:39:13.162Z",
  jobFingerprint: "77cd18219b99e0dc41f4afe2ad68cdaf799e59fff8d49050ac4e3d74440d9df9",
  predecessorFingerprint: "c47885ff8e9db6b9a6c63c8c047979bc4bdb257033b5c25605669b2bb4ac1ce6",
  repairCode: "SYNTHETIC_ZERO_DISTANCE_TRAVEL_SUPPRESSED",
  duplicateRepairCode: "DUPLICATE_DRIVER_RETRY_RETAINED_AS_EVIDENCE",
  duplicateRetries: [
    {
      eventId: "d446532e-5ad7-42ea-9c3c-c57ca18eaca9",
      eventType: "job_completed",
      canonicalEventId: "4a234c95-6268-42df-b1aa-55153179a2ad",
      photoCount: 5
    },
    {
      eventId: "5c762b49-0b32-49f2-8ee0-585be22b67f5",
      eventType: "job_completed",
      canonicalEventId: "4a234c95-6268-42df-b1aa-55153179a2ad",
      photoCount: 5
    },
    {
      eventId: "2f216a24-44e5-4d0d-8702-e4c0a59590d9",
      eventType: "job_started",
      canonicalEventId: "9c7577e4-78d8-4afb-98e9-02d101103249",
      photoCount: 0
    },
    {
      eventId: "a253c8d7-cfea-4d0d-8702-e4c0a59590d9",
      eventType: "job_completed",
      canonicalEventId: "8ce0cf1d-981e-498b-806d-c00622d3d9df",
      photoCount: 2
    },
    {
      eventId: "46282b3f-c10f-420c-88e8-e79e7af24b3b",
      eventType: "job_completed",
      canonicalEventId: "8ce0cf1d-981e-498b-806d-c00622d3d9df",
      photoCount: 2
    },
    {
      eventId: "ae97a30d-7e77-4d79-8cae-dc5c061ef6eb",
      eventType: "job_completed",
      canonicalEventId: "8ce0cf1d-981e-498b-806d-c00622d3d9df",
      photoCount: 2
    }
  ],
  actor: "system:ce94489-zero-travel-repair"
});

function assertRepair(condition, message) {
  if (!condition) {
    throw Object.assign(new Error(message), { code: "CE94489_ZERO_TRAVEL_REPAIR_ASSERTION_FAILED" });
  }
}

function text(value) {
  return String(value ?? "").trim();
}

function dateValue(value) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : text(value).slice(0, 10);
}

function iso(value) {
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : "";
}

function isExactRetry(record, events) {
  return text(record?.status).toLowerCase() === "superseded"
    && [TARGET.startEventId, TARGET.completionEventId].every((eventId) => {
      const event = events.get(eventId);
      return event?.status === "evidence_only"
        && event?.application_result?.code === TARGET.repairCode;
    })
    && TARGET.duplicateRetries.every(({ eventId }) => {
      const event = events.get(eventId);
      return event?.status === "evidence_only"
        && event?.application_result?.code === TARGET.duplicateRepairCode;
    });
}

async function repair() {
  const dryRun = process.env.CE94489_ZERO_TRAVEL_REPAIR_DRY_RUN === "1";
  const result = await withTransaction(async () => {
    await query("SELECT pg_advisory_xact_lock(hashtext($1))", [DISPATCH_FLEET_PLANNING_LOCK]);
    await query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [
      TARGET.driverLogin,
      TARGET.planDate
    ]);

    // Acquire row locks in one deterministic order. This script is intentionally
    // serialized with Dispatch saves and Driver-day sync before it validates or
    // changes any evidence.
    const planResult = await query("SELECT * FROM dispatch_plans WHERE id = $1 FOR UPDATE", [TARGET.planId]);
    const snapshotResult = await query("SELECT * FROM dispatch_plan_snapshots WHERE plan_id = $1 FOR SHARE", [TARGET.planId]);
    const recordResult = await query("SELECT * FROM driver_job_records WHERE id = $1 FOR UPDATE", [TARGET.recordId]);
    const repairEventIds = [
      TARGET.startEventId,
      TARGET.completionEventId,
      ...TARGET.duplicateRetries.map(({ eventId }) => eventId)
    ];
    const eventResult = await query(
      `SELECT *
         FROM driver_offline_events
        WHERE event_id = ANY($1::uuid[])
        ORDER BY client_sequence, id
        FOR UPDATE`,
      [repairEventIds]
    );
    const canonicalEventIds = [...new Set(TARGET.duplicateRetries.map(({ canonicalEventId }) => canonicalEventId))];
    const canonicalEventResult = await query(
      `SELECT *
         FROM driver_offline_events
        WHERE event_id = ANY($1::uuid[])
        ORDER BY client_sequence, id
        FOR SHARE`,
      [canonicalEventIds]
    );
    const photoCountResult = await query(
      `SELECT e.event_id::text AS event_id,
              count(p.id)::integer AS photo_count,
              count(p.id) FILTER (WHERE p.status = 'durably_received')::integer AS durable_photo_count
         FROM driver_offline_events e
         LEFT JOIN driver_offline_event_photos p ON p.event_record_id = e.id
        WHERE e.event_id = ANY($1::uuid[])
        GROUP BY e.event_id`,
      [[...repairEventIds, ...canonicalEventIds]]
    );
    const assignmentResult = await query(
      `SELECT *
         FROM dispatch_plan_load_assignments
        WHERE plan_id = $1 AND load_id = $2
        FOR UPDATE`,
      [TARGET.planId, TARGET.loadId]
    );

    assertRepair(planResult.rowCount === 1, "Target dispatch plan 183 was not found.");
    assertRepair(snapshotResult.rowCount === 1, "Target dispatch snapshot 183 was not found.");
    assertRepair(recordResult.rowCount === 1, "Synthetic Driver job record 295 was not found.");
    assertRepair(eventResult.rowCount === repairEventIds.length, "The synthetic and duplicate retry events were not found exactly once.");
    assertRepair(canonicalEventResult.rowCount === canonicalEventIds.length, "Canonical retry outcomes were not found exactly once.");
    assertRepair(assignmentResult.rowCount === 1, "CE94489 Load 4 assignment was not found exactly once.");

    const plan = planResult.rows[0];
    const snapshot = snapshotResult.rows[0];
    const record = recordResult.rows[0];
    const events = new Map(eventResult.rows.map((event) => [text(event.event_id), event]));
    const canonicalEvents = new Map(canonicalEventResult.rows.map((event) => [text(event.event_id), event]));
    const photoCounts = new Map(photoCountResult.rows.map((row) => [text(row.event_id), {
      total: Number(row.photo_count || 0),
      durable: Number(row.durable_photo_count || 0)
    }]));
    const assignment = assignmentResult.rows[0];
    assertRepair(text(plan.status).toLowerCase() === "confirmed", "Plan 183 is no longer confirmed.");
    assertRepair(dateValue(plan.plan_date) === TARGET.planDate, "Plan 183 date changed.");
    assertRepair(Number(plan.revision) >= 37, "Plan 183 does not contain the corrected Load 3 pickup revision.");
    assertRepair(text(record.job_id) === TARGET.badJobId, "Record 295 is no longer the expected synthetic travel job.");
    assertRepair(Number(record.plan_id) === TARGET.planId, "Synthetic record plan changed.");
    assertRepair(text(record.driver_login).toLowerCase() === TARGET.driverLogin, "Synthetic record owner changed.");
    assertRepair(text(record.truck_plate).toUpperCase() === TARGET.truckPlate, "Synthetic record truck changed.");
    assertRepair(text(record.load_id) === TARGET.loadId, "Synthetic record load changed.");
    assertRepair(text(record.stop_type).toLowerCase() === "travel", "Synthetic record is no longer a travel job.");
    assertRepair(iso(record.started_at) === TARGET.startedAt, "Synthetic travel arrival time changed.");
    assertRepair(
      ["in_progress", "complete", "superseded"].includes(text(record.status).toLowerCase()),
      `Synthetic record has unexpected status ${record.status}.`
    );

    const startEvent = events.get(TARGET.startEventId);
    const completionEvent = events.get(TARGET.completionEventId);
    for (const [event, eventType, occurrence] of [
      [startEvent, "job_started", TARGET.startedAt],
      [completionEvent, "job_completed", TARGET.completedAt]
    ]) {
      assertRepair(event, `${eventType} event was not found.`);
      assertRepair(text(event.event_type) === eventType, `Expected ${eventType} event type.`);
      assertRepair(text(event.original_job_id) === TARGET.badJobId, `${eventType} target changed.`);
      assertRepair(text(event.driver_login).toLowerCase() === TARGET.driverLogin, `${eventType} owner changed.`);
      assertRepair(dateValue(event.plan_date) === TARGET.planDate, `${eventType} plan date changed.`);
      assertRepair(text(event.job_fingerprint) === TARGET.jobFingerprint, `${eventType} fingerprint changed.`);
      assertRepair(
        text(event.predecessor_fingerprint) === TARGET.predecessorFingerprint,
        `${eventType} predecessor fingerprint changed.`
      );
      assertRepair(iso(event.device_occurred_at) === occurrence, `${eventType} device occurrence time changed.`);
      assertRepair(event.manifest_job_id, `${eventType} is missing its durable manifest job link.`);
      assertRepair(text(event.status) !== "rejected", `${eventType} was rejected and cannot be administratively suppressed.`);
    }

    for (const retry of TARGET.duplicateRetries) {
      const event = events.get(retry.eventId);
      const canonical = canonicalEvents.get(retry.canonicalEventId);
      assertRepair(event, `Duplicate retry event ${retry.eventId} was not found.`);
      assertRepair(canonical, `Canonical event ${retry.canonicalEventId} was not found.`);
      assertRepair(text(event.event_type) === retry.eventType, `Duplicate retry ${retry.eventId} type changed.`);
      assertRepair(text(canonical.event_type) === retry.eventType, `Canonical event ${retry.canonicalEventId} type changed.`);
      assertRepair(text(canonical.status) === "applied", `Canonical event ${retry.canonicalEventId} is no longer applied.`);
      assertRepair(text(event.original_job_id) === text(canonical.original_job_id), `Duplicate retry ${retry.eventId} targets a different job.`);
      assertRepair(text(event.driver_login).toLowerCase() === TARGET.driverLogin, `Duplicate retry ${retry.eventId} owner changed.`);
      assertRepair(text(canonical.driver_login).toLowerCase() === TARGET.driverLogin, `Canonical event ${retry.canonicalEventId} owner changed.`);
      assertRepair(text(event.job_fingerprint) === text(canonical.job_fingerprint), `Duplicate retry ${retry.eventId} fingerprint changed.`);
      assertRepair(
        text(event.predecessor_fingerprint) === text(canonical.predecessor_fingerprint),
        `Duplicate retry ${retry.eventId} predecessor changed.`
      );
      assertRepair(text(event.status) !== "rejected", `Duplicate retry ${retry.eventId} was rejected.`);
      assertRepair(
        photoCounts.get(retry.eventId)?.total === retry.photoCount,
        `Duplicate retry ${retry.eventId} photo descriptor count changed.`
      );
      const canonicalPhotos = photoCounts.get(retry.canonicalEventId) || { total: 0, durable: 0 };
      assertRepair(
        canonicalPhotos.durable === canonicalPhotos.total,
        `Canonical event ${retry.canonicalEventId} does not have durable evidence.`
      );
    }

    const matchingStops = [];
    for (const truck of snapshot.trucks || []) {
      for (const load of truck.loads || []) {
        if (text(load.id) !== TARGET.loadId) continue;
        for (const stop of load.stops || []) matchingStops.push({ truck, load, stop });
      }
    }
    const realPickup = matchingStops.find(({ stop }) => text(stop.id) === TARGET.realPickupJobId.split(":").at(-1));
    assertRepair(realPickup, "The genuine Load 4 pickup is missing from the Dispatch snapshot.");
    assertRepair(text(realPickup.stop.type).toLowerCase() === "pick", "The genuine Load 4 stop is not a pickup.");
    assertRepair(text(realPickup.stop.location) === TARGET.realPickupLocation, "The genuine Load 4 pickup location changed.");

    const route = await getDriverDayJobs(TARGET.driverLogin, { date: TARGET.planDate });
    assertRepair(Number(route.planId) === TARGET.planId, "Sety is no longer assigned to plan 183.");
    assertRepair(!route.jobs.some((job) => text(job.jobId) === TARGET.badJobId), "The synthetic zero-distance travel is still generated by the current code.");
    const realRoutePickup = route.jobs.find((job) => text(job.jobId) === TARGET.realPickupJobId);
    assertRepair(realRoutePickup, "The genuine 8821 Load 4 pickup is missing from Sety's current route.");
    assertRepair(text(realRoutePickup.address) === TARGET.realPickupAddress, "The genuine Load 4 pickup address changed.");

    if (isExactRetry(record, events)) {
      return {
        exactRetry: true,
        recordId: TARGET.recordId,
        recordStatus: record.status,
        eventStatuses: Object.fromEntries([...events].map(([id, event]) => [id, event.status])),
        nextJobId: TARGET.realPickupJobId,
        assignmentStarted: assignment.started,
        assignmentCompleted: assignment.completed
      };
    }

    const before = {
      record: {
        id: record.id,
        jobId: record.job_id,
        status: record.status,
        startedAt: record.started_at,
        completedAt: record.completed_at,
        sourceOfflineEventId: record.source_offline_event_id
      },
      events: Object.fromEntries([...events].map(([id, event]) => [id, {
        status: event.status,
        occurredAt: event.device_occurred_at,
        receivedAt: event.server_received_at,
        appliedAt: event.server_applied_at
      }])),
      assignment: { started: assignment.started, completed: assignment.completed }
    };

    for (const retry of TARGET.duplicateRetries) {
      const event = events.get(retry.eventId);
      const counts = photoCounts.get(retry.eventId) || { total: 0, durable: 0 };
      await query(
        `UPDATE driver_offline_events
            SET status = 'evidence_only',
                effective_job_id = COALESCE(effective_job_id, original_job_id),
                review_reason = '',
                application_result = $2::jsonb,
                server_applied_at = COALESCE(server_applied_at, now()),
                case_version = CASE WHEN status = 'evidence_only' THEN case_version ELSE case_version + 1 END,
                updated_at = now()
          WHERE event_id = $1::uuid`,
        [retry.eventId, JSON.stringify({
          code: TARGET.duplicateRepairCode,
          evidenceOnly: true,
          duplicateRetry: true,
          canonicalEventId: retry.canonicalEventId,
          originalJobId: event.original_job_id,
          deviceOccurredAt: iso(event.device_occurred_at),
          registeredPhotoCount: counts.total,
          durablePhotoCount: counts.durable,
          pendingPhotoCount: Math.max(0, counts.total - counts.durable),
          localPhotoRetentionRequired: counts.durable < counts.total,
          note: "A later event for this same Driver and immutable job was already durably applied. This retry is retained as evidence and will not repeat operational side effects."
        })]
      );
    }

    for (const event of [startEvent, completionEvent]) {
      const applicationResult = {
        code: TARGET.repairCode,
        evidenceOnly: true,
        syntheticRouteSuppressed: true,
        originalJobId: TARGET.badJobId,
        effectiveJobId: "",
        realNextJobId: TARGET.realPickupJobId,
        recordId: TARGET.recordId,
        deviceOccurredAt: iso(event.device_occurred_at),
        note: "The route generator created a travel step whose resolved origin and destination were both 8821 Weston Road. The event is retained as evidence without operational route effects."
      };
      await query(
        `UPDATE driver_offline_events
            SET status = 'evidence_only',
                effective_job_id = NULL,
                review_reason = '',
                application_result = $2::jsonb,
                server_applied_at = COALESCE(server_applied_at, now()),
                case_version = CASE WHEN status = 'evidence_only' THEN case_version ELSE case_version + 1 END,
                updated_at = now()
          WHERE event_id = $1::uuid`,
        [event.event_id, JSON.stringify(applicationResult)]
      );
    }

    await query(
      `UPDATE driver_job_records
          SET status = 'superseded',
              completed_at = $2::timestamptz,
              source_offline_event_id = $3::uuid,
              device_occurred_at = $2::timestamptz,
              server_received_at = $4::timestamptz,
              server_applied_at = COALESCE(server_applied_at, now()),
              location_status = $5,
              location_details = COALESCE(location_details, '{}'::jsonb) || $6::jsonb
        WHERE id = $1`,
      [
        TARGET.recordId,
        TARGET.completedAt,
        TARGET.completionEventId,
        completionEvent.server_received_at,
        completionEvent.location_status,
        JSON.stringify({
          repairCode: TARGET.repairCode,
          repairedAt: new Date().toISOString(),
          realNextJobId: TARGET.realPickupJobId,
          originalStartEventId: TARGET.startEventId,
          originalCompletionEventId: TARGET.completionEventId
        })
      ]
    );

    const expectedLoadJobIds = route.jobs
      .filter((job) => text(job.loadId) === TARGET.loadId)
      .map((job) => text(job.jobId));
    const activeResult = expectedLoadJobIds.length
      ? await query(
          `SELECT status
             FROM driver_job_records
            WHERE job_id = ANY($1::text[])
              AND status IN ('in_progress', 'complete')`,
          [expectedLoadJobIds]
        )
      : { rows: [] };
    const activeStatuses = activeResult.rows.map((row) => text(row.status).toLowerCase());
    await query(
      `UPDATE dispatch_plan_load_assignments
          SET started = $3,
              completed = $4,
              updated_at = now()
        WHERE plan_id = $1 AND load_id = $2`,
      [
        TARGET.planId,
        TARGET.loadId,
        activeStatuses.length > 0,
        expectedLoadJobIds.length > 0
          && activeStatuses.length === expectedLoadJobIds.length
          && activeStatuses.every((status) => status === "complete")
      ]
    );

    await query(
      `UPDATE driver_offline_manifests
          SET superseded_at = COALESCE(superseded_at, now()),
              updated_at = now()
        WHERE lower(driver_login) = $1
          AND plan_date = $2::date
          AND superseded_at IS NULL`,
      [TARGET.driverLogin, TARGET.planDate]
    );

    const afterAssignment = {
      started: activeStatuses.length > 0,
      completed: expectedLoadJobIds.length > 0
        && activeStatuses.length === expectedLoadJobIds.length
        && activeStatuses.every((status) => status === "complete")
    };
    await writeDispatchAudit({
      action: "driver_pwa_synthetic_zero_travel_suppressed",
      entityType: "driver_job",
      entityId: TARGET.badJobId,
      loadId: TARGET.loadId,
      truckId: text(realPickup.truck.id),
      planId: TARGET.planId,
      planDate: TARGET.planDate,
      operatorName: TARGET.actor,
      source: "driver_pwa_repair",
      before,
      after: {
        record: {
          id: TARGET.recordId,
          jobId: TARGET.badJobId,
          status: "superseded",
          startedAt: TARGET.startedAt,
          completedAt: TARGET.completedAt,
          sourceOfflineEventId: TARGET.completionEventId
        },
        events: {
          [TARGET.startEventId]: "evidence_only",
          [TARGET.completionEventId]: "evidence_only",
          ...Object.fromEntries(TARGET.duplicateRetries.map(({ eventId }) => [eventId, "evidence_only"]))
        },
        assignment: afterAssignment,
        nextJobId: TARGET.realPickupJobId,
        nextJobAddress: TARGET.realPickupAddress
      },
      details: {
        repairCode: TARGET.repairCode,
        preservedDeviceStartAt: TARGET.startedAt,
        preservedDeviceCompletionAt: TARGET.completedAt,
        duplicateRetryEventIds: TARGET.duplicateRetries.map(({ eventId }) => eventId),
        duplicateRetryPhotoCount: TARGET.duplicateRetries.reduce((sum, retry) =>
          sum + Number(photoCounts.get(retry.eventId)?.total || 0), 0),
        pendingDuplicatePhotoCount: TARGET.duplicateRetries.reduce((sum, retry) => {
          const counts = photoCounts.get(retry.eventId) || { total: 0, durable: 0 };
          return sum + Math.max(0, counts.total - counts.durable);
        }, 0),
        note: "Suppressed an impossible same-address travel step and prior duplicate UI retries while retaining every immutable event, timestamp, and local photo until durable upload."
      }
    });

    return {
      exactRetry: false,
      recordId: TARGET.recordId,
      recordStatus: "superseded",
      eventStatuses: {
        [TARGET.startEventId]: "evidence_only",
        [TARGET.completionEventId]: "evidence_only",
        ...Object.fromEntries(TARGET.duplicateRetries.map(({ eventId }) => [eventId, "evidence_only"]))
      },
      nextJobId: TARGET.realPickupJobId,
      nextJobAddress: TARGET.realPickupAddress,
      assignmentStarted: afterAssignment.started,
      assignmentCompleted: afterAssignment.completed
    };
  }, { rollback: dryRun });
  return { ...result, dryRun };
}

try {
  console.log(JSON.stringify(await repair(), null, 2));
} finally {
  await closeDb();
}
