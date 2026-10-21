import assert from 'node:assert/strict';
import { query, withTransaction, closeDb } from './src/db.js';
import { config } from './src/config.js';
import { DISPATCH_FLEET_PLANNING_LOCK } from './src/dispatch-fleet-status.js';
import { lockConsolidatedLoadOrders } from './src/consolidation-load-locks.js';
import { writeDispatchAudit } from './src/dispatch-audit-repository.js';
import { listDispatchOrders } from './src/dispatch-repository.js';
import { overlayFulfilledSalesDeliveryPlanning } from './src/dispatch-fulfilled-so-repository.js';
import { upsertDispatchOrderCatalog } from './src/dispatch-order-catalog-repository.js';
config.netsuite.directAccessEnabled = false;
const { loadDispatchOrdersForResponse } = await import('./src/server.js');
const lineId = 544895, orderId = 1049213, sourceLineId = 5137294;
const actor = '6d9d3766-27e1-4038-8cf8-d02b2ba1599e';
const progress = ['packed_pallet_qty','packed_layer_qty','packed_section_qty','packed_piece_qty','confirmed','confirmed_at',
  'loaded_qty','loaded_uom','fulfilled_pallet_qty','fulfilled_layer_qty','fulfilled_piece_qty','fulfilled_section_qty','packed_sales_qty'];
try {
  // Install empty support separately, avoiding DDL while canonical rows are locked.
  await withTransaction(async () => {
    await query("SET LOCAL lock_timeout='5s'");
    await query("SET LOCAL statement_timeout='30s'");
    // The wrapper supplies only the verified migration text, never credentials.
    const filename = '292_sales_order_line_sync_holds.sql';
    if (!(await query('SELECT 1 FROM schema_migrations WHERE filename=$1', [filename])).rowCount) {
      await query(verifiedHoldMigration);
      await query('INSERT INTO schema_migrations(filename) VALUES($1)', [filename]);
    }
  });
  const result = await withTransaction(async () => {
    await query("SET LOCAL lock_timeout='5s'");
    await query("SET LOCAL statement_timeout='30s'");
    await query('SELECT pg_advisory_xact_lock(hashtext($1))', [DISPATCH_FLEET_PLANNING_LOCK]);
    await lockConsolidatedLoadOrders([orderId]);
    const header = (await query("SELECT * FROM sales_orders WHERE netsuite_id=$1 AND tranid='SOM06964' FOR UPDATE", [orderId])).rows[0];
    assert.ok(header);
    const before = (await query('SELECT * FROM sales_order_lines WHERE sales_order_id=$1 ORDER BY id FOR UPDATE', [orderId])).rows;
    const line = before.find(row => Number(row.id) === lineId);
    assert.ok(line);
    assert.equal(Number(line.line_id), sourceLineId);
    assert.equal(Number(line.item_id), 2055);
    assert.equal(line.item_description, 'StoneArch-1 Edge Rockface Coping Flamed-OnyxBlack-2x12x48\n4sqft/pc, 15pcs/plt, 60sqft/plt');
    assert.equal(Number(line.quantity), 28); assert.equal(Number(line.piece_qty), 7);
    assert.ok(['PC','SQFT'].includes(line.unit));
    for (const key of progress.filter(key => !['loaded_qty','loaded_uom','confirmed_at'].includes(key))) {
      assert.ok(!line[key] || Number(line[key]) === 0, 'Local execution changed: ' + key);
    }
    assert.equal((await query("SELECT 1 FROM dispatch_so_po_allocations WHERE sales_line_id=$1 AND status='active'", [lineId])).rowCount, 0, 'PO allocation changed; recheck the unit before applying');
    assert.equal((await query("SELECT 1 FROM order_dependencies WHERE sales_order_ref='SOM06964' AND status<>'cancelled'")).rowCount, 0);
    assert.equal((await query("SELECT 1 FROM dispatch_plan_order_assignments WHERE order_ref='SOM06964' OR planned_order_ref='SOM06964'")).rowCount, 0);
    assert.equal((await query("SELECT 1 FROM driver_job_records WHERE order_refs ? 'SOM06964' AND (started_at IS NOT NULL OR completed_at IS NOT NULL)")).rowCount, 0);
    assert.equal((await query("SELECT 1 FROM operator_netsuite_posting_order_claims WHERE active AND local_order_key=$1", ['delivery_prep:sales_order:' + orderId])).rowCount, 0);
    const existing = (await query('SELECT * FROM sales_order_line_sync_holds WHERE sales_order_line_id=$1 FOR UPDATE', [lineId])).rows[0];
    if (existing) {
      assert.equal(existing.released_at, null);
      assert.equal(line.unit, 'SQFT');
      assert.equal(existing.created_by, 'testAdmin');
      return { alreadyApplied: true, orderRef: 'SOM06964', sourceLineId, quantity: 28, unit: 'SQFT', pieces: 7 };
    }
    assert.equal(line.unit, 'PC');
    await query("UPDATE sales_order_lines SET unit='SQFT',loaded_uom=CASE WHEN loaded_uom='PC' THEN 'SQFT' ELSE loaded_uom END WHERE id=$1", [lineId]);
    const reason = 'User requested SOM06964 StoneArch 28 PC to 28 SQFT locally and explicitly excluded this line from NetSuite sync.';
    await query(`INSERT INTO sales_order_line_sync_holds(sales_order_line_id,source_snapshot,before_state,reason,created_by)
      SELECT id,to_jsonb(line)-$2::text[],$3::jsonb,$4,'testAdmin' FROM sales_order_lines line WHERE id=$1`,
    [lineId, progress, JSON.stringify(line), reason]);
    const after = (await query('SELECT * FROM sales_order_lines WHERE sales_order_id=$1 ORDER BY id', [orderId])).rows;
    assert.deepEqual(after.filter(row => Number(row.id) !== lineId), before.filter(row => Number(row.id) !== lineId));
    const corrected = after.find(row => Number(row.id) === lineId);
    assert.deepEqual({ ...corrected, unit: line.unit, loaded_uom: line.loaded_uom }, line);
    const audit = await writeDispatchAudit({ action: 'sales_order_line_local_unit_correction', entityType: 'sales_order_line',
      entityId: String(lineId), orderId: 'SOM06964', operatorId: actor, operatorName: 'testAdmin', source: 'authorized-local-repair',
      before: line, after: corrected, details: { reason, sourceLineId, syncExcluded: true, netSuiteWrite: false } });
    const fresh = await overlayFulfilledSalesDeliveryPlanning(await listDispatchOrders({ type: 'SO', search: 'SOM06964', includeFulfilledSalesDeliveries: true }));
    const order = fresh.find(row => row.id === 'SOM06964');
    const item = order?.items.find(row => Number(row.lineId) === sourceLineId);
    assert.equal(item?.unit, 'SQFT'); assert.equal(Number(item?.quantity), 28); assert.equal(Number(item?.pieces), 7);
    await upsertDispatchOrderCatalog({ orders: [order], source: 'local-line-unit-correction' });
    const response = await loadDispatchOrdersForResponse({ type: 'SO', search: 'SOM06964', exactOrderRefs: ['SOM06964'], includeCompletedScmSearch: true });
    assert.equal(response.find(row => row.id === 'SOM06964')?.items.find(row => Number(row.lineId) === sourceLineId)?.unit, 'SQFT');
    return { orderRef: 'SOM06964', sourceLineId, localLineId: lineId, quantity: 28, unit: 'SQFT', pieces: 7,
      syncExcluded: true, auditId: audit.id, actor: 'testAdmin', otherLinesUnchanged: true, netSuiteWrite: false, before: line, after: corrected };
  });
  console.log(JSON.stringify(result, null, 2));
} finally { await closeDb(); }
