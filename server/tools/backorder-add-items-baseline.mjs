import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import pg from 'pg';
const url = new URL(process.env.DATABASE_URL);
assert.equal(process.env.MBT_TEST_ISOLATED, '1');
assert.equal(url.hostname, 'db'); assert.equal(url.pathname, '/mbt_test');
const client = new pg.Client({connectionString: url.href});
try {
  await client.connect();
  await client.query("INSERT INTO inventory_items(item_id,item_name,stock_unit,raw,synced_at) VALUES(2055,'MBBS-Special Order','PC','{}',now()) ON CONFLICT DO NOTHING");
} finally { await client.end(); }
const result = spawnSync(process.execPath, ['tools/backorder-add-items-report.mjs',
  'test/mbt/integration/backorder-requests.test.js','test/mbt/integration/special-sales-items-copy-http.test.js'], {stdio: 'inherit', env: {...process.env,
  RECEIPT_BASELINE_CAPTURE: '1', NODE_OPTIONS: '--require=/app/tools/regular-stock-add-items-test-env.cjs'}});
process.exitCode = result.status ?? 1;
