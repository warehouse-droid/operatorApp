// Real Express application, authentication, yard guard, and PostgreSQL; isolated data only.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { app } from '../src/server.js';
import { query, closeDb } from '../src/db.js';
import { createOperator, loginOperator } from '../src/auth-repository.js';

assert.equal(process.env.MBT_TEST_ISOLATED, '1');
const tag = crypto.randomUUID();
const username = `receipt-smoke-${tag}`;
const password = 'test-receipt-smoke-password';
let server;
try {
  const actor = await createOperator({ username, displayName: 'Receipt smoke', password, role: 'operator', operatorYardLocationIds: [1, 28] });
  const login = await loginOperator(username, password);
  const orderId = String(-800000000 - crypto.randomInt(1, 1000000));
  await query(`INSERT INTO purchase_orders(netsuite_id,tranid,destination_location_id,destination_location,netsuite_active,status,status_text,receipt_status)
    VALUES($1,'SN1401278',1,'3445',true,'G','Fully Billed','received')`, [orderId]);
  const commandId = crypto.randomUUID();
  await query(`INSERT INTO operator_netsuite_posting_commands
    (id,request_id,actor_operator_id,function_key,transaction_type,canonical_location_id,yard_code,gate_key,gate_revision,input_hash,status,result,completed_at)
    VALUES($1,$1,$2,'receiving','IR',1,'3445','operator_netsuite_receiving_ir_3445',4,$3,'completed',$4,now())`,
  [commandId, actor.id, 'c'.repeat(64), { localFinalization: { itemReceiptId: 1013762, itemReceiptTranid: 'IR14813', receiptStatus: 'received' } }]);
  await query(`INSERT INTO operator_netsuite_posting_order_claims(command_id,function_key,local_order_key,active,released_at)
    VALUES($1,'receiving',$2,false,now())`, [commandId, `receiving:purchase_order:${orderId}`]);
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization: `Bearer ${login.token}` };
  const route = `${base}/api/receiving/orders/${orderId}/posting-status`;
  assert.equal((await fetch(route)).status, 401);
  const response = await fetch(route + '?locationId=1', { headers });
  assert.equal(response.status, 200);
  const receipt = await response.json();
  assert.equal(receipt.job.id, commandId);
  assert.equal(receipt.job.result.localFinalization.itemReceiptTranid, 'IR14813');
  const wrongYard = await fetch(route + '?locationId=28', { headers });
  assert.equal(wrongYard.status, 403);
  assert.equal((await wrongYard.json()).error, 'The receipt belongs to another receiving yard.');
  assert.equal((await fetch(route + '?locationId=invalid', { headers })).status, 403);
  assert.equal((await fetch(base + '/health')).status, 200);
  console.log(JSON.stringify({ realApplication: true, authenticatedReceipt: 'IR14813', anonymous: 401, wrongAuthorizedYard: 403, health: 200 }));
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  await closeDb();
}
