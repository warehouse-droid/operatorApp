import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test, { before, after } from 'node:test';
import { query } from '../../../src/db.js';
import { createDispatchPlan } from '../../../src/dispatch-plan-repository.js';
import { getDispatchSplitPreview } from '../../../src/dispatch-split-preview-repository.js';
import { createDispatchV2Fixture } from '../support/dispatch-v2-fixture.js';
import { seedSalesOrder } from '../support/fulfilled-so-fixture.js';

let http;
before(async () => { http = await createDispatchV2Fixture(); });
after(async () => http?.close());

for (const [index, path] of ['legacy', 'v2'].entries()) {
  test(`HTTP ${path} returns an actionable 409, persists nothing, and accepts the corrected quantities`, async () => {
    const id = 20_000_000_000 + Number.parseInt(crypto.randomBytes(4).toString('hex'), 16);
    const ref = `SO-HTTP-QUANTITY-${id}`;
    await seedSalesOrder(id, ref, { status: 'B' });
    await query(`UPDATE sales_order_lines SET quantity=8432,unit='SQFT',item_type='NonInvtPart',
      pallet_qty=0,to_plt=0,to_lyr=0,to_sec=0,to_pcs=0 WHERE sales_order_id=$1`, [id]);
    const source = { ...await getDispatchSplitPreview({ orderRef: ref, type: 'SO' }),
      sourceTable: 'sales_orders', customer: 'Quantity HTTP test', address: 'Test Road',
      destinationAddress: 'Test Road', sourceYard: '3445', pickupLocations: ['3445'], netsuiteId: String(id) };
    const plan = await createDispatchPlan({ planDate: `2099-10-${21 + index}` });
    const sessionId = `quantity-${id}`;
    const lease = await http.acquireLease({ planDate: plan.planDate, sessionId });
    const bootstrap = await http.request(`/api/dispatch/v2/bootstrap?planId=${plan.id}&date=${plan.planDate}`);
    assert.equal(bootstrap.response.status, 200);
    const base = bootstrap.payload.plan;
    const state = async () => ({
      plan: (await query('SELECT to_jsonb(p) AS data FROM dispatch_plans p WHERE id=$1', [plan.id])).rows,
      snapshot: (await query('SELECT to_jsonb(s) AS data FROM dispatch_plan_snapshots s WHERE plan_id=$1', [plan.id])).rows,
      splits: (await query('SELECT to_jsonb(s) AS data FROM dispatch_global_order_splits s WHERE parent_order_ref=$1', [ref])).rows,
      history: (await query('SELECT to_jsonb(h) AS data FROM dispatch_plan_snapshot_history h WHERE plan_id=$1', [plan.id])).rows,
      audits: (await query('SELECT to_jsonb(a) AS data FROM dispatch_audit_log a WHERE plan_id=$1', [plan.id])).rows,
      receipts: (await query('SELECT to_jsonb(c) AS data FROM dispatch_plan_commands c WHERE plan_id=$1', [plan.id])).rows
    });
    const save = values => {
      const orders = values.map((quantity, n) => ({ ...source, id: `${ref}-S${n + 1}`,
        originalOrderId: ref, netsuiteId: '', planOwned: true, salesQty: quantity,
        items: source.items.map(item => ({ ...item, quantity, pallets: 0 })) }));
      const payload = { orders, trucks: [], summary: {}, planDate: plan.planDate,
        baseRevision: base.revision, baseDigest: base.digest, audit: { sessionId } };
      return http.request(path === 'legacy' ? `/api/dispatch/plans/${plan.id}` : `/api/dispatch/v2/plans/${plan.id}/commands`,
        { method: path === 'legacy' ? 'PUT' : 'POST', headers: { 'x-dispatch-edit-lease': lease },
          body: path === 'legacy' ? payload : { commandId: crypto.randomUUID(), commandType: 'replace_plan',
            baseRevision: base.revision, baseDigest: base.digest, sessionId, payload } });
    };
    const before = await state();
    for (const [values, difference] of [[[1860, 2356], '4,216 SQFT short'], [[1860, 6573], '1 SQFT over']]) {
      const response = await save(values);
      assert.equal(response.response.status, 409, JSON.stringify(response.payload));
      assert.equal(response.payload.code, 'DISPATCH_SPLIT_QUANTITY_MISMATCH');
      assert.ok(response.payload.error.includes(difference), JSON.stringify(response.payload));
      assert.deepEqual(await state(), before);
    }
    const accepted = await save([1860, 6572]);
    assert.equal(accepted.response.status, 200, JSON.stringify(accepted.payload));
    const after = await state();
    assert.equal(after.splits.length, 2);
    assert.equal(after.splits.reduce((sum, row) => sum + row.data.full_order.items[0].quantity, 0), 8432);
  });
}
