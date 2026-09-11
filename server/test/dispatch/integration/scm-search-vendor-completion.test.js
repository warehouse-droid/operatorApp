import assert from "node:assert/strict";
import test, { after } from "node:test";
import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import { listScmSchedule } from "../../../src/dispatch-repository.js";
import { enrichScmScheduleWithReconciliation } from "../../../src/scm-reconciliation-repository.js";
import { completeScmVendorOrder } from "../../../src/scm-vendor-completion.js";

after(closeDb);
let serial = 0;
const actor = { id: "scm-vendor-test", role: "scm" };
async function rollback(run) {
  const context = await beginRollbackContext();
  try { return await context.run(run); } finally { await context.rollback(); }
}
async function fixture({ status = "Queued", method = "Vendor", kind = "PO" } = {}) {
  const id = 878000000000 + (++serial);
  const ref = `${kind}-VENDOR-SEARCH-${id}`;
  if (kind === "PO") {
    await query(`INSERT INTO purchase_orders (netsuite_id,tranid,status,status_text,initial_scm_status,netsuite_active,vendor,destination_location,synced_at)
      VALUES ($1,$2,'B','Purchase Order : Pending Receipt',$3,true,'Vendor Search Fixture','2967',now())`, [id,ref,status === "Hold" ? "Hold" : "Queued"]);
  } else if (kind === "TO") {
    await query(`INSERT INTO transfer_orders (netsuite_id,tranid,status,status_text,netsuite_active,from_location,to_location,synced_at)
      VALUES ($1,$2,'B','Transfer Order : Pending Fulfillment',true,'3445','2967',now())`, [id,ref]);
  } else {
    await query(`INSERT INTO scm_vrma_orders (vrma_ref,status,method,vendor,pickup_location,dropoff_location,created_by,updated_by)
      VALUES ($1,$2,$3,'Vendor Search Fixture','3445','2967','test','test')`, [ref,status,method]);
  }
  const {rows:[schedule]} = await query(`INSERT INTO scm_transport_schedule (order_kind,order_ref,method,status,pickup_point,created_by,updated_by)
    VALUES ($1,$2,$3,$4,'Vendor Search Fixture','test','test') RETURNING updated_at::text AS revision`, [kind,ref,method,status]);
  return { id,ref,kind,revision:schedule.revision };
}
const input = (row, extra = {}) => ({ orderKind:row.kind,orderRef:row.ref,expectedUpdatedAt:row.revision,actor,...extra });

test("search includes every SCM status and overrides selected statuses", () => rollback(async () => {
  const rows = [];
  for (const status of ["Queued","Hold","Cancelled","Completed"]) { rows.push(await fixture({status})); }
  const found = await listScmSchedule({search:"VENDOR-SEARCH",view:"scm working",status:"Queued"});
  assert.deepEqual(new Set(found.map(row=>row.orderRef)), new Set(rows.map(row=>row.ref)));
  const historySearch = await listScmSchedule({search:rows[0].ref,view:"completed"});
  assert.equal(historySearch.length,1);
  const cleared = await listScmSchedule({search:"   ",view:"scm working",exactRef:rows[3].ref});
  assert.equal(cleared.length,0);
  const restricted = await listScmSchedule({search:rows[1].ref,audience:"operations"});
  assert.equal(restricted.length,0);
  const wrongMethod = await listScmSchedule({search:rows[3].ref,method:"MBT"});
  assert.equal(wrongMethod.length,0);
}));

test("search finds a fully received, reconciliation-completed PO with an old Queued schedule", () => rollback(async () => {
  const row=await fixture();
  await query(`INSERT INTO purchase_order_lines (purchase_order_id,line_id,quantity,unit,netsuite_received_qty,netsuite_active)
    VALUES ($1,1,1232,'EA',1232,true)`,[row.id]);
  await query(`SELECT dispatch_record_order_completion('PO',$1,now(),'reconciliation',$2)`,[row.ref,`search-fixture:${row.id}`]);
  const found=await listScmSchedule({search:row.ref,view:"scm working"});
  assert.equal(found.length,1);
  assert.equal(found[0].calculatedStatus,"Completed");
}));

for(const kind of ["PO","TO","VRMA"]) { test(`Vendor ${kind} completes locally without plans, drivers, receipts, or NetSuite`,()=>rollback(async()=>{
  const row=await fixture({kind});
  const network=globalThis.fetch;
  globalThis.fetch=()=>{throw new Error("Vendor completion attempted network access");};
  try {
    const result=await completeScmVendorOrder(input(row));
    assert.equal(result.completed,true);
    assert.equal(result.idempotent,false);
    const evidence=await query(`SELECT * FROM dispatch_order_completion_events WHERE order_kind=$1 AND order_ref=$2`,[kind,row.ref]);
    assert.equal(evidence.rowCount,1);
    assert.equal(evidence.rows[0].completion_evidence_type,"scm_vendor");
    assert.equal(evidence.rows[0].actor_id,actor.id);
    assert.equal(evidence.rows[0].plan_id,null);
    assert.equal(evidence.rows[0].metadata.netSuiteUpdated,false);
    const status=await query("SELECT status FROM scm_transport_schedule WHERE order_kind=$1 AND order_ref=$2",[kind,row.ref]);
    assert.equal(status.rows[0].status,"Completed");
    assert.equal((await query("SELECT count(*)::int AS count FROM dispatch_sales_order_if_candidates WHERE completion_event_id=$1",[evidence.rows[0].id])).rows[0].count,0);
    const replay=await completeScmVendorOrder(input(row));
    assert.equal(replay.idempotent,true);
    assert.equal((await query("SELECT count(*)::int AS count FROM dispatch_order_completion_events WHERE order_ref=$1",[row.ref])).rows[0].count,1);
    if(kind==="PO") {
      assert.equal((await query("SELECT status FROM purchase_orders WHERE netsuite_id=$1",[row.id])).rows[0].status,"B");
      await query("UPDATE scm_transport_schedule SET status='Queued',updated_at=now()+interval '1 minute' WHERE order_ref=$1",[row.ref]);
      const shown=await enrichScmScheduleWithReconciliation(await listScmSchedule({search:row.ref}),{});
      assert.equal(shown[0].calculatedStatus,"Completed");
    }
  } finally {globalThis.fetch=network;}
})); }

for(const [name,patch,options,code] of [
  ["unauthorized actor",{actor:{id:"outsider",role:"dispatcher"}},{},403],
  ["forged client method",{method:"Vendor"},{method:"MBT"},409],
  ["stale revision",{expectedUpdatedAt:"2000-01-01T00:00:00Z"},{},409],
  ["cancelled order",{},{status:"Cancelled"},409],
  ["missing order",{orderRef:"PO-NOT-FOUND"},{},404],
  ["unsupported order type",{orderKind:"SO"},{},400],
  ["missing revision",{expectedUpdatedAt:null},{},409]
]) { test(`Vendor completion rejects ${name} without writes`,()=>rollback(async()=>{
  const row=await fixture(options);
  await assert.rejects(completeScmVendorOrder(input(row,patch)),error=>error.status===code);
  assert.equal((await query("SELECT count(*)::int AS count FROM dispatch_order_completion_events WHERE order_ref=$1",[row.ref])).rows[0].count,0);
  assert.equal((await query("SELECT status FROM scm_transport_schedule WHERE order_ref=$1",[row.ref])).rows[0].status,options.status||"Queued");
})); }

test("local Vendor evidence takes precedence over inferred reconciliation completion",()=>rollback(async()=>{
  const row=await fixture();
  await query(`SELECT dispatch_record_order_completion('PO',$1,now(),'reconciliation',$2)`,[row.ref,`prior:${row.id}`]);
  await completeScmVendorOrder(input(row));
  const {rows:[completion]}=await query("SELECT completion_evidence_type FROM dispatch_order_completion_status WHERE order_ref=$1",[row.ref]);
  assert.equal(completion.completion_evidence_type,"scm_vendor");
}));

test("review, orphan, ambiguous reference, and sub-millisecond changes cannot be completed",()=>rollback(async()=>{
  const blocked=await fixture();
  await query("UPDATE scm_transport_schedule SET reconciliation_blocked=true WHERE order_ref=$1",[blocked.ref]);
  await assert.rejects(completeScmVendorOrder(input(blocked)),error=>error.code==="SCM_VENDOR_ORDER_BLOCKED");
  const orphan=await fixture();
  await query("DELETE FROM purchase_orders WHERE netsuite_id=$1",[orphan.id]);
  await assert.rejects(completeScmVendorOrder(input(orphan)),error=>error.status===404);
  const duplicate=await fixture();
  await query("INSERT INTO scm_transport_schedule (order_kind,order_ref,method,status) VALUES ('PO',lower($1),'Vendor','Queued')",[duplicate.ref]);
  await assert.rejects(completeScmVendorOrder(input(duplicate)),error=>error.code==="SCM_VENDOR_ORDER_AMBIGUOUS");
  const precise=await fixture();
  await query("UPDATE scm_transport_schedule SET updated_at='2026-09-10T12:00:00.123456Z' WHERE order_ref=$1",[precise.ref]);
  await assert.rejects(completeScmVendorOrder(input(precise,{expectedUpdatedAt:'2026-09-10T12:00:00.123455Z'})),error=>error.code==="SCM_VENDOR_STALE");
}));

test("failed schedule update rolls back the immutable completion evidence",()=>rollback(async()=>{
  const row=await fixture();
  await query(`CREATE FUNCTION pg_temp.reject_vendor_complete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.status='Completed' THEN RAISE EXCEPTION 'injected completion storage failure'; END IF; RETURN NEW; END $$`);
  await query(`CREATE TRIGGER scm_vendor_failure_test BEFORE UPDATE ON scm_transport_schedule FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_vendor_complete()`);
  await assert.rejects(completeScmVendorOrder(input(row)),/injected completion storage failure/);
  assert.equal((await query("SELECT count(*)::int AS count FROM dispatch_order_completion_events WHERE order_ref=$1",[row.ref])).rows[0].count,0);
  assert.equal((await query("SELECT status FROM scm_transport_schedule WHERE order_ref=$1",[row.ref])).rows[0].status,"Queued");
}));
