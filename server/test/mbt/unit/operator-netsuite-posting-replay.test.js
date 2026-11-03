// @ts-check
import assert from 'node:assert/strict';
import test from 'node:test';
import { isOperatorNetSuitePostingReplay } from '../../../src/operator-netsuite-posting-domain.js';

const command = Object.freeze({
  requestId: 'd9071ed9-bc51-41e0-a565-2b4f77033d57', actorOperatorId: 'operator-1', functionKey: 'customer_pickup',
  canonicalLocationId: 1,
  inputSnapshot: { localOperation: { kind: 'customer_pickup_load', orderId: '1090414' },
    photoRefs: ['r2://pickup/a.jpg', 'r2://pickup/b.jpg'] }
});
const input = Object.freeze({ requestId: command.requestId, actorOperatorId: 'operator-1', functionKey: 'customer_pickup',
  orderId: '1090414', clientLocationId: 1, photoRefs: ['r2://pickup/b.jpg', 'r2://pickup/a.jpg'] });

test('an exact repeat of the accepted Load is a replay', () => {
  assert.equal(isOperatorNetSuitePostingReplay(command, input), true);
  assert.equal(isOperatorNetSuitePostingReplay(command, { ...input, requestId: input.requestId.toUpperCase() }), true);
  assert.equal(isOperatorNetSuitePostingReplay(command, { ...input, orderId: 1090414 }), true);
  assert.equal(isOperatorNetSuitePostingReplay(command, { ...input, clientLocationId: '3445' }), true);
  assert.equal(isOperatorNetSuitePostingReplay(command, { ...input, clientLocationId: undefined }), true);
  assert.equal(isOperatorNetSuitePostingReplay(command, { ...input, photoRefs: [...input.photoRefs, ' r2://pickup/a.jpg '] }), true);
});

test('any difference in the operator action is not a replay', () => {
  for (const change of [
    { requestId: '00000000-0000-4000-8000-000000000000' },
    { actorOperatorId: 'operator-2' },
    { functionKey: 'delivery_prep' },
    { orderId: '1090415' },
    { clientLocationId: 28 },
    { photoRefs: ['r2://pickup/a.jpg'] },
    { photoRefs: ['r2://pickup/a.jpg', 'r2://pickup/c.jpg'] },
    { photoRefs: [] },
    { photoRefs: ['data:image/jpeg;base64,not-a-photo'] }
  ]) {
    assert.equal(isOperatorNetSuitePostingReplay(command, { ...input, ...change }), false, JSON.stringify(change));
  }
  assert.equal(isOperatorNetSuitePostingReplay(null, input), false);
  assert.equal(isOperatorNetSuitePostingReplay({ ...command, inputSnapshot: {} }, input), false);
});
