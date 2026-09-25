import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { closeDb, pool, query, withTransaction } from '../src/db.js';
import { fetchPurchaseOrderDetailsFromNetSuite } from '../src/netsuite.js';
import { applyPurchaseOrderItemWeights } from '../src/purchase-order-weight-refresh.js';

const refresh = process.argv.includes('--refresh');
const orderRef = 'POB03658';
const orderId = 936958;
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const protectedRows = rows => rows.map(({ item_weight: _weight, ...rest }) => rest);

async function readLines() {
  const result = await query(`WITH RECURSIVE linked AS (
    SELECT id, line_id AS root_line_id FROM purchase_order_lines
     WHERE purchase_order_id=$1 AND COALESCE(netsuite_active,true)
    UNION
    SELECT child.id, parent.root_line_id FROM linked parent
      JOIN dispatch_scm_po_split_lines ledger ON ledger.source_line_id=parent.id
      JOIN dispatch_scm_po_splits split ON split.id=ledger.split_id AND split.status='active'
      JOIN purchase_order_lines child ON child.id=ledger.split_line_id AND COALESCE(child.netsuite_active,true)
      JOIN purchase_orders po ON po.netsuite_id=child.purchase_order_id AND COALESCE(po.netsuite_active,true)
  ) SELECT line.*,linked.root_line_id FROM linked JOIN purchase_order_lines line ON line.id=linked.id ORDER BY line.id`, [orderId]);
  return result.rows;
}

function mismatches(rows, sources) {
  return rows.flatMap(line => {
    const source = sources.get(String(line.root_line_id));
    assert.ok(source, `Missing NetSuite source for line ${line.id}`);
    assert.equal(String(source.item_id), String(line.item_id));
    const expected = source.item_weight === undefined || source.item_weight === null ? null : Number(source.item_weight);
    const actual = line.item_weight === null ? null : Number(line.item_weight);
    if (actual === expected) {
      return [];
    }
    return [{ orderId: line.purchase_order_id, lineId: line.line_id, itemId: line.item_id,
      itemName: line.item_name, before: actual, after: expected }];
  });
}

if (!refresh) {
  pool.options.options = '-c default_transaction_read_only=on -c statement_timeout=30000';
}
try {
  const remote = await fetchPurchaseOrderDetailsFromNetSuite(orderId);
  assert.equal(remote.length, 39);
  const sources = new Map(remote.map(line => [String(line.line_id), line]));
  assert.equal(sources.size, remote.length);
  const result = await withTransaction(async () => {
    await query("SET LOCAL lock_timeout='5s'");
    await query("SET LOCAL statement_timeout='30s'");
    const order = (await query('SELECT tranid FROM purchase_orders WHERE netsuite_id=$1', [orderId])).rows[0];
    assert.equal(order?.tranid, orderRef);
    const before = await readLines();
    const changes = mismatches(before, sources);
    const correction = refresh ? await applyPurchaseOrderItemWeights({ netsuiteOrderId: orderId, lines: remote }) : null;
    const after = await readLines();
    assert.deepEqual(protectedRows(after), protectedRows(before));
    const remaining = mismatches(after, sources);
    if (refresh || process.argv.includes('--require-current')) {
      assert.deepEqual(remaining, []);
    }
    return { passed: true, orderRef, orderId, mode: refresh ? 'weight-only local refresh' : 'read-only comparison',
      checkedAt: new Date().toISOString(), parentLineCount: remote.length, parentAndSplitLineCount: after.length,
      changes, correction, remaining, protectedFieldsUnchanged: true, protectedFieldsHash: hash(protectedRows(after)) };
  });
  console.log(JSON.stringify(result));
} finally {
  await closeDb();
}
