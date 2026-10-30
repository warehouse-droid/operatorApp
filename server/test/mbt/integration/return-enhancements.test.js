import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { query, closeDb, withTransaction } from '../../../src/db.js';
import { config } from '../../../src/config.js';
import { submitReturnBatch, lookupReturnSalesOrder, syncReturnRecord } from '../../../src/return-repository.js';
import { fixture, submitInput, actor, reasonPhotos } from '../../support/return-batch-ra-fixture.js';
import { palletSearchResult } from '../../support/pallet-saved-search-fixture.js';
import { returnNotificationTransport } from '../../../src/return-notification-transport.js';
import { automaticReturnNotifications, createAutomaticReturnNotifications } from '../../../src/return-automatic-notifications.js';

after(closeDb);
const submit = input => submitReturnBatch({ operatorId: actor, input, autoSync: true });
const creates = remote => remote.requests.filter(r => r.method === 'POST' && /\/creditMemo$/.test(r.address));

async function setup(t) {
  const remote = await fixture(t, { enabled: false });
  const flags = (await query("SELECT flag_key,enabled,revision FROM mbt_feature_flags WHERE flag_key LIKE 'operator_netsuite_%return_cm_%'")).rows;
  t.after(async () => {
    for (const flag of flags) { await query('UPDATE mbt_feature_flags SET enabled=$2,revision=$3 WHERE flag_key=$1', [flag.flag_key, flag.enabled, flag.revision]); }
  });
  await query("UPDATE mbt_feature_flags SET enabled=true,revision=revision+1 WHERE flag_key LIKE 'operator_netsuite_%return_cm_%'");
  remote.remoteLines[0].customer_phone = '(416) 555-0123';
  remote.remoteLines[0].customer_email = 'customer@example.com';
  remote.control.customer = { id: '99091702', phone: '(416) 555-0123', email: 'customer@example.com' };
  remote.messages = [];
  t.mock.method(returnNotificationTransport, 'checkReady', async () => {});
  t.mock.method(returnNotificationTransport, 'send', async message => {
    remote.messages.push(message);
    return { providerId: 'synthetic-message' };
  });
  return remote;
}

test('E1/E6/E8/E9 blank stock plate posts the adjacent fee, SO reference and authenticated account memo', async t => {
  const remote = await setup(t);
  const input = await submitInput(); delete input.vehiclePlate;
  input.operatorAccount = 'forged';
  const result = await submit(input);
  assert.equal(result.stockReturn.vehiclePlate, '');
  const body = creates(remote)[0].body;
  assert.deepEqual(body.item.items.map(row => row.item.id), ['99091701', '3015']);
  assert.equal(body.item.items[1].rate, -4.38);
  assert.equal(body.otherRefNum, 'SOB99091700');
  assert.match(body.memo, new RegExp(`^${actor} \\| `));
  assert.doesNotMatch(body.memo, /forged/);
});

test('E10 stock CM uses the source SO custom rate and sales units exactly', async t => {
  const remote = await setup(t);
  remote.remoteLines[0].rate = 7.123456;
  const input = await submitInput({ quantity: 2 });
  input.lines[0].rate = 999;
  input.lines[0].salesUomId = 999;
  await submit(input);
  const rows = creates(remote)[0].body.item.items;
  assert.deepEqual(rows[0].price, { id: '-1' });
  assert.equal(rows[0].rate, 7.123456);
  assert.equal(rows[0].units, '3');
  assert.equal(rows[1].rate, -4.99);
});

test('E7 each R1-R5 reason posts only stock at the receiving child Return location', async t => {
  const remote = await setup(t);
  for (const [yard, child, reference] of [[1, 9, 'SOB99091700'], [28, 39, 'SOA99091700'], [26, 42, 'SOM99091700']]) {
    remote.remoteLines[0].ordering_location_id = String(yard);
    remote.remoteLines[0].tranid = reference;
    const input = await submitInput();
    input.receivingLocationId = yard;
    const { getOperatorNetSuitePostingPolicy } = await import('../../../src/operator-netsuite-posting-policy-repository.js');
    input.expectedPostingPolicies.stock_return = await getOperatorNetSuitePostingPolicy({ functionKey: 'stock_return', locationId: yard });
    input.stockReturnType = 'quality';
    input.lines = [5, 6, 7, 8, 9].map(reasonId => ({ sourceLineId: 99091703, salesQuantity: .1, reasonId, photos: reasonPhotos }));
    await submit(input);
    const body = creates(remote).at(-1).body;
    assert.equal(body.item.items.length, 5);
    assert.ok(body.item.items.every(row => row.location.id === String(child)));
    assert.equal(body.location.id, String(yard));
  }
});

test('E3 missing good-condition and per-row quality photos reject submission before a CM is created', async t => {
  const remote = await setup(t);
  const normal = await submitInput(); normal.photos = [];
  await assert.rejects(submit(normal), /requires at least one live-camera photo/);
  const quality = await submitInput(); quality.stockReturnType = 'quality';
  quality.lines[0].reasonId = 5;
  await assert.rejects(submit(quality), /live-camera photo/);
  assert.equal(creates(remote).length, 0);
});

test('E4 stock lookup gets optional pallet balance from the same NetSuite report, without the historical aggregate', async t => {
  const remote = await setup(t);
  const before = { account: config.netsuite.accountId, endpoint: config.netsuite.palletBalanceRestletUrl };
  config.netsuite.accountId = 'pallet-test';
  config.netsuite.palletBalanceRestletUrl = 'https://pallet-test.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=505&deploy=1';
  t.after(() => { config.netsuite.accountId = before.account; config.netsuite.palletBalanceRestletUrl = before.endpoint; });
  const transport = globalThis.fetch;
  let reports = 0;
  t.mock.method(globalThis, 'fetch', (url, options) => {
    if (String(url).includes('/app/site/hosting/restlet.nl')) {
      reports++;
      return Promise.resolve(Response.json(palletSearchResult(99091702, 13)));
    }
    return transport(url, options);
  });
  const result = await lookupReturnSalesOrder({ code: 99091700, receivingLocationId: 1 });
  assert.equal(result.palletBalance.available, 13);
  assert.equal(result.palletBalance.source, 'netsuite_saved_search');
  assert.equal(reports, 1);
  assert.equal(remote.requests.filter(r => /'ItemShip' AS transaction_type|return_pallet_credit_identity/.test(r.body?.q)).length, 0);
});

for (const [name, options] of [['stock', {}], ['pallet', { stock: false, pallet: true }], ['combined', { pallet: true }]]) {
  test(`E5 ${name} verified CM sends one automatic SMS, survives replay, and includes saved CM reference`, async t => {
    const remote = await setup(t);
    const input = await submitInput(options);
    const result = await submit(input);
    assert.equal(remote.messages.length, 1);
    assert.equal(remote.messages[0].recipient, '+14165550123');
    assert.equal(remote.messages[0].channel, 'sms');
    assert.match(remote.messages[0].text, new RegExp(result.records[0].netSuiteTransactionRef));
    assert.equal((await submit(input)).idempotentReplay, true);
    assert.equal(remote.messages.length, 1);
  });
}

test('E5 no usable NetSuite phone falls back to email; unverified CMs never notify', async t => {
  const remote = await setup(t);
  remote.control.customer.phone = 'bad phone';
  await submit(await submitInput({ stock: false, pallet: true }));
  assert.equal(remote.messages[0]?.channel, 'email');
  assert.equal(remote.messages[0]?.recipient, 'customer@example.com');
  remote.control.alter = cm => { cm.entity.id = '123'; };
  await assert.rejects(submit(await submitInput()), /draft/i);
  assert.equal(remote.messages.length, 1);
});

test('E5 absent customer contacts are visible without failing the posted CM', async t => {
  const remote = await setup(t);
  remote.control.customer = { id: '99091702', phone: '', email: '' };
  const result = await submit(await submitInput());
  assert.equal(result.stockReturn.netSuiteSyncStatus, 'succeeded');
  assert.equal(result.stockReturn.customerNotification.status, 'no_contact');
  assert.equal(remote.messages.length, 0);
});

test('E5 concurrent workers and manual replay share one durable message reservation', async t => {
  const remote = await setup(t);
  const input = await submitInput();
  const result = await submit(input);
  const batchId = result.stockReturn.batchId;
  await query("UPDATE return_automatic_notifications SET status='pending',next_attempt_at=now() WHERE batch_id=$1", [batchId]);
  await Promise.all(Array.from({ length: 6 }, () => automaticReturnNotifications.process({ batchId })));
  const { returnNotifications } = await import('../../../src/return-notification-service.js');
  const replay = await returnNotifications.send({ recordId: result.stockReturn.id,
    operator: { id: actor, role: 'operator', operatorYardLocationIds: [1] }, recipient: '(416) 555-0123' });
  assert.equal(replay.replayed, true);
  assert.equal(remote.messages.length, 1);
});

test('E5 uncertain delivery never retries; definitive failures retry the frozen contact with a three-attempt bound', async t => {
  const remote = await setup(t);
  let sends = 0;
  t.mock.method(returnNotificationTransport, 'send', async () => {
    sends++;
    throw Object.assign(new Error('private provider error'), { deliveryStatus: 'uncertain' });
  });
  const first = await submit(await submitInput());
  assert.equal(first.stockReturn.customerNotification.status, 'uncertain');
  await query('UPDATE return_automatic_notifications SET next_attempt_at=now() WHERE batch_id=$1', [first.stockReturn.batchId]);
  await automaticReturnNotifications.process({ batchId: first.stockReturn.batchId });
  assert.equal(sends, 1);
  t.mock.method(returnNotificationTransport, 'send', async message => {
    sends++;
    assert.equal(message.recipient, '+14165550123');
    throw Object.assign(new Error('private provider error'), { deliveryStatus: 'failed' });
  });
  const second = await submit(await submitInput());
  assert.equal(second.stockReturn.netSuiteSyncStatus, 'succeeded');
  assert.equal(second.stockReturn.customerNotification.status, 'retry');
  remote.control.customer.phone = '(416) 555-9999';
  for (let i = 0; i < 4; i++) {
    await query('UPDATE return_automatic_notifications SET next_attempt_at=now() WHERE batch_id=$1', [second.stockReturn.batchId]);
    await automaticReturnNotifications.process({ batchId: second.stockReturn.batchId });
  }
  assert.equal(sends, 4);
  const row = (await query('SELECT * FROM return_automatic_notifications WHERE batch_id=$1', [second.stockReturn.batchId])).rows[0];
  assert.equal(row.status, 'failed');
  assert.equal(row.attempts, 3);
  assert.equal(row.recipient, '+14165550123');
});

test('E5 an outer rollback after CM verification does not send a customer message', async t => {
  const remote = await setup(t);
  const saved = await submitReturnBatch({ operatorId: actor, input: await submitInput(), autoSync: false });
  await assert.rejects(withTransaction(async () => {
    await syncReturnRecord({ recordId: saved.stockReturn.id });
    assert.equal(remote.messages.length, 0);
    throw new Error('synthetic rollback');
  }), /synthetic rollback/);
  assert.equal(remote.messages.length, 0);
});

test('E6 retry after a lost CM response preserves the admitted fee and sends only after recovery verifies', async t => {
  const remote = await setup(t);
  remote.control.failAfterCreate = true;
  const input = await submitInput();
  await assert.rejects(submit(input), /draft/i);
  assert.equal(remote.messages.length, 0);
  remote.control.failAfterCreate = false;
  remote.control.feePercent = 90;
  const result = await submit(input);
  assert.equal(result.stockReturn.netSuiteSyncStatus, 'succeeded');
  assert.equal(creates(remote).length, 1);
  assert.equal(creates(remote)[0].body.item.items[1].rate, -4.38);
  assert.equal(remote.messages.length, 1);
});

test('E6 unavailable fee percentages reject new CMs without guessing a charge', async t => {
  const remote = await setup(t);
  for (const percent of [-1, 101, 'bad']) {
    remote.control.feePercent = percent;
    await assert.rejects(submit(await submitInput()), /Restocking Fee percentage/);
  }
  assert.equal(creates(remote).length, 0);
  assert.equal(remote.messages.length, 0);
});

test('E7 an unverified Return child cannot fall back to its parent yard', async t => {
  const remote = await setup(t);
  const previous = config.netsuite.accountId;
  config.netsuite.accountId = 'missing-return-location-test';
  t.after(() => { config.netsuite.accountId = previous; });
  remote.control.locations = [{ id: '9', name: '3445 Return', parent: '28', isinactive: 'F' }];
  const input = await submitInput();
  input.stockReturnType = 'quality';
  input.lines[0] = { ...input.lines[0], reasonId: 5, photos: reasonPhotos };
  await assert.rejects(submit(input), /Return location.*could not be verified/);
  assert.equal(creates(remote).length, 0);
});

test('E5 historical CMs never acquire automatic notifications', async t => {
  const remote = await setup(t);
  const result = await submitReturnBatch({ operatorId: actor, input: await submitInput(), autoSync: false });
  // Seed the historical fixture before its first attempt. Admitted intents
  // remain immutable: do not disable or alter the production UPDATE trigger.
  await query(`WITH historical AS (DELETE FROM return_batch_authorizations WHERE batch_id=$1 AND attempted_at IS NULL RETURNING *)
    INSERT INTO return_batch_authorizations(batch_id,external_id,intent_snapshot,posting_policy,sync_status)
    SELECT batch_id,external_id,jsonb_set(intent_snapshot,'{version}','3'),posting_policy,sync_status FROM historical`, [result.stockReturn.batchId]);
  await syncReturnRecord({ recordId: result.stockReturn.id });
  assert.equal((await query('SELECT * FROM return_automatic_notifications WHERE batch_id=$1', [result.stockReturn.batchId])).rowCount, 0);
  assert.equal(remote.messages.length, 0);
});

test('E5 new RAs and local-only returns never queue or send a CM confirmation', async t => {
  const remote = await setup(t);
  await query("UPDATE mbt_feature_flags SET enabled=false,revision=revision+1 WHERE flag_key LIKE 'operator_netsuite_%return_cm_%'");
  await query("UPDATE mbt_feature_flags SET enabled=true,revision=revision+1 WHERE flag_key LIKE 'operator_netsuite_%return_ra_%'");
  const ra = await submit(await submitInput());
  assert.equal(ra.stockReturn.netSuiteStage, 'return_authorization');
  assert.equal(ra.stockReturn.netSuiteSyncStatus, 'succeeded');
  await query("UPDATE mbt_feature_flags SET enabled=false,revision=revision+1 WHERE flag_key LIKE 'operator_netsuite_%return_ra_%'");
  const local = await submit(await submitInput());
  assert.equal(local.stockReturn.netSuiteSyncStatus, 'disabled');
  const queued = await query('SELECT * FROM return_automatic_notifications WHERE batch_id=ANY($1::bigint[])', [[ra.stockReturn.batchId, local.stockReturn.batchId]]);
  assert.equal(queued.rowCount, 0);
  assert.equal(remote.messages.length, 0);
});

test('E5 an exhausted worker lease has an uncertain result instead of risking another send', async t => {
  const remote = await setup(t);
  const result = await submit(await submitInput());
  await query(`UPDATE return_automatic_notifications SET status='processing',attempts=3,next_attempt_at=now()-interval '1 minute'
    WHERE batch_id=$1`, [result.stockReturn.batchId]);
  await automaticReturnNotifications.process({ batchId: result.stockReturn.batchId });
  assert.equal((await query('SELECT status FROM return_automatic_notifications WHERE batch_id=$1', [result.stockReturn.batchId])).rows[0].status, 'uncertain');
  assert.equal(remote.messages.length, 1);
});

test('E5 a superseded contact lookup cannot overwrite the frozen recipient or a newer worker outcome', async t => {
  const remote = await setup(t);
  const result = await submit(await submitInput());
  const batchId = result.stockReturn.batchId;
  await query('DELETE FROM return_customer_notifications WHERE batch_id=$1', [batchId]);
  await query(`UPDATE return_automatic_notifications SET status='pending',recipient=NULL,channel=NULL,attempts=0,next_attempt_at=now()
    WHERE batch_id=$1`, [batchId]);
  remote.messages.length = 0;
  let releaseContact;
  let lookupStarted;
  const started = new Promise(resolve => { lookupStarted = resolve; });
  const worker = createAutomaticReturnNotifications({ lookupCustomer: () => new Promise(resolve => {
    releaseContact = resolve; lookupStarted();
  }) });
  const oldWorker = worker.process({ batchId });
  await started;
  await query('UPDATE return_automatic_notifications SET next_attempt_at=now() WHERE batch_id=$1', [batchId]);
  await automaticReturnNotifications.process({ batchId });
  releaseContact({ phone: '(416) 555-9999', email: 'different@example.com' });
  await oldWorker;
  assert.equal(remote.messages.length, 1);
  const row = (await query('SELECT status,recipient FROM return_automatic_notifications WHERE batch_id=$1', [batchId])).rows[0];
  assert.equal(row.status, 'sent');
  assert.equal(row.recipient, '+14165550123');
});

test('E5 messaging configuration failure preserves the successful CM and queues a safe retry', async t => {
  const remote = await setup(t);
  t.mock.method(returnNotificationTransport, 'checkReady', async () => { throw new Error('service unavailable'); });
  const result = await submit(await submitInput());
  assert.equal(result.stockReturn.netSuiteSyncStatus, 'succeeded');
  assert.equal(result.stockReturn.customerNotification.status, 'retry');
  assert.equal(remote.messages.length, 0);
});

test('E5 a CM cancelled before a pending notification is processed does not send', async t => {
  const remote = await setup(t);
  const result = await submit(await submitInput());
  await query("UPDATE return_batch_authorizations SET sync_status='cancelled' WHERE batch_id=$1", [result.stockReturn.batchId]);
  await query("UPDATE return_automatic_notifications SET status='pending',next_attempt_at=now() WHERE batch_id=$1", [result.stockReturn.batchId]);
  const processed = await automaticReturnNotifications.process({ batchId: result.stockReturn.batchId });
  assert.equal(processed[0].status, 'cancelled');
  assert.equal(remote.messages.length, 1);
});
