import assert from 'node:assert/strict';
import test from 'node:test';
import { query } from '../../../src/db.js';
import { getDispatchOrderUnavailableReason } from '../../../src/dispatch-repository.js';
import { createDispatchV2Fixture } from '../support/dispatch-v2-fixture.js';
import { seedSalesOrder } from '../support/fulfilled-so-fixture.js';

test('Dispatch explains pending approval without changing order eligibility', { timeout: 60000 }, async t => {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  const fixture = await createDispatchV2Fixture();
  const id = 998264001;
  const ref = 'SOR998264';
  try {
    await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key='sor_rental_workflow'");
    await seedSalesOrder(id, ref, { status: 'A' });
    await query("UPDATE sales_orders SET status_text='Sales Order : Pending Approval' WHERE netsuite_id=$1", [id]);
    const before = (await query('SELECT status,dispatch_planned FROM sales_orders WHERE netsuite_id=$1', [id])).rows[0];

    await t.test('fresh and ordinary detail reads explain the existing pending order', async () => {
      for (const identity of [ref, ref.toLowerCase(), String(id)]) {
        for (const suffix of ['?fresh=true', '']) {
          const { response, payload } = await fixture.request(`/api/dispatch/v2/order-feed/${identity}${suffix}`);
          assert.equal(response.status, 409, JSON.stringify(payload));
          assert.equal(payload.code, 'DISPATCH_ORDER_PENDING_APPROVAL');
          assert.equal(payload.orderRef, ref);
          assert.match(payload.error, /pending approval in NetSuite/);
          assert.match(payload.error, /Approve it in NetSuite, then refresh the order pool/);
          assert.doesNotMatch(payload.error, /not found/i);
          assert.match(response.headers.get('cache-control'), /no-store/);
        }
      }
    });

    await t.test('the source status and planning state remain unchanged', async () => {
      const row = (await query('SELECT status,dispatch_planned FROM sales_orders WHERE netsuite_id=$1', [id])).rows[0];
      assert.deepEqual(row, before);
    });

    await t.test('missing references retain the real not-found error', async () => {
      const { response, payload } = await fixture.request('/api/dispatch/v2/order-feed/SOR998265?fresh=true');
      assert.equal(response.status, 404);
      assert.equal(payload.code, 'DISPATCH_ORDER_NOT_FOUND');
      assert.equal(await getDispatchOrderUnavailableReason("SOR998264' OR 1=1 --"), null);
      assert.equal(await getDispatchOrderUnavailableReason(''), null);
    });

    await t.test('approval makes full details available on the next fresh read', async () => {
      await query("UPDATE sales_orders SET status='B',status_text='Sales Order : Pending Fulfillment' WHERE netsuite_id=$1", [id]);
      const { response, payload } = await fixture.request(`/api/dispatch/v2/order-feed/${ref}?fresh=true`);
      assert.equal(response.status, 200, JSON.stringify(payload));
      assert.equal(payload.order.id, ref);
      assert.equal(payload.order.catalogHydrated, true);
      assert.ok(payload.order.items.length > 0);
      assert.equal(await getDispatchOrderUnavailableReason(ref), null);
    });

    await t.test('pending status text is recognized and inactive/pickup sources are not misdiagnosed', async () => {
      await query("UPDATE sales_orders SET status='',status_text='Sales Order : Pending Approval' WHERE netsuite_id=$1", [id]);
      assert.equal((await getDispatchOrderUnavailableReason(ref)).code, 'DISPATCH_ORDER_PENDING_APPROVAL');
      await query('UPDATE sales_orders SET netsuite_active=false WHERE netsuite_id=$1', [id]);
      assert.equal(await getDispatchOrderUnavailableReason(ref), null);
      await query("UPDATE sales_orders SET netsuite_active=true,sales_order_type='Pick-Up' WHERE netsuite_id=$1", [id]);
      assert.equal(await getDispatchOrderUnavailableReason(ref), null);
    });
  } finally {
    await fixture.close();
  }
});
