// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { closeDb, query } from "../../../src/db.js";
import {
  completeMbtDriverBinJob,
  materializeMbtDriverBinJob,
  startMbtDriverBinJob
} from "../../../src/mbt/driver-bin-execution-service.js";
import { MbtError } from "../../../src/mbt/errors.js";
import {
  createAssignedDriverBinFixture,
  driverBinDurableState,
  driverBinEvent,
  enabledDriverBinBoundary
} from "../support/driver-bin-fixtures.js";

const DRIVER_VERSION = Object.freeze({
  clientVersion: "2026.08.03.1",
  minimumClientVersion: "2026.08.03.1"
});

after(closeDb);

/**
 * @param {unknown} error
 * @param {{status: number, code: string, message: string, eventId?: string}} expected
 */
function exactMbtFailure(error, expected) {
  return error instanceof MbtError
    && error.status === expected.status
    && error.code === expected.code
    && error.message === expected.message
    && (expected.eventId === undefined || error.details?.eventId === expected.eventId);
}

/** @param {Record<string, any>} baseJob @param {Record<string, string>} [versions] */
function materialize(baseJob, versions = DRIVER_VERSION) {
  return materializeMbtDriverBinJob(baseJob, versions);
}

/** @param {Record<string, any>} fixture */
function partialManifest(fixture) {
  return {
    manifestId: crypto.randomUUID(),
    schemaVersion: 2,
    planId: fixture.planId,
    planRevision: fixture.assignment.planRevision
  };
}

/** @param {Record<string, any>} fixture @param {Record<string, any>} job */
function validCollectDetails(fixture, job) {
  return {
    schemaVersion: "mbt-driver-bin-event-v1",
    actionCode: String(job.mbt.actionCode),
    scans: [{
      evidenceCode: "outgoing_bin_scan",
      assetRole: "outgoing",
      assetId: fixture.assetId,
      scannedValue: fixture.assetCode
    }]
  };
}

/** @param {string} eventId */
async function eventFootprint(eventId) {
  const result = await query(
    `SELECT
       (SELECT count(*)::int FROM mbt_driver_bin_event_applications
         WHERE source_event_id = $1::uuid) AS applications,
       (SELECT count(*)::int FROM mbt_evidence
         WHERE source_driver_event_id = $1::uuid) AS evidence,
       (SELECT count(*)::int FROM mbt_dump_receipts
         WHERE source_driver_event_id = $1::uuid) AS receipts,
       (SELECT count(*)::int FROM mbt_driver_bin_billing_triggers
         WHERE source_driver_event_id = $1::uuid) AS billing`,
    [eventId]
  );
  return result.rows[0];
}

test("P3 coverage: materialization rejects missing authority, wrong assignment, old clients, and unknown steps without writes", async () => {
  const fixture = await createAssignedDriverBinFixture("coverage-materialization-boundaries");
  const before = await driverBinDurableState(fixture);

  const missingVisit = structuredClone(fixture.jobs[0]);
  missingVisit.mbt.visitId = crypto.randomUUID();
  await assert.rejects(
    () => materialize(missingVisit),
    (error) => exactMbtFailure(error, {
      status: 404,
      code: "MBT_DRIVER_BIN_VISIT_NOT_FOUND",
      message: "The BIN service visit was not found."
    })
  );

  const wrongDriver = structuredClone(fixture.jobs[0]);
  wrongDriver.driverLogin = `other-${fixture.driverLogin}`;
  await assert.rejects(
    () => materialize(wrongDriver),
    (error) => exactMbtFailure(error, {
      status: 403,
      code: "MBT_DRIVER_BIN_ASSIGNMENT_MISMATCH",
      message: "The BIN visit is not assigned to this exact Driver route."
    })
  );

  await assert.rejects(
    () => materialize(fixture.jobs[0], {
      clientVersion: "2026.08.03.0",
      minimumClientVersion: "2026.08.03.1"
    }),
    (error) => exactMbtFailure(error, {
      status: 426,
      code: "DRIVER_PWA_UPDATE_REQUIRED",
      message: "Close and reopen the Driver PWA before starting BIN work."
    }) && error.details?.preserveLocalEvidence === true
  );

  const unknownStep = structuredClone(fixture.jobs[0]);
  unknownStep.stopId = `unknown-${fixture.jobs[0].stopId}`;
  unknownStep.mbt.actionCode = "";
  unknownStep.mbtDispatchStop = {};
  await assert.rejects(
    () => materialize(unknownStep),
    (error) => exactMbtFailure(error, {
      status: 409,
      code: "MBT_DRIVER_BIN_SNAPSHOT_INVALID",
      message: "The Driver stop does not match a frozen BIN visit step."
    })
  );

  assert.deepEqual(await driverBinDurableState(fixture), before);
});

test("P3 coverage: materialization safely falls back to the base-job capability snapshot", async () => {
  const fixture = await createAssignedDriverBinFixture("coverage-capability-fallback");
  const selected = await query(
    "SELECT dispatch_assignment_snapshot FROM mbt_service_visits WHERE service_visit_id = $1",
    [fixture.frontVisitId]
  );
  const assignment = structuredClone(selected.rows[0].dispatch_assignment_snapshot);
  const assignedStop = assignment.stops.find((stop) => stop.id === fixture.jobs[0].stopId);
  delete assignedStop.mbt.capabilitySnapshot;
  await query(
    `UPDATE mbt_service_visits
        SET dispatch_assignment_snapshot = $2::jsonb
      WHERE service_visit_id = $1`,
    [fixture.frontVisitId, JSON.stringify(assignment)]
  );

  const materialized = await materialize(fixture.jobs[0]);
  assert.deepEqual(materialized.mbt.capabilitySnapshot, fixture.jobs[0].mbt.capabilitySnapshot);
  assert.match(materialized.mbt.executionSnapshotHash, /^[0-9a-f]{64}$/u);
});

test("P3 coverage: event envelope and capability boundaries reject before opening a durable application", async () => {
  const fixture = await createAssignedDriverBinFixture("coverage-event-boundaries");
  const collect = await materialize(fixture.jobs[0]);
  const manifest = partialManifest(fixture);
  const before = await driverBinDurableState(fixture);

  const disabled = driverBinEvent(fixture, collect, "job_started", 1, {}, {
    manifestId: manifest.manifestId
  });
  await assert.rejects(
    () => startMbtDriverBinJob({ event: disabled, job: collect, manifest }, {
      capability: {
        environmentEnabled: false,
        databaseEnabled: true,
        pilotAuthorized: true,
        issuedManifestAuthorized: false
      }
    }),
    (error) => exactMbtFailure(error, {
      status: 409,
      code: "MBT_CAPABILITY_DISABLED",
      message: "MBT Driver BIN execution is disabled."
    })
  );

  const invalidTime = driverBinEvent(fixture, collect, "job_started", 2, {}, {
    manifestId: manifest.manifestId,
    occurredAt: "not-a-time"
  });
  await assert.rejects(
    () => startMbtDriverBinJob({ event: invalidTime, job: collect, manifest }, {
      capability: enabledDriverBinBoundary
    }),
    (error) => exactMbtFailure(error, {
      status: 400,
      code: "MBT_DRIVER_BIN_INPUT_INVALID",
      message: "The device occurrence time is invalid."
    })
  );

  const invalidSequence = driverBinEvent(fixture, collect, "job_started", 3, {}, {
    manifestId: manifest.manifestId,
    clientSequence: 0
  });
  await assert.rejects(
    () => startMbtDriverBinJob({ event: invalidSequence, job: collect, manifest }, {
      capability: enabledDriverBinBoundary
    }),
    (error) => exactMbtFailure(error, {
      status: 400,
      code: "MBT_DRIVER_BIN_INPUT_INVALID",
      message: "A positive client sequence is required."
    })
  );

  const completionAtStartBoundary = driverBinEvent(
    fixture,
    collect,
    "job_completed",
    4,
    { mbt: validCollectDetails(fixture, collect) },
    { manifestId: manifest.manifestId }
  );
  await assert.rejects(
    () => startMbtDriverBinJob({ event: completionAtStartBoundary, job: collect, manifest }, {
      capability: enabledDriverBinBoundary
    }),
    (error) => exactMbtFailure(error, {
      status: 400,
      code: "MBT_DRIVER_BIN_INPUT_INVALID",
      message: "A BIN job-start event is required."
    })
  );

  const startAtCompletionBoundary = driverBinEvent(fixture, collect, "job_started", 5, {}, {
    manifestId: manifest.manifestId
  });
  await assert.rejects(
    () => completeMbtDriverBinJob({
      event: startAtCompletionBoundary,
      job: collect,
      manifest,
      photoReferences: []
    }, { capability: enabledDriverBinBoundary }),
    (error) => exactMbtFailure(error, {
      status: 400,
      code: "MBT_DRIVER_BIN_INPUT_INVALID",
      message: "A BIN job-completion event is required."
    })
  );

  assert.deepEqual(await driverBinDurableState(fixture), before);
  for (const event of [disabled, invalidTime, invalidSequence, completionAtStartBoundary, startAtCompletionBoundary]) {
    assert.deepEqual(await eventFootprint(event.eventId), {
      applications: 0,
      evidence: 0,
      receipts: 0,
      billing: 0
    });
  }
});

test("P3 coverage: complete manifests reject missing jobs and invalid generation time without writes", async () => {
  const fixture = await createAssignedDriverBinFixture("coverage-invalid-manifest");
  const collect = await materialize(fixture.jobs[0]);
  const before = await driverBinDurableState(fixture);

  const missingJobEvent = driverBinEvent(fixture, collect, "job_started", 1);
  const missingJobManifest = {
    complete: true,
    manifestId: missingJobEvent.manifestId,
    generatedAt: new Date(Date.now() - 60_000).toISOString(),
    jobs: []
  };
  await assert.rejects(
    () => startMbtDriverBinJob({
      event: missingJobEvent,
      job: collect,
      manifest: missingJobManifest
    }, { capability: enabledDriverBinBoundary }),
    (error) => exactMbtFailure(error, {
      status: 409,
      code: "MBT_DRIVER_BIN_MANIFEST_INVALID",
      message: "The complete offline route does not contain this BIN job. Reopen the Driver PWA."
    })
  );

  const invalidTimeEvent = driverBinEvent(fixture, collect, "job_started", 2);
  const invalidTimeManifest = {
    complete: true,
    manifestId: invalidTimeEvent.manifestId,
    generatedAt: "invalid",
    jobs: [{ jobId: collect.jobId, sequenceIndex: 0 }]
  };
  await assert.rejects(
    () => startMbtDriverBinJob({
      event: invalidTimeEvent,
      job: collect,
      manifest: invalidTimeManifest
    }, { capability: enabledDriverBinBoundary }),
    (error) => exactMbtFailure(error, {
      status: 409,
      code: "MBT_DRIVER_BIN_MANIFEST_INVALID",
      message: "The complete offline route has no valid generation time. Reopen the Driver PWA."
    })
  );

  assert.deepEqual(await driverBinDurableState(fixture), before);
  assert.deepEqual(await eventFootprint(missingJobEvent.eventId), {
    applications: 0, evidence: 0, receipts: 0, billing: 0
  });
  assert.deepEqual(await eventFootprint(invalidTimeEvent.eventId), {
    applications: 0, evidence: 0, receipts: 0, billing: 0
  });
});

test("P3 coverage: a completed visit is not startable and preserves the source event identity", async () => {
  const fixture = await createAssignedDriverBinFixture("coverage-non-startable");
  const collect = await materialize(fixture.jobs[0]);
  await query(
    "UPDATE mbt_service_visits SET status = 'completed' WHERE service_visit_id = $1",
    [fixture.frontVisitId]
  );
  const manifest = partialManifest(fixture);
  const event = driverBinEvent(fixture, collect, "job_started", 1, {}, {
    manifestId: manifest.manifestId
  });
  const before = await driverBinDurableState(fixture);
  await assert.rejects(
    () => startMbtDriverBinJob({ event, job: collect, manifest }, {
      capability: enabledDriverBinBoundary
    }),
    (error) => exactMbtFailure(error, {
      status: 409,
      code: "MBT_DRIVER_BIN_REVIEW_REQUIRED",
      message: "The BIN visit is no longer startable.",
      eventId: event.eventId
    })
  );
  assert.deepEqual(await driverBinDurableState(fixture), before);
  assert.deepEqual(await eventFootprint(event.eventId), {
    applications: 0, evidence: 0, receipts: 0, billing: 0
  });
});

test("P3 coverage: action drift and a cancelled visit are distinct completion review boundaries", async () => {
  const actionFixture = await createAssignedDriverBinFixture("coverage-action-drift");
  const actionCollect = await materialize(actionFixture.jobs[0]);
  const actionManifest = partialManifest(actionFixture);
  const actionEvent = driverBinEvent(actionFixture, actionCollect, "job_completed", 1, {
    mbt: { schemaVersion: "mbt-driver-bin-event-v1", actionCode: "deliver_bin" }
  }, { manifestId: actionManifest.manifestId });
  const actionBefore = await driverBinDurableState(actionFixture);
  await assert.rejects(
    () => completeMbtDriverBinJob({
      event: actionEvent,
      job: actionCollect,
      manifest: actionManifest,
      photoReferences: []
    }, { capability: enabledDriverBinBoundary }),
    (error) => exactMbtFailure(error, {
      status: 409,
      code: "MBT_DRIVER_BIN_REVIEW_REQUIRED",
      message: "The saved BIN action no longer matches its visit step.",
      eventId: actionEvent.eventId
    })
  );
  assert.deepEqual(await driverBinDurableState(actionFixture), actionBefore);

  const statusFixture = await createAssignedDriverBinFixture("coverage-non-completable");
  const statusCollect = await materialize(statusFixture.jobs[0]);
  await query(
    `UPDATE mbt_service_visits
        SET status = 'cancelled', cancelled_at = now(),
            cancellation_reason = 'Synthetic coverage cancellation'
      WHERE service_visit_id = $1`,
    [statusFixture.frontVisitId]
  );
  const statusManifest = partialManifest(statusFixture);
  const statusEvent = driverBinEvent(statusFixture, statusCollect, "job_completed", 1, {
    mbt: validCollectDetails(statusFixture, statusCollect)
  }, { manifestId: statusManifest.manifestId });
  const statusBefore = await driverBinDurableState(statusFixture);
  await assert.rejects(
    () => completeMbtDriverBinJob({
      event: statusEvent,
      job: statusCollect,
      manifest: statusManifest,
      photoReferences: []
    }, { capability: enabledDriverBinBoundary }),
    (error) => exactMbtFailure(error, {
      status: 409,
      code: "MBT_DRIVER_BIN_REVIEW_REQUIRED",
      message: "The BIN visit is no longer completable.",
      eventId: statusEvent.eventId
    })
  );
  assert.deepEqual(await driverBinDurableState(statusFixture), statusBefore);
  assert.deepEqual(await eventFootprint(actionEvent.eventId), {
    applications: 0, evidence: 0, receipts: 0, billing: 0
  });
  assert.deepEqual(await eventFootprint(statusEvent.eventId), {
    applications: 0, evidence: 0, receipts: 0, billing: 0
  });
});

test("P3 coverage: unversioned and mismatched-step jobs cannot create start records", async () => {
  const fixture = await createAssignedDriverBinFixture("coverage-job-snapshot-boundaries");
  const manifest = partialManifest(fixture);
  const before = await driverBinDurableState(fixture);

  const unversionedEvent = driverBinEvent(fixture, fixture.jobs[0], "job_started", 1, {}, {
    manifestId: manifest.manifestId
  });
  await assert.rejects(
    () => startMbtDriverBinJob({
      event: unversionedEvent,
      job: fixture.jobs[0],
      manifest
    }, { capability: enabledDriverBinBoundary }),
    (error) => exactMbtFailure(error, {
      status: 409,
      code: "MBT_DRIVER_BIN_SNAPSHOT_INVALID",
      message: "A versioned BIN Driver job is required."
    })
  );

  const mismatchedStep = await materialize(fixture.jobs[0]);
  mismatchedStep.mbt.visitStepId = crypto.randomUUID();
  const stepEvent = driverBinEvent(fixture, mismatchedStep, "job_started", 2, {}, {
    manifestId: manifest.manifestId
  });
  await assert.rejects(
    () => startMbtDriverBinJob({ event: stepEvent, job: mismatchedStep, manifest }, {
      capability: enabledDriverBinBoundary
    }),
    (error) => exactMbtFailure(error, {
      status: 409,
      code: "MBT_DRIVER_BIN_REVIEW_REQUIRED",
      message: "The saved BIN step no longer matches this visit."
    })
  );

  assert.deepEqual(await driverBinDurableState(fixture), before);
  assert.deepEqual(await eventFootprint(unversionedEvent.eventId), {
    applications: 0, evidence: 0, receipts: 0, billing: 0
  });
  assert.deepEqual(await eventFootprint(stepEvent.eventId), {
    applications: 0, evidence: 0, receipts: 0, billing: 0
  });
});

test("P3 coverage: reusing an applied event ID with changed evidence is rejected without a second write", async () => {
  const fixture = await createAssignedDriverBinFixture("coverage-event-id-conflict");
  const collect = await materialize(fixture.jobs[0]);
  const manifest = partialManifest(fixture);
  const event = driverBinEvent(fixture, collect, "job_started", 1, {}, {
    manifestId: manifest.manifestId
  });
  const applied = await startMbtDriverBinJob({ event, job: collect, manifest }, {
    capability: enabledDriverBinBoundary
  });
  assert.equal(applied.replayed, false);
  const beforeConflict = await driverBinDurableState(fixture);
  const conflicting = structuredClone(event);
  conflicting.clientSequence = 2;

  await assert.rejects(
    () => startMbtDriverBinJob({ event: conflicting, job: collect, manifest }, {
      capability: enabledDriverBinBoundary
    }),
    (error) => exactMbtFailure(error, {
      status: 409,
      code: "MBT_DRIVER_BIN_EVENT_IDEMPOTENCY_CONFLICT",
      message: "The BIN event ID was reused with different evidence."
    })
  );
  assert.deepEqual(await driverBinDurableState(fixture), beforeConflict);
  assert.deepEqual(await eventFootprint(event.eventId), {
    applications: 1, evidence: 0, receipts: 0, billing: 0
  });
});

test("P3 coverage: required note/signature evidence rejects incomplete attempts and accepts durable plus inline signatures", async () => {
  const fixture = await createAssignedDriverBinFixture("coverage-note-signature");
  const step = await query(
    `SELECT visit_step_id::text
       FROM mbt_visit_steps
      WHERE service_visit_id = $1 AND action_code = 'collect_empty_bin'`,
    [fixture.frontVisitId]
  );
  const stepId = String(step.rows[0].visit_step_id);
  await query(
    `INSERT INTO mbt_visit_evidence_requirements (
       visit_evidence_requirement_id, service_visit_id, visit_step_id,
       evidence_code, evidence_type, minimum_count, required
     ) VALUES
       ($1, $3, $4, 'driver_note', 'note', 1, true),
       ($2, $3, $4, 'site_signature', 'signature', 1, true)`,
    [crypto.randomUUID(), crypto.randomUUID(), fixture.frontVisitId, stepId]
  );
  const collect = await materialize(fixture.jobs[0]);
  const manifest = partialManifest(fixture);
  const before = await driverBinDurableState(fixture);

  const missingNote = driverBinEvent(fixture, collect, "job_completed", 1, {
    mbt: validCollectDetails(fixture, collect)
  }, { manifestId: manifest.manifestId });
  await assert.rejects(
    () => completeMbtDriverBinJob({
      event: missingNote,
      job: collect,
      manifest,
      photoReferences: []
    }, { capability: enabledDriverBinBoundary }),
    (error) => exactMbtFailure(error, {
      status: 409,
      code: "MBT_DRIVER_BIN_EVIDENCE_MISSING",
      message: "Required note driver_note is missing."
    })
  );
  assert.deepEqual(await driverBinDurableState(fixture), before);

  const missingSignaturePhoto = driverBinEvent(fixture, collect, "job_completed", 2, {
    mbt: {
      ...validCollectDetails(fixture, collect),
      notes: [{ evidenceCode: "driver_note", text: "No damage observed" }],
      signatures: [{
        evidenceCode: "site_signature",
        signedBy: "Site Receiver",
        signaturePhotoOrdinal: 0
      }]
    }
  }, { manifestId: manifest.manifestId });
  await assert.rejects(
    () => completeMbtDriverBinJob({
      event: missingSignaturePhoto,
      job: collect,
      manifest,
      photoReferences: []
    }, { capability: enabledDriverBinBoundary }),
    (error) => exactMbtFailure(error, {
      status: 409,
      code: "MBT_DRIVER_BIN_EVIDENCE_MISSING",
      message: "Required signature site_signature is missing."
    })
  );
  assert.deepEqual(await driverBinDurableState(fixture), before);

  const photoReference = `r2://driver-stop-photo/${fixture.suffix}-signature.jpg`;
  const completedEvent = driverBinEvent(fixture, collect, "job_completed", 3, {
    mbt: {
      ...validCollectDetails(fixture, collect),
      notes: [{ evidenceCode: "driver_note", text: "No damage observed" }],
      signatures: [
        {
          evidenceCode: "site_signature",
          signedBy: "Site Receiver",
          signaturePhotoOrdinal: 0
        },
        {
          evidenceCode: "driver_ack",
          signedBy: "Synthetic Driver",
          signaturePhotoOrdinal: 99
        }
      ]
    }
  }, {
    manifestId: manifest.manifestId,
    photos: [{
      photoId: crypto.randomUUID(),
      ordinal: 0,
      objectReference: photoReference,
      sha256: "b".repeat(64),
      mimeType: "image/jpeg",
      byteSize: 4_096,
      durableReceipt: true
    }]
  });
  const result = await completeMbtDriverBinJob({
    event: completedEvent,
    job: collect,
    manifest,
    photoReferences: [photoReference]
  }, { capability: enabledDriverBinBoundary });
  assert.equal(result.replayed, false);

  const evidence = await query(
    `SELECT evidence_type, evidence_code, storage_key, mime_type
       FROM mbt_evidence
      WHERE source_driver_event_id = $1::uuid
      ORDER BY evidence_type, evidence_code`,
    [completedEvent.eventId]
  );
  assert.deepEqual(evidence.rows.map((row) => ({
    type: row.evidence_type,
    code: row.evidence_code,
    key: row.storage_key,
    mime: row.mime_type
  })), [
    {
      type: "bin_scan",
      code: "outgoing_bin_scan",
      key: `driver-bin-scan/${completedEvent.eventId}/outgoing_bin_scan/0`,
      mime: "application/vnd.mbbs-bin-scan+json"
    },
    {
      type: "note",
      code: "driver_note",
      key: `driver-bin-note/${completedEvent.eventId}/driver_note`,
      mime: "text/plain"
    },
    {
      type: "signature",
      code: "driver_ack",
      key: `driver-bin-signature/${completedEvent.eventId}/0`,
      mime: "application/vnd.mbbs-signature+json"
    },
    {
      type: "signature",
      code: "site_signature",
      key: photoReference,
      mime: "image/jpeg"
    }
  ]);
  assert.deepEqual(await eventFootprint(completedEvent.eventId), {
    applications: 1, evidence: 4, receipts: 0, billing: 1
  });
});

test("P3 coverage: a late billing-hook failure rolls back all evidence and can be safely retried", async () => {
  const fixture = await createAssignedDriverBinFixture("coverage-late-hook-rollback");
  const collect = await materialize(fixture.jobs[0]);
  const manifest = partialManifest(fixture);
  const event = driverBinEvent(fixture, collect, "job_completed", 1, {
    mbt: validCollectDetails(fixture, collect)
  }, { manifestId: manifest.manifestId });
  const input = { event, job: collect, manifest, photoReferences: [] };
  const before = await driverBinDurableState(fixture);
  const injected = new Error("synthetic failure after local-only billing trigger");

  await assert.rejects(
    () => completeMbtDriverBinJob(input, {
      capability: enabledDriverBinBoundary,
      hooks: {
        afterBillingTrigger: () => {
          throw injected;
        }
      }
    }),
    (error) => error === injected
  );
  assert.deepEqual(await driverBinDurableState(fixture), before);
  assert.deepEqual(await eventFootprint(event.eventId), {
    applications: 0, evidence: 0, receipts: 0, billing: 0
  });

  const retried = await completeMbtDriverBinJob(input, {
    capability: enabledDriverBinBoundary
  });
  assert.equal(retried.replayed, false);
  const afterRetry = await driverBinDurableState(fixture);
  assert.equal(afterRetry.application_count, before.application_count + 1);
  assert.equal(afterRetry.evidence_count, before.evidence_count + 1);
  assert.equal(afterRetry.movement_count, before.movement_count + 1);
  assert.equal(afterRetry.completed_driver_record_count, before.completed_driver_record_count + 1);
  assert.deepEqual(await eventFootprint(event.eventId), {
    applications: 1, evidence: 1, receipts: 0, billing: 1
  });
});
