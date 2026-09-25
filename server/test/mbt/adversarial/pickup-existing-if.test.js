import assert from 'node:assert/strict';
import test from 'node:test';
import { resolvePickupExistingFulfillment, pickupExistingFulfillmentTransactions } from '../../../src/operator-pickup-existing-if-domain.js';
import { createPickupExistingFulfillmentReader } from '../../../src/operator-pickup-existing-if-source.js';
import { buildOperatorNetSuitePostingDraft } from '../../../src/operator-netsuite-posting-domain.js';
import { pickupEvidence, pickupCommand } from '../../support/pickup-existing-if-fixture.mjs';

const rejected = { code: 'OPERATOR_PICKUP_EXISTING_IF_UNVERIFIED' };
test('existing IF adversarial: repeated confirmed lines cannot count one source line twice', () => {
  const evidence = pickupEvidence();
  evidence.selectedItems.push(structuredClone(evidence.selectedItems[0]));
  assert.throws(() => resolvePickupExistingFulfillment(evidence), rejected);
});

test('existing IF adversarial: corrupt completion commands cannot manufacture a successful IF result', () => {
  const changes = [command => { command.steps = [{}]; }, command => { command.functionKey = 'receiving'; },
    command => { command.transactionType = 'IR'; }, command => { command.inputSnapshot.lineReconciliation.lines = []; },
    command => { command.inputSnapshot.lineReconciliation.lines[0].postedQuantity = 1; },
    command => { command.inputSnapshot.lineReconciliation.lines[0].authoritative = false; },
    command => { command.inputSnapshot.lineReconciliation.lines[0].linkedTransactions = []; },
    command => { command.inputSnapshot.lineReconciliation.lines[0].linkedTransactions[0].id = -1; },
    command => { const line = structuredClone(command.inputSnapshot.lineReconciliation.lines[0]);
      line.linkedTransactions[0].ref = 'IF-CONFLICT'; command.inputSnapshot.lineReconciliation.lines.push(line); }];
  for (const change of changes) {
    const command = pickupCommand(); change(command);
    assert.throws(() => pickupExistingFulfillmentTransactions(command), rejected);
  }
});

function draftInput() {
  const source = resolvePickupExistingFulfillment(pickupEvidence());
  return { requestId: pickupCommand().requestId, actorOperatorId: 'test', functionKey: 'customer_pickup', transactionType: 'IF',
    localOrderKeys: ['customer_pickup:sales_order:963502'],
    localOperation: { kind: 'customer_pickup_load', orderType: 'sales_order', orderId: '963502' }, photoRefs: [],
    policy: { gateKey: 'operator_netsuite_customer_pickup_if_3445', revision: 1, effective: true,
      functionKey: 'customer_pickup', transactionType: 'IF', locationId: 1, yardCode: '3445' },
    targets: [{ ...source, selectedLines: [{ orderLine: 1, sourceLineKey: '4828215', quantity: 109, location: 1,
      localOrderKey: 'customer_pickup:sales_order:963502', localLineId: '344018' }] }] };
}
test('existing IF adversarial: mixed strategies and evidence with posting quantity cannot enter the immutable queue', () => {
  assert.equal(buildOperatorNetSuitePostingDraft(draftInput()).steps.length, 0);
  const changes = [input => { input.targets.push({ ...input.targets[0], postingStrategy: 'stored_order_line_v1' }); },
    input => { input.functionKey = input.policy.functionKey = 'delivery_prep'; },
    input => { input.targets[0].availableLines[0].remainingQuantity = 1; },
    input => { input.targets[0].availableLines[0].linkedTransactions = []; }];
  for (const change of changes) {
    const input = draftInput(); change(input);
    assert.throws(() => buildOperatorNetSuitePostingDraft(input), { code: 'OPERATOR_NETSUITE_POSTING_INPUT_INVALID' });
  }
});

test('existing IF adversarial: malformed source identity and unknown status never fall back to posting', async () => {
  const read = createPickupExistingFulfillmentReader({ fetchStatuses: async () => [{ id: 963502, tranid: 'SOA07444', status_text: '' }] });
  await assert.rejects(read({ ...pickupEvidence(), sourceNetSuiteId: -1 }), rejected);
  await assert.rejects(read(pickupEvidence()), rejected);
  const evidence = pickupEvidence(); evidence.links[0].transactionId = -1;
  const invalidLink = createPickupExistingFulfillmentReader({ fetchStatuses: async () => [{ id: 963502, tranid: 'SOA07444', status_text: 'Billed' }],
    fetchSourceItems: async () => evidence.sourceItems, fetchLinkedTransactions: async () => evidence.links });
  await assert.rejects(invalidLink(evidence), rejected);
});
