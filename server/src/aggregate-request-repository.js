import { createHash } from 'node:crypto';
import { query, withTransaction } from './db.js';
import { lockAggregateRequestAccess } from './aggregate-request-access-repository.js';
import {
  AGGREGATE_MATERIALS, AGGREGATE_YARDS, aggregateDates, aggregateError, aggregateText,
  aggregateCanManage, aggregateYardsForActor, aggregateSubmissionYards, assertAggregateSubmitter, assertAggregateYard,
  normalizeAggregateLoads, transitionAggregateRequest
} from './aggregate-request-domain.js';

const headerSql = `SELECT r.*, r.service_date::text, r.report_due_date::text,
  creator.display_name AS requested_by_name,
  (SELECT jsonb_agg(jsonb_build_object('materialCode', material_code, 'requestedLoads', requested_loads,
    'confirmedLoads', confirmed_loads, 'actualLoads', actual_loads, 'scmMemo', scm_memo))
    FROM aggregate_request_lines WHERE request_id=r.id) AS material_lines
  FROM aggregate_requests r JOIN operators creator ON creator.id = r.requested_by`;

function positiveId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) { throw aggregateError('A valid request ID is required.'); }
  return id;
}

function mapHeader(row) {
  const lines = AGGREGATE_MATERIALS.map(material => {
    const line = row.material_lines?.find(item => item.materialCode === material.code);
    if (!line) { throw aggregateError('Request material lines are incomplete. Contact SCM.', 500, 'AGGREGATE_INCOMPLETE_RECORD'); }
    return line;
  });
  return {
    id: Number(row.id), requestRef: `AGG-${String(row.id).padStart(6, '0')}`,
    yardLocationId: Number(row.yard_location_id), serviceDate: row.service_date, reportDueDate: row.report_due_date,
    requestedBy: row.requested_by, requestedByName: row.requested_by_name,
    status: row.status, revision: row.revision, remarks: row.remarks, decisionReason: row.decision_reason,
    confirmedBy: row.confirmed_by, confirmedAt: row.confirmed_at?.toISOString() || null,
    reportedBy: row.reported_by, reportedAt: row.reported_at?.toISOString() || null,
    needsReview: row.needs_review, acknowledgedBy: row.acknowledged_by,
    acknowledgedAt: row.acknowledged_at?.toISOString() || null,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(), lines
  };
}

async function loadRequest(id, actor, { lock = false } = {}) {
  const result = await query(`${headerSql} WHERE r.id = $1 ${lock ? 'FOR UPDATE OF r' : ''}`, [positiveId(id)]);
  if (!result.rows[0]) { throw aggregateError('Aggregate request not found.', 404, 'AGGREGATE_NOT_FOUND'); }
  const request = mapHeader(result.rows[0]);
  assertAggregateYard(actor, request.yardLocationId);
  return request;
}

export async function getAggregateRequest(id, actor) {
  return withTransaction(async () => {
    // Acquire the lock before taking the snapshot of the header and its lines.
    // A SELECT that waits for a writer can otherwise pair its new header with old line values.
    await query('SELECT id FROM aggregate_requests WHERE id=$1 FOR SHARE', [positiveId(id)]);
    const request = await loadRequest(id, actor);
    const result = await query(`SELECT e.*, actor.display_name AS actor_name
      FROM aggregate_request_events e JOIN operators actor ON actor.id = e.actor_id
      WHERE e.request_id = $1 ORDER BY e.id`, [request.id]);
    return { ...request, events: result.rows.map(event => ({
      id: Number(event.id), action: event.action, actorId: event.actor_id, actorName: event.actor_name,
      reason: event.reason, before: event.before_snapshot, after: event.after_snapshot, createdAt: event.created_at.toISOString()
    })) };
  });
}

function canonical(value) {
  if (Array.isArray(value)) { return value.map(canonical); }
  if (value && typeof value === 'object') { return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])); }
  return value;
}

function operation(input, action, id = null) {
  if (typeof input.operationId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(input.operationId)) {
    throw aggregateError('A valid operationId is required.');
  }
  const hash = createHash('sha256').update(JSON.stringify(canonical({ action, id, input }))).digest('hex');
  return { id: input.operationId, hash };
}

async function lockKey(key) {
  await query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`aggregate:${key}`]);
}

async function retryResult(actor, op) {
  await lockKey(`operation:${actor.id}:${op.id}`);
  const result = await query('SELECT payload_hash, after_snapshot FROM aggregate_request_events WHERE actor_id = $1 AND operation_id = $2', [actor.id, op.id]);
  if (!result.rows.length) { return null; }
  if (result.rows[0].payload_hash !== op.hash) { throw aggregateError('This retry identifier was already used for a different operation.', 409, 'AGGREGATE_RETRY_CONFLICT'); }
  const saved = result.rows[0].after_snapshot;
  assertAggregateYard(actor, saved.yardLocationId);
  return saved;
}

async function recordEvent(before, after, actor, op, action, reason, now) {
  await query(`INSERT INTO aggregate_request_events
    (request_id,actor_id,operation_id,payload_hash,action,reason,before_snapshot,after_snapshot,created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9)`,
  [after.id, actor.id, op.id, op.hash, action, reason, before ? JSON.stringify(before) : null, JSON.stringify(after), now]);
}

async function dueRequests(actor, today, yardLocationId = null) {
  const result = await query(`${headerSql} WHERE r.requested_by = $1
    AND r.yard_location_id = ANY($2::bigint[]) AND r.report_due_date <= $3::date
    AND r.status IN ('submitted','confirmed') AND ($4::bigint IS NULL OR r.yard_location_id = $4)
    ORDER BY r.report_due_date, r.id`, [actor.id, aggregateYardsForActor(actor), today, yardLocationId]);
  return result.rows.map(mapHeader);
}

async function assertNoDueRequests(actor, yardLocationId, today) {
  const blockers = await dueRequests(actor, today, yardLocationId);
  if (blockers.length) {
    throw Object.assign(aggregateError('Resolve overdue aggregate requests for this yard before submitting again.', 409, 'AGGREGATE_REPORT_REQUIRED'), {
      blockingRequestIds: blockers.map(row => row.id)
    });
  }
}

export async function createAggregateRequest(input, actor, { now = new Date() } = {}) {
  assertAggregateSubmitter(actor);
  const yard = assertAggregateYard(actor, input.yardLocationId);
  const loads = normalizeAggregateLoads(input.loads, { positive: true });
  const remarks = aggregateText(input.remarks);
  const op = operation(input, 'submit');
  return withTransaction(async () => {
    await lockAggregateRequestAccess(actor, yard);
    const retry = await retryResult(actor, op);
    if (retry) { return retry; }
    const dates = aggregateDates(now);
    if (input.serviceDate !== dates.serviceDate) { throw aggregateError('The request date has changed. Refresh and review tomorrow’s date.', 409, 'AGGREGATE_DATE_CHANGED'); }
    await lockKey(`yard:${yard}`);
    await assertNoDueRequests(actor, yard, dates.today);
    const inserted = await query(`INSERT INTO aggregate_requests
      (yard_location_id, service_date, report_due_date, requested_by, remarks, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$6) ON CONFLICT (yard_location_id) WHERE status IN ('submitted','confirmed') DO NOTHING RETURNING id`,
    [yard, dates.serviceDate, dates.reportDueDate, actor.id, remarks, now]);
    if (!inserted.rows.length) {
      const existing = await query("SELECT id FROM aggregate_requests WHERE yard_location_id=$1 AND status IN ('submitted','confirmed')", [yard]);
      throw Object.assign(aggregateError('Complete the unfinished request for this yard before starting another.', 409, 'AGGREGATE_ACTIVE_REQUEST_EXISTS'), { requestId: Number(existing.rows[0].id) });
    }
    const id = Number(inserted.rows[0].id);
    for (const material of AGGREGATE_MATERIALS) {
      await query('INSERT INTO aggregate_request_lines (request_id,material_code,requested_loads) VALUES ($1,$2,$3)', [id, material.code, loads[material.code]]);
    }
    const request = await loadRequest(id, actor);
    await recordEvent(null, request, actor, op, 'submit', '', now);
    return request;
  });
}

function authorizeAction(request, action, actor) {
  if (['confirm', 'reject', 'correct', 'acknowledge', 'memo'].includes(action) && !aggregateCanManage(actor)) {
    throw aggregateError('SCM edit access required.', 403, 'AGGREGATE_SCM_REQUIRED');
  }
  const ownerOnly = action === 'edit' || (action === 'report' && !aggregateCanManage(actor));
  if (ownerOnly && request.requestedBy !== actor.id) { throw aggregateError('Only the original requester can perform this action.', 403, 'AGGREGATE_OWNER_REQUIRED'); }
}

async function saveRequest(row) {
  await query(`UPDATE aggregate_requests SET status=$2,revision=$3,remarks=$4,decision_reason=$5,
    confirmed_by=$6,confirmed_at=$7,reported_by=$8,reported_at=$9,needs_review=$10,
    acknowledged_by=$11,acknowledged_at=$12,updated_at=$13,service_date=$14,report_due_date=$15 WHERE id=$1`,
  [row.id, row.status, row.revision, row.remarks, row.decisionReason,
    row.confirmedBy, row.confirmedAt, row.reportedBy, row.reportedAt,
    row.needsReview, row.acknowledgedBy, row.acknowledgedAt, row.updatedAt, row.serviceDate, row.reportDueDate]);
  for (const line of row.lines) {
    await query(`UPDATE aggregate_request_lines SET requested_loads=$3,confirmed_loads=$4,actual_loads=$5,scm_memo=$6
      WHERE request_id=$1 AND material_code=$2`, [row.id, line.materialCode, line.requestedLoads, line.confirmedLoads, line.actualLoads, line.scmMemo || '']);
  }
}

export async function changeAggregateRequest(id, action, input, actor, { now = new Date() } = {}) {
  const original = await loadRequest(id, actor);
  authorizeAction(original, action, actor);
  const op = operation(input, action, original.id);
  return withTransaction(async () => {
    if (action === 'edit' || !aggregateCanManage(actor)) { await lockAggregateRequestAccess(actor, original.yardLocationId); }
    const retry = await retryResult(actor, op);
    if (retry) { return retry; }
    await lockKey(`yard:${original.yardLocationId}`);
    const before = await loadRequest(original.id, actor, { lock: true });
    const after = transitionAggregateRequest(before, action, input, actor, now);
    await saveRequest(after);
    await recordEvent(before, after, actor, op, action, aggregateText(input.reason), now);
    return after;
  });
}

function listFilters(actor, filters) {
  const yards = aggregateYardsForActor(actor);
  if (!yards.length) { throw aggregateError('No aggregate yard access assigned. Contact an administrator.', 403, 'AGGREGATE_YARD_FORBIDDEN'); }
  const params = [yards];
  const clauses = ['r.yard_location_id = ANY($1::bigint[])'];
  if (filters.yardLocationId) {
    params.push([assertAggregateYard(actor, Number(filters.yardLocationId))]);
    clauses.push(`r.yard_location_id = ANY($${params.length}::bigint[])`);
  }
  if (filters.serviceDate) {
    const date = String(filters.serviceDate);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
      throw aggregateError('Select a valid service date.');
    }
    params.push(date);
    clauses.push(`r.service_date = $${params.length}::date`);
  }
  const queues = { all: 'TRUE', pending: "r.status='submitted'", awaiting_actuals: "r.status='confirmed'", needs_review: 'r.needs_review', history: "r.status IN ('reported','rejected')" };
  const queue = filters.queue || 'all';
  if (!Object.hasOwn(queues, queue)) { throw aggregateError('Select a valid aggregate queue.'); }
  clauses.push(queues[queue]);
  return { params, clauses, yards };
}

export async function listAggregateRequests(actor, filters = {}, { now = new Date() } = {}) {
  const { params, clauses, yards } = listFilters(actor, filters);
  const offset = Number(filters.offset || 0);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) { throw aggregateError('Invalid request offset.'); }
  const result = await query(`${headerSql} WHERE ${clauses.join(' AND ')}
    ORDER BY r.service_date DESC,r.id DESC LIMIT 51 OFFSET $${params.length + 1}`, [...params, offset]);
  const requests = result.rows.slice(0, 50).map(mapHeader);
  const dates = aggregateDates(now);
  const review = await query('SELECT count(*)::int AS count FROM aggregate_requests WHERE yard_location_id=ANY($1::bigint[]) AND needs_review', [yards]);
  return {
    requests, hasMore: result.rows.length > 50, offset, ...dates,
    materials: AGGREGATE_MATERIALS, yards: AGGREGATE_YARDS.filter(yard => yards.includes(yard.locationId)),
    canManage: aggregateCanManage(actor), blockers: await dueRequests(actor, dates.today),
    canSubmit: aggregateSubmissionYards(actor).length > 0,
    needsReviewCount: review.rows[0].count
  };
}

export async function getAggregateRequesterWorkspace(actor, filters = {}, { now = new Date() } = {}) {
  assertAggregateSubmitter(actor);
  const allowed = aggregateSubmissionYards(actor);
  const dates = aggregateDates(now);
  const yard = filters.yardLocationId ? Number(filters.yardLocationId) : null;
  if (yard !== null && !allowed.includes(yard)) { throw aggregateError('This yard is outside your assigned yards.', 403, 'AGGREGATE_YARD_FORBIDDEN'); }
  const result = await query(`${headerSql} WHERE r.yard_location_id=ANY($1::bigint[])
    AND r.status IN ('submitted','confirmed')
    AND ($2::bigint IS NULL OR r.yard_location_id=$2)
    ORDER BY r.service_date, r.id LIMIT 1`,
  [allowed, yard]);
  const request = result.rows[0] ? mapHeader(result.rows[0]) : null;
  return { ...dates, materials: AGGREGATE_MATERIALS, yards: AGGREGATE_YARDS.filter(item => allowed.includes(item.locationId)),
    yardLocationId: yard || request?.yardLocationId || allowed[0], request, canSubmit: true, canManage: aggregateCanManage(actor) };
}
