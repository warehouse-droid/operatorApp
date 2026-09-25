import assert from 'node:assert/strict';
import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import pg from 'pg';
const url=new URL(process.env.DATABASE_URL);
assert.equal(process.env.MBT_TEST_ISOLATED,'1');assert.match(url.pathname,/mbt_test/);
const adminUrl=new URL(url);adminUrl.pathname='/postgres';
const admin=new pg.Client({connectionString:adminUrl.href});await admin.connect();
const name='mbt_test_file_50a188aabbcc_migration';
await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
await admin.query(`CREATE DATABASE ${name}`);url.pathname=`/${name}`;
const db=new pg.Client({connectionString:url.href});await db.connect();
try {
 for(const file of readdirSync('migrations').filter(file=>file.endsWith('.sql')&&file<'222_').sort())await db.query(readFileSync(`migrations/${file}`,'utf8'));
 const before=(await db.query("SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='dispatch_custom_orders'::regclass ORDER BY conname")).rows;
 const sql=readFileSync('migrations/222_sor_rental_returns.sql','utf8');
 await db.query('BEGIN');await db.query(sql);
 assert.equal((await db.query("SELECT to_regclass('sor_item_policies') AS name")).rows[0].name,'sor_item_policies');
 await db.query('ROLLBACK');
 assert.equal((await db.query("SELECT to_regclass('sor_item_policies') AS name")).rows[0].name,null);
 assert.deepEqual((await db.query("SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='dispatch_custom_orders'::regclass ORDER BY conname")).rows,before);
 await db.query('BEGIN');await db.query(sql);await db.query('COMMIT');
 assert.equal((await db.query('SELECT returns_enabled FROM sor_signature_settings')).rows[0].returns_enabled,false);
 const triggers=(await db.query("SELECT tgname FROM pg_trigger WHERE tgname IN ('sor_header_changed','sor_lines_changed','sor_splits_changed','sor_assignments_changed')")).rows;
 assert.equal(triggers.length,4);
 writeFileSync('test-artifacts/sor-rentals/migration-result.json',JSON.stringify({passed:true,rollbackRestoresConstraints:true,activationInitiallyDisabled:true,triggers:triggers.map(row=>row.tgname)}));
 console.log('SOR migration apply, rollback and reapply passed.');
} finally {await db.end();await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);await admin.end();}
