import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeOperatorNetSuiteLocationId } from '../../../src/operator-netsuite-posting-policy.js';
import { buildReturnCreditMemoPayload, verifyReturnCreditMemoSnapshot } from '../../../src/return-credit-memo.js';
import { buildReturnNotification } from '../../../src/return-notification-domain.js';

for (const [yard, locationId, reference] of [['3445', 1, 'CMB004321'], ['2967', 28, 'CMA001234'], ['150', 26, 'CMM009876']]) {
  test(`${yard}: post with the receiving CM location and retain the full NetSuite ${reference} number`, () => {
    const intent = { receivingLocationId: normalizeOperatorNetSuiteLocationId(yard), customerId: 77,
      externalId: 'TEST-PALLET-CM', submittedDate: '2026-10-26', memo: 'Pallet return',
      lines: [{ kind: 'pallet', itemId: 88, returnedSalesQuantity: 2, rate: 40, reasonId: 10 }] };
    const payload = buildReturnCreditMemoPayload(intent);
    assert.equal(payload.location.id, String(locationId));
    assert.equal(payload.item.items[0].location.id, String(locationId));
    assert.equal(Object.hasOwn(payload, 'tranId'), false, 'NetSuite generates the document number');
    const saved = verifyReturnCreditMemoSnapshot(intent, { ...payload, id: 101, tranId: reference });
    const message = buildReturnNotification([{ recordType: 'pallet', status: 'accepted', netSuiteSyncStatus: 'succeeded',
      netSuiteStage: 'credit_memo', netSuiteTransactionId: saved.id, netSuiteTransactionRef: saved.tranId }]);
    assert.equal(message.subject, `MBBS return confirmation - ${reference}`);
    assert.equal(message.text, `MBBS: Your pallet return has been posted to NetSuite. Credit Memo: ${reference}. Thank you.`);
  });
}
