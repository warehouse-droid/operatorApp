import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { resolvePickupExistingFulfillment, pickupExistingFulfillmentTransactions } from '../../../src/operator-pickup-existing-if-domain.js';
import { pickupEvidence, pickupCommand } from '../../support/pickup-existing-if-fixture.mjs';

test('existing IF property: every valid partial pickup retains exact evidence; duplicate links never increase completion', () => {
  fc.assert(fc.property(fc.integer({ min: 2, max: 10000 }), fc.nat(10000), fc.nat(10000), (quantity, a, b) => {
    const loaded = a % quantity, confirmed = 1 + b % (quantity - loaded), first = 1 + a % (quantity - 1);
    const e = pickupEvidence({ quantity, loaded, confirmed, parts: [first, quantity - first] });
    e.links.push(...structuredClone(e.links));
    const source = resolvePickupExistingFulfillment(e);
    assert.equal(source.availableLines.length, 1);
    assert.equal(source.availableLines[0].completedQuantity, quantity);
    assert.equal(source.availableLines[0].remainingQuantity, 0);
    assert.equal(source.availableLines[0].linkedTransactions.reduce((sum, row) => sum + row.quantity, 0), quantity);
    assert.equal(source.availableLines[0].linkedTransactions.length, 2);
  }), { seed: 220926, numRuns: 150 });
});

test('existing IF property: changing any verified identity or quantity fails without a source result', () => {
  const fields = ['source', 'item', 'location', 'unit', 'key', 'reference', 'orderLine', 'quantity', 'status', 'void'];
  fc.assert(fc.property(fc.constantFrom(...fields), fc.integer({ min: 1, max: 10000 }), (field, delta) => {
    const e = pickupEvidence();
    if (field === 'source') { e.records[0].createdFrom.id = String(963502 + delta); }
    if (field === 'item') { e.records[0].item.items[0].item.id = String(2875 + delta); }
    if (field === 'location') { e.records[0].item.items[0].location.id = String(1 + delta); }
    if (field === 'unit') { e.records[0].item.items[0].units = String(494 + delta); }
    if (field === 'key') { e.sourceItems[0].lineUniqueKey = String(4828215 + delta); }
    if (field === 'reference') { e.records[0].tranId = `IF-WRONG-${delta}`; }
    if (field === 'orderLine') { e.records[0].item.items[0].orderLine = 1 + delta; }
    if (field === 'quantity') { e.links[0].quantity = 109 + delta; e.records[0].item.items[0].quantity = 109 + delta; }
    if (field === 'status') { e.links[0].statusText = 'Item Fulfillment : Picked'; }
    if (field === 'void') { e.records[0].voided = true; }
    assert.throws(() => resolvePickupExistingFulfillment(e), { code: 'OPERATOR_PICKUP_EXISTING_IF_UNVERIFIED' });
  }), { seed: 220927, numRuns: 150 });
});

test('existing IF property: distinct IF numbers remain visible while repeated line evidence is deduplicated', () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 20 }), count => {
    const command = pickupCommand(), line = command.inputSnapshot.lineReconciliation.lines[0];
    line.linkedTransactions = Array.from({ length: count }, (_, index) => ({ id: 977092 + index, ref: `IF${151113 + index}`, type: 'IF', quantity: 109 / count }));
    command.inputSnapshot.lineReconciliation.lines.push(structuredClone(line));
    const transactions = pickupExistingFulfillmentTransactions(command);
    assert.equal(transactions.length, count);
    assert.ok(transactions.every(t => t.reused && t.sourceNetSuiteId === 963502));
    assert.deepEqual(transactions.map(t => t.transactionRef), line.linkedTransactions.map(t => t.ref));
  }), { seed: 220928, numRuns: 50 });
});
