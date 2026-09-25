import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pool, query, withTransaction, closeDb } from '../src/db.js';
import { config } from '../src/config.js';
import { getDeliveryOrder } from '../src/delivery-repository.js';
import { fetchOperatorKitSource } from '../src/operator-netsuite-posting-kit-source.js';
import { assertOperatorKitStepCurrent } from '../src/operator-netsuite-posting-kits.js';
import { buildOperatorNetSuitePostingDraft } from '../src/operator-netsuite-posting-domain.js';
import { createOperatorNetSuitePostingRealSourceResolver, createOperatorNetSuitePostingTargetResolver } from '../src/operator-netsuite-posting-targets.js';

pool.options.options = '-c default_transaction_read_only=on -c statement_timeout=30000';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
try {
  const report = await withTransaction(async () => {
    await query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    assert.equal(config.netsuite.operatorStoredOrderLinePosting, true);
    const attempts = (await query(`SELECT id,command_id,status,payload,line_snapshot,netsuite_transaction_id
      FROM operator_netsuite_posting_steps WHERE source_netsuite_id=997764 ORDER BY id`)).rows;
    const failed = attempts.find(row => Number(row.id) === 59);
    assert.equal(failed.status, 'failed');
    const rows = (await query(`SELECT id,line_id,netsuite_order_line,item_id,item_type,quantity,loaded_qty,packed_sales_qty
      FROM sales_order_lines WHERE sales_order_id=997764 AND COALESCE(netsuite_active,true) ORDER BY netsuite_order_line`)).rows;
    const order = structuredClone(await getDeliveryOrder(997764, { includeNetSuiteClosed: true }));
    assert.ok(order);
    for (const line of order.lines) {
      Object.assign(line, { packed_pallet_qty: 0, packed_layer_qty: 0, packed_section_qty: 0, packed_piece_qty: 0, packed_sales_qty: 0 });
    }
    // Reconstruct the failed confirmation only in memory; production state is read-only.
    for (const item of failed.payload.item.items.filter(line => line.itemReceive !== false && line.quantity > 0)) {
      const row = rows.find(line => Number(line.netsuite_order_line) === item.orderLine);
      assert.ok(row);
      const line = order.lines.find(entry => String(entry.line_id) === String(row.line_id));
      assert.ok(line);
      line.packed_sales_qty = item.quantity;
      line.pack_quantity_source = 'sales';
      const conversions = [['packed_pallet_qty', 'pallet_qty', 'to_plt'], ['packed_layer_qty', 'layer_qty', 'to_lyr'],
        ['packed_section_qty', 'section_qty', 'to_sec'], ['packed_piece_qty', 'piece_qty', 'to_pcs']];
      const physical = conversions.find(([_packed, required, conversion]) => Number(line[required]) > 0
        && Math.abs(Number(line[required]) * Number(line[conversion]) - item.quantity) < 0.000001)
        || [...conversions].reverse().find(([_packed, _required, conversion]) => Number(line[conversion]) > 0);
      if (physical) { line[physical[0]] = item.quantity / Number(line[physical[2]]); }
    }
    const resolver = createOperatorNetSuitePostingTargetResolver({ getDeliveryOrder: async () => order,
      resolveRealSource: createOperatorNetSuitePostingRealSourceResolver({ query, useStoredOrderLines: true, fetchKitSource: fetchOperatorKitSource }) });
    const resolution = await resolver({ functionKey: 'customer_pickup', orderId: 997764, clientLocationId: 1 });
    const draft = buildOperatorNetSuitePostingDraft({ ...resolution,
      requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', actorOperatorId: 'read-only-kit-check', photoRefs: [],
      policy: { gateKey: 'operator_netsuite_customer_pickup_if_3445', revision: 1, effective: true,
        functionKey: 'customer_pickup', transactionType: 'IF', locationId: 1, yardCode: '3445' } });
    const step = draft.steps[0];
    assert.deepEqual(step.payload.item.items, [
      { orderLine: 1, quantity: 95.6, itemReceive: true, location: 1 },
      { orderLine: 2, quantity: 1, itemReceive: true, location: 1 }
    ]);
    const current = await fetchOperatorKitSource(997764);
    assertOperatorKitStepCurrent(step, current);
    const kit = step.lineSnapshot.find(line => line.kit).kit;
    assert.equal(kit.definition.parent.itemId, 10126);
    assert.equal(kit.definition.members[0].itemId, 599);
    assert.equal(kit.physicalLines[0].quantity, 1);
    return { passed: true, readOnly: true, netSuiteTransforms: 0, order: 'SOB120656', sourceId: 997764,
      payloadItems: step.payload.item.items, kit, failedAttemptIds: attempts.map(row => Number(row.id)),
      failedAttemptsHash: digest(attempts), localLinesHash: digest(rows) };
  }, { rollback: true });
  console.log(JSON.stringify(report));
} finally { await closeDb(); }
