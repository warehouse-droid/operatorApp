import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { buildSpecialSalesOrderPayload, buildSpecialPurchaseOrderPayload } from '../../../src/special-stock-request-netsuite.js';

test('arbitrary multiline public Notes survive SO serialization without inherited emails', () => {
  const notes = fc.array(fc.oneof(fc.string({ maxLength: 80 }), fc.constant('条款 / 自提 🚚')), { maxLength: 20 })
    .map(lines => lines.join('\n'));
  fc.assert(fc.property(notes, fc.boolean(), (remarks, delivery) => {
    const draft = { customerId: 101, fulfillmentMethod: delivery ? 'mbt_delivery' : 'yard_pickup',
      deliveryAddress: 'TEST delivery address', deliveryInstructions: 'TEST unload carefully', remarks,
      materialLines: [{ itemId: 2055, quantity: 10, rate: 5 }] };
    const payload = JSON.parse(JSON.stringify(buildSpecialSalesOrderPayload({
      caseId: 42, draft, netsuiteLocationId: 10, deliveryMethodId: 2, pickupMethodId: 1
    })));
    assert.equal(payload.toBeEmailed, false);
    const instructions = 'Delivery Address: TEST delivery address\nContact:  \nDrop-off Loc: TEST unload carefully';
    const expected = [delivery ? instructions : '', remarks.trim()].filter(Boolean).join('\n\n');
    assert.equal(payload.custbody7, expected || undefined);
    assert.equal(draft.remarks, remarks);
  }), { numRuns: 200, seed: 13963 });
});

test('PO Notes preserve text and SO references without changing lines or emailing', () => {
  fc.assert(fc.property(fc.array(fc.string({ maxLength: 80 }), { maxLength: 15 }), fc.boolean(), (lines, linked) => {
    const remarks = `条款 🚚\n${lines.join('\n')}`;
    const payload = JSON.parse(JSON.stringify(buildSpecialPurchaseOrderPayload({
      caseId: 42, vendorId: 201, netsuiteLocationId: 10, remarks,
      salesOrderRef: linked ? 'SOTEST42' : '',
      lines: [{ itemId: 2055, quantity: 10, unitPurchaseCost: 2.5 }]
    })));
    assert.equal(payload.toBeEmailed, false);
    assert.equal(payload.custbody7, `${linked ? 'for SOTEST42\n\n' : ''}${remarks.trim()}`);
    assert.equal(payload.item.items[0].rate, 2.5);
    assert.equal(payload.item.items[0].quantity, 10);
  }), { numRuns: 200, seed: 13964 });
});
