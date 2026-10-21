import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { query, closeDb } from '/app/src/db.js';

try {
  const health = await fetch('http://127.0.0.1:3000/health');
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
  for (const name of ['dispatch.js', 'dispatch.html']) {
    const response = await fetch(`http://127.0.0.1:3000/${name}?v=20261020-split-quantity-v1`, { cache: 'no-store' });
    assert.equal(response.status, 200);
    const digest = value => crypto.createHash('sha256').update(value).digest('hex');
    assert.equal(digest(Buffer.from(await response.arrayBuffer())), digest(await readFile(`/app/public/${name}`)));
  }
  const source = (await query(`SELECT sum(l.quantity)::numeric AS quantity FROM sales_order_lines l
    JOIN sales_orders o ON o.netsuite_id=l.sales_order_id WHERE o.tranid='SOA09140' AND o.netsuite_id>0
    AND l.netsuite_active IS DISTINCT FROM false`)).rows[0];
  const family = (await query(`SELECT split_ref,full_order FROM dispatch_global_order_splits
    WHERE parent_order_ref='SOA09140' AND active ORDER BY split_ref`)).rows;
  const quantities = Object.fromEntries(family.map(row => [row.split_ref,
    row.full_order.items.reduce((sum, line) => sum + Number(line.quantity), 0)]));
  assert.equal(Number(source.quantity), 8432);
  assert.deepEqual(quantities, { 'SOA09140-S1': 1860, 'SOA09140-S3': 1984, 'SOA09140-S4': 4588 });
  const remaining = (await query(`SELECT sum(l.quantity)::numeric AS quantity FROM sales_order_lines l
    JOIN sales_orders o ON o.netsuite_id=l.sales_order_id WHERE o.tranid='SOA09140-S4'
    AND l.netsuite_active IS DISTINCT FROM false`)).rows[0];
  assert.equal(Number(remaining.quantity), 4588);
  console.log(JSON.stringify({ localHealth: 200, servedAssetsVerified: 2, soa09140: {
    sourceSqft: 8432, deliveredSqft: 3844, remainingSqft: 4588, localTotalSqft: 8432, splits: quantities } }));
} finally { await closeDb(); }
