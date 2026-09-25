import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import fc from 'fast-check';
import { query, withTransaction, closeDb } from '../../../src/db.js';
import { getOrderDependencyOptions } from '../../../src/order-dependency-repository.js';
import { executeScmDependencyCommand } from '../../../src/scm-dependency-command-service.js';
import { getDeliveryOrder } from '../../../src/delivery-repository.js';
import { updateDispatchOrderDetails } from '../../../src/dispatch-repository.js';
import { getDispatchOrderCatalogOrder } from '../../../src/dispatch-order-catalog-repository.js';
import { seedLinkGroup, linkCommand, linkAndPlan } from '../../support/link-to-fix-fixture.mjs';
after(closeDb);

test('L1 generated grouped links conserve member quantities and repeated commands stay idempotent', async () => {
  await fc.assert(fc.asyncProperty(fc.tuple(fc.integer({ min: 1, max: 60 }), fc.integer({ min: 1, max: 60 })),
    quantities => withTransaction(async () => {
      const f = await seedLinkGroup({ quantities });
      const options = await getOrderDependencyOptions({ dispatchTargetRef: f.groupRef, transferOrderRef: f.transferRef, planDate: f.nextDate });
      assert.equal(new Set(options.matchingLines.map(line => line.targetLineKey)).size, 2);
      assert.deepEqual(options.matchingLines.map(line => Number(line.suggestedQuantity)), quantities);
      const command = await linkCommand(f);
      const result = await executeScmDependencyCommand(command);
      const repeat = await executeScmDependencyCommand(command);
      assert.equal(repeat.idempotent, true);
      assert.equal(repeat.dependency.id, result.dependency.id);
      assert.equal(result.dependency.lines.filter(line => line.salesLineId)
        .reduce((sum, line) => sum + Number(line.allocatedQuantity), 0), quantities[0] + quantities[1]);
      const unchanged = (await query('SELECT quantity FROM sales_order_lines WHERE id=ANY($1::bigint[]) ORDER BY id', [f.lines.map(line => line.id)])).rows;
      assert.deepEqual(unchanged.map(line => Number(line.quantity)), quantities);
    }, { rollback: true })), { seed: 1103, numRuns: 25 });
});

test('L3 generated confirmed-plan transitions show and release the inherited assignment without changing TO flags', async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom('draft', 'cancelled'), fc.boolean(),
    (status, unlink) => withTransaction(async () => {
      const f = await seedLinkGroup();
      await linkAndPlan(f);
      assert.equal((await getDeliveryOrder(f.transferId)).dispatch_planned, true);
      if (unlink) {await query("UPDATE order_dependencies SET status='cancelled' WHERE id=$1", [f.dependency.id]);}
      else {await query('UPDATE dispatch_plans SET status=$2 WHERE id=$1', [f.deliveryPlan.id, status]);}
      assert.equal((await getDeliveryOrder(f.transferId)).dispatch_planned, false);
      assert.equal((await query('SELECT dispatch_planned FROM transfer_orders WHERE netsuite_id=$1', [f.transferId])).rows[0].dispatch_planned, false);
    }, { rollback: true })), { seed: 6537, numRuns: 12 });
});

test('G1 generated group overrides update every member and preserve line quantities', async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 99999 }), fc.boolean(),
    (number, reverse) => withTransaction(async () => {
      const f = await seedLinkGroup();
      await query('DELETE FROM local_co_orders WHERE co_ref=$1', [f.coRef]);
      if (reverse) {
        await query("UPDATE dispatch_global_order_groups SET full_order=jsonb_set(full_order,'{childOrders}',$2::jsonb) WHERE group_ref=$1",
          [f.groupRef, JSON.stringify([...f.members].reverse())]);
      }
      for (const address of [`${number} Group Road`, `${number} Changed Road`]) {
        await updateDispatchOrderDetails(f.groupRef, { type: 'SO', address, pickupAddress: '', expectedDeliveryDate: '' });
        assert.ok((await query('SELECT dispatch_address FROM sales_orders WHERE tranid=ANY($1)', [f.members])).rows
          .every(row => row.dispatch_address === address));
        assert.ok((await getDispatchOrderCatalogOrder(f.groupRef)).childOrderDetails.every(child => child.address === address));
      }
      assert.deepEqual((await query('SELECT quantity FROM sales_order_lines WHERE id=ANY($1) ORDER BY id', [f.lines.map(line => line.id)])).rows
        .map(line => Number(line.quantity)), [4, 6]);
    }, { rollback: true })), { seed: 656, numRuns: 10 });
});
