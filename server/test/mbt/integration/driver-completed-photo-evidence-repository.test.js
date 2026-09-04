// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { closeDb, query } from "../../../src/db.js";
import {
  appendDriverCompletedVisitPhotos,
  getDriverCompletedPhotoReplay,
  getDriverCompletedVisit,
  listDriverCompletedVisits
} from "../../../src/driver-completed-photo-repository.js";

after(async () => {
  await closeDb();
});

function randomPastDate() {
  const bytes = crypto.randomBytes(4).readUInt32BE(0) % 20_000;
  return new Date(Date.UTC(1900, 0, 1 + bytes)).toISOString().slice(0, 10);
}

function durablePhoto(label) {
  return `r2://driver/driver-dropoff-photo/2026/08/20/${crypto.randomUUID()}/${label}.jpg`;
}

function supplementalDescriptors(requestId, count = 1) {
  return Array.from({ length: count }, (_, index) => {
    const photoId = crypto.randomUUID();
    const ordinal = index + 1;
    return {
      photoId,
      ordinal,
      byteSize: 200 + ordinal,
      sha256: String(ordinal).repeat(64),
      mimeType: "image/jpeg",
      objectReference: `r2://dispatch-stop-evidence/driver-dropoff-photo/2026/08/20/${requestId}-${photoId}/evidence-${ordinal}.jpg`
    };
  });
}

async function fixturePlanId(planId, planDate, label) {
  if (planId) {
    return planId;
  }
  const inserted = await query(
    `INSERT INTO dispatch_plans (plan_date, status, revision, confirmed_at, note)
     VALUES ($1::date, 'confirmed', 3, now(), $2)
     RETURNING id`,
    [planDate, `Completed-photo fixture ${label}`]
  );
  return Number(inserted.rows[0].id);
}

function fixtureJobDetails({ completionSource, jobIds, label, index }) {
  const details = {
    schemaVersion: completionSource === "legacy_unknown" ? 0 : 1,
    physicalVisitJobIds: jobIds,
    consolidatedPhysicalVisit: jobIds.length > 1,
    requiredPhotos: 2,
    location: "12441 Highway 50",
    dropLocation: "12441 Highway 50",
    address: "Bolton, ON",
    orders: [{ orderRef: `SO-PHOTO-${label}-${index + 1}`, orderType: "SO" }]
  };
  if (completionSource === "dispatch_historical_assist") {
    details.completionSource = "dispatch_historical_assist";
  }
  return details;
}

function fixtureOfflineEventId(completionSource) {
  return completionSource === "driver_offline" ? crypto.randomUUID() : null;
}

async function seedVisit(label, {
  memberCount = 2,
  photoCount = 2,
  driverLogin = `photo-driver-${crypto.randomUUID().slice(0, 8)}`,
  stopType = "dropoff",
  status = "complete",
  completionSource = "driver_online",
  planDate = randomPastDate(),
  planId = null
} = {}) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const jobIds = Array.from({ length: memberCount }, (_, index) => `${label}-job-${index + 1}-${suffix}`);
  const photos = Array.from({ length: photoCount }, (_, index) => durablePhoto(`${label}-${index + 1}`));
  const resolvedPlanId = await fixturePlanId(planId, planDate, label);
  const recordIds = [];
  for (let index = 0; index < jobIds.length; index += 1) {
    const sourceOfflineEventId = fixtureOfflineEventId(completionSource);
    const details = fixtureJobDetails({ completionSource, jobIds, label, index });
    const inserted = await query(
      `INSERT INTO driver_job_records (
         job_id, plan_id, plan_date, driver_login, truck_id, truck_plate,
         load_id, load_name, stop_id, stop_type, order_refs, photo_data_urls,
         status, started_at, completed_at, job_details, source_offline_event_id
       ) VALUES (
         $1, $2, $3::date, $4, 'truck-photo', 'PHOTO-1',
         'load-photo', 'Photo evidence load', $5, $6, $7::jsonb, $8::jsonb,
         $9, $10::timestamptz,
         CASE WHEN $9 = 'complete' THEN $11::timestamptz ELSE NULL END,
         $12::jsonb, $13::uuid
       ) RETURNING id`,
      [
        jobIds[index],
        resolvedPlanId,
        planDate,
        driverLogin,
        `stop-photo-${index + 1}`,
        stopType,
        JSON.stringify([`SO-PHOTO-${label}-${index + 1}`]),
        JSON.stringify(photos),
        status,
        `${planDate}T14:00:00.000Z`,
        `${planDate}T14:05:00.000Z`,
        JSON.stringify(details),
        sourceOfflineEventId
      ]
    );
    recordIds.push(Number(inserted.rows[0].id));
  }
  return { planId: resolvedPlanId, planDate, driverLogin, jobIds, recordIds, photos };
}

function appendInput(fixture, visit, overrides = {}) {
  const requestId = overrides.requestId || crypto.randomUUID();
  return {
    recordId: fixture.recordIds[0],
    expectedStateHash: visit.stateHash,
    requestId,
    additionEventId: overrides.additionEventId || crypto.randomUUID(),
    actorId: overrides.actorId || "dispatcher-photo-1",
    actorName: overrides.actorName || "Dispatcher Photo One",
    reason: overrides.reason || "Customer requested an additional delivery-condition photo.",
    photos: overrides.photos || supplementalDescriptors(requestId)
  };
}

test("S35: completed visits group physical records before single-day filtering and expose facets", async () => {
  const grouped = await seedVisit("list-group", { memberCount: 2, photoCount: 2 });
  await seedVisit("list-other", {
    memberCount: 1,
    photoCount: 0,
    driverLogin: `other-${crypto.randomUUID().slice(0, 8)}`,
    completionSource: "dispatch_historical_assist",
    planDate: grouped.planDate,
    planId: grouped.planId
  });

  const result = await listDriverCompletedVisits({
    planDate: grouped.planDate,
    status: "complete",
    driverLogin: grouped.driverLogin.toUpperCase(),
    stopType: "drop",
    photoState: "has_photos",
    completionSource: "driver_online",
    q: "SO-PHOTO-list-group",
    limit: 20
  });

  assert.equal(result.count, 1, JSON.stringify(result));
  assert.equal(result.visits.length, 1);
  assert.deepEqual(result.visits[0].recordIds, grouped.recordIds);
  assert.deepEqual(result.visits[0].jobIds, grouped.jobIds);
  assert.equal(result.visits[0].photoCount, 2);
  assert.equal(result.visits[0].completionSource, "driver_online");
  assert.equal(result.visits[0].requiredPhotos, 2);
  assert.equal(result.visits[0].maxPhotos, 20);
  assert.match(result.visits[0].stateHash, /^[0-9a-f]{64}$/u);
  assert.ok(result.facets.drivers.some((driver) => driver.driverLogin === grouped.driverLogin.toLowerCase()));
  assert.equal(result.nextCursor, null);
});

test("S36: append atomically merges every visit member and exact replay does not duplicate evidence", async () => {
  const fixture = await seedVisit("append-group", { memberCount: 2, photoCount: 2 });
  const visit = await getDriverCompletedVisit({ recordId: fixture.recordIds[0] });
  const input = appendInput(fixture, visit);
  const completionCountBefore = Number((await query(
    `SELECT count(*)::int AS count
       FROM dispatch_order_completion_events
      WHERE completion_evidence_id = ANY($1::text[])`,
    [fixture.jobIds]
  )).rows[0].count);

  const result = await appendDriverCompletedVisitPhotos(input);
  const replay = await appendDriverCompletedVisitPhotos({ ...input, additionEventId: crypto.randomUUID() });
  const directReplay = await getDriverCompletedPhotoReplay({
    requestId: input.requestId,
    recordId: input.recordId,
    actorId: input.actorId
  });
  const exactPayloadReplay = await getDriverCompletedPhotoReplay({
    requestId: input.requestId,
    recordId: input.recordId,
    actorId: input.actorId,
    reason: input.reason,
    expectedStateHash: input.expectedStateHash,
    photoReferences: input.photos.map((photo) => photo.objectReference)
  });
  await assert.rejects(
    getDriverCompletedPhotoReplay({
      requestId: input.requestId,
      recordId: input.recordId,
      actorId: input.actorId,
      reason: "Altered retry payload",
      expectedStateHash: input.expectedStateHash,
      photoReferences: input.photos.map((photo) => photo.objectReference)
    }),
    (error) => error?.code === "DRIVER_COMPLETED_PHOTO_REQUEST_CONFLICT"
  );
  const rows = await query(
    `SELECT id, photo_data_urls
       FROM driver_job_records
      WHERE id = ANY($1::bigint[])
      ORDER BY id`,
    [fixture.recordIds]
  );

  assert.equal(result.exactReplay, undefined);
  assert.equal(replay.exactReplay, true);
  assert.equal(directReplay.exactReplay, true);
  assert.equal(exactPayloadReplay.exactReplay, true);
  assert.deepEqual(rows.rows.map((row) => row.photo_data_urls), [result.photos, result.photos]);
  assert.deepEqual(result.photos, [...fixture.photos, input.photos[0].objectReference]);
  assert.equal((await query(
    "SELECT count(*)::int AS count FROM driver_job_photo_addition_events WHERE request_id = $1::uuid",
    [input.requestId]
  )).rows[0].count, 1);
  assert.equal((await query(
    `SELECT count(*)::int AS count
       FROM dispatch_audit_log
      WHERE action = 'driver_pwa_completed_stop_photos_added'
        AND details->>'requestId' = $1`,
    [input.requestId]
  )).rows[0].count, 1);
  assert.equal(Number((await query(
    `SELECT count(*)::int AS count
       FROM dispatch_order_completion_events
      WHERE completion_evidence_id = ANY($1::text[])`,
    [fixture.jobIds]
  )).rows[0].count), completionCountBefore);
});

test("S37: stale state and 20-photo limit roll back every member, ledger, and audit", async () => {
  const fixture = await seedVisit("rollback-group", { memberCount: 2, photoCount: 19 });
  const visit = await getDriverCompletedVisit({ recordId: fixture.recordIds[0] });
  const tooMany = appendInput(fixture, visit, {
    photos: supplementalDescriptors(crypto.randomUUID(), 2)
  });
  // Rebuild references with the request actually sent so namespace validation reaches the limit.
  tooMany.photos = supplementalDescriptors(tooMany.requestId, 2);

  await assert.rejects(
    appendDriverCompletedVisitPhotos(tooMany),
    (error) => error?.status === 409 && error?.code === "DRIVER_COMPLETED_PHOTO_LIMIT"
  );
  const rowsAfterLimit = await query(
    "SELECT photo_data_urls FROM driver_job_records WHERE id = ANY($1::bigint[]) ORDER BY id",
    [fixture.recordIds]
  );
  assert.deepEqual(rowsAfterLimit.rows.map((row) => row.photo_data_urls), [fixture.photos, fixture.photos]);
  assert.equal((await query(
    "SELECT count(*)::int AS count FROM driver_job_photo_addition_events WHERE request_id = $1::uuid",
    [tooMany.requestId]
  )).rows[0].count, 0);

  const stale = appendInput(fixture, visit);
  await query(
    `UPDATE driver_job_records
        SET job_details = job_details || '{"driverRemark":"changed elsewhere"}'::jsonb
      WHERE id = $1`,
    [fixture.recordIds[0]]
  );
  await assert.rejects(
    appendDriverCompletedVisitPhotos(stale),
    (error) => error?.status === 409 && error?.code === "DRIVER_COMPLETED_VISIT_STALE"
  );
  assert.equal((await query(
    "SELECT count(*)::int AS count FROM driver_job_photo_addition_events WHERE request_id = $1::uuid",
    [stale.requestId]
  )).rows[0].count, 0);
});

test("S38: concurrent appends from one rendered state have one winner and no lost update", async () => {
  const fixture = await seedVisit("concurrent-group", { memberCount: 2, photoCount: 2 });
  const visit = await getDriverCompletedVisit({ recordId: fixture.recordIds[0] });
  const first = appendInput(fixture, visit, { actorId: "dispatcher-concurrent-a" });
  const second = appendInput(fixture, visit, { actorId: "dispatcher-concurrent-b" });
  const outcomes = await Promise.allSettled([
    appendDriverCompletedVisitPhotos(first),
    appendDriverCompletedVisitPhotos(second)
  ]);
  const winners = outcomes.filter((outcome) => outcome.status === "fulfilled");
  const losers = outcomes.filter((outcome) => outcome.status === "rejected");

  assert.equal(winners.length, 1, JSON.stringify(outcomes));
  assert.equal(losers.length, 1, JSON.stringify(outcomes));
  assert.equal(losers[0].reason?.code, "DRIVER_COMPLETED_VISIT_STALE");
  const rows = await query(
    "SELECT photo_data_urls FROM driver_job_records WHERE id = ANY($1::bigint[]) ORDER BY id",
    [fixture.recordIds]
  );
  assert.equal(rows.rows[0].photo_data_urls.length, 3);
  assert.deepEqual(rows.rows[0].photo_data_urls, rows.rows[1].photo_data_urls);
  assert.equal((await query(
    `SELECT count(*)::int AS count
       FROM driver_job_photo_addition_events
      WHERE primary_driver_job_record_id = $1`,
    [fixture.recordIds[0]]
  )).rows[0].count, 1);
});

test("S43: corrupt and mixed-lifecycle physical declarations are visible conflicts, not partial groups", async () => {
  const corrupt = await seedVisit("corrupt-declaration", { memberCount: 1, photoCount: 1 });
  await query(
    `UPDATE driver_job_records
        SET job_details = jsonb_set(job_details, '{physicalVisitJobIds}', $2::jsonb)
      WHERE id = $1`,
    [corrupt.recordIds[0], JSON.stringify(["missing-own-job"])]
  );
  const corruptList = await listDriverCompletedVisits({
    planDate: corrupt.planDate,
    status: "all",
    driverLogin: corrupt.driverLogin
  });
  assert.equal(corruptList.count, 1);
  assert.equal(corruptList.visits[0].declarationValid, false);
  assert.equal(corruptList.visits[0].appendable, false);
  assert.equal(corruptList.visits[0].blockCode, "DRIVER_COMPLETED_VISIT_DECLARATION_INVALID");

  const mixed = await seedVisit("mixed-lifecycle", { memberCount: 2, photoCount: 1 });
  await query(
    "UPDATE driver_job_records SET status = 'in_progress', completed_at = NULL WHERE id = $1",
    [mixed.recordIds[1]]
  );
  const mixedList = await listDriverCompletedVisits({
    planDate: mixed.planDate,
    status: "all",
    driverLogin: mixed.driverLogin
  });
  assert.equal(mixedList.count, 1);
  assert.deepEqual(mixedList.visits[0].recordIds, mixed.recordIds);
  assert.equal(mixedList.visits[0].status, "mixed");
  assert.equal(mixedList.visits[0].declarationValid, false);
  assert.equal(mixedList.visits[0].appendable, false);
});
