import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { once } from 'node:events';
import test, { before, after } from 'node:test';
import express from 'express';
import { createOperator } from '../../../src/auth-repository.js';
import { query, withTransaction, closeDb } from '../../../src/db.js';
import { createOperatorYardGuard } from '../../../src/operator-yard-authorization.js';

const { readOperatorReceiptRecovery, createOperatorReceiptRecoveryRouter } = await import(
  process.env.RECEIPT_CONFIRMATION_BACKEND || '../../../src/operator-receipt-recovery.js');
const tag = crypto.randomUUID();
const orderId = String(-700000000 - crypto.randomInt(1, 1000000));
const order = { netsuite_id: orderId, order_type: 'purchase_order', tranid: 'SN1401278', destination_location_id: 1 };
let actor, other, server, base, completed;

async function command({ actorId = actor.id, localId = orderId, yard = 1, type = 'purchase_order', status = 'completed', age = 10 } = {}) {
  const id = crypto.randomUUID();
  const result = { localFinalization: { itemReceiptId: 1013762, itemReceiptTranid: 'IR14813', receiptStatus: 'received' } };
  await query(`INSERT INTO operator_netsuite_posting_commands
    (id,request_id,actor_operator_id,function_key,transaction_type,canonical_location_id,yard_code,gate_key,gate_revision,input_hash,status,result,created_at,completed_at)
    VALUES ($1,$1,$2,'receiving','IR',$3,'3445','operator_netsuite_receiving_ir_3445',4,$4,$5,$6,now()-($7*interval '1 second'),CASE WHEN $5='completed' THEN now() ELSE NULL END)`,
  [id, actorId, yard, 'a'.repeat(64), status, result, age]);
  await query(`INSERT INTO operator_netsuite_posting_order_claims(command_id,function_key,local_order_key,active,released_at)
    VALUES($1,'receiving',$2,false,now())`, [id, `receiving:${type}:${localId}`]);
  await query(`INSERT INTO operator_netsuite_posting_steps
    (command_id,step_index,source_order_kind,source_netsuite_id,source_order_ref,transaction_type,external_id,payload_hash,payload,status,netsuite_transaction_id,netsuite_transaction_ref,posted_at)
    VALUES($1,1,'PO',936958,'POB03658','IR',$2,$3,'{}',$4,$5,$6,CASE WHEN $4='posted' THEN now() ELSE NULL END)`,
  [id, `TEST-${id}`, 'b'.repeat(64), status === 'completed' ? 'posted' : 'pending', status === 'completed' ? 1013762 : null, status === 'completed' ? 'IR14813' : null]);
  return id;
}

before(async () => {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  actor = await createOperator({ username: `receipt-a-${tag}`, displayName: 'Receipt A', password: 'test-password', role: 'operator', operatorYardLocationIds: [1] });
  other = await createOperator({ username: `receipt-b-${tag}`, displayName: 'Receipt B', password: 'test-password', role: 'operator', operatorYardLocationIds: [1] });
  actor = { ...actor, operatorYardLocationIds: [1], roles: ['operator'] };
  other = { ...other, operatorYardLocationIds: [1], roles: ['operator'] };
  await query(`INSERT INTO purchase_orders(netsuite_id,tranid,destination_location_id,destination_location,netsuite_active,status,status_text,receipt_status)
    VALUES($1,'SN1401278',1,'3445',true,'G','Fully Billed','received')`, [orderId]);
  completed = await command();
  const app = express();
  app.use('/api/receiving', (req, res, next) => {
    const token = req.get('authorization');
    req.operator = token === 'Bearer a' ? actor : token === 'Bearer b' ? other : null;
    if (!req.operator) return res.status(401).json({ error: 'Authentication required' });
    next();
  }, createOperatorYardGuard(), createOperatorReceiptRecoveryRouter());
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { if (server) await new Promise(resolve => server.close(resolve)); await closeDb(); });

test('completed receipt is recovered through its released exact order claim in a read-only transaction', async () => {
  await withTransaction(async () => {
    await query('SET TRANSACTION READ ONLY');
    const recovered = await readOperatorReceiptRecovery({ operatorId: actor.id, order, locationId: 1 });
    assert.equal(recovered.job.id, completed);
    assert.equal(recovered.job.result.localFinalization.itemReceiptTranid, 'IR14813');
    assert.equal(recovered.order.order_type, 'purchase_order');
    assert.equal(recovered.order.netsuite_id, orderId);
    assert.equal(recovered.job.steps[0].transactionRef, 'IR14813');
  }, { rollback: true });
});

test('lookup isolates the operator, yard, order type, and exact order ID', async () => {
  for (const input of [
    { operatorId: other.id, order, locationId: 1 },
    { operatorId: actor.id, order: { ...order, destination_location_id: 28 }, locationId: 28 },
    { operatorId: actor.id, order: { ...order, order_type: 'transfer_order' }, locationId: 1 },
    { operatorId: actor.id, order: { ...order, netsuite_id: orderId + '0' }, locationId: 1 },
  ]) {
    const recovered = await readOperatorReceiptRecovery(input);
    assert.equal(recovered?.job, null);
  }
});

test('a failed latest attempt cannot recover an older success as the current receipt', async () => {
  await withTransaction(async () => {
    const latest = await command({ status: 'failed', age: 0 });
    const recovered = await readOperatorReceiptRecovery({ operatorId: actor.id, order, locationId: 1 });
    assert.equal(recovered.job.id, latest);
    assert.equal(recovered.job.status, 'failed');
    assert.deepEqual(recovered.job.result, {});
  }, { rollback: true });
});

test('an in-progress latest job is discoverable for recovery without reposting', async () => {
  await withTransaction(async () => {
    const latest = await command({ status: 'queued', age: 0 });
    const recovered = await readOperatorReceiptRecovery({ operatorId: actor.id, order, locationId: 1 });
    assert.equal(recovered.job.id, latest);
    assert.equal(recovered.job.status, 'queued');
    assert.deepEqual(recovered.job.result, {});
  }, { rollback: true });
});

test('authenticated HTTP lookup returns IR14813 even when the order is NetSuite-closed', async () => {
  const response = await fetch(`${base}/api/receiving/orders/${orderId}/posting-status?locationId=1`, { headers: { authorization: 'Bearer a' } });
  assert.equal(response.status, 200, await response.clone().text());
  assert.match(response.headers.get('cache-control'), /no-store/u);
  const body = await response.json();
  assert.equal(body.job.id, completed);
  assert.equal(body.job.result.localFinalization.itemReceiptTranid, 'IR14813');
});

test('anonymous, other-operator, and wrong-yard HTTP lookups cannot disclose the receipt', async () => {
  const path = `${base}/api/receiving/orders/${orderId}/posting-status`;
  assert.equal((await fetch(path + '?locationId=1')).status, 401);
  const otherResponse = await fetch(path + '?locationId=1', { headers: { authorization: 'Bearer b' } });
  assert.equal(otherResponse.status, 200);
  assert.equal((await otherResponse.json()).job, null);
  assert.equal((await fetch(path + '?locationId=28', { headers: { authorization: 'Bearer a' } })).status, 403);
});

test('local CO lookup has no NetSuite receipt and no posted transaction', async () => {
  const recovered = await readOperatorReceiptRecovery({ operatorId: actor.id, order: { ...order, order_type: 'co_order' }, locationId: 1 });
  assert.equal(recovered?.job, null);
});
