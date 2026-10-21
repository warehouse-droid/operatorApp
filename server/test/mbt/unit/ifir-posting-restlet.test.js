import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { ifirFixture } from '../../support/ifir-restlet-fixture.mjs';
import { verifyPurchaseReceiptWithCharges } from '../../../src/operator-netsuite-receipt-charges.js';

for (const [kind, type, sourceType] of [['PO', 'IR', 'purchaseorder'], ['SO', 'IF', 'salesorder'],
  ['TO', 'IF', 'transferorder'], ['TO', 'IR', 'transferorder']]) {
  test(`saved ${kind} -> ${type} response passes the existing posting verifier`, () => {
    const f = ifirFixture();
    Object.assign(f.request, { sourceOrderKind: kind, transactionType: type });
    f.state.source.type = sourceType;
    const result = f.post();
    assert.equal(result.ok, true);
    assert.equal(result.contractVersion, 1);
    assert.equal(result.complete, true);
    assert.equal(result.outcome, 'created');
    assert.equal(result.record.tranId, type === 'IR' ? 'IR000123' : 'IF000456');
    assert.equal(result.id, 8001);
    assert.equal(result.record.id, result.id);
    assert.equal(result.record.externalId, f.request.payload.externalId);
    assert.equal(result.record.createdFromId, 901);
    assert.equal(result.record.transactionType, type);
    assert.equal(result.record.memo, 'PO901');
    assert.equal(result.record.custbody9, 'PO901');
    assert.equal(result.record.item.items[0].custcol_plt, 1);
    assert.equal(result.record.item.items.length, 1);
    assert.equal(result.record.item.items[0].quantity, 2);
    assert.equal(result.source.id, 901);
    assert.equal(result.source.lines[0].lineId, '7001');
    assert.equal(f.state.transforms.length, 1);
    assert.equal(f.state.saves.length, 1);
    assert.equal(f.state.saves[0].ignoreMandatoryFields, false);
    assert.ok(f.state.loads.some(input => input.id === 8001));
    assert.equal(verifyPurchaseReceiptWithCharges(f.step(), result.record, result.source).id, 8001);
  });
}

test('a saved quantity change is returned honestly and rejected by the existing verifier', () => {
  const f = ifirFixture({ afterSave: saved => { saved.items[0].quantity = 3; saved.header.tranid = 'IR-WORKFLOW'; } });
  const result = f.post();
  assert.equal(result.record.tranId, 'IR-WORKFLOW');
  assert.equal(result.record.item.items[0].quantity, 3);
  assert.throws(() => verifyPurchaseReceiptWithCharges(f.step(), result.record, result.source), /quantity/);
});

test('native purchase charges include independent source evidence, amounts and classifications', () => {
  const f = ifirFixture();
  f.state.source.items.push({ line: 3, lineuniquekey: 7003, item: 503, itemtype: 'OthCharge',
    quantity: 1, rate: 50, units: 'Each', unitstext: 'Each', location: 15 });
  const result = f.post();
  assert.equal(result.ok, true);
  const charge = result.record.item.items[1];
  assert.equal(charge.itemSubtype, 'Purchase');
  assert.equal(charge.generateAccruals, false);
  assert.equal(charge.itemUnitPrice, 50);
  assert.equal(charge.itemFxAmount, 50);
  assert.equal(charge.orderDoc.id, '901');
  const verified = verifyPurchaseReceiptWithCharges(f.step(), result.record, result.source);
  assert.deepEqual(verified.additionalPurchaseCharges, [{ orderLine: 3, sourceLineKey: '7003', itemId: 503,
    quantity: 1, rate: 50, amount: 50, location: 15, unit: 'EACH' }]);
  charge.itemFxAmount = 49;
  assert.throws(() => verifyPurchaseReceiptWithCharges(f.step(), result.record, result.source), /amount/);
});

test('same external ID returns the saved transaction without a second save', () => {
  const f = ifirFixture();
  const first = f.post(), second = f.post();
  assert.equal(second.ok, true);
  assert.equal(second.outcome, 'existing');
  assert.deepEqual(second.record, first.record);
  assert.equal(f.state.transforms.length, 1);
  assert.equal(f.state.saves.length, 1);
});

test('a duplicate external-ID save race recovers the persisted winner', () => {
  const f = ifirFixture({ race: true });
  const result = f.post();
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'existing');
  assert.equal(result.record.tranId, 'IR000123');
  assert.equal(f.state.saves.length, 1);
});

test('external ID bound to another source or type is a conflict without another save', () => {
  for (const fault of ['source', 'type']) {
    const f = ifirFixture();
    assert.equal(f.post().ok, true);
    const saved = f.state.stored.get(8001);
    if (fault === 'source') { saved.header.createdfrom = 902; }
    else { saved.type = 'itemfulfillment'; }
    const result = f.post();
    assert.equal(result.ok, false);
    assert.equal(result.code, 'IFIR_EXTERNAL_ID_CONFLICT');
    assert.equal(f.state.saves.length, 1);
  }
});

test('known saved ID survives readback failure and retry recovers without reposting', () => {
  const f = ifirFixture({ failRead: true });
  const failed = f.post();
  assert.equal(failed.ok, false);
  assert.equal(failed.id, 8001);
  assert.equal(failed.ambiguous, true);
  assert.equal(failed.requiresReconciliation, true);
  assert.equal(failed.stage, 'readback');
  f.state.failRead = false;
  assert.equal(f.post().record.tranId, 'IR000123');
  assert.equal(f.state.saves.length, 1);
});

test('save exceptions remain ambiguous and do not trigger another transform', () => {
  const f = ifirFixture({ failSave: true });
  const result = f.post();
  assert.equal(result.ok, false);
  assert.equal(result.ambiguous, true);
  assert.equal(result.postingNotAttempted, false);
  assert.equal(f.state.transforms.length, 1);
  assert.equal(f.state.saves.length, 1);
});

test('missing assigned number is incomplete with a known ID instead of a fabricated number', () => {
  const f = ifirFixture({ afterSave: saved => { saved.header.tranid = ''; } });
  const result = f.post();
  assert.equal(result.ok, false);
  assert.equal(result.complete, false);
  assert.equal(result.id, 8001);
  assert.equal(result.requiresReconciliation, true);
  assert.equal(result.code, 'IFIR_INCOMPLETE_READBACK');
});

test('health is read-only and deployment parameters alone control write activation', () => {
  const f = ifirFixture();
  assert.equal(f.health().contractVersion, 1);
  assert.equal(f.state.loads.length, 0);
  f.state.params.custscript_mbbs_ifir_writes_enabled = false;
  f.request.writesEnabled = true;
  assert.equal(f.post().ok, false);
  assert.equal(f.state.transforms.length, 0);
  delete f.request.writesEnabled;
  f.state.params.custscript_mbbs_ifir_writes_enabled = true;
  f.state.envType = 'PRODUCTION';
  assert.equal(f.post().code, 'IFIR_PRODUCTION_DISABLED');
  assert.equal(f.state.saves.length, 0);
  f.state.params.custscript_mbbs_ifir_allow_production = true;
  assert.equal(f.post().ok, true);
});

test('invalid inputs and unsupported keys fail before save', () => {
  const faults = [
    request => { request.sourceNetSuiteId = 0; },
    request => { request.sourceNetSuiteId = true; },
    request => { request.sourceOrderKind = 'CUSTOM'; },
    request => { request.transactionType = 'IF'; },
    request => { request.payload.externalId = ''; },
    request => { request.payload.ignoreMandatoryFields = true; },
    request => { request.payload.item.items[0].quantity = 0; },
    request => { request.payload.item.items[0].quantity = 'NaN'; },
    request => { request.payload.item.items[0].quantity = true; },
    request => { request.payload.item.items[0].location = -1; },
    request => { request.payload.item.items[0].orderLine = 999; },
    request => { request.payload.item.items[0].itemReceive = 'false'; },
    request => { request.payload.item.items[0].custcol_plt = -1; },
    request => { request.payload.item.items.push({ ...request.payload.item.items[0] }); },
    request => { request.payload.item.items[0].inventoryDetail = { inventoryAssignment: {} }; }
  ];
  for (const fault of faults) {
    const f = ifirFixture(); fault(f.request);
    const result = f.post();
    assert.equal(result.ok, false);
    assert.equal(result.postingNotAttempted, true);
    assert.equal(f.state.saves.length, 0);
  }
});

test('unrequested material is deselected, reordered lines use orderline identities', () => {
  const f = ifirFixture();
  f.request.payload.item.items.pop();
  f.state.source.items.reverse();
  const result = f.post();
  assert.equal(result.ok, true);
  assert.equal(result.record.item.items.length, 1);
  assert.equal(result.record.item.items[0].item.id, '501');
  assert.equal(result.record.item.items[0].orderLine, 1);
});

test('duplicate transformed line identities, kits and inventory-required lines fail before save', () => {
  for (const fault of ['duplicate', 'kit', 'inventory']) {
    const f = ifirFixture({ transformChange: data => {
      if (fault === 'duplicate') { data.items.push({ ...data.items[0] }); }
      if (fault === 'kit') { data.items[0].itemtype = 'Kit'; }
      if (fault === 'inventory') { data.items[0].inventorydetailreq = true; }
    } });
    assert.equal(f.post().ok, false);
    assert.equal(f.state.saves.length, 0);
  }
});

test('property: saved response preserves selected quantity and suppresses all omitted material', () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 10 }), fc.boolean(), (quantity, reverse) => {
    const f = ifirFixture();
    f.request.payload.item.items[0].quantity = quantity;
    f.request.payload.item.items.pop();
    if (reverse) { f.state.source.items.reverse(); }
    const result = f.post();
    assert.equal(result.ok, true);
    assert.equal(result.record.item.items.length, 1);
    assert.equal(result.record.item.items[0].quantity, quantity);
    assert.equal(result.record.item.items[0].item.id, '501');
    assert.equal(verifyPurchaseReceiptWithCharges(f.step(), result.record, result.source).id, 8001);
    assert.equal(f.post().id, 8001);
    assert.equal(f.state.saves.length, 1);
  }), { seed: 20261021, numRuns: 100 });
});

test('actual saved identity changes and missing evidence cannot produce complete success', () => {
  for (const field of ['createdfrom', 'externalid', 'type', 'units', 'itemreceive', 'quantity', 'item', 'orderline']) {
    const f = ifirFixture({ afterSave: saved => {
      if (field === 'createdfrom') { saved.header.createdfrom = 902; }
      else if (field === 'externalid') { saved.header.externalid = 'different'; }
      else if (field === 'type') { saved.type = 'itemfulfillment'; }
      else { saved.items[0][field] = ''; saved.items[0][`${field}text`] = ''; }
    } });
    const result = f.post();
    assert.equal(result.ok, false, field);
    assert.equal(result.id, 8001, field);
    assert.equal(result.requiresReconciliation, true, field);
  }
});

test('snapshot includes inventory assignments added by a save workflow and never resubmits them', () => {
  const f = ifirFixture({ afterSave: saved => {
    saved.items[0].inventorydetail = [{ receiptinventorynumber: 'LOT-123', binnumber: 7, inventorystatus: 1, quantity: 2 }];
  } });
  const result = f.post();
  assert.equal(result.ok, true);
  assert.deepEqual(result.record.item.items[0].inventoryDetail.inventoryAssignment.items, [{
    issueInventoryNumber: null, receiptInventoryNumber: 'LOT-123', binNumber: '7', toBinNumber: null,
    inventoryStatus: '1', toInventoryStatus: null, quantity: 2
  }]);
  assert.equal(f.state.saves.length, 1);
});

test('missing purchase charge rate or amount is never synthesized from the submitted request', () => {
  const f = ifirFixture({ afterSave: saved => { saved.items[1].itemfxamount = ''; } });
  f.state.source.items.push({ line: 3, lineuniquekey: 7003, item: 503, itemtype: 'OthCharge',
    quantity: 1, rate: 50, units: 'Each', unitstext: 'Each', location: 15 });
  const result = f.post();
  assert.equal(result.record.item.items[1].itemFxAmount, null);
  assert.throws(() => verifyPurchaseReceiptWithCharges(f.step(), result.record, result.source), /amount/);
});

test('IF inventory location, ship status and reference objects are preserved', () => {
  const f = ifirFixture();
  Object.assign(f.request, { sourceOrderKind: 'SO', transactionType: 'IF' });
  f.state.source.type = 'salesorder';
  f.request.payload.inventoryLocation = { id: '15' };
  f.request.payload.shipStatus = 'C';
  f.request.payload.item.items[0].location = { id: '15' };
  const result = f.post();
  assert.equal(result.ok, true);
  assert.equal(result.record.shipStatus, 'C');
  assert.equal(f.state.stored.get(8001).header.inventorylocation, 15);
  assert.equal(result.record.item.items[0].location.id, '15');
});

test('read limits and failed duplicate lookup stop posting without silent truncation', () => {
  for (const fault of ['request-size', 'record-size', 'duplicate-lookup', 'inventory-size', 'multiple-existing']) {
    const f = ifirFixture();
    if (fault === 'request-size') { f.request.payload.item.items = Array(1001).fill(f.request.payload.item.items[0]); }
    if (fault === 'record-size') { f.state.source.items = Array(1001).fill(f.state.source.items[0]); }
    if (fault === 'duplicate-lookup') { f.state.failSearch = true; }
    if (fault === 'inventory-size') {
      f.state.afterSave = saved => { saved.items[0].inventorydetail = Array(1001).fill({ quantity: 1 }); };
    }
    if (fault === 'multiple-existing') {
      assert.equal(f.post().ok, true);
      f.state.stored.set(8002, { ...f.state.stored.get(8001), id: 8002 });
    }
    const savesBefore = f.state.saves.length;
    const result = f.post();
    assert.equal(result.ok, false, fault);
    assert.equal(f.state.saves.length, savesBefore + (fault === 'inventory-size' ? 1 : 0), fault);
  }
});

test('malformed envelopes, unknown sublist keys and invalid IF headers never reach save', () => {
  const faults = [
    () => null, () => [], () => 'post',
    input => ({ ...input, payload: null }),
    input => ({ ...input, payload: { ...input.payload, memo: 12 } }),
    input => ({ ...input, payload: { ...input.payload, memo: 'x'.repeat(4001) } }),
    input => ({ ...input, payload: { ...input.payload, shipStatus: 'C' } }),
    input => ({ ...input, payload: { ...input.payload, inventoryLocation: 15 } }),
    input => ({ ...input, transactionType: 'IF', sourceOrderKind: 'SO', payload: { ...input.payload, shipStatus: 'X' } }),
    input => ({ ...input, payload: { ...input.payload, item: { items: [] } } }),
    input => ({ ...input, payload: { ...input.payload, item: { items: [{ orderLine: 1, itemReceive: false }] } } }),
    input => ({ ...input, payload: { ...input.payload, item: { items: [null] } } })
  ];
  for (const fault of faults) {
    const f = ifirFixture();
    const result = f.post(fault(f.request));
    assert.equal(result.ok, false);
    assert.equal(result.code, 'IFIR_INVALID_REQUEST');
    assert.equal(f.state.saves.length, 0);
  }
});

test('a changed request with the same key returns original saved evidence for verification', () => {
  const f = ifirFixture();
  assert.equal(f.post().ok, true);
  f.request.payload.item.items[0].quantity = 4;
  const replay = f.post();
  assert.equal(replay.record.item.items[0].quantity, 2);
  assert.throws(() => verifyPurchaseReceiptWithCharges(f.step(), replay.record, replay.source), /quantity/);
  assert.equal(f.state.saves.length, 1);
});
