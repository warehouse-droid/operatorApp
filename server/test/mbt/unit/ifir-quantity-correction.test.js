import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { ifirFixture } from '../../support/ifir-restlet-fixture.mjs';

function fixture(kind = 'SO', type = 'IF', requested = 70.6200001, remaining = 70.62, unit = 'SQFT') {
  const f = ifirFixture();
  Object.assign(f.request, { sourceOrderKind: kind, transactionType: type, quantityPolicy: 'sqft_remaining_v1' });
  f.state.source.type = { SO: 'salesorder', PO: 'purchaseorder', TO: 'transferorder' }[kind];
  Object.assign(f.state.source.items[0], { quantity: 100, units: unit, unitstext: unit });
  f.state.transformChange = data => { data.items[0].quantityremaining = remaining; data.items[0].quantity = remaining; };
  f.request.payload.item.items[0].quantity = requested;
  return f;
}

for (const [kind, type] of [['SO','IF'], ['PO','IR'], ['TO','IF'], ['TO','IR']]) {
  test(`quantity policy ${kind}:${type} corrects 70.6200001 and returns actual saved evidence`, () => {
    const f = fixture(kind, type), result = f.post();
    assert.equal(result.ok, true);
    assert.equal(f.state.saves.length, 1);
    assert.equal(result.record.item.items[0].quantity, 70.62);
    assert.equal(result.tranId, type === 'IF' ? 'IF000456' : 'IR000123');
    assert.equal(result.quantityPolicy, 'sqft_remaining_v1');
    assert.deepEqual(result.quantityAdjustments, [{ orderLine: 1, requestedQuantity: 70.6200001,
      netSuiteQuantity: 70.62, salesUom: 'SQFT' }]);
    assert.equal(result.record.item.items[0].custcol_plt, 1);
    const again = f.post();
    assert.equal(again.outcome, 'existing');
    assert.equal(again.record.item.items[0].quantity, 70.62);
    assert.deepEqual(again.quantityAdjustments, result.quantityAdjustments);
    assert.equal(f.state.saves.length, 1);
  });
}

test('quantity policy preserves partial quantities and accepts a small difference in either direction', () => {
  for (const [requested, remaining, expected] of [[20.1234,70.62,20.1234], [70.6199,70.62,70.62],
    [70.629999,70.62,70.62], [70.61,70.62,70.61]]) {
    const result = fixture('SO','IF',requested,remaining).post();
    assert.equal(result.ok,true);
    assert.equal(result.record.item.items[0].quantity,expected);
  }
});

test('quantity policy refuses exact-boundary excess, zero and absent remaining evidence before saving', () => {
  for (const [requested,remaining] of [[70.63,70.62],[71,70.62],[0.001,0],[70.62,null]]) {
    const f=fixture('SO','IF',requested,remaining), result=f.post();
    assert.equal(result.ok,false);
    assert.equal(result.postingNotAttempted,true);
    assert.equal(result.ambiguous,false);
    assert.equal(f.state.saves.length,0);
  }
});

test('quantity policy requires SQFT units for correction and rejects unrecognized policies', () => {
  for(const unit of ['EACH','PC','TON','']) {
    const f=fixture('SO','IF',70.6200001,70.62,unit), result=f.post();
    assert.equal(result.ok,false);
    assert.equal(f.state.saves.length,0);
  }
  const f=fixture();f.request.quantityPolicy='round_everything';
  assert.equal(f.post().postingNotAttempted,true);
  assert.equal(f.state.transforms.length,0);
});

test('quantity policy reports honest post-save changes and preserves recovery semantics', () => {
  const f=fixture();f.state.afterSave=saved=>{saved.items[0].quantity=65;};
  const result=f.post();
  assert.equal(result.record.item.items[0].quantity,65);
  assert.equal(result.quantityAdjustments[0].netSuiteQuantity,65);
  const g=fixture();g.state.failRead=true;
  assert.equal(g.post().requiresReconciliation,true);
  assert.equal(g.state.saves.length,1);
});

test('property: quantity policy corrects only near remaining SQFT quantities and saves once', () => {
  fc.assert(fc.property(fc.integer({min:100,max:100000000}),fc.integer({min:1,max:9999}),
    fc.boolean(),(hundredths,millionths,up)=>{
      const remaining=hundredths/100, requested=remaining+(up?1:-1)*millionths/1000000;
      const f=fixture('SO','IF',requested,remaining),result=f.post();
      assert.equal(result.ok,true);
      assert.equal(result.record.item.items[0].quantity,remaining);
      assert.equal(f.post().outcome,'existing');
      assert.equal(f.state.saves.length,1);
    }),{numRuns:100,seed:20261022});
});

test('property: quantity policy preserves partial orders and refuses excess or correction in other units', () => {
  fc.assert(fc.property(fc.integer({ min: 10000, max: 10000000 }), fc.integer({ min: 1, max: 9 }),
    (hundredths, offset) => {
      const remaining = hundredths / 100;
      const partial = fixture('SO', 'IF', remaining / 2, remaining).post();
      assert.equal(partial.record.item.items[0].quantity, remaining / 2);
      for (const unit of ['SQFT', 'EACH']) {
        const excess = fixture('SO', 'IF', remaining + offset / 100, remaining, unit);
        assert.equal(excess.post().postingNotAttempted, true);
        assert.equal(excess.state.saves.length, 0);
      }
      const otherUnit = fixture('SO', 'IF', remaining + .0001, remaining, 'EACH');
      assert.equal(otherUnit.post().postingNotAttempted, true);
      assert.equal(otherUnit.state.saves.length, 0);
    }), { numRuns: 100, seed: 20261023 });
});
