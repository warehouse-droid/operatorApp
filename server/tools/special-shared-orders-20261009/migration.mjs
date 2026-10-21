import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { query, withTransaction, closeDb } from '../../src/db.js';
import { createSpecialStockCase } from '../../src/special-stock-request-repository.js';

assert.equal(process.env.MBT_TEST_ISOLATED, '1');
assert.equal(new URL(process.env.DATABASE_URL).hostname, 'mbbs-special-review-db');
const sql = readFileSync('migrations/278_special_shared_orders.sql', 'utf8');
const indexes = async () => (await query("SELECT indexname,indexdef FROM pg_indexes WHERE tablename='sales_special_stock_cases' AND indexname LIKE 'idx_sales_special_stock_%' ORDER BY indexname")).rows;
const rows = async () => (await query(`SELECT jsonb_build_object('request',to_jsonb(request),'case',to_jsonb(special),
  'lines',(SELECT jsonb_agg(to_jsonb(line) ORDER BY line.id) FROM sales_special_stock_lines line WHERE line.request_id=request.id),
  'events',(SELECT jsonb_agg(to_jsonb(event) ORDER BY event.id) FROM sales_special_stock_events event WHERE event.request_id=request.id)) AS data
  FROM sales_stock_requests request JOIN sales_special_stock_cases special ON special.request_id=request.id ORDER BY request.id`)).rows;
try {
  const result = await withTransaction(async () => {
    await query("INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,yard_location_ids) VALUES('shared-migration-test','shared-migration-test','TEST','hash','salt','sales',ARRAY['sales'],ARRAY[1])");
    const d = await createSpecialStockCase({ storeLocationId: 1, inquiryDate: '2099-01-01', customerName: 'TEST Migration',
      vendorId: 331, vendorName: 'TEST Vendor', fulfillmentMethod: 'yard_pickup',
      lines: [{ productName: 'TEST Seeded Material', quantity: 9, uom: 'PCS', rate: 12, requiredDate: '2099-02-01' }] },
    { operatorId: 'shared-migration-test', authorizedStoreLocationIds: [1] });
    await query("UPDATE sales_special_stock_cases SET sales_order_netsuite_id=88997701,sales_order_ref='TEST-SEED-SO',purchase_order_netsuite_id=88997702,purchase_order_ref='TEST-SEED-PO' WHERE request_id=$1", [d.id]);
    await query(`DROP INDEX idx_sales_special_stock_so_owner; DROP INDEX idx_sales_special_stock_po_owner;
      CREATE UNIQUE INDEX idx_sales_special_stock_so_owner ON sales_special_stock_cases(sales_order_netsuite_id) WHERE sales_order_netsuite_id IS NOT NULL AND workflow_kind='special';
      CREATE UNIQUE INDEX idx_sales_special_stock_po_owner ON sales_special_stock_cases(purchase_order_netsuite_id) WHERE purchase_order_netsuite_id IS NOT NULL AND workflow_kind='special';`);
    const oldRows = await rows(), oldIndexes = await indexes();
    await query('SAVEPOINT sharing_upgrade');
    await query(sql);
    assert.deepEqual(await rows(), oldRows, 'Migration changed existing request data or history');
    const upgraded = await indexes();
    assert.ok(upgraded.filter(index => index.indexname.endsWith('_owner')).every(index => !index.indexdef.includes('UNIQUE')));
    assert.deepEqual(upgraded.filter(index => index.indexname.endsWith('_operation')), oldIndexes.filter(index => index.indexname.endsWith('_operation')));
    await query('ROLLBACK TO SAVEPOINT sharing_upgrade');
    assert.deepEqual(await indexes(), oldIndexes, 'Transactional rollback did not restore original indexes');
    assert.deepEqual(await rows(), oldRows, 'Rollback changed existing data');
    await query(sql);
    assert.deepEqual(await rows(), oldRows);
    return { migration: '278_special_shared_orders.sql', preservedRequests: oldRows.length,
      dataAndHistoryPreserved: true, operationIndexesPreserved: true, rollbackVerified: true,
      migrationSha256: createHash('sha256').update(sql).digest('hex') };
  }, { rollback: true });
  writeFileSync('test-artifacts/special-shared-orders-20261009/migration.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { await closeDb(); }
