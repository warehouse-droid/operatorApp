// @ts-check
import { verifyOperatorNetSuitePostingRecord } from '../../src/operator-netsuite-posting-adapter.js';
import assert from 'node:assert/strict';

export const commandId = '537ee8b8-2967-4f52-a992-590bc4336837';
const inventory = [
  [1, 56, 4041, 5128086], [2, 192, 2058, 5128087],
  [3, 728, 609, 5128088], [4, 168, 609, 5128089], [19, 23, 1784, 5138328]
];

/** @param {any[]} rows @param {string} key @param {number} id */
function unique(rows, key, id) {
  const matches = rows.filter(row => Number(row[key]) === id);
  assert.equal(matches.length, 1, `Expected one ${key} ${id}`);
  return matches[0];
}

/** @param {any} source @param {any} receipt */
function verifyFreight(source, receipt) {
  const actual = unique(receipt.item.items, 'orderLine', 22);
  const expected = unique(source.lines, 'restLineId', 22);
  assert.equal(actual.itemType, 'OthCharge');
  assert.equal(expected.itemType, 'OthCharge');
  assert.equal(actual.itemSubtype, 'Purchase');
  assert.equal(actual.generateAccruals, false);
  assert.equal(Number(actual.item.id), 3025);
  assert.equal(expected.itemId, 3025);
  assert.equal(expected.lineId, 5138331);
  assert.equal(expected.description, 'Freight');
  assert.equal(actual.itemReceive, true);
  assert.equal(actual.quantity, 1);
  assert.equal(expected.quantity, 1);
  assert.equal(expected.receivedQuantity, 1);
  assert.equal(Number(actual.location.id), 1);
  assert.equal(expected.locationId, 1);
  assert.equal(actual.itemUnitPrice, 130.42);
  assert.equal(expected.rate, 130.42);
  assert.equal(actual.itemFxAmount, 130.42);
  assert.equal(expected.amount, 130.42);
  assert.equal(expected.unit, '');
  assert.equal(actual.unitsDisplay ?? '', '');
  return { orderLine: 22, sourceLineKey: '5138331', itemId: 3025, quantity: 1, amount: 130.42, location: 1 };
}

/** @param {any} command @param {any} source @param {any} step */
function verifyInventory(command, source, step) {
  const local = command.inputSnapshot.localPayload.item.items;
  assert.equal(step.payload.item.items.length, 5);
  assert.equal(local.length, 5);
  assert.equal(step.lineSnapshot.length, 5);
  return inventory.map(([orderLine, quantity, itemId, sourceLineKey]) => {
    const selected = unique(step.payload.item.items, 'orderLine', orderLine);
    const localLine = unique(local, 'orderLine', sourceLineKey);
    const snapshot = unique(step.lineSnapshot, 'orderLine', orderLine);
    const origin = unique(source.lines, 'restLineId', orderLine);
    for (const line of [selected, localLine]) {
      assert.equal(line.quantity, quantity);
      assert.equal(line.location, 1);
      assert.equal(line.itemReceive, true);
    }
    assert.equal(snapshot.quantity, quantity);
    assert.equal(snapshot.sourceLineKey, String(sourceLineKey));
    assert.equal(snapshot.salesUom, 'EACH');
    assert.equal(origin.lineId, sourceLineKey);
    assert.equal(origin.itemId, itemId);
    assert.equal(origin.itemType, 'InvtPart');
    assert.equal(origin.quantity, quantity);
    assert.equal(origin.receivedQuantity, quantity);
    assert.equal(origin.locationId, 1);
    assert.equal(origin.unit, 'EACH');
    return { ...snapshot, itemId };
  });
}

/** @param {any} input */
export function verifyReceiptRecovery(input) {
  const { command, receipt, source } = input;
  assert.equal(command.id, commandId);
  assert.equal(command.inputHash, '03ed74c080dce3f42accef077cede70125073fc46f410d12ae4e3c509f2f6eba');
  assert.equal(command.functionKey, 'receiving');
  assert.equal(command.transactionType, 'IR');
  assert.equal(command.canonicalLocationId, 1);
  assert.deepEqual(command.inputSnapshot.localOperation,
    { kind: 'receiving_receipt', orderId: '1059322', orderType: 'purchase_order' });
  assert.equal(command.steps.length, 1);
  const step = command.steps[0];
  assert.equal(step.sourceOrderKind, 'PO');
  assert.equal(step.sourceNetSuiteId, 1059322);
  assert.equal(step.sourceOrderRef, 'POB04042');
  assert.equal(step.transactionType, 'IR');
  assert.equal(step.externalId, `MBBS-OP-${commandId}-1`);
  assert.equal(Number(receipt.id), 1071915);
  assert.equal(receipt.tranId, 'IR15183');
  assert.equal(source.id, 1059322);
  assert.equal(source.tranid, 'POB04042');
  assert.equal(source.lines.length, 6);
  assert.equal(receipt.item.items.length, 6);
  const freight = verifyFreight(source, receipt);
  const snapshots = verifyInventory(command, source, step);
  // Enrich only the verification copy with independently read source evidence.
  // The durable payload and the operator's local inventory quantities stay intact.
  const verified = verifyOperatorNetSuitePostingRecord({ ...step,
    payload: { ...step.payload, item: { items: [...step.payload.item.items,
      { orderLine: 22, quantity: 1, location: 1, itemReceive: true }] } },
    lineSnapshot: [...snapshots, { orderLine: 22, itemId: 3025, location: 1 }]
  }, { ...receipt, transactionType: 'IR' });
  return { ...verified, freight };
}
