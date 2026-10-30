import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {query,withTransaction,closeDb} from '../../../src/db.js';
import {rental} from '../support/bin-collection-request-fixtures.js';
after(closeDb);
test('price migration: failed DDL rolls back every constraint and preserves accepted rows',async()=>{
  await rental(false,'soil');
  const original=await readFile('migrations/142_mbt_frontdesk_customer_charge_requests.sql','utf8');
  const migration=await readFile('migrations/307_bin_order_price_changes.sql','utf8');
  const names=[...migration.matchAll(/DROP CONSTRAINT (\w+);/gu)].map(m=>m[1]);
  for(const name of names){
    const start=original.indexOf(`CONSTRAINT ${name}\n`);
    assert.ok(start>=0);
    const end=original.indexOf(',\n  CONSTRAINT',start);
    assert.ok(end>start);
    await query(`ALTER TABLE mbt_frontdesk_charge_requests DROP CONSTRAINT ${name}, ADD ${original.slice(start,end)}`);
  }
  const constraints=()=>query("SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='mbt_frontdesk_charge_requests'::regclass ORDER BY conname");
  const before=(await constraints()).rows;
  const rows=(await query('SELECT * FROM mbt_frontdesk_charge_requests ORDER BY charge_request_id')).rows;
  assert.ok(rows.length>0);
  await assert.rejects(withTransaction(async()=>{await query(migration);await query('SELECT 1/0');}),{code:'22012'});
  assert.deepEqual((await constraints()).rows,before);
  assert.deepEqual((await query('SELECT * FROM mbt_frontdesk_charge_requests ORDER BY charge_request_id')).rows,rows);
  await withTransaction(async()=>{await query(migration);});
  assert.ok((await constraints()).rows.find(r=>r.conname.endsWith('_kind')).definition.includes('change_bin'));
  assert.deepEqual((await query('SELECT * FROM mbt_frontdesk_charge_requests ORDER BY charge_request_id')).rows,rows);
});
