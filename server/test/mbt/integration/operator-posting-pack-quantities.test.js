import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { query, closeDb } from '../../../src/db.js';
import { createOperator } from '../../../src/auth-repository.js';
import { buildOperatorNetSuitePostingDraft } from '../../../src/operator-netsuite-posting-domain.js';
import { verifyOperatorNetSuitePostingRecord } from '../../../src/operator-netsuite-posting-adapter.js';
import { createOperatorNetSuitePostingProcessor } from '../../../src/operator-netsuite-posting-service.js';
import { finalizeOperatorNetSuitePosting } from '../../../src/operator-netsuite-posting-finalizer.js';
import * as repo from '../../../src/operator-netsuite-posting-repository.js';

after(closeDb);
const repository = { get: repo.getOperatorNetSuitePostingCommand, claim: repo.claimOperatorNetSuitePostingCommand,
  renew: repo.renewOperatorNetSuitePostingLease, startAttempt: repo.startOperatorNetSuitePostingAttempt,
  success: repo.recordOperatorNetSuitePostingStepSuccess, failure: repo.recordOperatorNetSuitePostingStepFailure,
  attention: repo.markOperatorNetSuitePostingCommandAttention, fail: repo.failOperatorNetSuitePostingCommand,
  complete: repo.completeOperatorNetSuitePostingCommand };
let sequence = 0;

async function fixture(actual = 31.38) {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  const id = 997550001 + sequence++;
  const actor = await createOperator({ username: `packs-${randomUUID()}`, displayName: 'Pack metadata test',
    password: 'test-only-packs', role: 'operator', roles: ['operator'], yardLocationIds: [28] });
  await query(`INSERT INTO sales_orders(netsuite_id,tranid,status,status_text,outbound_location_id,delivery_method_id,sales_order_type,netsuite_active)
    VALUES($1,$2,'B','Pending Fulfillment',28,1,'Pick-Up',true)`, [id, `PACKS-${id}`]);
  const row = (await query(`INSERT INTO sales_order_lines(sales_order_id,line_id,netsuite_order_line,item_id,item_type,
    quantity,unit,location_id,layer_qty,packed_layer_qty,to_lyr,loaded_qty,netsuite_active,confirmed,confirmed_at)
    VALUES($1,$2,1,4756,'InvtPart',73.22,'SQFT',28,7,3,10.46,0,true,true,now()) RETURNING id`, [id, id + 5000000])).rows[0];
  const key = `customer_pickup:sales_order:${id}`;
  const draft = buildOperatorNetSuitePostingDraft({ requestId: randomUUID(), actorOperatorId: actor.id,
    functionKey: 'customer_pickup', transactionType: 'IF', photoRefs: ['r2://packs-test/load.jpg', 'r2://packs-test/pickup.jpg'],
    policy: { gateKey: 'operator_netsuite_customer_pickup_if_2967', revision: 1, effective: true,
      functionKey: 'customer_pickup', transactionType: 'IF', locationId: 28, yardCode: '2967' },
    localOrderKeys: [key], localOperation: { kind: 'customer_pickup_load', orderId: String(id), orderType: 'sales_order' },
    targets: [{ sourceOrderKind: 'SO', sourceNetSuiteId: id, sourceOrderRef: `PACKS-${id}`, postingStrategy: 'stored_order_line_v1',
      selectedLines: [{ orderLine: 1, quantity: 31.38, location: 28, itemId: 4756, salesUom: 'SQFT',
        sourceLineKey: String(id + 5000000), localOrderKey: key, localLineId: String(row.id),
        packQuantities: { pallets: 0, layers: 3, sections: 0, pieces: 0 } }],
      availableLines: [{ orderLine: 1, location: 28, sourceLineKey: String(id + 5000000), salesUom: 'SQFT',
        orderedQuantity: 73.22, remainingQuantity: 73.22, completedQuantity: 0 }] }] });
  const accepted = await repo.createOrReplayOperatorNetSuitePostingCommand(draft);
  const record = { id: 19990001 + sequence, tranId: `IF-PACKS-${id}`, externalId: draft.steps[0].externalId,
    transactionType: 'IF', createdFrom: { id: String(id) }, item: { items: [{ orderLine: 1, itemReceive: true,
      quantity: actual, unitsDisplay: 'SQFT', item: { id: '4756' }, location: { id: '28' }, custcol_lyr: 7 }] } };
  const calls = { transforms: 0, finalized: 0 };
  const worker = createOperatorNetSuitePostingProcessor({ repository, workerId: `packs-${randomUUID()}`,
    adapter: { findByExternalId: async () => structuredClone(record), fetchById: async () => structuredClone(record),
      verify: verifyOperatorNetSuitePostingRecord,
      transform: async step => {
        calls.transforms++;
        assert.equal(step.payload.item.items[0].quantity, 31.38);
        assert.equal(step.payload.item.items[0].custcol_lyr, 3);
        return { id: record.id };
      } }, finalize: async command => { calls.finalized++; return finalizeOperatorNetSuitePosting(command); } });
  return { id, lineId: row.id, command: accepted.command, record, worker, calls };
}

test('E7 durable pickup writes 3 LYR but an inherited 7 LYR readback never blocks or duplicates it', async () => {
  const f = await fixture();
  const original = JSON.stringify(f.command.inputSnapshot);
  const result = await f.worker.process(f.command.id);
  assert.equal(result.status, 'completed', result.lastError);
  await f.worker.process(f.command.id);
  assert.equal(f.calls.transforms, 1);
  assert.equal(f.calls.finalized, 1);
  const row = (await query('SELECT loaded_qty FROM sales_order_lines WHERE id=$1', [f.lineId])).rows[0];
  assert.equal(Number(row.loaded_qty), 31.38);
  assert.equal((await query('SELECT id FROM operator_load_records WHERE order_id=$1', [f.id])).rowCount, 1);
  const saved = await repo.getOperatorNetSuitePostingCommand(f.command.id);
  assert.equal(saved.steps[0].payload.item.items[0].custcol_lyr, 3);
  assert.equal(JSON.stringify(saved.inputSnapshot), original);
  assert.equal(saved.activeClaims.length, 0);
});

test('E7 accounting mismatch stays held then recovers the same IF with zero further transforms', async () => {
  const f = await fixture(73.22);
  const held = await f.worker.process(f.command.id);
  assert.equal(held.status, 'attention');
  assert.match(held.lastError, /quantity/u);
  assert.equal(f.calls.transforms, 1);
  assert.equal(f.calls.finalized, 0);
  assert.equal((await query('SELECT id FROM operator_load_records WHERE order_id=$1', [f.id])).rowCount, 0);
  assert.equal(Number((await query('SELECT loaded_qty FROM sales_order_lines WHERE id=$1', [f.lineId])).rows[0].loaded_qty), 0);
  f.record.item.items[0].quantity = 31.38;
  await repo.resumeOperatorNetSuitePostingCommand(f.command.id);
  const recovered = await f.worker.process(f.command.id);
  assert.equal(recovered.status, 'completed', recovered.lastError);
  assert.equal(f.calls.transforms, 1);
  assert.equal(f.calls.finalized, 1);
  assert.equal(recovered.steps[0].netSuiteTransactionId, f.record.id);
  assert.equal((await query('SELECT id FROM operator_load_records WHERE order_id=$1', [f.id])).rowCount, 1);
});
