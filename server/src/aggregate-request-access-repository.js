import { query, withTransaction } from './db.js';
import { AGGREGATE_YARDS, aggregateError, canBeAggregateRequester, aggregateSubmissionYards } from './aggregate-request-domain.js';

function assertAdmin(actor) {
  if (!actor?.id || actor.publicSales || ![actor.role, ...(actor.roles || [])].includes('admin')) {
    throw aggregateError('Admin access is required.', 403, 'AGGREGATE_ACCESS_ADMIN_REQUIRED');
  }
}

function validateChange(input) {
  const yards = input?.yardLocationIds;
  const revisions = input?.expectedRevisions;
  if (!Array.isArray(yards) || yards.length > 4 || new Set(yards).size !== yards.length
    || yards.some(id => !AGGREGATE_YARDS.some(yard => yard.locationId === id))) {
    throw aggregateError('Select valid Aggregate request yards.');
  }
  if (!revisions || typeof revisions !== 'object' || Array.isArray(revisions) || Object.keys(revisions).length !== 4
    || AGGREGATE_YARDS.some(yard => !Number.isSafeInteger(revisions[yard.locationId]) || revisions[yard.locationId] < 0)) {
    throw aggregateError('Refresh Aggregate access before saving.');
  }
  return { yards, revisions };
}

export async function listAggregateRequestAccess(actor) {
  assertAdmin(actor);
  const result = await query(`SELECT a.*, o.display_name FROM aggregate_request_yard_assignments a
    LEFT JOIN operators o ON o.id=a.operator_id ORDER BY a.yard_location_id`);
  return { assignments: AGGREGATE_YARDS.map(yard => {
    const row = result.rows.find(item => item.yard_location_id === yard.locationId);
    return { yardLocationId: yard.locationId, yardCode: yard.yardCode, operatorId: row.operator_id,
      displayName: row.display_name, revision: row.revision };
  }) };
}

export async function updateAggregateRequestAccess(operatorId, input, actor) {
  assertAdmin(actor);
  const { yards, revisions } = validateChange(input);
  return withTransaction(async () => {
    const before = await query('SELECT * FROM aggregate_request_yard_assignments ORDER BY yard_location_id FOR UPDATE');
    if (before.rows.some(row => revisions[row.yard_location_id] !== row.revision)) {
      throw aggregateError('Aggregate access changed. Refresh and review the assignments.', 409, 'AGGREGATE_ACCESS_CONFLICT');
    }
    const target = (await query('SELECT id, role, roles, active FROM operators WHERE id=$1 FOR SHARE', [operatorId])).rows[0];
    if (!target) { throw aggregateError('Account not found.', 404, 'AGGREGATE_ACCOUNT_NOT_FOUND'); }
    if (yards.length && (!target.active || !canBeAggregateRequester(target))) {
      throw aggregateError('Choose an active Operator, Sales, or Yard Manager account.');
    }
    const changes = [];
    for (const row of before.rows) {
      const next = yards.includes(row.yard_location_id) ? operatorId : row.operator_id === operatorId ? null : row.operator_id;
      if (next === row.operator_id) { continue; }
      await query(`UPDATE aggregate_request_yard_assignments SET operator_id=$2,revision=revision+1,updated_by=$3,updated_at=now()
        WHERE yard_location_id=$1`, [row.yard_location_id, next, actor.id]);
      changes.push({ yardLocationId: row.yard_location_id, previousOperatorId: row.operator_id, operatorId: next });
    }
    if (changes.length) {
      await query(`INSERT INTO delivery_audit_log (actor_type,actor_operator_id,source,action,details)
        VALUES ('operator',$1,'control','aggregate_access.updated',$2::jsonb)`, [actor.id, JSON.stringify({ operatorId, changes })]);
    }
    return listAggregateRequestAccess(actor);
  });
}

// Called inside each requester write transaction. The shared lock serializes
// submission with assignment/revocation and account deactivation/role changes.
export async function lockAggregateRequestAccess(actor, yardLocationId) {
  const row = (await query(`SELECT a.operator_id, o.id, o.role, o.roles, o.active
    FROM aggregate_request_yard_assignments a JOIN operators o ON o.id=a.operator_id
    WHERE a.yard_location_id=$1 FOR SHARE OF a,o`, [yardLocationId])).rows[0];
  if (!row || row.operator_id !== actor.id || !row.active || !canBeAggregateRequester(row)
    || !aggregateSubmissionYards(actor).includes(yardLocationId)) {
    throw aggregateError('Aggregate request access is required. Ask Admin to assign a yard.', 403, 'AGGREGATE_ACCESS_REQUIRED');
  }
}
