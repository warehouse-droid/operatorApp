// Read-only incident verification. Run through docker exec; never seed production.
import assert from 'node:assert/strict';
import { withTransaction, query, closeDb } from '../src/db.js';
import { listScmSchedule } from '../src/dispatch-repository.js';

const mode = process.argv[2] || 'after';
try {
  const result = await withTransaction(async () => {
    await query('SET TRANSACTION READ ONLY');
    await query("SET LOCAL statement_timeout = '15s'");
    const ledger = (await query(`SELECT s.id,s.split_po_id,s.status,p.netsuite_active,
      (SELECT count(*)::int FROM purchase_order_lines l WHERE l.purchase_order_id=s.split_po_id) AS saved_line_count
      FROM dispatch_scm_po_splits s JOIN purchase_orders p ON p.netsuite_id=s.split_po_id
      WHERE s.split_po_ref='SN1400761' ORDER BY s.id`)).rows;
    const active = ledger.filter(row => row.status === 'active');
    const cancelled = ledger.filter(row => row.status === 'cancelled');
    assert.equal(active.length, 1);
    assert.equal(cancelled.length, 1);
    assert.equal(cancelled[0].netsuite_active, false);
    assert.ok(cancelled[0].saved_line_count > 0, 'Cancelled item history must remain saved');
    const rows = await listScmSchedule({ search: 'SN1400761', exactRef: 'SN1400761', audience: 'scm' });
    assert.equal(rows.length, mode === 'before' ? 2 : 1);
    const visible = rows.find(row => String(row.sourceId) === String(active[0].split_po_id));
    assert.ok(visible, 'The active replacement must remain visible');
    assert.equal(visible.totalPalletQty, 40);
    assert.equal(visible.content.split('\n').length, 8);
    if (mode !== 'before') {
      assert.ok(rows.every(row => String(row.sourceId) !== String(cancelled[0].split_po_id)));
    }
    return { mode, passed: true, ledger, rows: rows.map(row => ({ sourceId: row.sourceId,
      sourceRef: row.sourceRef, orderRef: row.orderRef, content: row.content, status: row.status,
      totalPalletQty: row.totalPalletQty, weightLbs: row.weightLbs })) };
  }, { rollback: true });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await closeDb();
}
