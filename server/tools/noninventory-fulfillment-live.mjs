import assert from 'node:assert/strict';
import { query, withTransaction, closeDb } from '../src/db.js';
import { getDeliveryOrder } from '../src/delivery-repository.js';
import { resolveOperatorNetSuitePostingTargets } from '../src/operator-netsuite-posting-targets.js';
import { buildOperatorNetSuitePostingDraft } from '../src/operator-netsuite-posting-domain.js';
import { fetchSalesOrderFulfillmentStateFromNetSuite } from '../src/netsuite.js';

try {
  const result = await withTransaction(async () => {
    await query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    const value = (await query("SELECT netsuite_id FROM sales_orders WHERE tranid='SOM06789'")).rows[0];
    assert(value, 'SOM06789 must exist');
    const order = await getDeliveryOrder(value.netsuite_id, { includeNetSuiteClosed: true });
    assert(order.lines.some(line => line.item_type === 'NonInvtPart' && Number(line.item_id) === 9920));
    const resolution = await resolveOperatorNetSuitePostingTargets({ functionKey: 'customer_pickup', orderId: value.netsuite_id, clientLocationId: 26 });
    const draft = buildOperatorNetSuitePostingDraft({ requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', actorOperatorId: 'read-only-preview',
      functionKey: 'customer_pickup', transactionType: 'IF', photoRefs: [], localOrderKeys: resolution.localOrderKeys, localOperation: resolution.localOperation,
      policy: { gateKey: 'operator_netsuite_customer_pickup_if_150', revision: 1, effective: true, functionKey: 'customer_pickup', transactionType: 'IF', locationId: 26, yardCode: '150' },
      targets: resolution.targets });
    const items = draft.steps.flatMap(step => step.payload.item.items);
    assert.deepEqual(items.map(item => item.orderLine), [1, 2, 3, 8]);
    const live = await fetchSalesOrderFulfillmentStateFromNetSuite(value.netsuite_id);
    assert.deepEqual(live.lines.map(line => line.orderLine), [1, 2, 3, 8]);
    return { readOnly: true, netSuitePosts: 0, order: order.tranid, visibleLines: order.lines.length,
      resaleVisible: true, fulfillmentLines: items.map(({ orderLine, itemReceive, quantity }) => ({ orderLine, itemReceive, quantity })),
      automaticLiveLines: live.lines.map(line => line.orderLine) };
  }, { rollback: true });
  console.log(JSON.stringify(result));
} finally { await closeDb(); }
