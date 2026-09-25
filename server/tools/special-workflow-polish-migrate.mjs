import { readFile } from 'node:fs/promises';
import { query, closeDb, withTransaction } from '../src/db.js';
const target = new URL(process.env.DATABASE_URL || '');
if (process.env.MBT_TEST_ISOLATED !== '1' || target.hostname !== 'mbbs-special-review-db' || !['/mbt_verify', '/mbt_test'].includes(target.pathname)) {
  throw new Error('Use the existing isolated Special workflow database');
}
try {
  const sql = await readFile('migrations/226_special_workflow_test_skips.sql', 'utf8');
  await withTransaction(() => query(sql));
  console.log('Applied isolated migration 226:', target.pathname);
} finally { await closeDb(); }
