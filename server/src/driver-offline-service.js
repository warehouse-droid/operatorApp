import { query, withTransaction } from "./db.js";
import { getDriverDayJobs } from "./driver-repository.js";
import { DISPATCH_FLEET_PLANNING_LOCK } from "./dispatch-fleet-status.js";
import {
  consumeDriverLocationVerification,
  findDriverOfflineRebaseCandidates,
  getDriverOfflineEvent,
  getDriverOfflineManifest,
  getDriverOfflineSyncQueue,
  markDriverOfflineEventApplied,
  markDriverOfflineEventApplying,
  markDriverOfflineEventBlocked,
  markDriverOfflineEventEvidenceOnly,
  markDriverOfflineEventReviewRequired,
  materializeDriverOfflineJobs
} from "./driver-offline-repository.js";

function safeError(error) {
  return {
    code: String(error?.code || "OFFLINE_EVENT_APPLICATION_FAILED").slice(0, 160),
    error: String(error?.message || error || "Offline event application failed.").slice(0, 2000)
  };
}

function canonicalOccurrenceTime(value) {
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : "";
}

export async function foregroundReceiptResult(event, manifest) {
  const result = await query(
    `SELECT *
       FROM driver_foreground_action_receipts
      WHERE event_id = $1::uuid
      LIMIT 1
      FOR UPDATE`,
    [event.eventId]
  );
  if (!result.rowCount) return null;
  const receipt = result.rows[0];
  const compatibleType = receipt.action_type === event.eventType
    || (
      event.eventType === "truck_switched_physical"
      && receipt.action_type === "truck_switched_samsara_skipped"
    );
  const compatibleTarget = event.eventType === "dvir_captured"
    ? String(receipt.target_id || "") === String(event.details?.dvirType || "pre")
    : String(receipt.target_id || "") === String(event.jobId || "");
  const context = receipt.event_context || {};
  const manifestJob = event.jobId ? jobSnapshotForEvent(manifest, event) : null;
  const compatibleManifest = String(context.manifestId || "") === String(event.manifestId)
    && String(context.planId ?? "") === String(manifest?.planId ?? "")
    && String(context.planDate || "") === String(manifest?.planDate || "")
    && Number(context.planRevision || 0) === Number(manifest?.planRevision || 0);
  const compatibleIdentity = !event.jobId || (
    String(context.jobFingerprint || "") === String(event.jobFingerprint || "")
    && String(context.predecessorFingerprint || "") === String(event.predecessorFingerprint || "")
    && String(manifestJob?.fingerprint || "") === String(event.jobFingerprint || "")
    && String(manifestJob?.predecessorFingerprint || "") === String(event.predecessorFingerprint || "")
  );
  const compatibleTruck = event.eventType !== "dvir_captured"
    || String(context.truckPlate || "").replace(/\s+/g, "").toUpperCase()
      === String(event.details?.truckPlate || manifest?.dayState?.truckPlate || "").replace(/\s+/g, "").toUpperCase();
  const compatibleSequence = !Number(context.clientSequence)
    || Number(context.clientSequence) === Number(event.clientSequence);
  const compatibleOccurrence = canonicalOccurrenceTime(receipt.device_occurred_at)
    === canonicalOccurrenceTime(event.occurredAt);
  if (
    String(receipt.driver_login).toLowerCase() !== String(event.driverLogin).toLowerCase()
    || String(receipt.device_id) !== String(event.deviceId)
    || !compatibleType
    || !compatibleTarget
    || !compatibleManifest
    || !compatibleIdentity
    || !compatibleTruck
    || !compatibleSequence
    || !compatibleOccurrence
  ) {
    return markDriverOfflineEventReviewRequired(event.eventId, {
      reason: "The foreground action receipt does not match this offline event.",
      result: { code: "OFFLINE_FOREGROUND_RECEIPT_MISMATCH" }
    });
  }
  if (event.eventType === "dvir_captured") {
    try {
      validatePhotoEvidence(event, null);
    } catch (error) {
      return markDriverOfflineEventReviewRequired(event.eventId, {
        reason: String(error?.message || "Foreground DVIR evidence is not durably available."),
        result: safeError(error)
      });
    }
  }
  if (receipt.status === "applied") {
    return markDriverOfflineEventApplied(event.eventId, {
      effectiveJobId: event.jobId || "",
      result: {
        ...(receipt.result || {}),
        foregroundReceipt: true,
        foregroundReceiptAppliedAt: receipt.completed_at
      }
    });
  }
  if (
    receipt.status === "executing"
    && Date.now() - new Date(receipt.created_at).getTime() < 5 * 60 * 1000
  ) {
    return {
      ...event,
      foregroundExecuting: true
    };
  }
  return markDriverOfflineEventReviewRequired(event.eventId, {
    reason: receipt.status === "executing"
      ? "The online action may have reached Samsara before its server response was interrupted."
      : receipt.error_message || "The online foreground action failed before its event was synchronized.",
    result: {
      code: receipt.status === "executing"
        ? "OFFLINE_FOREGROUND_OUTCOME_UNCERTAIN"
        : receipt.error_code || "OFFLINE_FOREGROUND_ACTION_FAILED"
    }
  });
}

function jobSnapshotForEvent(manifest, event) {
  return (manifest?.jobs || []).find((job) => String(job.jobId) === String(event.jobId)) || null;
}

async function supersedingDriverPwaCorrection(event, manifest) {
  if (!event?.jobId || !manifest?.generatedAt) return null;
  const result = await query(
    `SELECT correction_id, corrected_by, audit_note, created_at
       FROM driver_job_corrections
      WHERE action = 'reopen'
        AND lower(driver_login) = lower($1)
        AND plan_date = $2::date
        AND job_id = $3
        AND created_at > $4::timestamptz
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [event.driverLogin, event.planDate, event.jobId, manifest.generatedAt]
  );
  return result.rows[0] || null;
}

function currentJobEntries(currentPlan, driverLogin) {
  if (!currentPlan?.jobs?.length) return [];
  return materializeDriverOfflineJobs(currentPlan.jobs, driverLogin).map((entry) => ({
    ...entry,
    jobId: entry.snapshot.jobId
  }));
}

function manifestProjectionClientVersion(manifest) {
  const versions = [...new Set((manifest?.jobs || [])
    .map((job) => String(job?.mbt?.minimumClientVersion || "").trim())
    .filter(Boolean))];
  return versions.length === 1 ? versions[0] : "";
}

function resolveEffectiveJob({ event, manifest, currentPlan, currentEntries, driverLogin }) {
  if (!event.jobId) {
    const revisionUnchanged = String(currentPlan?.planId ?? "") === String(manifest?.planId ?? "")
      && Number(currentPlan?.revision || 0) === Number(manifest?.planRevision || 0);
    if (event.eventType === "dvir_captured" && !revisionUnchanged) {
      return {
        conflict: "The assigned plan changed after this offline inspection was captured."
      };
    }
    return { job: null, rebased: false };
  }
  const original = jobSnapshotForEvent(manifest, event);
  if (!original) {
    return { conflict: "The original job snapshot is missing from the offline manifest." };
  }
  const revisionUnchanged = String(currentPlan?.planId ?? "") === String(manifest?.planId ?? "")
    && Number(currentPlan?.revision || 0) === Number(manifest?.planRevision || 0);
  if (revisionUnchanged) {
    const current = currentEntries.find((entry) => entry.jobId === event.jobId);
    if (
      current
      && current.fingerprint === event.jobFingerprint
      && current.predecessorFingerprint === event.predecessorFingerprint
    ) {
      return { job: current.snapshot, rebased: false };
    }
    return {
      conflict: "The original stop no longer matches the unchanged plan snapshot."
    };
  }
  const candidates = findDriverOfflineRebaseCandidates(event, currentPlan?.jobs || [], driverLogin);
  if (candidates.length === 1) {
    return {
      job: candidates[0].job,
      rebased: candidates[0].jobId !== event.jobId,
      candidate: candidates[0]
    };
  }
  return {
    conflict: candidates.length
      ? "More than one current stop matches this offline event."
      : "The assigned stop, predecessor, or driver changed after the route was downloaded.",
    candidates
  };
}

async function validateLocationEvidence(event, effectiveJob) {
  if (event.eventType !== "job_completed") return null;
  if (event.locationStatus === "not_checked_offline") {
    return { status: "not_checked_offline", source: "offline" };
  }
  if (event.locationStatus === "not_required" && Number(effectiveJob?.requiredPhotos || 0) === 0) {
    return { status: "not_required", source: "route" };
  }
  const verificationId = event.details?.locationVerificationId
    || event.locationDetails?.verificationId
    || "";
  if (!verificationId) {
    throw Object.assign(new Error("Online location verification evidence is missing."), {
      code: "OFFLINE_LOCATION_EVIDENCE_MISSING"
    });
  }
  const verification = await consumeDriverLocationVerification(verificationId, {
    driverLogin: event.driverLogin,
    jobId: effectiveJob?.jobId || event.jobId,
    eventId: event.eventId,
    deviceId: event.deviceId,
    occurredAt: event.occurredAt
  });
  const acceptable = event.locationStatus === "verified"
    ? verification?.status === "verified"
    : event.locationStatus === "warning_overridden"
      ? ["warning", "override_allowed"].includes(verification?.status)
      : false;
  if (!acceptable) {
    throw Object.assign(new Error("Online location verification is invalid or expired."), {
      code: "OFFLINE_LOCATION_EVIDENCE_INVALID"
    });
  }
  return verification;
}

function validatePhotoEvidence(event, effectiveJob) {
  const durablePhotos = (event.photos || []).filter((photo) => photo.durableReceipt);
  let required = 0;
  if (event.eventType === "job_completed") {
    required = Math.max(0, Number(effectiveJob?.requiredPhotos || 0));
  } else if (event.eventType === "dvir_captured") {
    required = 4;
  }
  if (durablePhotos.length < required) {
    throw Object.assign(
      new Error(`${required} durably received photo${required === 1 ? " is" : "s are"} required.`),
      { code: "OFFLINE_REQUIRED_PHOTOS_MISSING" }
    );
  }
  return durablePhotos.map((photo) => photo.objectReference);
}

export async function findDriverOfflineCompletionConflict(event, effectiveJob) {
  if (event.eventType !== "job_completed" || !effectiveJob?.jobId) return null;
  const result = await query(
    `SELECT driver_login AS existing_driver_login,
            source_offline_event_id::text AS source_offline_event_id
       FROM driver_job_records
      WHERE job_id = $1
        AND status = 'complete'
      LIMIT 1
      FOR UPDATE`,
    [effectiveJob.jobId]
  );
  if (!result.rowCount) return null;
  const existingDriverLogin = String(result.rows[0].existing_driver_login || "");
  const sourceEventId = String(result.rows[0].source_offline_event_id || "");
  const sameDriver = existingDriverLogin.toLowerCase() === String(event.driverLogin || "").toLowerCase();
  if (sameDriver && sourceEventId === String(event.eventId)) return null;
  return {
    ownerMismatch: !sameDriver,
    sourceEventId,
    reason: !sameDriver
      ? "This job was already completed under a different driver assignment."
      : sourceEventId
        ? "This job was already completed by a different offline event."
        : "This job was already completed before this offline event was received."
  };
}

async function applyOneEvent({
  event,
  manifest,
  currentPlan,
  currentEntries,
  driverLogin,
  applyEvent
}) {
  const resolved = resolveEffectiveJob({
    event,
    manifest,
    currentPlan,
    currentEntries,
    driverLogin
  });
  if (resolved.conflict) {
    return markDriverOfflineEventReviewRequired(event.eventId, {
      reason: resolved.conflict,
      result: {
        candidates: (resolved.candidates || []).map(({ job, ...candidate }) => candidate)
      }
    });
  }
  const duplicateCompletion = await findDriverOfflineCompletionConflict(event, resolved.job);
  if (duplicateCompletion) {
    return markDriverOfflineEventReviewRequired(event.eventId, {
      reason: duplicateCompletion.reason,
      result: {
        code: "OFFLINE_JOB_ALREADY_COMPLETED",
        ...(duplicateCompletion.ownerMismatch
          ? { existingOwnerMismatch: true }
          : { existingOfflineEventId: duplicateCompletion.sourceEventId })
      }
    });
  }
  try {
    const photoReferences = validatePhotoEvidence(event, resolved.job);
    const locationVerification = await validateLocationEvidence(event, resolved.job);
    await markDriverOfflineEventApplying(event.eventId);
    const application = await withTransaction(() => applyEvent({
      event,
      job: resolved.job,
      manifest,
      rebased: resolved.rebased,
      photoReferences,
      locationVerification,
      offlineTrace: {
        eventId: event.eventId,
        occurredAt: event.occurredAt,
        receivedAt: event.receivedAt,
        locationStatus: event.locationStatus,
        locationDetails: {
          verificationId: locationVerification?.verificationId || "",
          source: locationVerification?.source || (
            event.locationStatus === "not_checked_offline" ? "offline" : ""
          )
        }
      },
      routeJobs: currentPlan.jobs || []
    }));
    return markDriverOfflineEventApplied(event.eventId, {
      effectiveJobId: resolved.job?.jobId || "",
      result: {
        ...(application || {}),
        rebased: resolved.rebased === true,
        originalJobId: event.jobId || "",
        effectiveJobId: resolved.job?.jobId || ""
      }
    });
  } catch (error) {
    return markDriverOfflineEventReviewRequired(event.eventId, {
      reason: String(error?.message || error || "Offline event could not be applied."),
      result: safeError(error)
    });
  }
}

export async function processDriverOfflineQueue({
  driverLogin,
  planDate,
  deviceId = "",
  applyEvent,
  allowBlocked = false,
  onlyEventIds = null
}) {
  if (typeof applyEvent !== "function") throw new Error("Offline event application handler is required.");
  const manifestCache = new Map();
  const allowedIds = onlyEventIds ? new Set(onlyEventIds.map(String)) : null;
  const output = [];
  let reviewBarrier = false;
  const queue = await getDriverOfflineSyncQueue(driverLogin, planDate, {
    limit: 1000,
    deviceId
  });

  for (const queued of queue) {
    if (allowedIds && !allowedIds.has(String(queued.eventId))) continue;
    if (["applied", "evidence_only", "rejected"].includes(queued.status)) {
      output.push(queued);
      continue;
    }
    // A Dispatcher restart is a deliberate evidence-preserving barrier. Check
    // it before the ordinary review/photo barriers so a late upload from the
    // superseded manifest can drain locally without replaying the old action.
    const correctionDisposition = await withTransaction(async () => {
      await query("SELECT pg_advisory_xact_lock(hashtext($1))", [DISPATCH_FLEET_PLANNING_LOCK]);
      await query(
        "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
        [String(driverLogin).trim().toLowerCase(), String(planDate).slice(0, 10)]
      );
      const event = await getDriverOfflineEvent(queued.eventId);
      if (!event || ["applied", "evidence_only", "rejected"].includes(event.status)) return null;
      if (!manifestCache.has(event.manifestId)) {
        manifestCache.set(
          event.manifestId,
          await getDriverOfflineManifest(event.manifestId, {
            driverLogin: event.driverLogin,
            deviceId: event.deviceId,
            touch: false
          })
        );
      }
      const manifest = manifestCache.get(event.manifestId);
      if (!manifest) return null;
      const correction = await supersedingDriverPwaCorrection(event, manifest);
      if (!correction) return null;
      return markDriverOfflineEventEvidenceOnly(event.eventId, {
        reason: "Dispatcher restarted this stop after the saved event was captured.",
        result: {
          supersededByDriverPwaCorrectionId: correction.correction_id,
          correctedBy: correction.corrected_by,
          correctionCreatedAt: correction.created_at,
          disposition: "evidence_only"
        }
      });
    });
    if (correctionDisposition) {
      output.push(correctionDisposition);
      continue;
    }
    if (queued.status === "review_required") {
      reviewBarrier = true;
      output.push(queued);
      continue;
    }
    if (queued.status === "blocked" && !allowBlocked) {
      reviewBarrier = true;
      output.push(queued);
      continue;
    }
    if (reviewBarrier) {
      if (queued.status === "pending") {
        output.push(await markDriverOfflineEventBlocked(queued.eventId));
      } else {
        output.push(queued);
      }
      continue;
    }
    if (["waiting_photos", "registered"].includes(queued.status)) {
      output.push(queued);
      break;
    }

    const processed = await withTransaction(async () => {
      await query("SELECT pg_advisory_xact_lock(hashtext($1))", [DISPATCH_FLEET_PLANNING_LOCK]);
      await query(
        "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
        [String(driverLogin).trim().toLowerCase(), String(planDate).slice(0, 10)]
      );
      let event = await getDriverOfflineEvent(queued.eventId);
      if (!event) return queued;
      if (["applied", "evidence_only", "rejected"].includes(event.status)) return event;
      if (event.status === "review_required") return event;
      if (["waiting_photos", "registered"].includes(event.status)) return event;
      if (event.status === "blocked" && allowBlocked) {
        const unblocked = await query(
          `UPDATE driver_offline_events
              SET status = 'pending',
                  review_reason = '',
                  case_version = case_version + 1,
                  updated_at = now()
            WHERE event_id = $1::uuid
              AND status = 'blocked'
            RETURNING *`,
          [event.eventId]
        );
        if (!unblocked.rowCount) return event;
        event = { ...event, status: "pending" };
      }
      if (!manifestCache.has(event.manifestId)) {
        manifestCache.set(
          event.manifestId,
          await getDriverOfflineManifest(event.manifestId, {
            driverLogin: event.driverLogin,
            deviceId: event.deviceId,
            touch: false
          })
        );
      }
      const manifest = manifestCache.get(event.manifestId);
      if (!manifest) {
        return markDriverOfflineEventReviewRequired(event.eventId, {
          reason: "The event manifest is no longer available."
        });
      }
      const manifestHasBinJobs = (manifest.jobs || []).some((job) => job?.mbt?.schemaVersion);
      const projectionClientVersion = manifestProjectionClientVersion(manifest);
      const currentPlan = await getDriverDayJobs(driverLogin, {
        date: planDate,
        // An already issued manifest is the recovery authority. This read does
        // not release new work and must remain available after a gate closes.
        allowBin: manifestHasBinJobs,
        // Client compatibility is presentation metadata stamped by the server.
        // Re-project with the version frozen into this manifest so a PWA
        // deployment cannot make an otherwise unchanged saved stop look edited.
        ...(projectionClientVersion ? {
          clientVersion: projectionClientVersion,
          minimumClientVersion: projectionClientVersion
        } : {})
      });
      const currentEntries = currentJobEntries(currentPlan, driverLogin);
      const correction = await supersedingDriverPwaCorrection(event, manifest);
      if (correction) {
        return markDriverOfflineEventEvidenceOnly(event.eventId, {
          reason: "Dispatcher restarted this stop after the saved event was captured.",
          result: {
            supersededByDriverPwaCorrectionId: correction.correction_id,
            correctedBy: correction.corrected_by,
            correctionCreatedAt: correction.created_at,
            disposition: "evidence_only"
          }
        });
      }
      const foregroundResult = await foregroundReceiptResult(event, manifest);
      if (foregroundResult) return foregroundResult;
      return applyOneEvent({
        event,
        manifest,
        currentPlan,
        currentEntries,
        driverLogin,
        applyEvent
      });
    });
    output.push(processed);
    if (processed?.foregroundExecuting) break;
    if (processed?.status === "review_required") reviewBarrier = true;
  }
  return output;
}
