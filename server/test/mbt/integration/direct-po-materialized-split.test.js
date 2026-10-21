import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { after } from 'node:test';
import fc from 'fast-check';
import { beginRollbackContext, closeDb, query, withTransaction } from '../../../src/db.js';
import { listScmSchedule } from '../../../src/dispatch-repository.js';
import { recoverDirectPoScheduleCompletion } from '../../../tools/direct-po-split-status-recovery.mjs';

after(closeDb);
const PO_ID = -997151885;
const PO = 'SN-MATERIALIZED-TEST';
const GROUP = 'GO-MATERIALIZED-TEST';
const AT = '2026-10-13T15:39:49.216Z';
async function scenario(run) {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  const tx = await beginRollbackContext();
  try { await tx.run(run); } finally { await tx.rollback(); }
}

async function fixture({ suffix = 3, quantity = 1984 } = {}) {
  await query(`INSERT INTO purchase_orders(netsuite_id,tranid,status,status_text,vendor,netsuite_active)
    VALUES($1,$2,'B','Pending Receipt','Test vendor',true)`, [PO_ID, PO]);
  await query("INSERT INTO scm_transport_schedule(order_kind,order_ref,status) VALUES('PO',$1,'Queued')", [PO]);
  const plan = (await query("INSERT INTO dispatch_plans(plan_date,status) VALUES('2026-10-13','confirmed') RETURNING id")).rows[0];
  const children = [], allocations = [];
  for (const [index, item, qty, unit] of [[1,2055,quantity,'SQFT'],[2,1784,32,'EACH']]) {
    const ref = `SO-MATERIALIZED-${index}-S${suffix}`, soId = PO_ID - index;
    const name = index === 1 ? 'MBBS-Special Order' : 'PALLET';
    const description = index === 1 ? 'Umbriano 24x24' : '**PALLET DEPOSIT** INTERLOCK,CEMENT, CONCRETE';
    await query(`INSERT INTO sales_orders(netsuite_id,tranid,status,status_text,netsuite_active)
      VALUES($1,$2,'B','Pending Fulfillment',true)`, [soId,ref]);
    const sales = (await query(`INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_type,
      item_name,sku,item_description,quantity,unit,netsuite_active) VALUES($1,$2,$3,'NonInvtPart',$4,$4,$5,$6,$7,true) RETURNING id`,
    [soId,4997300 + index,item,name,description,qty,unit])).rows[0];
    const purchase = (await query(`INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_id,item_type,
      item_name,sku,item_description,quantity,unit,netsuite_active) VALUES($1,$2,$3,'NonInvtPart',$4,$4,$5,$6,$7,true) RETURNING id`,
    [PO_ID,index,item,name,description,qty,unit])).rows[0];
    const allocation = (await query(`INSERT INTO dispatch_so_po_allocations(sales_order_id,sales_order_ref,sales_line_id,
      po_order_id,po_order_ref,po_line_id,item_id,allocated_sales_qty,dispatch_target_ref,dispatch_target_kind,dispatch_target_line_key)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'group',$10) RETURNING id`,
    [soId,ref,sales.id,PO_ID,PO,purchase.id,item,qty,GROUP,`${GROUP}::${ref}::${sales.id}`])).rows[0];
    children.push({id:ref,type:'SO',items:[{lineRowId:470000 + index,lineId:4997300 + index,itemId:item,quantity:qty,splitQty:qty,unit}]});
    allocations.push(allocation.id);
  }
  const definition = { id: GROUP, type: 'SO', childOrders: children.map(c => c.id), childOrderDetails: children };
  await query(`INSERT INTO dispatch_global_order_groups(group_ref,order_type,source_plan_id,source_plan_date,full_order,card)
    VALUES($1,'SO',$2,'2026-10-13',$3::jsonb,$3::jsonb)`, [GROUP,plan.id,JSON.stringify(definition)]);
  return { plan, children, allocations, definition };
}

async function job(f, { refs = f.children.map(c => c.id), stop = 'dropoff', kind = 'SO', name = stop } = {}) {
  return (await query(`INSERT INTO driver_job_records(job_id,plan_id,plan_date,driver_login,load_id,stop_id,
    stop_type,order_refs,status,completed_at,job_details)
    VALUES($1,$2,'2026-10-13','test-driver','test-load',$1,$3,$4::jsonb,'complete',$5,$6::jsonb) RETURNING *`,
  [name,f.plan.id,stop,JSON.stringify(refs),AT,JSON.stringify({orderTypes:[kind],orders:refs.map(ref=>({orderRef:ref,orderType:kind}))})])).rows[0];
}
const refsFor = async id => (await query('SELECT dispatch_po_allocation_delivery_refs($1) AS refs', [id])).rows[0].refs;
const status = async () => (await listScmSchedule({exactRefs:[PO]}))[0].calculatedStatus;

test('materialized split references match the exact allocation and advance Direct ship through In Transit to Completed', () => scenario(async () => {
  const f = await fixture();
  assert.deepEqual(await refsFor(f.allocations[0]), [f.children[0].id]);
  assert.deepEqual(await refsFor(f.allocations[1]), [f.children[1].id]);
  assert.equal(await status(), 'Direct ship');
  await job(f, {stop:'pickup',refs:[f.children[0].id]});
  assert.equal(await status(), 'In Transit');
  await job(f);
  assert.equal(await status(), 'Completed');
  const event = (await query("SELECT * FROM dispatch_order_completion_status WHERE order_kind='PO' AND order_ref=$1", [PO])).rows[0];
  assert.equal(new Date(event.dispatch_completed_at).toISOString(), AT);
  await job(f, {name:'duplicate-proof'});
  assert.equal((await query("SELECT count(*)::int AS n FROM dispatch_order_completion_status WHERE order_kind='PO' AND order_ref=$1", [PO])).rows[0].n, 1);
}));

test('sibling split deliveries cannot satisfy the allocated materialized split', () => scenario(async () => {
  const f = await fixture();
  const sibling = structuredClone(f.children[0]);
  sibling.id = sibling.id.replace(/-S3$/u, '-S2');
  f.definition.childOrders.push(sibling.id);
  f.definition.childOrderDetails.push(sibling);
  await query('UPDATE dispatch_global_order_groups SET full_order=$2::jsonb WHERE group_ref=$1', [GROUP,JSON.stringify(f.definition)]);
  assert.deepEqual(await refsFor(f.allocations[0]), [f.children[0].id]);
  await job(f, {refs:[sibling.id,f.children[1].id]});
  assert.notEqual(await status(), 'Completed');
  await job(f, {refs:[f.children[0].id],name:'correct-split'});
  assert.equal(await status(), 'Completed');
}));

test('wrong item, wrong source line, insufficient quantity, and missing group membership remain blocked', () => scenario(async () => {
  const f = await fixture();
  for (const mutate of [
    d => { d.childOrderDetails[0].items[0].itemId = 999999; },
    d => { d.childOrderDetails[0].items[0].lineId = 999999; },
    d => { d.childOrderDetails[0].items[0].splitQty = 1983; },
    d => { d.childOrders = [f.children[1].id]; }
  ]) {
    const invalid = structuredClone(f.definition); mutate(invalid);
    await query('UPDATE dispatch_global_order_groups SET full_order=$2::jsonb WHERE group_ref=$1', [GROUP,JSON.stringify(invalid)]);
    assert.deepEqual(await refsFor(f.allocations[0]), []);
  }
}));

test('property: arbitrary split suffixes and quantities recognize only the exact split', () => scenario(async () => {
  await fc.assert(fc.asyncProperty(fc.integer({min:1,max:40}),fc.integer({min:1,max:10000}),async (suffix,quantity) => {
    await withTransaction(async () => {
      const f = await fixture({suffix,quantity});
      assert.deepEqual(await refsFor(f.allocations[0]),[f.children[0].id]);
      let proof;
      await query('ALTER TABLE driver_job_records DISABLE TRIGGER trg_driver_job_z_direct_po_link_completion');
      try { proof=await job(f); } finally { await query('ALTER TABLE driver_job_records ENABLE TRIGGER trg_driver_job_z_direct_po_link_completion'); }
      const input={poId:PO_ID,poRef:PO,driverJobRecordId:proof.id};
      const first=await recoverDirectPoScheduleCompletion(input);
      assert.equal((await recoverDirectPoScheduleCompletion(input)).completionEventId,first.completionEventId);
      assert.equal((await query('SELECT count(*)::int AS n FROM dispatch_direct_po_ir_jobs WHERE local_po_id=$1',[PO_ID])).rows[0].n,0);
      f.definition.childOrderDetails[0].items[0].itemId=999999;
      await query('UPDATE dispatch_global_order_groups SET full_order=$2::jsonb WHERE group_ref=$1',[GROUP,JSON.stringify(f.definition)]);
      assert.deepEqual(await refsFor(f.allocations[0]),[]);
      f.definition.childOrderDetails[0].items[0].itemId=2055;
      f.definition.childOrderDetails[0].id = `SO-MATERIALIZED-1-S${suffix+1}`;
      f.definition.childOrders[0] = f.definition.childOrderDetails[0].id;
      await query('UPDATE dispatch_global_order_groups SET full_order=$2::jsonb WHERE group_ref=$1',[GROUP,JSON.stringify(f.definition)]);
      assert.deepEqual(await refsFor(f.allocations[0]),[]);
    },{rollback:true});
  }),{seed:1401885,numRuns:40});
}));

test('historical completion recovery preserves source records, creates no receipt, rolls back and is idempotent', () => scenario(async () => {
  const f = await fixture();
  let proof;
  await query('ALTER TABLE driver_job_records DISABLE TRIGGER trg_driver_job_z_direct_po_link_completion');
  try { proof = await job(f); } finally { await query('ALTER TABLE driver_job_records ENABLE TRIGGER trg_driver_job_z_direct_po_link_completion'); }
  const state = async () => (await query(`SELECT jsonb_build_object(
    'order',(SELECT to_jsonb(p) FROM purchase_orders p WHERE netsuite_id=$1),
    'lines',(SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM purchase_order_lines l WHERE purchase_order_id=$1),
    'allocations',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM dispatch_so_po_allocations a WHERE po_order_id=$1),
    'proof',(SELECT to_jsonb(j) FROM driver_job_records j WHERE id=$2),
    'receipts',(SELECT jsonb_agg(to_jsonb(j) ORDER BY id) FROM dispatch_direct_po_ir_jobs j WHERE local_po_id=$1)) AS state`, [PO_ID,proof.id])).rows[0].state;
  const original = await state();
  const input = {poId:PO_ID,poRef:PO,driverJobRecordId:proof.id};
  await withTransaction(async () => {
    await recoverDirectPoScheduleCompletion(input);
    assert.equal(await status(),'Completed');
  },{rollback:true});
  assert.notEqual(await status(),'Completed');
  const first = await recoverDirectPoScheduleCompletion(input);
  const second = await recoverDirectPoScheduleCompletion(input);
  assert.equal(second.completionEventId,first.completionEventId);
  assert.equal(await status(),'Completed');
  assert.deepEqual(await state(),original);
  const events=(await query("SELECT * FROM dispatch_order_completion_events WHERE order_kind='PO' AND order_ref=$1",[PO])).rows;
  assert.equal(events.length,1);
  assert.equal(new Date(events[0].dispatch_completed_at).toISOString(),AT);
  assert.equal(events[0].completion_evidence_id,proof.job_id);
  assert.equal(events[0].metadata.directShipCoverageVerified,false);
  assert.equal(events[0].metadata.directTransportCoverageVerified,true);
}));

test('recovery refuses wrong PO identity, wrong driver proof, and an unfinished split', () => scenario(async () => {
  const f=await fixture();
  const proof=await job(f,{refs:['SO-UNRELATED-S3']});
  const input={poId:PO_ID,poRef:PO,driverJobRecordId:proof.id};
  await assert.rejects(recoverDirectPoScheduleCompletion({...input,poRef:'SN-OTHER'}),/identity/u);
  await assert.rejects(recoverDirectPoScheduleCompletion(input),/delivery proof/u);
  assert.equal(await status(),'Direct ship');
  assert.equal((await query('SELECT count(*)::int AS n FROM dispatch_direct_po_ir_jobs WHERE local_po_id=$1',[PO_ID])).rows[0].n,0);
}));

test('unexpected receipt queue admission aborts the entire historical status repair', () => scenario(async () => {
  const f=await fixture(); let proof;
  await query('ALTER TABLE driver_job_records DISABLE TRIGGER trg_driver_job_z_direct_po_link_completion');
  try { proof=await job(f); } finally { await query('ALTER TABLE driver_job_records ENABLE TRIGGER trg_driver_job_z_direct_po_link_completion'); }
  await query(`CREATE FUNCTION pg_temp.inject_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.metadata->>'statusOnlyRecovery'='true' THEN
      INSERT INTO dispatch_direct_po_ir_jobs(completion_event_id,local_po_id) VALUES(NEW.id,(NEW.metadata->>'poOrderId')::bigint);
    END IF; RETURN NEW; END $$`);
  await query(`CREATE TRIGGER test_status_repair_receipt AFTER INSERT ON dispatch_order_completion_events
    FOR EACH ROW EXECUTE FUNCTION pg_temp.inject_receipt()`);
  await assert.rejects(recoverDirectPoScheduleCompletion({poId:PO_ID,poRef:PO,driverJobRecordId:proof.id}),/must not create receipt/u);
  assert.notEqual(await status(),'Completed');
  assert.equal((await query('SELECT count(*)::int AS n FROM dispatch_direct_po_ir_jobs WHERE local_po_id=$1',[PO_ID])).rows[0].n,0);
}));

test('SQL function replacement and migration rollback preserve the previously installed definition', () => scenario(async () => {
  const current=await query("SELECT pg_get_functiondef('dispatch_po_allocation_delivery_refs(bigint)'::regprocedure) AS sql");
  const f=await fixture();
  const old=await readFile(new URL('../../../migrations/257_direct_linked_po_group_completion.sql',import.meta.url),'utf8');
  await withTransaction(async () => {
    await query(old.slice(old.indexOf('CREATE OR REPLACE FUNCTION dispatch_po_allocation_delivery_refs'),old.indexOf('CREATE OR REPLACE FUNCTION dispatch_po_driver_job_has_so')));
    assert.deepEqual(await refsFor(f.allocations[0]),[]);
    await query(await readFile(new URL('../../../migrations/291_direct_po_materialized_split_status.sql',import.meta.url),'utf8'));
    assert.deepEqual(await refsFor(f.allocations[0]),[f.children[0].id]);
  },{rollback:true});
  const restored=await query("SELECT pg_get_functiondef('dispatch_po_allocation_delivery_refs(bigint)'::regprocedure) AS sql");
  assert.equal(restored.rows[0].sql,current.rows[0].sql);
}));

test('a reopened driver visit cannot be recovered as current completion', () => scenario(async () => {
  const f=await fixture(); let proof;
  await query('ALTER TABLE driver_job_records DISABLE TRIGGER trg_driver_job_z_direct_po_link_completion');
  try { proof=await job(f); } finally { await query('ALTER TABLE driver_job_records ENABLE TRIGGER trg_driver_job_z_direct_po_link_completion'); }
  await query(`INSERT INTO driver_job_corrections(correction_id,idempotency_id,action,driver_job_record_id,
    job_id,plan_id,plan_date,driver_login,expected_state_hash,audit_note,corrected_by,before_state,after_state)
    VALUES(gen_random_uuid(),gen_random_uuid(),'reopen',$1,$2,$3,'2026-10-13','test-driver',
      repeat('a',64),'Test reopened proof','test-actor','{}','{}')`,[proof.id,proof.job_id,f.plan.id]);
  await assert.rejects(recoverDirectPoScheduleCompletion({poId:PO_ID,poRef:PO,driverJobRecordId:proof.id}),/superseded/u);
  assert.notEqual(await status(),'Completed');
}));
