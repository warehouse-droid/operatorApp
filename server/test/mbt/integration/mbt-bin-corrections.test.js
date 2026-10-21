import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test, { after } from 'node:test';
import { closeDb, query } from '../../../src/db.js';
import { createFrontdeskQuote, issueFrontdeskQuote, acceptFrontdeskQuote, convertFrontdeskQuote,
  exchangeFrontdeskServiceLine, collectFrontdeskServiceLine } from '../../../src/mbt/frontdesk-service.js';
import { previewFrontdeskChargeRequest } from '../../../src/mbt/customer-charge-request-service.js';
import { getMbtBinPlanning } from '../../../src/mbt/bin-planning-service.js';
import { createFrontdeskPrerequisites, frontdeskCommand, quoteCommand, frontdeskDistanceResolver,
  frontdeskTaxResolver } from '../support/frontdesk-fixtures.js';
import { boundary } from '../support/bin-planning-fixtures.js';

after(closeDb);
const actor = { operatorId: 'bin-corrections-regression', roles: ['mbt_frontdesk'] };
async function fixture() {
  const f = await createFrontdeskPrerequisites({ label: 'bin-corrections' });
  const created = await createFrontdeskQuote({ ...quoteCommand(f, { actor, identity: crypto.randomUUID() }),
    serviceLines: [1, 2].map(() => ({ binTypeId: f.binTypeId,
      proposedDeliveryAt: '2037-08-03T12:00:00Z', proposedReturnAt: '2037-08-17T12:00:00Z' })) },
  { resolveDistance: frontdeskDistanceResolver(f), resolveTaxPolicy: frontdeskTaxResolver });
  const quoteId = created.body.quote.quoteId;
  await issueFrontdeskQuote(frontdeskCommand('bin-issue', actor, { quoteId, expectedRevision: 1, validUntil: '2037-08-04T12:00:00Z' }));
  await acceptFrontdeskQuote(frontdeskCommand('bin-accept', actor, { quoteId, expectedRevision: 2, acceptedAt: '2037-08-03T10:00:00Z' }));
  const converted = await convertFrontdeskQuote(frontdeskCommand('bin-convert', actor, { quoteId, expectedRevision: 3 }));
  return { ...f, ...converted.body };
}
async function snapshot(f) {
  return (await query(`SELECT
    (SELECT jsonb_agg(to_jsonb(v) ORDER BY visit_number) FROM mbt_service_visits v WHERE contract_id=$1) AS visits,
    (SELECT jsonb_agg(to_jsonb(l) ORDER BY line_number) FROM mbt_contract_service_lines l WHERE contract_id=$1) AS lines,
    (SELECT count(*)::int FROM mbt_frontdesk_charge_requests WHERE contract_id=$1) AS requests,
    (SELECT count(*)::int FROM mbt_contract_amendments WHERE contract_id=$1) AS amendments`, [f.contract.contractId])).rows[0];
}
function operation(f, line, action) {
  const common = { contractId: f.contract.contractId, serviceLineId: line.serviceLineId, expectedRevision: line.revision };
  if (action === 'exchange') { return () => exchangeFrontdeskServiceLine(frontdeskCommand('guard-exchange', actor, {
    ...common, incomingBinTypeId: f.binTypeId, chargeMode: 'free_internal', waiverReason: 'Replacement',
    exchangeWindow: { startAt: '2037-08-04T12:00:00Z', endAt: '2037-08-04T16:00:00Z' } })); }
  return () => collectFrontdeskServiceLine(frontdeskCommand('guard-collect', actor, {
    ...common, collectionWindow: { startAt: '2037-08-10T12:00:00Z', endAt: '2037-08-10T16:00:00Z' } }));
}

for (const status of ['ready', 'planned', 'in_progress', 'evidence_pending']) {
  for (const action of ['exchange', 'collect']) {
    test(`${action} rejects a ${status} delivery without changing either physical bin`, async () => {
      const f = await fixture();
      await query("UPDATE mbt_service_visits SET status=$2 WHERE service_line_id=$1 AND service_action='delivery'", [f.serviceLines[0].serviceLineId, status]);
      const before = await snapshot(f);
      await assert.rejects(operation(f, f.serviceLines[0], action), error => error.status === 409 && error.code === 'MBT_FRONTDESK_BIN_NOT_DELIVERED');
      assert.deepEqual(await snapshot(f), before);
    });
  }
}

test('exchange pricing rejects an undelivered bin before creating a charge request', async () => {
  const f = await fixture(); const line = f.serviceLines[0]; const before = await snapshot(f);
  await assert.rejects(() => previewFrontdeskChargeRequest(frontdeskCommand('guard-preview', actor, {
    kind: 'exchange_bin', contractId: f.contract.contractId, serviceLineId: line.serviceLineId,
    expectedContractRevision: f.contract.revision, expectedServiceLineRevision: line.revision,
    rateCardVersionId: f.rateCardVersionId, paymentMethod: 'cash', distanceMetres: 12500,
    billingAddressText: '100 Billing Ave', serviceAddressText: '200 Service Rd', contractTelephone: '4165550100',
    bin: {}, aggregateLines: [] })), error => error.status === 409 && error.code === 'MBT_FRONTDESK_BIN_NOT_DELIVERED');
  assert.deepEqual(await snapshot(f), before);
});

test('a delivered sibling can be collected while the newly added bin remains blocked', async () => {
  const f = await fixture(); const [delivered, added] = f.serviceLines;
  await query("UPDATE mbt_service_visits SET status='completed',actual_completed_at=now() WHERE service_line_id=$1 AND service_action='delivery'", [delivered.serviceLineId]);
  const current = (await query('SELECT revision::int FROM mbt_contract_service_lines WHERE service_line_id=$1', [delivered.serviceLineId])).rows[0];
  const result = await operation(f, { ...delivered, revision: current.revision }, 'collect')();
  assert.equal(result.body.serviceLine.status, 'return_due');
  await assert.rejects(operation(f, added, 'collect'), error => error.code === 'MBT_FRONTDESK_BIN_NOT_DELIVERED');
});

test('two fresh deliveries show unavailable physical bins instead of reporting missing front legs', async () => {
  const f = await fixture();
  const feed = await getMbtBinPlanning({ planDate: '2037-08-03', search: f.contract.contractNumber }, boundary);
  assert.equal(feed.pool.total, 2);
  assert.equal(new Set(feed.pool.items.map(card => card.mbt.serviceLineId)).size, 2);
  for (const card of feed.pool.items) {
    assert.equal(card.serviceAction, 'delivery');
    assert.match(card.blockedReason, /no available.*bin/i);
    assert.doesNotMatch(card.blockedReason, /front leg.*missing/i);
    assert.equal(card.mbt.frontLeg.dispatchable, false);
  }
});

test('simultaneous premature exchange and collection both reject without partial changes', async () => {
  const f = await fixture(); const before = await snapshot(f);
  const results = await Promise.allSettled(['exchange', 'collect'].map(action => operation(f, f.serviceLines[0], action)()));
  assert.deepEqual(results.map(result => result.status), ['rejected', 'rejected']);
  assert.ok(results.every(result => result.reason.code === 'MBT_FRONTDESK_BIN_NOT_DELIVERED'));
  assert.deepEqual(await snapshot(f), before);
});

test('a pending replacement must finish before another exchange or collection', async () => {
  const f = await fixture(); const line = f.serviceLines[0];
  await query("UPDATE mbt_service_visits SET status='completed',actual_completed_at=now() WHERE service_line_id=$1 AND service_action='delivery'", [line.serviceLineId]);
  const current = (await query('SELECT revision::int FROM mbt_contract_service_lines WHERE service_line_id=$1', [line.serviceLineId])).rows[0];
  const swapped = await operation(f, { ...line, revision: current.revision }, 'exchange')();
  const before = await snapshot(f);
  for (const action of ['exchange', 'collect']) {
    await assert.rejects(operation(f, swapped.body.serviceLine, action), error => error.code === 'MBT_FRONTDESK_BIN_NOT_DELIVERED');
  }
  assert.deepEqual(await snapshot(f), before);
});
