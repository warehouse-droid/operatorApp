import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { query, withTransaction, closeDb } from './src/db.js';
import { getDispatchSplitPreview } from './src/dispatch-split-preview-repository.js';
try {
  assert.equal((await fetch('http://127.0.0.1:3000/api/dispatch/orders/SOA09143-S2/split-preview?type=SO')).status, 401);
  const page = await fetch('http://127.0.0.1:3000/dispatch/planning');
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes('/dispatch.js?v=20261012-split-fast'));
  const client = readFileSync('public/dispatch.js', 'utf8');
  assert.ok(client.includes('/split-preview?type='));
  const measurement = await withTransaction(async () => {
    await query('SET TRANSACTION READ ONLY');
    const row = (await query(`SELECT split_ref FROM dispatch_global_order_splits
      WHERE active AND order_type='SO' AND parent_order_ref='SOA09143' AND split_ref<>'SOA09143-S1'
      AND split_ref ~ '^SOA09143-S[0-9]+$' ORDER BY updated_at DESC LIMIT 1`)).rows[0];
    const ref = row?.split_ref || 'SOA09143';
    const times = []; let preview;
    for (let index = 0; index < 5; index += 1) {
      const start = performance.now(); preview = await getDispatchSplitPreview({ orderRef: ref, type: 'SO' });
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    assert.ok(preview.items.length > 0);
    return { orderRef: ref, operatorStatus: preview.operatorStatus, payloadBytes: Buffer.byteLength(JSON.stringify(preview)),
      previewMedianMs: Math.round(times[2] * 100) / 100, previewMaxMs: Math.round(times.at(-1) * 100) / 100 };
  });
  console.log(JSON.stringify({ featureAvailable: true, unauthorizedBlocked: true, previewReadOnly: true, ...measurement }));
} finally { await closeDb(); }
