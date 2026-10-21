import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { query, closeDb } from '../../../src/db.js';
import { createOperator } from '../../../src/auth-repository.js';
import { buildOperatorNetSuitePostingDraft } from '../../../src/operator-netsuite-posting-domain.js';
import { createOperatorNetSuitePostingAdapter } from '../../../src/operator-netsuite-posting-netsuite-adapter.js';
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

async function fixture({ timeout = false, mismatch = false, unreadable = false, complete = false } = {}) {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  const id = 997591001 + sequence++;
  const actor = await createOperator({ username: `static-lines-${randomUUID()}`, password: randomUUID(),
    displayName: 'Static lines test', role: 'operator', operatorYardLocationIds: [1] });
  await query(`INSERT INTO sales_orders(netsuite_id,tranid,status,status_text,outbound_location_id,order_location_id,
    delivery_method_id,sales_order_type,netsuite_active)
    VALUES($1,$2,'D','Partially Fulfilled',1,28,1,'Pick-Up',true)`, [id, `STATIC-${id}`]);
  const rows = (await query(`INSERT INTO sales_order_lines(sales_order_id,line_id,netsuite_order_line,item_id,item_type,
    quantity,unit,location_id,packed_piece_qty,to_pcs,loaded_qty,netsuite_active,confirmed,confirmed_at)
    VALUES($1,$2,1,1260,'InvtPart',7,'PC',1,7,1,0,true,true,now()),
          ($1,$3,2,8794,'InvtPart',1,'PC',28,5,1,0,true,true,now()) RETURNING id`, [id, id + 5000000, id + 5000001])).rows;
  const key = `customer_pickup:sales_order:${id}`;
  const draft = buildOperatorNetSuitePostingDraft({ requestId: randomUUID(), actorOperatorId: actor.id,
    functionKey: 'customer_pickup', transactionType: 'IF', photoRefs: ['data:image/png;base64,dGVzdA=='],
    policy: { gateKey: 'operator_netsuite_customer_pickup_if_3445', revision: 1, effective: true,
      functionKey: 'customer_pickup', transactionType: 'IF', locationId: 1, yardCode: '3445' },
    localOrderKeys: [key], localOperation: { kind: 'customer_pickup_load', orderId: String(id), orderType: 'sales_order' },
    targets: [{ sourceOrderKind: 'SO', sourceNetSuiteId: id, sourceOrderRef: `STATIC-${id}`, postingStrategy: 'stored_order_line_v1',
      selectedLines: [{ orderLine: 1, quantity: 7, location: 1, salesUom: 'PC',
        sourceLineKey: String(id + 5000000), localOrderKey: key, localLineId: String(rows[0].id),
        packQuantities: { pallets: 0, layers: 0, sections: 0, pieces: 7 } }],
      availableLines: [{ orderLine: 1, location: 1, sourceLineKey: String(id + 5000000), salesUom: 'PC', orderedQuantity: 7, remainingQuantity: 7 },
        { orderLine: 2, location: 28, sourceLineKey: String(id + 5000001), salesUom: 'PC', orderedQuantity: 1, remainingQuantity: 1 }] }] });
  const accepted = await repo.createOrReplayOperatorNetSuitePostingCommand(draft);
  const source = { id, status: 'D', lines: [
    { orderLine: 1, sourceLineKey: String(id + 5000000), itemId: 1260, remainingQuantity: complete ? 0 : 7, location: 1 },
    { orderLine: 2, sourceLineKey: String(id + 5000001), itemId: 8794, remainingQuantity: 0, location: 28 }
  ] };
  const record = { id: 199959001 + sequence, tranId: `IF-STATIC-${id}`, externalId: draft.steps[0].externalId,
    transactionType: 'IF', createdFrom: { id: String(id) }, item: { items: [
      { orderLine: 1, itemReceive: true, quantity: mismatch ? 8 : 7, unitsDisplay: 'PC',
        item: { id: '1260' }, location: { id: '1' }, custcol_lyr: 7, custcol_pcs: 7 }
    ] } };
  const calls = { reads: 0, transforms: 0, finalizations: 0, payloads: [] };
  let exists = false;
  const adapter = createOperatorNetSuitePostingAdapter({
    findTransactionByExternalId: async () => exists ? { id: record.id, record } : null,
    fetchSalesOrderFulfillmentSource: async () => { calls.reads++; if (unreadable) { throw new Error('source read unavailable'); } return source; },
    transformSalesOrderToItemFulfillment: async (sourceId, payload) => {
      calls.transforms++; calls.payloads.push(structuredClone(payload)); assert.equal(sourceId, id);
      if (payload.item.items.some(item => item.orderLine === 2)) {
        throw Object.assign(new Error('Invalid static sublist operation'), { status: 400 });
      }
      exists = true; source.lines[0].remainingQuantity = 0;
      if (timeout) { throw Object.assign(new Error('Response lost after save'), { ambiguous: true }); }
      return { id: record.id };
    },
    fetchItemFulfillment: async () => structuredClone(record), fetchItemReceipt: async () => null
  });
  const processor = createOperatorNetSuitePostingProcessor({ repository, adapter, workerId: `static-lines-${randomUUID()}`,
    finalize: async command => { calls.finalizations++; return finalizeOperatorNetSuitePosting(command); } });
  const state = async () => (await query(`SELECT id,loaded_qty,packed_piece_qty,confirmed,confirmed_at
    FROM sales_order_lines WHERE sales_order_id=$1 ORDER BY netsuite_order_line`, [id])).rows;
  return { id, command: accepted.command, source, record, calls, processor, state };
}

test('S7 real durable pickup omits the completed other-yard row and finalizes exactly once', async () => {
  const f = await fixture(), before = await f.state();
  const original = structuredClone(f.command.steps[0].payload);
  const result = await f.processor.process(f.command.id);
  assert.equal(result.status, 'completed', result.lastError);
  await f.processor.process(f.command.id);
  assert.equal(f.calls.transforms, 1); assert.equal(f.calls.reads, 1); assert.equal(f.calls.finalizations, 1);
  assert.deepEqual(f.calls.payloads[0].item.items, [original.item.items[0]]);
  assert.equal(Number((await f.state())[0].loaded_qty), 7);
  assert.deepEqual((await f.state())[1], before[1]);
  assert.equal((await query('SELECT id FROM operator_load_records WHERE order_id=$1', [f.id])).rowCount, 1);
  const saved = await repo.getOperatorNetSuitePostingCommand(f.command.id);
  assert.deepEqual(saved.steps[0].payload, original);
  assert.equal(saved.steps[0].payloadHash, f.command.steps[0].payloadHash);
  assert.equal(saved.activeClaims.length, 0);
});

test('S6 a saved IF with a lost response recovers without reposting its now-completed source', async () => {
  const f = await fixture({ timeout: true }); const foreign = (await f.state())[1];
  const result = await f.processor.process(f.command.id);
  assert.equal(result.status, 'completed', result.lastError);
  await f.processor.process(f.command.id);
  assert.equal(f.calls.transforms, 1); assert.equal(f.calls.reads, 1); assert.equal(f.calls.finalizations, 1);
  assert.deepEqual((await f.state())[1], foreign);
});

test('S6 quantity mismatch stays held and resume verifies the existing IF with no new read or POST', async () => {
  const f = await fixture({ mismatch: true }); const before = await f.state();
  const held = await f.processor.process(f.command.id);
  assert.equal(held.status, 'attention'); assert.match(held.lastError, /quantity/u);
  assert.deepEqual(await f.state(), before); assert.equal(f.calls.finalizations, 0);
  f.record.item.items[0].quantity = 7;
  await repo.resumeOperatorNetSuitePostingCommand(f.command.id);
  const result = await f.processor.process(f.command.id);
  assert.equal(result.status, 'completed', result.lastError);
  assert.equal(f.calls.reads, 1); assert.equal(f.calls.transforms, 1); assert.equal(f.calls.finalizations, 1);
  assert.deepEqual((await f.state())[1], before[1]);
});

for (const failure of ['complete', 'unreadable']) {
  test(`S7 ${failure} source never posts, finalizes, or clears either yard's draft`, async () => {
    const f = await fixture({ [failure]: true }); const before = await f.state();
    const result = await f.processor.process(f.command.id);
    assert.equal(result.status, 'failed', result.lastError);
    assert.equal(f.calls.transforms, 0); assert.equal(f.calls.finalizations, 0);
    assert.deepEqual(await f.state(), before);
    assert.equal((await query('SELECT id FROM operator_load_records WHERE order_id=$1', [f.id])).rowCount, 0);
    const saved = await repo.getOperatorNetSuitePostingCommand(f.command.id);
    assert.equal(saved.steps[0].status, 'failed'); assert.equal(saved.activeClaims.length, 0);
  });
}
