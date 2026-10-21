import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyExistingTransferPosting } from '../../../tools/operator-to-yard-flow-reconciliation-proof.mjs';

function fixture() {
  return {
    job: { transaction_type: 'IF', snapshot: { lines: [{ lineId: '5', sourceLineKey: '100', itemId: 2299, quantity: 5 }] } },
    source: { id: 42, tranid: 'TO42', lines: [{ stage: 'outbound', sourceLineKey: '100', sourceLineAliases: ['100', '101'], identityStatus: 'exact', itemId: 2299, unit: 'PC', netsuite_order_line: 1,
      raw: { identityStatus: 'exact', physicalRows: [
        { id: '42', item_id: '2299', signed_quantity: -5, source_line_key: '100', order_line_number: '1', do_not_print_line: 'F' },
        { id: '42', item_id: '2299', signed_quantity: -5, source_line_key: '101', order_line_number: '2', do_not_print_line: 'T' }
      ] } }] },
    localLines: [{ id: '5', line_id: '100', item_id: '2299', unit: 'PC' }],
    records: [{ type: 'ItemShip', sourceId: 42, id: 900, record: { id: '900', tranId: 'IF900', createdFrom: { id: '42' }, shipStatus: { id: 'C' }, externalId: '', item: { items: [{ orderLine: 2, item: { id: '2299' }, quantity: 5, unitsDisplay: 'PC', location: { id: '1' } }] } } }],
    linked: [{ sourceOrderId: 42, transactionId: 900, transactionType: 'ItemShip', status: 'C', itemId: 2299, quantity: 5, unit: 'PC', sourceOrderLineAliases: ['2'] }]
  };
}
test('verified shipped IF proves the exact frozen physical item, quantity and source', () => {
  const f = fixture(), result = verifyExistingTransferPosting(f);
  assert.equal(result.transactions[0].transactionId, 900);
  assert.equal(result.transactions[0].transactionType, 'IF');
  assert.equal(result.reconciledExisting, true);
});
test('a different source cannot be attached even with matching item and quantity', () => {
  const f = fixture(); f.records[0].record.createdFrom.id = '43';
  assert.throws(() => verifyExistingTransferPosting(f), /different source|No uniquely verified/u);
});
test('base-unit quantities and mismatched local sales units cannot pass verification', () => {
  const f = fixture(); f.records[0].record.item.items[0].unitsDisplay = 'EACH';
  assert.throws(() => verifyExistingTransferPosting(f), /sales unit|No uniquely verified/u);
});
test('a picked fulfillment cannot be treated as shipped', () => {
  const f = fixture(); f.records[0].record.shipStatus.id = 'A';
  assert.throws(() => verifyExistingTransferPosting(f), /shipped|No uniquely verified/u);
});
test('two otherwise valid fulfillment records are ambiguous', () => {
  const f = fixture(); f.records.push({ ...structuredClone(f.records[0]), id: 901 }); f.records[1].record.id = '901';
  f.linked.push({ ...structuredClone(f.linked[0]), transactionId: 901 });
  assert.throws(() => verifyExistingTransferPosting(f), /uniquely verified/u);
});
test('unexpected positive lines and wrong quantities cannot be attached', () => {
  for (const extra of [false, true]) {
    const f = fixture();
    if (extra) {f.records[0].record.item.items.push({ orderLine: 2, item: { id: '2300' }, quantity: 1, unitsDisplay: 'PC' });}
    else {f.records[0].record.item.items[0].quantity = 4;}
    assert.throws(() => verifyExistingTransferPosting(f), /No uniquely verified/u);
  }
});
test('ambiguous source identities and invalid saved quantities fail closed', () => {
  for (const invalid of [false, true]) {
    const f = fixture();
    if (invalid) {f.job.snapshot.lines[0].quantity = 0;}
    else {f.source.lines[0].identityStatus = 'ambiguous';}
    assert.throws(() => verifyExistingTransferPosting(f), /saved|identity/u);
  }
});
test('an immutable native command must keep its own recovery contract', () => {
  const f = fixture(); f.job.command_id = 'native-command';
  assert.throws(() => verifyExistingTransferPosting(f), /native command/u);
});
test('actual accounting leg and SuiteQL shipped evidence are required when REST omits shipStatus', () => {
  const f = fixture(); delete f.records[0].record.shipStatus;
  assert.equal(verifyExistingTransferPosting(f).transactions[0].transactionId, 900);
  f.linked[0].status = 'A';
  assert.throws(() => verifyExistingTransferPosting(f), /shipped|No uniquely verified/u);
});
test('a visible source sublist line cannot replace the observed accounting posting leg', () => {
  const f = fixture(); f.records[0].record.item.items[0].orderLine = 1;
  assert.throws(() => verifyExistingTransferPosting(f), /No uniquely verified/u);
});
test('a changed local sales unit cannot inherit an old NetSuite fulfillment', () => {
  const f = fixture(); f.localLines[0].unit = 'EACH';
  assert.throws(() => verifyExistingTransferPosting(f), /saved posting sales unit/u);
});
