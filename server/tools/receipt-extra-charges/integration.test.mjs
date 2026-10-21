import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { closeDb, query } from '../../src/db.js';
import { createOperator } from '../../src/auth-repository.js';
import { getReceivingOrder } from '../../src/receiving-repository.js';
import { buildOperatorNetSuitePostingDraft } from '../../src/operator-netsuite-posting-domain.js';
import { createOperatorNetSuitePostingProcessor } from '../../src/operator-netsuite-posting-service.js';
import { finalizeOperatorNetSuitePosting } from '../../src/operator-netsuite-posting-finalizer.js';
import { publicOperatorNetSuitePostingCommand } from '../../src/operator-netsuite-posting-controller.js';
import * as repo from '../../src/operator-netsuite-posting-repository.js';
import { adapterFixture } from './fixtures.mjs';

after(closeDb);
const repository = { get: repo.getOperatorNetSuitePostingCommand, claim: repo.claimOperatorNetSuitePostingCommand,
  renew: repo.renewOperatorNetSuitePostingLease, startAttempt: repo.startOperatorNetSuitePostingAttempt,
  success: repo.recordOperatorNetSuitePostingStepSuccess, failure: repo.recordOperatorNetSuitePostingStepFailure,
  attention: repo.markOperatorNetSuitePostingCommandAttention, fail: repo.failOperatorNetSuitePostingCommand,
  complete: repo.completeOperatorNetSuitePostingCommand };
let sequence = 0;

async function fixture() {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  assert.equal(process.env.NETSUITE_DIRECT_ACCESS_ENABLED, 'false');
  const id = 996990000 + ++sequence, key = id + 100000;
  const actor = await createOperator({ username: `charge-${randomUUID()}`, displayName: 'Partial receipt test',
    password: 'isolated-charge-test', role: 'operator', yardLocationIds: [1] });
  await query(`INSERT INTO purchase_orders(netsuite_id,tranid,status,status_text,destination_location_id,receipt_status,netsuite_active)
    VALUES($1,$2,'B','Pending Receipt',1,'not_received',true)`, [id, `PO-CHARGE-${id}`]);
  const line = (await query(`INSERT INTO purchase_order_lines(purchase_order_id,line_id,netsuite_order_line,item_id,item_type,
    quantity,unit,location_id,netsuite_active,netsuite_received_qty,netsuite_received_baseline_qty,confirmed_at,received_sales_qty)
    VALUES($1,$2,1,4041,'InvtPart',10,'EACH',1,true,0,0,now(),6) RETURNING id`, [id, key])).rows[0];
  return { id, key, lineId: String(line.id), actor };
}

async function commandFor(f, quantity, { freight = true, sourceError = false, finalizerError = false } = {}) {
  const localOrderKey = `receiving:purchase_order:${f.id}`;
  const draft = buildOperatorNetSuitePostingDraft({ requestId: randomUUID(), actorOperatorId: f.actor.id,
    functionKey: 'receiving', transactionType: 'IR', photoRefs: ['r2://charge-test/one.jpg', 'r2://charge-test/two.jpg'],
    policy: { gateKey: 'operator_netsuite_receiving_ir_3445', revision: 1, effective: true,
      functionKey: 'receiving', transactionType: 'IR', locationId: 1, yardCode: '3445' },
    localOrderKeys: [localOrderKey], localOperation: { kind: 'receiving_receipt', orderId: String(f.id), orderType: 'purchase_order' },
    localPayload: { item: { items: [{ orderLine: f.key, quantity, location: 1, itemReceive: true }] } },
    targets: [{ sourceOrderKind: 'PO', sourceNetSuiteId: f.id, sourceOrderRef: `PO-CHARGE-${f.id}`, postingStrategy: 'stored_order_line_v1',
      selectedLines: [{ orderLine: 1, quantity, location: 1, itemId: 4041, salesUom: 'EACH', sourceLineKey: String(f.key),
        localOrderKey, localLineId: f.lineId }],
      availableLines: [{ orderLine: 1, location: 1, sourceLineKey: String(f.key), salesUom: 'EACH',
        orderedQuantity: 10, completedQuantity: 0, remainingQuantity: 10 }] }] });
  const { command } = await repo.createOrReplayOperatorNetSuitePostingCommand(draft);
  const receiptId = f.id + 10000 + (quantity === 4 ? 1 : 0);
  const record = { id: String(receiptId), tranId: `IR-CHARGE-${receiptId}`, createdFrom: { id: String(f.id) },
    externalId: command.steps[0].externalId, item: { items: [{ orderLine: 1, itemReceive: true, quantity,
      item: { id: '4041' }, unitsDisplay: 'EACH', location: { id: '1' } }] } };
  if (freight) {
    record.item.items.push({ orderLine: 22, itemReceive: true, quantity: 1, item: { id: '3025' }, unitsDisplay: '',
      location: { id: '1' }, itemType: 'OthCharge', itemSubtype: 'Purchase', generateAccruals: false,
      orderDoc: { id: String(f.id) }, itemUnitPrice: 130.42, itemFxAmount: 130.42 });
  }
  const source = { id: f.id, lines: [{ restLineId: 22, lineId: f.key + 1, itemId: 3025,
    itemType: 'OthCharge', quantity: 1, receivedQuantity: 0, unit: '', locationId: 1, rate: 130.42, amount: 130.42 }] };
  const boundary = adapterFixture({ receipt: record, source }, { sourceError });
  const processor = createOperatorNetSuitePostingProcessor({ repository, adapter: boundary.adapter,
    workerId: `charge-test-${randomUUID()}`, finalize: async saved => {
      const result = await finalizeOperatorNetSuitePosting(saved);
      if (finalizerError) { throw new Error('injected finalization failure'); }
      return result;
    } });
  return { command, record, source, processor, calls: boundary.calls };
}

test('a partial receipt plus freight saves the IR and leaves the exact outstanding balance', async () => {
  const f = await fixture(), c = await commandFor(f, 6);
  const before = JSON.stringify(c.command.inputSnapshot);
  const result = await c.processor.process(c.command.id);
  assert.equal(result.status, 'completed', result.lastError);
  assert.equal(result.result.localFinalization.receiptStatus, 'partial_received');
  assert.equal(publicOperatorNetSuitePostingCommand(result).result.localFinalization.itemReceiptTranid, c.record.tranId);
  assert.equal(result.steps[0].response.additionalPurchaseCharges[0].amount, 130.42);
  assert.equal(JSON.stringify(result.inputSnapshot), before);
  assert.equal(result.steps[0].payload.item.items.length, 1);
  const remaining = await getReceivingOrder(f.id);
  assert.equal(Number(remaining.lines[0].quantity), 4);
  const receipt = (await query('SELECT * FROM receiving_receipt_records WHERE order_id=$1', [f.id])).rows[0];
  assert.equal(receipt.item_receipt_tranid, c.record.tranId);
  assert.equal(receipt.payload.item.items.length, 1);
  await c.processor.process(c.command.id);
  assert.equal(c.calls.transform, 1);
  assert.equal((await query('SELECT id FROM receiving_receipt_records WHERE order_id=$1', [f.id])).rowCount, 1);
});

test('a follow-up receives only the remaining quantity and preserves the first IR', async () => {
  const f = await fixture(), first = await commandFor(f, 6);
  assert.equal((await first.processor.process(first.command.id)).status, 'completed');
  await query('UPDATE purchase_order_lines SET received_sales_qty=4,confirmed_at=now() WHERE id=$1', [f.lineId]);
  const second = await commandFor(f, 4, { freight: false });
  const result = await second.processor.process(second.command.id);
  assert.equal(result.result.localFinalization.receiptStatus, 'received');
  const receipts = (await query('SELECT item_receipt_tranid,receipt_status FROM receiving_receipt_records WHERE order_id=$1 ORDER BY id', [f.id])).rows;
  assert.deepEqual(receipts, [{ item_receipt_tranid: first.record.tranId, receipt_status: 'partial_received' },
    { item_receipt_tranid: second.record.tranId, receipt_status: 'received' }]);
  assert.equal((await getReceivingOrder(f.id)).lines.length, 0);
  assert.equal(first.calls.transform, 1); assert.equal(second.calls.transform, 1);
});

test('a held existing receipt recovers with no transform and only one local receipt under concurrent workers', async () => {
  const f = await fixture(), c = await commandFor(f, 6);
  const claimed = await repo.claimOperatorNetSuitePostingCommand({ commandId: c.command.id, workerId: 'old-verifier', leaseSeconds: 180 });
  const step = claimed.steps[0];
  const attempt = await repo.startOperatorNetSuitePostingAttempt({ commandId: claimed.id, stepId: step.id, leaseToken: claimed.leaseToken });
  const error = new Error('unexpected positive line');
  await repo.recordOperatorNetSuitePostingStepFailure({ commandId: claimed.id, stepId: step.id, leaseToken: claimed.leaseToken,
    attemptNumber: attempt.attemptNumber, uncertain: true, error });
  await repo.markOperatorNetSuitePostingCommandAttention({ commandId: claimed.id, leaseToken: claimed.leaseToken, error });
  await repo.resumeOperatorNetSuitePostingCommand(claimed.id);
  await Promise.all(Array.from({ length: 4 }, () => c.processor.process(claimed.id)));
  const saved = await repo.getOperatorNetSuitePostingCommand(claimed.id);
  assert.equal(saved.status, 'completed', saved.lastError);
  assert.equal(saved.result.localFinalization.itemReceiptTranid, c.record.tranId);
  assert.equal(c.calls.transform, 0);
  assert.equal((await query('SELECT id FROM receiving_receipt_records WHERE order_id=$1', [f.id])).rowCount, 1);
});

test('source read failure keeps the IR visible for review while preserving the unreceived balance', async () => {
  const f = await fixture(), c = await commandFor(f, 6, { sourceError: true });
  const result = await c.processor.process(c.command.id);
  assert.equal(result.status, 'attention');
  const job = publicOperatorNetSuitePostingCommand(result);
  assert.equal(job.steps[0].observedTransaction.tranId, c.record.tranId);
  assert.equal((await query('SELECT id FROM receiving_receipt_records WHERE order_id=$1', [f.id])).rowCount, 0);
  assert.equal(Number((await getReceivingOrder(f.id)).lines[0].quantity), 10);
  assert.equal(c.calls.transform, 1);
});

test('unexpected inventory is held with its existing IR number and no local receipt', async () => {
  const f = await fixture(), c = await commandFor(f, 6);
  c.record.item.items[1].itemType = 'InvtPart';
  const result = await c.processor.process(c.command.id);
  assert.equal(result.status, 'attention');
  assert.equal(result.steps[0].response.observedTransaction.tranId, c.record.tranId);
  assert.equal((await query('SELECT id FROM receiving_receipt_records WHERE order_id=$1', [f.id])).rowCount, 0);
});

test('a failed finalizer rolls back local history and retains the verified receipt for retry', async () => {
  const f = await fixture(), c = await commandFor(f, 6, { finalizerError: true });
  const result = await c.processor.process(c.command.id);
  assert.equal(result.status, 'attention');
  assert.equal(result.steps[0].status, 'posted');
  assert.equal(result.steps[0].netSuiteTransactionRef, c.record.tranId);
  assert.equal((await query('SELECT id FROM receiving_receipt_records WHERE order_id=$1', [f.id])).rowCount, 0);
  assert.equal(Number((await getReceivingOrder(f.id)).lines[0].quantity), 10);
});
