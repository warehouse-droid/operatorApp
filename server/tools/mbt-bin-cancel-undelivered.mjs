import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Resolve from the application root so this audited maintenance command can
// also run through stdin in the deployed app without adding a public endpoint.
const applicationModule = name => import(pathToFileURL(resolve('src', name)).href);
const { query, closeDb } = await applicationModule('db.js');
const { executeMbtCommand } = await applicationModule('mbt/command-repository.js');
const { DISPATCH_FLEET_PLANNING_LOCK } = await applicationModule('dispatch-fleet-status.js');
const { currentFrontdeskContractTotal } = await applicationModule('mbt/customer-charge-request-service.js');

function validateInput(input) {
  assert.ok(input.actor?.roles?.includes('admin'), 'Admin maintenance actor required');
  assert.ok(String(input.actor.operatorId || '').trim(), 'Actor ID required');
  for (const key of ['expectedContractRevision', 'expectedLineRevision', 'expectedAmountMinor', 'expectedActiveTotalMinor']) {
    assert.ok(Number.isSafeInteger(input[key]) && input[key] > 0, `${key} must be a positive safe integer`);
  }
  assert.ok(input.expectedAmountMinor <= input.expectedActiveTotalMinor, 'Adjustment exceeds the active total');
  assert.ok(Array.isArray(input.confirmedChargeRequestIds) && input.confirmedChargeRequestIds.length > 0);
  assert.equal(new Set(input.confirmedChargeRequestIds).size, input.confirmedChargeRequestIds.length, 'Duplicate charge IDs');
  assert.ok(String(input.reason || '').trim(), 'Reason required');
}

async function lockedState(input) {
  await query('SELECT pg_advisory_xact_lock(hashtext($1))', [DISPATCH_FLEET_PLANNING_LOCK]);
  const contract = (await query('SELECT * FROM mbt_contracts WHERE contract_id=$1 FOR UPDATE', [input.contractId])).rows[0];
  assert.ok(contract && contract.status === 'confirmed', 'Expected a confirmed contract');
  assert.equal(Number(contract.revision), input.expectedContractRevision, 'Contract revision changed');
  if (input.expectedContractNumber) { assert.equal(contract.contract_number, input.expectedContractNumber); }
  const lines = (await query('SELECT * FROM mbt_contract_service_lines WHERE contract_id=$1 ORDER BY line_number FOR UPDATE', [input.contractId])).rows;
  const line = lines.find(row => row.service_line_id === input.serviceLineId);
  assert.ok(line, 'Service line does not belong to this contract');
  assert.equal(Number(line.revision), input.expectedLineRevision, 'Bin revision changed');
  if (input.expectedLineNumber) { assert.equal(line.line_number, input.expectedLineNumber); }
  assert.ok(['scheduled', 'return_due'].includes(line.status), 'Bin is no longer pending delivery');
  assert.ok(!line.actual_delivery_completed_at && !line.actual_collected_at, 'Bin has physical service activity');
  assert.ok(lines.some(row => row.service_line_id !== input.serviceLineId && !['cancelled', 'closed'].includes(row.status)), 'An active sibling bin is required');
  const visits = (await query('SELECT * FROM mbt_service_visits WHERE service_line_id=$1 ORDER BY visit_number FOR UPDATE', [input.serviceLineId])).rows;
  assert.ok(visits.length > 0, 'Expected pending service visits');
  for (const visit of visits) { assertUnstartedVisit(visit); }
  return { contract, lines, line, visits };
}

function assertUnstartedVisit(visit) {
  assert.ok(['tentative', 'ready'].includes(visit.status), 'A visit has already been planned or started');
  const physicalOrDispatchFields = ['actual_started_at', 'actual_completed_at', 'dispatch_plan_id', 'dispatch_load_id',
    'planned_truck_id', 'planned_driver_id', 'expected_asset_id', 'outgoing_asset_id', 'incoming_asset_id'];
  assert.ok(physicalOrDispatchFields.every(field => !visit[field]), 'A visit has dispatch or physical asset activity');
}

async function assertNoServiceEvidence(state) {
  const ids = state.visits.map(visit => visit.service_visit_id);
  const steps = (await query('SELECT * FROM mbt_visit_steps WHERE service_visit_id=ANY($1::uuid[]) FOR UPDATE', [ids])).rows;
  assert.ok(steps.every(step => step.status === 'pending' && !step.started_at && !step.completed_at && !step.verified_asset_id), 'Driver steps have started');
  const exposure = (await query(`SELECT
    (SELECT count(*)::int FROM mbt_evidence WHERE service_visit_id=ANY($1::uuid[])) AS evidence,
    (SELECT count(*)::int FROM mbt_bin_asset_reservations WHERE visit_id=ANY($1::uuid[]) AND released_at IS NULL) AS reservations,
    (SELECT count(*)::int FROM mbt_billing_versions version JOIN mbt_billing_cases billing USING(billing_case_id)
      WHERE billing.contract_id=$2) AS billing`, [ids, state.contract.contract_id])).rows[0];
  assert.deepEqual(exposure, { evidence: 0, reservations: 0, billing: 0 }, 'Service or billing evidence requires separate reconciliation');
}

function chargeBelongsToLine(request, state) {
  if (request.service_line_id) { return request.service_line_id === state.line.service_line_id; }
  if (request.charge_request_id === state.line.source_charge_request_id) { return true; }
  return request.request_kind === 'initial_bin' && request.source_quote_id === state.contract.quote_id
    && state.line.source_quote_id === request.source_quote_id
    && state.lines.filter(line => line.source_quote_id === request.source_quote_id).length === 1;
}

async function verifiedCharges(input, state) {
  const requests = (await query(`SELECT * FROM mbt_frontdesk_charge_requests
    WHERE contract_id=$1 AND charge_request_id=ANY($2::uuid[]) ORDER BY charge_request_id FOR UPDATE`,
  [input.contractId, input.confirmedChargeRequestIds])).rows;
  assert.equal(requests.length, input.confirmedChargeRequestIds.length, 'Charge request ownership changed');
  let amount = 0;
  for (const request of requests) {
    assert.equal(request.status, 'confirmed', 'Only confirmed evidence can be offset');
    assert.equal(request.payment_method, 'cash', 'This maintenance command only offsets cash pricing');
    assert.equal(request.netsuite_export_policy, 'excluded_cash', 'Exported billing requires separate reconciliation');
    assert.ok(chargeBelongsToLine(request, state), 'A charge belongs to another physical bin');
    amount += Number(request.request_total_minor);
    assert.ok(Number.isSafeInteger(amount), 'Charge total overflow');
  }
  assert.equal(amount, input.expectedAmountMinor, 'Confirmed charge amount changed');
  assert.equal(await currentFrontdeskContractTotal(state.contract), input.expectedActiveTotalMinor, 'Active contract total changed');
  return requests;
}

async function insertAdjustment(input, state, amendmentId) {
  const after = { schemaVersion: 'mbt-frontdesk-charge-adjustment-v1', operation: 'cancel_undelivered_bin',
    serviceLineId: input.serviceLineId, cancelledChargeRequestIds: input.confirmedChargeRequestIds,
    customerChargeAdjustmentMinor: -input.expectedAmountMinor,
    activeTotalBeforeMinor: input.expectedActiveTotalMinor,
    activeTotalAfterMinor: input.expectedActiveTotalMinor - input.expectedAmountMinor };
  await query(`INSERT INTO mbt_contract_amendments (
    amendment_id,contract_id,amendment_number,amendment_type,status,rate_card_version_id,reason,
    before_snapshot,after_snapshot,requested_effective_at,approved_at,approved_by,created_by,updated_by)
    SELECT $1,$2,COALESCE(max(amendment_number),0)+1,'other','approved',$3,$4,$5::jsonb,$6::jsonb,now(),now(),$7,$7,$7
    FROM mbt_contract_amendments WHERE contract_id=$2`,
  [amendmentId, input.contractId, state.contract.rate_card_version_id, input.reason,
    JSON.stringify(state), JSON.stringify(after), input.actor.operatorId]);
  return after;
}

async function cancelPendingWork(input, state) {
  const visitIds = state.visits.map(visit => visit.service_visit_id);
  await query(`UPDATE mbt_visit_steps SET status='cancelled',revision=revision+1,updated_at=now()
    WHERE service_visit_id=ANY($1::uuid[]) AND status='pending'`, [visitIds]);
  await query(`UPDATE mbt_service_visits SET status='cancelled',cancelled_at=now(),cancellation_reason=$2,
    revision=revision+1,updated_by=$3,updated_at=now() WHERE service_visit_id=ANY($1::uuid[])`,
  [visitIds, input.reason, input.actor.operatorId]);
  const drafts = await query(`UPDATE mbt_frontdesk_charge_requests SET status='cancelled',revision=revision+1,updated_by=$2,updated_at=now()
    WHERE service_line_id=$1 AND status='draft' RETURNING charge_request_id`, [input.serviceLineId, input.actor.operatorId]);
  await query(`UPDATE mbt_contract_service_lines SET status='cancelled',revision=revision+1,updated_by=$2,updated_at=now()
    WHERE service_line_id=$1`, [input.serviceLineId, input.actor.operatorId]);
  await query(`UPDATE mbt_contracts SET planned_delivery_at=bounds.delivery_at,planned_return_at=bounds.return_at,
    revision=revision+1,updated_by=$2,updated_at=now() FROM
    (SELECT min(planned_delivery_at) AS delivery_at,max(planned_return_at) AS return_at
      FROM mbt_contract_service_lines WHERE contract_id=$1 AND status<>'cancelled') bounds WHERE contract_id=$1`,
  [input.contractId, input.actor.operatorId]);
  return { cancelledVisitIds: visitIds, cancelledDraftRequestIds: drafts.rows.map(row => row.charge_request_id) };
}

async function cancellationMutation(input) {
  const state = await lockedState(input);
  await assertNoServiceEvidence(state);
  const requests = await verifiedCharges(input, state);
  const amendmentId = crypto.randomUUID();
  const adjustment = await insertAdjustment(input, state, amendmentId);
  const cancelled = await cancelPendingWork(input, state);
  const activeTotalMinor = await currentFrontdeskContractTotal(state.contract);
  assert.equal(activeTotalMinor, adjustment.activeTotalAfterMinor, 'Adjusted active total mismatch');
  const afterLines = (await query('SELECT * FROM mbt_contract_service_lines WHERE contract_id=$1 ORDER BY line_number', [input.contractId])).rows;
  assert.deepEqual(afterLines.filter(line => line.service_line_id !== input.serviceLineId),
    state.lines.filter(line => line.service_line_id !== input.serviceLineId), 'Sibling bins changed');
  const body = { serviceLineId: input.serviceLineId, amendmentId, ...cancelled,
    adjustmentMinor: adjustment.customerChargeAdjustmentMinor, activeTotalMinor };
  await query(`INSERT INTO mbt_contract_service_line_events (
    service_line_event_id,service_line_id,contract_id,event_type,before_snapshot,after_snapshot,reason,actor_operator_id)
    VALUES ($1,$2,$3,'dispatch_change',$4::jsonb,$5::jsonb,$6,$7)`,
  [crypto.randomUUID(), input.serviceLineId, input.contractId, JSON.stringify(state), JSON.stringify(body), input.reason, input.actor.operatorId]);
  return { status: 200, body, audit: { action: 'mbt.frontdesk.undelivered_bin.cancelled',
    entityType: 'mbt_contract_service_line', entityId: input.serviceLineId,
    beforeState: { ...state, confirmedChargeRequests: requests }, afterState: body, reason: input.reason,
    revisionBefore: input.expectedLineRevision, revisionAfter: input.expectedLineRevision + 1, source: 'authorized_maintenance' } };
}

export async function cancelUndeliveredBin(input) {
  validateInput(input);
  const { actor, ...payload } = input;
  return executeMbtCommand({ actor, payload, commandName: 'mbt.frontdesk.cancel-undelivered-bin',
    idempotencyKey: input.idempotencyKey, correlationId: input.idempotencyKey, requestId: input.idempotencyKey,
    mutation: () => cancellationMutation(input) });
}

const dhInput = {
  contractId: 'a4d22d0b-57ad-48ec-a949-d6e1f2886735', serviceLineId: 'e0395e35-3cfe-4a69-a864-e3442e4a10a2',
  expectedContractNumber: 'MBT-C-A4D22D0B57AD', expectedLineNumber: 1,
  expectedContractRevision: 4, expectedLineRevision: 3,
  confirmedChargeRequestIds: ['120e950a-dcb0-4082-a8dc-47738f38a58d', '6e52de2b-ebb6-4426-8b40-badcfafac913'],
  expectedAmountMinor: 110000, expectedActiveTotalMinor: 165000,
  reason: 'User authorized removing D&H undelivered Bin 1 and its $550 initial plus $550 exchange pricing from the active total on 2026-10-15. Preserve Bin 2 and immutable pricing/audit history.',
  actor: { operatorId: 'codex-authorized-maintenance', roles: ['admin'], actorType: 'maintenance' },
  idempotencyKey: 'dh-bin1-user-authorized-cancellation-20261015'
};

export async function dhContractSnapshot() {
  const id = dhInput.contractId;
  const rows = {};
  for (const table of ['mbt_contracts', 'mbt_contract_service_lines', 'mbt_service_visits', 'mbt_frontdesk_charge_requests',
    'mbt_contract_amendments', 'mbt_contract_service_line_events']) {
    rows[table] = (await query(`SELECT * FROM ${table} WHERE contract_id=$1 ORDER BY 1`, [id])).rows;
  }
  const ids = rows.mbt_service_visits.map(visit => visit.service_visit_id);
  rows.mbt_visit_steps = (await query('SELECT * FROM mbt_visit_steps WHERE service_visit_id=ANY($1::uuid[]) ORDER BY 1', [ids])).rows;
  rows.activeTotalMinor = await currentFrontdeskContractTotal(rows.mbt_contracts[0]);
  return rows;
}

const mode = process.env.MBT_CANCEL_DH_BIN1_MODE;
if (mode) {
  try {
    assert.ok(!process.env.MBT_TEST_ISOLATED, 'Production IDs are forbidden in isolated tests');
    assert.ok(['preview', 'apply'].includes(mode), 'Mode must be preview or apply');
    const result = mode === 'apply' ? await cancelUndeliveredBin(dhInput) : null;
    console.log(JSON.stringify({ mode, result, snapshot: await dhContractSnapshot() }, null, 2));
  } finally { await closeDb(); }
}
