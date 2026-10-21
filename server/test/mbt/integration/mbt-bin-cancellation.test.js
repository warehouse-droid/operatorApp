import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test, { after as afterAll } from 'node:test';
import { closeDb, query } from '../../../src/db.js';
import { createFrontdeskQuote, issueFrontdeskQuote, acceptFrontdeskQuote, convertFrontdeskQuote } from '../../../src/mbt/frontdesk-service.js';
import * as chargeService from '../../../src/mbt/customer-charge-request-service.js';
import { cancelUndeliveredBin } from '../../../tools/mbt-bin-cancel-undelivered.mjs';
import { getMbtBinPlanning } from '../../../src/mbt/bin-planning-service.js';
import { boundary } from '../support/bin-planning-fixtures.js';
import { createFrontdeskPrerequisites, frontdeskCommand, quoteCommand, frontdeskDistanceResolver,
  frontdeskTaxResolver } from '../support/frontdesk-fixtures.js';

afterAll(closeDb);
const actor = { operatorId: 'bin-cancellation-regression', roles: ['admin'] };
async function fixture() {
  const f = await createFrontdeskPrerequisites({ label: 'bin-cancellation' });
  const created = await createFrontdeskQuote({ ...quoteCommand(f, { actor, identity: crypto.randomUUID() }),
    serviceLines: [1, 2].map(() => ({ binTypeId: f.binTypeId,
      proposedDeliveryAt: f.proposedDeliveryAt, proposedReturnAt: f.proposedReturnAt })) },
  { resolveDistance: frontdeskDistanceResolver(f), resolveTaxPolicy: frontdeskTaxResolver });
  const quoteId = created.body.quote.quoteId;
  await issueFrontdeskQuote(frontdeskCommand('cancel-issue', actor, { quoteId, expectedRevision: 1, validUntil: '2037-08-04T12:00:00Z' }));
  await acceptFrontdeskQuote(frontdeskCommand('cancel-accept', actor, { quoteId, expectedRevision: 2, acceptedAt: '2037-08-03T10:00:00Z' }));
  const converted = await convertFrontdeskQuote(frontdeskCommand('cancel-convert', actor, { quoteId, expectedRevision: 3 }));
  const contract = converted.body.contract; const [first, second] = converted.body.serviceLines;
  const requests = [];
  for (const [kind, status, line, quote] of [
    ['initial_bin', 'confirmed', null, quoteId], ['exchange_bin', 'confirmed', first.serviceLineId, null],
    ['add_bin', 'confirmed', null, null], ['exchange_bin', 'draft', first.serviceLineId, null]
  ]) {
    const id = crypto.randomUUID(); requests.push(id);
    await query(`INSERT INTO mbt_frontdesk_charge_requests (
      charge_request_id,request_number,request_kind,status,contract_id,service_line_id,source_quote_id,
      rate_card_version_id,payment_method,payment_category,tax_mode,netsuite_export_policy,pricing_snapshot,
      pre_tax_revenue_minor,included_hst_minor,request_total_minor,resulting_contract_total_minor,due_now_minor,
      billing_address_text,service_address_text,contract_telephone,reason,confirmed_at,confirmed_by,created_by,updated_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'cash','cash','included','excluded_cash','{}',48672,6328,55000,55000,55000,
        'Synthetic billing','Synthetic service','5550100','Synthetic cancellation history',
        CASE WHEN $4='confirmed' THEN now() ELSE NULL END,CASE WHEN $4='confirmed' THEN $9 ELSE NULL END,$9,$9)`,
    [id, 'CANCEL-' + id, kind, status, contract.contractId, line, quote, f.rateCardVersionId, actor.operatorId]);
  }
  await query('UPDATE mbt_contract_service_lines SET source_charge_request_id=$2 WHERE service_line_id=$1', [first.serviceLineId, requests[0]]);
  await query('UPDATE mbt_contract_service_lines SET source_quote_id=NULL,source_charge_request_id=$2 WHERE service_line_id=$1', [second.serviceLineId, requests[2]]);
  const input = { contractId: contract.contractId, serviceLineId: first.serviceLineId,
    expectedContractRevision: contract.revision, expectedLineRevision: first.revision,
    confirmedChargeRequestIds: requests.slice(0, 2), expectedAmountMinor: 110000,
    expectedActiveTotalMinor: 165000, reason: 'User requested removing the broken undelivered Bin 1 and its charges',
    actor, idempotencyKey: 'cancel-bin-' + crypto.randomUUID() };
  return { ...f, contract, first, second, requests, input };
}
async function snapshot(f) {
  return (await query(`SELECT
    (SELECT to_jsonb(c) FROM mbt_contracts c WHERE contract_id=$1) AS contract,
    (SELECT jsonb_agg(to_jsonb(l) ORDER BY line_number) FROM mbt_contract_service_lines l WHERE contract_id=$1) AS lines,
    (SELECT jsonb_agg(to_jsonb(v) ORDER BY visit_number) FROM mbt_service_visits v WHERE contract_id=$1) AS visits,
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY request_number) FROM mbt_frontdesk_charge_requests r WHERE contract_id=$1) AS requests,
    (SELECT jsonb_agg(to_jsonb(s) ORDER BY visit_step_id) FROM mbt_visit_steps s JOIN mbt_service_visits v USING(service_visit_id) WHERE v.contract_id=$1) AS steps,
    (SELECT count(*)::int FROM mbt_contract_amendments WHERE contract_id=$1) AS amendments,
    (SELECT count(*)::int FROM mbt_contract_service_line_events WHERE contract_id=$1) AS events,
    (SELECT count(*)::int FROM mbt_audit_events WHERE entity_id=$2) AS audit,
    (SELECT count(*)::int FROM mbt_command_receipts WHERE entity_id=$2) AS receipts`, [f.contract.contractId, f.first.serviceLineId])).rows[0];
}

test('cancel Bin 1, remove its 110000 cents, preserve Bin 2 and confirmed evidence, and replay once', async () => {
  const f = await fixture(); const before = await snapshot(f);
  const result = await cancelUndeliveredBin(f.input);
  assert.equal(result.body.activeTotalMinor, 55000);
  const after = await snapshot(f);
  assert.equal(after.lines[0].status, 'cancelled');
  assert.deepEqual(after.lines[1], before.lines[1]);
  assert.ok(after.visits.filter(visit => visit.service_line_id === f.first.serviceLineId).every(visit => visit.status === 'cancelled'));
  assert.deepEqual(after.visits.filter(visit => visit.service_line_id === f.second.serviceLineId),
    before.visits.filter(visit => visit.service_line_id === f.second.serviceLineId));
  assert.deepEqual(after.requests.filter(request => request.status === 'confirmed'), before.requests.filter(request => request.status === 'confirmed'));
  assert.equal(after.requests.find(request => request.charge_request_id === f.requests[3]).status, 'cancelled');
  const amendment = (await query('SELECT * FROM mbt_contract_amendments WHERE contract_id=$1', [f.contract.contractId])).rows[0];
  assert.equal(amendment.after_snapshot.customerChargeAdjustmentMinor, -110000);
  assert.equal(amendment.status, 'approved');
  const currentContract = (await query('SELECT * FROM mbt_contracts WHERE contract_id=$1', [f.contract.contractId])).rows[0];
  assert.equal(await chargeService.currentFrontdeskContractTotal(currentContract), 55000);
  const feed = await getMbtBinPlanning({ planDate: '2037-08-03', search: f.contract.contractNumber }, boundary);
  assert.equal(feed.pool.total, 1);
  assert.equal(feed.pool.items[0].mbt.serviceLineId, f.second.serviceLineId);
  assert.equal((await cancelUndeliveredBin(f.input)).replayed, true);
  assert.deepEqual(await snapshot(f), after);
});

for (const mode of ['driver-started', 'step-started', 'assigned-load', 'wrong-line-charge', 'wrong-revision', 'wrong-amount']) {
  test(`cancellation refuses ${mode} without changing any bin or price`, async () => {
    const f = await fixture();
    if (mode === 'driver-started') {
      await query("UPDATE mbt_service_visits SET status='in_progress',actual_started_at=now() WHERE service_line_id=$1 AND service_action='delivery'", [f.first.serviceLineId]);
    }
    if (mode === 'step-started') {
      await query("UPDATE mbt_visit_steps SET status='in_progress',started_at=now() WHERE service_visit_id IN (SELECT service_visit_id FROM mbt_service_visits WHERE service_line_id=$1) AND sequence_number=0", [f.first.serviceLineId]);
    }
    if (mode === 'assigned-load') {
      await query("UPDATE mbt_service_visits SET dispatch_load_id='synthetic-assigned-load' WHERE service_line_id=$1 AND service_action='delivery'", [f.first.serviceLineId]);
    }
    if (mode === 'wrong-line-charge') { f.input.confirmedChargeRequestIds[1] = f.requests[2]; }
    if (mode === 'wrong-revision') { f.input.expectedLineRevision++; }
    if (mode === 'wrong-amount') { f.input.expectedAmountMinor--; }
    const before = await snapshot(f);
    await assert.rejects(() => cancelUndeliveredBin(f.input));
    assert.deepEqual(await snapshot(f), before);
  });
}

test('a late audit failure rolls back the cancellation, pricing adjustment, draft and driver steps', async () => {
  const f = await fixture(); const before = await snapshot(f);
  await query(`CREATE FUNCTION bin_cancellation_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.action='mbt.frontdesk.undelivered_bin.cancelled' THEN RAISE EXCEPTION 'Synthetic audit failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER bin_cancellation_reject_audit BEFORE INSERT ON mbt_audit_events FOR EACH ROW EXECUTE FUNCTION bin_cancellation_reject_audit()`);
  try {
    await assert.rejects(() => cancelUndeliveredBin(f.input), /Synthetic audit failure/u);
    assert.deepEqual(await snapshot(f), before);
    assert.equal(await chargeService.currentFrontdeskContractTotal(before.contract), 165000);
  } finally {
    await query('DROP TRIGGER bin_cancellation_reject_audit ON mbt_audit_events; DROP FUNCTION bin_cancellation_reject_audit()');
  }
});

test('simultaneous cancellation commands deduct the charge once', async () => {
  const f = await fixture();
  const results = await Promise.allSettled([cancelUndeliveredBin(f.input),
    cancelUndeliveredBin({ ...f.input, idempotencyKey: f.input.idempotencyKey + '-concurrent' })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal((await snapshot(f)).amendments, 1);
  assert.equal(await chargeService.currentFrontdeskContractTotal((await snapshot(f)).contract), 55000);
});

test('invalid and duplicate adjustment inputs cannot change the contract', async () => {
  const f = await fixture(); const before = await snapshot(f);
  for (const changes of [{ expectedAmountMinor: -1 }, { expectedAmountMinor: Number.MAX_SAFE_INTEGER + 1 },
    { confirmedChargeRequestIds: [f.requests[0], f.requests[0]] }, { actor: { operatorId: 'viewer', roles: ['viewer'] } }]) {
    await assert.rejects(() => cancelUndeliveredBin({ ...f.input, ...changes }));
    assert.deepEqual(await snapshot(f), before);
  }
});
