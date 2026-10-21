import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { query, withTransaction, closeDb } from './src/db.js';
import { getOperatorProgressDetails } from './src/operator-order-progress-repository.js';
import { evaluateDependencyMutationBlockers } from './src/scm-dependency-management-policy.js';

const refs = ['SOA08800', 'SOA08801'];
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
try {
  const health = await fetch('http://127.0.0.1:3000/health');
  assert.equal(health.status, 200);
  for (const path of ['/api/control/operator-orders?search=SOA08801', '/api/control/operator-orders/SOA08801/reopen-preview']) {
    assert.equal((await fetch('http://127.0.0.1:3000' + path)).status, 401);
  }
  const page = await fetch('http://127.0.0.1:3000/control/order-reopen');
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes('control-order-reopen.js?v=20261012-order-reopen'));
  assert.ok(readFileSync('public/operator.js', 'utf8').includes('${renderOperatorReopenEvidence(order)}'));
  const evidence = await withTransaction(async () => {
    await query('SET TRANSACTION READ ONLY');
    const snapshot = async () => (await query(`SELECT s.tranid,s.operator_status,s.local_yard_order_status,s.preparing_operator_id,
      jsonb_agg(jsonb_build_object('item',l.item_name,'loaded',l.loaded_qty,'confirmed',l.confirmed,
        'packed',ARRAY[l.packed_pallet_qty,l.packed_layer_qty,l.packed_section_qty,l.packed_piece_qty,l.packed_sales_qty]) ORDER BY l.id) AS lines
      FROM sales_orders s LEFT JOIN sales_order_lines l ON l.sales_order_id=s.netsuite_id
      WHERE s.tranid=ANY($1::text[]) GROUP BY s.netsuite_id ORDER BY s.tranid`, [refs])).rows;
    const initial = await snapshot();
    const details = await getOperatorProgressDetails(['SOA08801']);
    const blocker = evaluateDependencyMutationBlockers({ operatorActivity: { refs: ['SOA08801'], orders: details } })[0];
    const final = await snapshot();
    assert.equal(hash(initial), hash(final));
    const corrections = (await query('SELECT count(*)::int AS count FROM operator_order_reopens')).rows[0].count;
    return { orders: final, linkDiagnostic: blocker?.message, corrections,
      inspectionReadOnly: true, orderStateUnchangedDuringInspection: true };
  });
  console.log(JSON.stringify({ featureAvailable: true, unauthorizedAccessBlocked: true, ...evidence }));
} finally { await closeDb(); }
