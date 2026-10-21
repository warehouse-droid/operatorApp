import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {query,closeDb} from '../src/db.js';
assert.equal(process.env.MBT_TEST_ISOLATED,'1');
assert.equal(new URL(process.env.DATABASE_URL).hostname,'mbbs-special-review-db');
try {
  await query(await readFile('migrations/247_purchase_order_note.sql','utf8'));
  console.log(JSON.stringify({isolated:true,migration:'247_purchase_order_note.sql'}));
} finally {await closeDb();}
