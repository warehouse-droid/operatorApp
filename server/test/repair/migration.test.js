import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {query,withTransaction,closeDb} from '../../src/db.js';
assert.equal(process.env.MBT_TEST_ISOLATED,'1');after(closeDb);
test('Repair migration rolls back schema, settings and authority changes after an aborted deployment',async()=>{
 const schema='repair_rehearsal_'+randomUUID().replaceAll('-','');
 const migration=await fs.readFile(process.env.REPAIR_MIGRATION_FILE||'migrations/310_repair.sql','utf8');
 await withTransaction(async()=>{
  await query(`CREATE SCHEMA ${schema}`);await query(`SET LOCAL search_path TO ${schema},public`);
  await query("CREATE TABLE operators(id bigint PRIMARY KEY,role text,roles text[]); CREATE TABLE dispatch_trucks(id bigint PRIMARY KEY)");
  await query("INSERT INTO operators VALUES(1,'mbr_sales',ARRAY['mbr_sales'])");
  await query(migration);
  assert.equal((await query('SELECT data FROM repair_settings')).rows[0].data.inspectionFeeMinor,15000);
  await query("INSERT INTO operators VALUES(2,'repair_technician',ARRAY['repair_technician']), (3,'repair_office',ARRAY['repair_office'])");
  await assert.rejects(withTransaction(()=>query("INSERT INTO operators VALUES(4,'unknown_authority',ARRAY['repair_office'])")),error=>error.code==='23514');
  assert.equal((await query('SELECT role FROM operators WHERE id=1')).rows[0].role,'mbr_sales');
  await query(await fs.readFile('migrations/313_repair_equipment_masters.sql','utf8'));
  const settings=(await query('SELECT data FROM repair_settings')).rows[0].data;
  assert.equal(settings.mappings.mbbsCustomerId,'7143');assert.equal(settings.postingEnabled,false);
  await query("INSERT INTO repair_vehicles(id,machine_id,company,customer_id) VALUES($1,42,'MBR','13366')",[randomUUID()]);
  await assert.rejects(withTransaction(()=>query("INSERT INTO repair_vehicles(id,machine_id,company,customer_id) VALUES($1,42,'MBR','13366')",[randomUUID()])),error=>error.code==='23505');
 },{rollback:true});
 assert.equal((await query('SELECT to_regnamespace($1) AS schema',[schema])).rows[0].schema,null);
 assert.ok((await query("SELECT to_regclass('public.repair_requests') AS original")).rows[0].original,'the disposable application schema is intact');
});

test('local PO migration preserves invoices and rolls back its schema and sequence on failure',async()=>{
 const schema='repair_po_rehearsal_'+randomUUID().replaceAll('-','');
 await withTransaction(async()=>{
  await query(`CREATE SCHEMA ${schema}`);await query(`SET LOCAL search_path TO ${schema},public`);await query('CREATE TABLE operators(id bigint PRIMARY KEY,role text,roles text[]); CREATE TABLE dispatch_trucks(id bigint PRIMARY KEY)');await query(await fs.readFile('migrations/310_repair.sql','utf8'));
  const existing=randomUUID();await query("INSERT INTO repair_purchases(id,vendor_id,invoice_ref,purchase_date,created_by) VALUES($1,'12821','OLD-INVOICE','2026-10-27','office')",[existing]);
  await query(await fs.readFile('migrations/316_repair_local_purchase_orders.sql','utf8'));
  for(const poNumber of ['PO-1','PO-2'])await query("INSERT INTO repair_purchases(id,vendor_id,invoice_ref,purchase_date,status,created_by,data) VALUES($1,'12821','','2026-10-27','ordered','office',$2)",[randomUUID(),{poNumber}]);
  await assert.rejects(withTransaction(()=>query("INSERT INTO repair_purchases(id,vendor_id,invoice_ref,purchase_date,created_by) VALUES($1,'12821','','2026-10-27','office')",[randomUUID()])),error=>error.code==='23514');
  await assert.rejects(withTransaction(()=>query("INSERT INTO repair_purchases(id,vendor_id,invoice_ref,purchase_date,created_by) VALUES($1,'12821',' old-invoice ','2026-10-27','office')",[randomUUID()])),error=>error.code==='23505');
  assert.equal((await query('SELECT invoice_ref,status FROM repair_purchases WHERE id=$1',[existing])).rows[0].invoice_ref,'OLD-INVOICE');assert.equal((await query('SELECT count(*) FROM repair_purchases')).rows[0].count,'3');
 },{rollback:true});
 assert.equal((await query('SELECT to_regnamespace($1) AS schema',[schema])).rows[0].schema,null);assert.equal((await query('SELECT to_regclass($1) AS sequence',[schema+'.repair_local_po_number_seq'])).rows[0].sequence,null);
});
test('legacy request migrates to its initial repair job without changing histories, quantities or NetSuite links',async()=>{
 const schema='repair_jobs_rehearsal_'+randomUUID().replaceAll('-','');
 await withTransaction(async()=>{
  await query(`CREATE SCHEMA ${schema}`);await query(`SET LOCAL search_path TO ${schema},public`);await query('CREATE TABLE operators(id bigint PRIMARY KEY,role text,roles text[]); CREATE TABLE dispatch_trucks(id bigint PRIMARY KEY)');await query(await fs.readFile('migrations/310_repair.sql','utf8'));
  const vehicle=randomUUID(),request=randomUUID(),oldQuote=randomUUID(),quote=randomUUID(),partRequest=randomUUID(),work=randomUUID();
  await query("INSERT INTO repair_vehicles(id,company,customer_id) VALUES($1,'MBT','7973')",[vehicle]);
  await query("INSERT INTO repair_requests(id,vehicle_id,company,requester_type,requester_id,condition,status,inspection_fee_minor,inspection_tax_bps,revision,data) VALUES($1,$2,'MBT','driver','1','out_of_service','in_progress',15000,1300,7,$3)",[request,vehicle,{inspectionComplete:true,phase:'repair',worId:'501',sosId:'502',defect:'Legacy fault'}]);
  for(const [id,version,status] of [[oldQuote,1,'superseded'],[quote,2,'decided']])await query('INSERT INTO repair_quotes(id,request_id,version,status,lines,created_by) VALUES($1,$2,$3,$4,$5,\'office\')',[id,request,version,status,JSON.stringify([{id:'legacy',decision:'approved',amountMinor:10000,taxMinor:1300}])]);
  await query("INSERT INTO repair_part_requests(id,request_id,quote_id,quote_line_id,description,quantity_milli,created_by) VALUES($1,$2,$3,'legacy','Legacy part',3000,'tech')",[partRequest,request,quote]);
  await query("INSERT INTO repair_work_entries(id,request_id,phase,actor,data) VALUES($1,$2,'repair','tech',$3)",[work,request,{done:'Legacy repair notes',hoursMilli:2000}]);
  for(const file of ['316_repair_local_purchase_orders.sql','317_repair_quote_scopes.sql','318_repair_work_jobs.sql'])await query(await fs.readFile('migrations/'+file,'utf8'));
  const job=(await query('SELECT * FROM repair_jobs WHERE id=$1',[request])).rows[0];assert.equal(job.request_id,request);assert.equal(job.revision,7);assert.equal(job.data.inspectionRequired,true);assert.equal(job.data.inspectionComplete,true);
  assert.equal((await query('SELECT job_id FROM repair_work_entries WHERE id=$1',[work])).rows[0].job_id,request);const part=(await query('SELECT job_id,quantity_milli FROM repair_part_requests WHERE id=$1',[partRequest])).rows[0];assert.equal(part.job_id,request);assert.equal(Number(part.quantity_milli),3000);
  const history=(await query('SELECT job_id,scope_id,scope_revision,status FROM repair_quotes ORDER BY version')).rows;assert.equal(history.length,2);assert.equal(history[0].status,'superseded');assert.equal(history[1].scope_revision,2);assert.ok(history.every(q=>q.job_id===request&&q.scope_id===request));
  const parent=(await query('SELECT data FROM repair_requests WHERE id=$1',[request])).rows[0];assert.equal(parent.data.worId,'501');assert.equal(parent.data.sosId,'502');
 },{rollback:true});assert.equal((await query('SELECT to_regnamespace($1) AS schema',[schema])).rows[0].schema,null);
});
