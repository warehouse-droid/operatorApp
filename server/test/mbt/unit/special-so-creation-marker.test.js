import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { findSpecialStockOrdersByMarkerFromNetSuite } from '../../../src/netsuite.js';

async function lookup(caseId, orderKind = 'sales_order', entityId = null) {
  let seen;
  const marker = `MBBS-SPECIAL-${orderKind === 'sales_order' ? 'SO' : 'PO'}:${caseId}`;
  const rows = [{ id: 1052318, tranid: 'TEST-SOB', externalid: marker, memo: 'Edited after creation' }];
  const result = await findSpecialStockOrdersByMarkerFromNetSuite({ caseId, orderKind, entityId }, {
    query: async sql => {
      seen = sql;
      // Transport fixture has a changed memo; only the exact external ID can find it.
      return { items: sql.includes(`UPPER(COALESCE(t.externalid, '')) = '${marker}'`) ? rows : [] };
    }
  });
  return { result, seen, rows, marker };
}

test('SO recovery finds the exact external ID when the memo and customer have changed', async () => {
  const f = await lookup(162);
  assert.deepEqual(f.result, f.rows);
  assert.equal(f.seen.includes('AND t.entity ='), false);
  assert.ok(f.seen.includes("t.type = 'SalesOrd'"));
  assert.ok(f.seen.includes("LIKE '%MBBS-SPECIAL-SO:162 |%'"));
  assert.ok(f.seen.includes("LIKE '%MBBS-SPECIAL-SO:162'"));
});

test('PO marker recovery retains its vendor filter and record type', async () => {
  const f = await lookup(162, 'purchase_order', 55);
  assert.deepEqual(f.result, f.rows);
  assert.ok(f.seen.includes('AND t.entity = 55'));
  assert.ok(f.seen.includes("t.type = 'PurchOrd'"));
});

test('property: marker lookup uses exact, numeric request identity without prefix matching', async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 100000000 }), async caseId => {
    const f = await lookup(caseId);
    assert.deepEqual(f.result, f.rows);
    assert.ok(f.seen.includes(`= '${f.marker}'`));
    assert.equal(f.seen.includes(`LIKE '%${f.marker}%'`), false);
  }), { seed: 122477, numRuns: 100 });
});
