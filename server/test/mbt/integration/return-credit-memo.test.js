import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import http from 'node:http';
import { closeDb, query, withTransaction } from '../../../src/db.js';
import { config } from '../../../src/config.js';
import { getOperatorNetSuitePostingPolicy } from '../../../src/operator-netsuite-posting-policy-repository.js';
import { submitReturnBatch, syncReturnRecord, getReturnRecordDetail, localPalletReserved, localStockReserved,
  reconcileReturnRecords, voidReturnRecord, linkReturnNetSuiteTransaction } from '../../../src/return-repository.js';
import { fixture, submitInput, actor, reasonPhotos } from '../../support/return-batch-ra-fixture.js';
import { listOperatorHistory } from '../../../src/history-repository.js';
import { createOperator, loginOperator } from '../../../src/auth-repository.js';
import { app } from '../../../src/server.js';
after(closeDb);
const creates = remote => remote.requests.filter(request => request.method === 'POST' && /\/record\//.test(request.address));
const submit = (input, autoSync = true) => submitReturnBatch({ operatorId: actor, input, autoSync });
async function creditFixture(t) {
  const remote = await fixture(t);
  const before = await query("SELECT * FROM mbt_feature_flags WHERE flag_key LIKE 'operator_netsuite_%return_cm_%'");
  t.after(async () => {
    await query("DELETE FROM mbt_feature_flags WHERE flag_key LIKE 'operator_netsuite_%return_cm_%'");
    for (const row of before.rows) {
      await query('INSERT INTO mbt_feature_flags(flag_key,enabled,description,revision) VALUES($1,$2,$3,$4)',
        [row.flag_key, row.enabled, row.description, row.revision]);
    }
  });
  await query(`INSERT INTO mbt_feature_flags(flag_key,enabled,description)
    SELECT 'operator_netsuite_' || kind || '_return_cm_' || yard,true,'test'
    FROM unnest(ARRAY['stock','pallet']) kind CROSS JOIN unnest(ARRAY['3445','2967','12441','150']) yard
    ON CONFLICT(flag_key) DO UPDATE SET enabled=true,revision=mbt_feature_flags.revision+1`);
  return remote;
}

test('G1 migration seeds all eight CM gates off', async () => {
  const result = await query("SELECT enabled FROM mbt_feature_flags WHERE flag_key LIKE 'operator_netsuite_%return_cm_%'");
  assert.equal(result.rowCount, 8);
  assert.ok(result.rows.every(row => row.enabled === false));
});

for (const [name, options] of [['stock', {}], ['pallet', { stock: false, pallet: true }], ['combined', { pallet: true }]]) {
  test(`P1 ${name} confirmation posts one direct CM and records its verified type`, async t => {
    const remote = await creditFixture(t);
    const input = await submitInput(options);
    const result = await submit(input);
    assert.equal(creates(remote).length, 1);
    assert.match(creates(remote)[0].address, /\/creditMemo$/);
    assert.ok(result.records.every(record => record.netSuiteStage === 'credit_memo' && record.netSuiteSyncStatus === 'succeeded'));
    assert.equal(creates(remote)[0].body.entity.id, '99091702');
    assert.equal(creates(remote)[0].body.location.id, '1');
    assert.ok(creates(remote)[0].body.item.items.every(line => line.orderLine === undefined));
    assert.equal((await submit(input)).idempotentReplay, true);
    assert.equal(creates(remote).length, 1);
    const audit = await query("SELECT event_type FROM return_sync_events WHERE return_record_id=$1", [result.records[0].id]);
    assert.ok(audit.rows.some(row => row.event_type === 'batch_credit_memo'));
  });
}

test('G1 CM works with the RA gate off; a closed direct-access ceiling blocks new posting', async t => {
  const remote = await creditFixture(t);
  await query("UPDATE mbt_feature_flags SET enabled=false WHERE flag_key LIKE 'operator_netsuite_%return_ra_%'");
  const policy = await getOperatorNetSuitePostingPolicy({ functionKey: 'stock_return', locationId: 1 });
  assert.equal(policy.transactionType, 'CM');
  assert.equal(policy.effective, true);
  config.netsuite.directAccessEnabled = false;
  assert.equal((await getOperatorNetSuitePostingPolicy({ functionKey: 'stock_return', locationId: 1 })).effective, false);
  await assert.rejects(submit(await submitInput()), /Direct NetSuite access is disabled/);
  assert.equal(creates(remote).length, 0);
});

test('U1 personal history retains the verified Credit Memo type and reference', async t => {
  await creditFixture(t);
  const result = await submit(await submitInput({ pallet: true }));
  const history = await listOperatorHistory({ operatorId: actor, date: new Date().toISOString().slice(0, 10) });
  const returned = history.filter(record => ['stock_return', 'pallet_return'].includes(record.type));
  assert.equal(returned.length, 2);
  assert.ok(returned.every(record => record.details.netSuiteStage === 'credit_memo'
    && record.details.netSuiteTransactionRef === result.stockReturn.netSuiteTransactionRef));
});

test('HTTP Operator confirms a direct CM and receives its type/reference without financial details', async t => {
  const remote = await creditFixture(t);
  const username = `credit-memo-http-${process.pid}`;
  const password = 'synthetic-credit-memo-test-password';
  const operator = await createOperator({ username, displayName: 'CM test', password,
    role: 'operator', roles: ['operator'], operatorYardLocationIds: [1] });
  const { token } = await loginOperator(username, password);
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const call = (path, body) => new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port: server.address().port, path,
      method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }, response => {
      let data = '';
      response.on('data', chunk => { data += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(data) }));
    });
    request.on('error', reject);
    request.end(body ? JSON.stringify(body) : undefined);
  });
  const policy = await call('/api/operator/netsuite-posting-policy?functionKey=stock_return&locationId=1');
  assert.equal(policy.status, 200);
  assert.equal(policy.body.transactionType, 'CM');
  const input = await submitInput();
  input.photos = [`r2://operator/operator-return-photo/2026/10/08/${operator.id}/test/photo.jpg`];
  input.expectedPostingPolicies.stock_return = policy.body;
  assert.equal((await call('/api/returns/submit', { ...input, receivingLocationId: 28 })).status, 403);
  const response = await call('/api/returns/submit', input);
  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.equal(response.body.stockReturn.netSuiteStage, 'credit_memo');
  assert.match(response.body.stockReturn.netSuiteTransactionRef, /^CM/);
  assert.equal(response.body.stockReturn.actualCredit, undefined);
  assert.equal(response.body.stockReturn.lines[0].rate, undefined);
  assert.equal((await call('/api/returns/submit', input)).status, 200);
  assert.equal(creates(remote).length, 1);
});

test('P2 one disabled component saves the entire combined batch locally without partial CM posting', async t => {
  const remote = await creditFixture(t);
  await query("UPDATE mbt_feature_flags SET enabled=false WHERE flag_key IN ('operator_netsuite_pallet_return_cm_3445','operator_netsuite_pallet_return_ra_3445')");
  const result = await submit(await submitInput({ pallet: true }));
  assert.ok(result.records.every(record => record.netSuiteSyncStatus === 'disabled'));
  assert.equal(creates(remote).length, 0);
  await assert.rejects(syncReturnRecord({ recordId: result.stockReturn.id, force: true }), /locally|admitted/);
});

test('L1 an already-admitted RA stays an RA when CM gates are enabled', async t => {
  const remote = await fixture(t);
  const result = await submit(await submitInput(), false);
  await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key='operator_netsuite_stock_return_cm_3445'");
  t.after(() => query("UPDATE mbt_feature_flags SET enabled=false WHERE flag_key='operator_netsuite_stock_return_cm_3445'"));
  assert.equal((await syncReturnRecord({ recordId: result.stockReturn.id })).netSuiteStage, 'return_authorization');
  assert.equal(creates(remote).length, 1);
  assert.match(creates(remote)[0].address, /!transform\/returnAuthorization/);
});

test('R1 definitive CM rejection releases the draft admission and allows exactly one successful retry', async t => {
  const remote = await creditFixture(t);
  remote.control.rejectCreate = true;
  const input = await submitInput({ pallet: true });
  await assert.rejects(submit(input), { code: 'RETURN_SUBMISSION_DRAFT' });
  assert.equal((await query('SELECT id FROM return_records WHERE operator_id=$1', [actor])).rowCount, 0);
  remote.control.rejectCreate = false;
  const result = await submit(input);
  assert.ok(result.records.every(record => record.netSuiteStage === 'credit_memo' && record.netSuiteSyncStatus === 'succeeded'));
  assert.equal(remote.created.size, 1);
  assert.equal(creates(remote).length, 2);
});

test('G2 stale RA review cannot create a CM after the gate changes', async t => {
  const remote = await fixture(t);
  const input = await submitInput();
  await query("INSERT INTO mbt_feature_flags(flag_key,enabled,description) VALUES('operator_netsuite_stock_return_cm_3445',true,'test') ON CONFLICT(flag_key) DO UPDATE SET enabled=true");
  t.after(() => query("UPDATE mbt_feature_flags SET enabled=false WHERE flag_key='operator_netsuite_stock_return_cm_3445'"));
  await assert.rejects(submit(input), { code: 'OPERATOR_NETSUITE_POSTING_POLICY_CHANGED' });
  assert.equal(creates(remote).length, 0);
});

test('P2 incompatible effective stock/pallet modes block all remote posting', async t => {
  const remote = await creditFixture(t);
  await query("UPDATE mbt_feature_flags SET enabled=false WHERE flag_key='operator_netsuite_pallet_return_cm_3445'");
  await assert.rejects(submit(await submitInput({ pallet: true })), { code: 'RETURN_POSTING_TYPE_MISMATCH' });
  assert.equal(creates(remote).length, 0);
});

test('R1 concurrent retries keep the admitted CM type after gates switch back to RA', async t => {
  const remote = await creditFixture(t);
  const result = await submit(await submitInput({ pallet: true }), false);
  await query("UPDATE mbt_feature_flags SET enabled=false WHERE flag_key LIKE 'operator_netsuite_%return_cm_%'");
  const replies = await Promise.all(Array.from({ length: 12 }, (_, i) => syncReturnRecord({ recordId: result.records[i % 2].id })));
  assert.equal(creates(remote).length, 1);
  assert.match(creates(remote)[0].address, /\/creditMemo$/);
  assert.ok(replies.every(record => record.netSuiteStage === 'credit_memo' && record.netSuiteSyncStatus === 'succeeded'));
  await assert.rejects(query("UPDATE return_batch_authorizations SET intent_snapshot=jsonb_set(intent_snapshot,'{transactionType}','\"return_authorization\"') WHERE batch_id=$1", [result.stockReturn.batchId]), /immutable/);
});

test('R1 a lost CM response remains a draft, then recovers without a second financial transaction', async t => {
  const remote = await creditFixture(t);
  const input = await submitInput({ pallet: true });
  remote.control.failAfterCreate = true;
  remote.control.hideExternalId = true;
  await assert.rejects(submit(input), { code: 'RETURN_SUBMISSION_DRAFT' });
  await assert.rejects(submit(input), { code: 'RETURN_SUBMISSION_DRAFT' });
  assert.equal(creates(remote).length, 1);
  assert.match(creates(remote)[0].address, /\/creditMemo$/);
  assert.equal((await query('SELECT id FROM return_records WHERE operator_id=$1', [actor])).rowCount, 0);
  remote.control.hideExternalId = false;
  const result = await submit(input);
  assert.equal(result.stockReturn.netSuiteStage, 'credit_memo');
  assert.equal(creates(remote).length, 1);
});

test('V1 altered CM readback cannot finalize a draft, and recovery reuses the identified CM', async t => {
  const remote = await creditFixture(t);
  const input = await submitInput();
  remote.control.alter = snapshot => { snapshot.item.items[0].rate += 1; };
  await assert.rejects(submit(input), error => error.code === 'RETURN_SUBMISSION_DRAFT' && /Credit Memo verification/.test(error.message));
  assert.equal((await query('SELECT id FROM return_records WHERE operator_id=$1', [actor])).rowCount, 0);
  remote.created.values().next().value.item.items[0].rate -= 1;
  const result = await submit(input);
  assert.equal(result.stockReturn.netSuiteStage, 'credit_memo');
  assert.equal(creates(remote).length, 1);
});

test('R1 an outer rollback cannot discard a durable CM identity', async t => {
  const remote = await creditFixture(t);
  const result = await submit(await submitInput(), false);
  await assert.rejects(withTransaction(async () => {
    await syncReturnRecord({ recordId: result.stockReturn.id });
    throw new Error('outer rollback');
  }), /outer rollback/);
  assert.equal((await syncReturnRecord({ recordId: result.stockReturn.id })).netSuiteStage, 'credit_memo');
  assert.equal(creates(remote).length, 1);
});

test('P1 split reasons survive direct CM posting without duplicate transform keys', async t => {
  const remote = await creditFixture(t);
  const input = await submitInput({ pallet: true });
  input.stockReturnType = 'quality';
  input.lines = [6, 7, 8].map(reasonId => ({ sourceLineId: 99091703, salesQuantity: 1, reasonId, photos: reasonPhotos }));
  const result = await submit(input);
  const payload = creates(remote)[0].body;
  assert.equal(result.stockReturn.netSuiteStage, 'credit_memo');
  assert.deepEqual(payload.item.items.map(line => line.custcol_atlas_rc_so.id), ['6', '7', '8', '10']);
  assert.ok(payload.item.items.every(line => line.orderLine === undefined));
  assert.equal(new Set(payload.item.items.slice(0, 3).map(line => line.description)).size, 3);
});

test('Q1 direct CM pallet quantities reserve only until the CM is observed; stock source quota stays conserved', async t => {
  await creditFixture(t);
  const result = await submit(await submitInput({ pallet: true, quantity: 3 }));
  const id = result.palletReturn.netSuiteTransactionId;
  assert.equal(await localPalletReserved(99091702), 3);
  assert.equal(await localPalletReserved(99091702, [], [id]), 0);
  assert.equal(await localPalletReserved(99091702, [`MBBS-${result.batchReference}`]), 0);
  assert.equal((await localStockReserved([99091703])).get('99091703'), 3);
  assert.equal((await localStockReserved([99091703], [], [id], new Map([['99091703', { transactions: [{ id, countedQuantity: 3 }] }]]))).get('99091703'), 0);
});

test('L1 CM manual-link type, reconciliation and void guards use the admitted financial transaction', async t => {
  const remote = await creditFixture(t);
  const result = await submit(await submitInput());
  const record = result.stockReturn;
  await assert.rejects(linkReturnNetSuiteTransaction({ recordId: record.id, transactionType: 'return_authorization', netsuiteId: record.netSuiteTransactionId }), /Credit Memo/);
  const linked = await linkReturnNetSuiteTransaction({ recordId: record.id, transactionType: 'credit_memo', netsuiteId: record.netSuiteTransactionId });
  assert.equal(linked.netSuiteStage, 'credit_memo');
  await assert.rejects(linkReturnNetSuiteTransaction({ recordId: record.id, transactionType: 'credit_memo',
    netsuiteId: record.netSuiteTransactionId + 1 }), /different Credit Memo/);
  await assert.rejects(linkReturnNetSuiteTransaction({ recordId: record.id, transactionType: 'credit_memo',
    netsuiteId: record.netSuiteTransactionId, netsuiteTranid: 'CM-WRONG' }), /Credit Memo number does not match/);
  await assert.rejects(voidReturnRecord({ recordId: record.id, actorOperatorId: actor, reason: 'test' }), /Credit Memo/);
  remote.created.values().next().value.status = { refName: 'Voided' };
  await reconcileReturnRecords();
  assert.equal((await getReturnRecordDetail(record.id)).netSuiteSyncStatus, 'cancelled');
  await voidReturnRecord({ recordId: record.id, actorOperatorId: actor, reason: 'voided remotely' });
  assert.equal(creates(remote).length, 1);
});

test('L1 a changed return decision blocks CM posting before any network mutation', async t => {
  const remote = await creditFixture(t);
  const result = await submit(await submitInput(), false);
  await query("UPDATE return_records SET status='rejected' WHERE id=$1", [result.stockReturn.id]);
  await assert.rejects(syncReturnRecord({ recordId: result.stockReturn.id }), /changed|unfinished|rejected/i);
  assert.equal(creates(remote).length, 0);
});
