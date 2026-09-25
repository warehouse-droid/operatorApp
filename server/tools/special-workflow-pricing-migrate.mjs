import { readFile } from 'node:fs/promises';
import { query, closeDb, withTransaction } from '../src/db.js';
const target = new URL(process.env.DATABASE_URL || '');
if (process.env.MBT_TEST_ISOLATED !== '1' || target.hostname !== 'mbbs-special-review-db' || !['/mbt_verify','/mbt_test'].includes(target.pathname)) throw new Error('Isolated Special workflow database required');
try {
  await withTransaction(async () => {
    await query(await readFile('migrations/228_special_workflow_pricing.sql','utf8'));
  });
  console.log('Applied isolated pricing migration:', target.pathname);
} finally { await closeDb(); }
