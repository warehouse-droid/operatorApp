// Data-only correction. Run inside /app; default mode rolls the entire change back.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { query, withTransaction, closeDb } from "/app/src/db.js";
import { lockConsolidatedLoadOrders } from "/app/src/consolidation-load-locks.js";
import { DISPATCH_FLEET_PLANNING_LOCK } from "/app/src/dispatch-fleet-status.js";
import { writeAudit } from "/app/src/auth-repository.js";
import { writeDispatchAudit } from "/app/src/dispatch-audit-repository.js";
import { listDispatchOrders } from "/app/src/dispatch-repository.js";
import { upsertDispatchOrderCatalog, getDispatchOrderCatalogOrder } from "/app/src/dispatch-order-catalog-repository.js";

const repairId = "som06255-som06256-move-loads-20261001";
const targets = [
  {parent:"SOM06255",parentId:"980538",from:"SOM06255-S2",fromId:"-258416193066378",fromLine:"-39847566315893",fromKey:"4902668",fromQty:1274.4,to:"SOM06255-S1",toId:"-14850163832951",toLine:"-219104741028314",toKey:"4902669",toQty:1489.29,recordId:"1098"},
  {parent:"SOM06256",parentId:"980542",from:"SOM06256-S2",fromId:"-249382364623888",fromLine:"-281139366017401",fromKey:"4902689",fromQty:52.75,to:"SOM06256-S1",toId:"-59981265766031",toLine:"-67332401643328",toKey:"4902690",toQty:211,recordId:"1097"}
];
const parents = targets.map(t=>t.parent);
const refs = targets.flatMap(t=>[t.parent,t.from,t.to]);
const ids = targets.flatMap(t=>[t.parentId,t.fromId,t.toId]);
const recordIds = targets.map(t=>t.recordId);
const packedFields = ["packed_pallet_qty","packed_layer_qty","packed_section_qty","packed_piece_qty","packed_sales_qty"];
const rows = async (sql,params=[]) => (await query(sql,params)).rows;
const canonical = value => JSON.stringify(value,(_key,v)=>v && typeof v === "object" && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])) : v);
const digest = value => createHash("sha256").update(canonical(value)).digest("hex");
const omit = (row,fields) => Object.fromEntries(Object.entries(row).filter(([key])=>!fields.includes(key)));

async function protect() {
  const result = {};
  for (const [name,sql,params] of [
    ["completions","SELECT * FROM dispatch_order_completion_status WHERE order_ref=ANY($1::text[]) ORDER BY order_ref",[refs]],
    ["assignments","SELECT * FROM dispatch_plan_order_assignments WHERE order_ref=ANY($1::text[]) ORDER BY plan_id,order_ref",[refs]],
    ["drivers","SELECT id,md5(row_to_json(r)::text) AS hash FROM driver_job_records r WHERE order_refs::text LIKE '%SOM06255%' OR order_refs::text LIKE '%SOM06256%' ORDER BY id",[]],
    ["plans","SELECT plan_id,md5(row_to_json(s)::text) AS hash FROM dispatch_plan_snapshots s WHERE orders::text LIKE '%SOM06255%' OR orders::text LIKE '%SOM06256%' ORDER BY plan_id",[]],
    ["ledger","SELECT * FROM dispatch_scm_so_splits WHERE source_so_ref=ANY($1::text[]) ORDER BY split_so_ref",[parents]]
  ]) { result[name] = await rows(sql,params); }
  return result;
}

async function capture() {
  return {
    headers:await rows("SELECT * FROM sales_orders WHERE netsuite_id=ANY($1::bigint[]) ORDER BY netsuite_id FOR UPDATE NOWAIT",[ids]),
    lines:await rows("SELECT * FROM sales_order_lines WHERE sales_order_id=ANY($1::bigint[]) ORDER BY id FOR UPDATE NOWAIT",[ids]),
    loads:await rows("SELECT * FROM operator_load_records WHERE id=ANY($1::bigint[]) ORDER BY id FOR UPDATE NOWAIT",[recordIds]),
    splits:await rows("SELECT * FROM dispatch_global_order_splits WHERE parent_order_ref=ANY($1::text[]) ORDER BY split_ref FOR UPDATE NOWAIT",[parents]),
    protected:await protect()
  };
}

function fingerprint(state) {
  return digest({headers:state.headers.map(r=>omit(r,["synced_at"])),lines:state.lines.map(r=>omit(r,["synced_at"])),
    loads:state.loads,splits:state.splits.map(r=>({ref:r.split_ref,active:r.active,items:r.full_order.items,salesQty:r.full_order.salesQty})),
    protected:state.protected});
}

async function acquireLocks() {
  await query("SET LOCAL lock_timeout='5s'");
  await query("SET LOCAL statement_timeout='30s'");
  // Catalog refresh acquires its table writes before source advisory locks.
  // Fail immediately when a refresh is already running; never invert that order.
  // Wait for planning before holding any row or catalog locks.
  await query("SET LOCAL lock_timeout='25s'");
  await query("SELECT pg_advisory_xact_lock(hashtext($1))",[DISPATCH_FLEET_PLANNING_LOCK]);
  await query("SET LOCAL lock_timeout='5s'");
  await query("SELECT order_ref FROM dispatch_order_catalog_entries WHERE order_ref=ANY($1::text[]) ORDER BY order_ref FOR UPDATE NOWAIT",[refs]);
  await query("SELECT singleton FROM dispatch_order_catalog_state WHERE singleton=true FOR UPDATE NOWAIT");
  await lockConsolidatedLoadOrders(ids);
  for (const ref of [...refs].sort()) {
    await query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`dispatch-global-source-refresh:${ref.toLowerCase()}`]);
    await query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`dispatch-global-order-definition:${ref.toLowerCase()}`]);
  }
}

async function validateBefore(state) {
  assert.equal(state.headers.length,6);
  assert.equal(state.loads.length,2);
  for (const t of targets) {
    const from = state.headers.find(r=>r.netsuite_id===t.fromId), to = state.headers.find(r=>r.netsuite_id===t.toId);
    assert.equal(from.tranid,t.from); assert.equal(to.tranid,t.to);
    assert.equal(from.operator_status,"loaded"); assert.equal(to.operator_status,"loaded");
    assert.equal(from.preparing_operator_id,null); assert.equal(to.preparing_operator_id,null);
    const sourceLine = state.lines.find(r=>r.id===t.fromLine), targetLine = state.lines.find(r=>r.id===t.toLine);
    assert.equal(sourceLine.line_id,t.fromKey); assert.equal(Number(sourceLine.quantity),t.fromQty);
    assert.equal(targetLine.line_id,t.toKey); assert.equal(Number(targetLine.quantity),t.toQty);
    const load = state.loads.find(r=>r.id===t.recordId);
    assert.equal(load.order_id,t.fromId); assert.equal(load.order_ref,t.from);
    assert.equal(load.line_snapshot.length,1); assert.equal(String(load.line_snapshot[0].lineId),t.fromKey);
    assert.equal(load.reload_cycle_id,null); assert.equal(load.source_record_id,null);
    assert.ok(state.splits.find(r=>r.split_ref===t.from)?.active);
    assert.equal(state.protected.completions.find(r=>r.order_ref===t.to)?.dispatch_completion_status,"completed");
    assert.ok(!state.protected.completions.some(r=>r.order_ref===t.from));
    assert.ok(!state.protected.assignments.some(r=>r.order_ref===t.from));
  }
  assert.equal((await rows("SELECT id FROM operator_load_records WHERE order_ref=ANY($1::text[]) AND id<>ALL($2::bigint[])",[targets.flatMap(t=>[t.to,t.from]),recordIds])).length,0,"Other loading evidence requires review");
  assert.equal((await rows("SELECT id FROM operator_reload_cycles WHERE source_load_record_id=ANY($1::bigint[]) OR (order_ref=ANY($2::text[]) AND status IN ('authorized','preparing','packed','in_progress'))",[recordIds,refs])).length,0);
  assert.equal((await rows("SELECT local_order_key FROM operator_netsuite_posting_order_claims WHERE active AND local_order_key=ANY($1::text[])",[ids.flatMap(id=>[id,`sales_order:${id}`])])).length,0);
  assert.equal((await rows("SELECT id FROM operator_netsuite_posting_commands WHERE status IN ('pending','posting','finalizing') AND (input_snapshot::text LIKE '%SOM06255%' OR input_snapshot::text LIKE '%SOM06256%')")).length,0);
}

function targetSnapshot(line) {
  return [{lineId:line.line_id,itemId:line.item_id,itemName:line.item_name,description:line.item_description || "",
    quantity:Number(line.quantity),unit:line.unit,packedPallets:0,packedLayers:0,packedSections:0,packedSalesQty:0,packedPieces:0,
    loadedQty:Number(line.quantity),loadedUom:line.unit}];
}

async function moveRecord(t,before) {
  const targetLine = before.lines.find(r=>r.id===t.toLine);
  const correction = {repairId,reason:"User confirmed operator selected S2 in error; loading belongs to S1 and S2 is unpacked and unloaded",fromOrderRef:t.from,toOrderRef:t.to};
  const changed = await query(`UPDATE operator_load_records SET order_id=$2,order_ref=$3,line_snapshot=$4::jsonb,
    response=COALESCE(response,'{}'::jsonb)||jsonb_build_object('supportCorrection',$5::jsonb)
    WHERE id=$1 AND order_id=$6 AND order_ref=$7`,
  [t.recordId,t.toId,t.to,JSON.stringify(targetSnapshot(targetLine)),JSON.stringify(correction),t.fromId,t.from]);
  assert.equal(changed.rowCount,1);
  await query("UPDATE sales_order_lines SET loaded_qty=quantity,loaded_uom=unit WHERE id=$1 AND sales_order_id=$2",[t.toLine,t.toId]);
  await query(`UPDATE sales_order_lines SET loaded_qty=0,packed_sales_qty=0,packed_pallet_qty=0,packed_layer_qty=0,
    packed_piece_qty=0,packed_section_qty=0,confirmed=false,confirmed_at=null WHERE sales_order_id=$1`,[t.fromId]);
  await query(`UPDATE sales_orders SET operator_status='open',local_yard_order_status='Open',preparing_operator_id=null,
    preparing_started_at=null,status_updated_at=now() WHERE netsuite_id=$1`,[t.fromId]);
  // Whole-parent packing duplicates the split operations. The correctly loaded S1
  // is represented by its own header, line and moved load record.
  await query(`UPDATE sales_order_lines SET packed_sales_qty=0,packed_pallet_qty=0,packed_layer_qty=0,
    packed_piece_qty=0,packed_section_qty=0,confirmed=false,confirmed_at=null WHERE sales_order_id=$1`,[t.parentId]);
  await query(`UPDATE sales_orders SET operator_status='open',local_yard_order_status='Open',preparing_operator_id=null,
    preparing_started_at=null,status_updated_at=now() WHERE netsuite_id=$1`,[t.parentId]);
  await writeAudit({actorType:"system",source:"user-confirmed-correction",action:"delivery.order.load.reassigned",orderId:t.toId,
    details:{...correction,loadRecordId:t.recordId,originalRecord:before.loads.find(r=>r.id===t.recordId)}});
  await writeAudit({actorType:"system",source:"user-confirmed-correction",action:"delivery.order.reopened",orderId:t.fromId,
    details:{...correction,loadRecordId:t.recordId,packedQuantity:0,loadedQuantity:0}});
}

async function refreshCatalog() {
  const orders = await listDispatchOrders({type:"SO",exactOrderRefs:parents});
  await upsertDispatchOrderCatalog({orders,source:repairId});
}

function assertPermittedChanges(before,after) {
  const headerFields = ["operator_status","local_yard_order_status","preparing_operator_id","preparing_started_at","status_updated_at"];
  const lineFields = [...packedFields,"loaded_qty","loaded_uom","confirmed","confirmed_at"];
  assert.deepEqual(after.headers.map(r=>omit(r,headerFields)),before.headers.map(r=>omit(r,headerFields)));
  assert.deepEqual(after.lines.map(r=>omit(r,lineFields)),before.lines.map(r=>omit(r,lineFields)));
  assert.deepEqual(after.protected,before.protected,"Plan, driver, split ledger or completion records changed");
  for (const t of targets) {
    assert.deepEqual(after.headers.find(r=>r.netsuite_id===t.toId),before.headers.find(r=>r.netsuite_id===t.toId),"S1 header changed");
    const load = after.loads.find(r=>r.id===t.recordId), original = before.loads.find(r=>r.id===t.recordId);
    assert.deepEqual(omit(load,["order_id","order_ref","line_snapshot","response"]),omit(original,["order_id","order_ref","line_snapshot","response"]),"Load photos, timestamp or operator changed");
    assert.deepEqual(omit(load.response,["supportCorrection"]),original.response);
    assert.equal(load.order_id,t.toId); assert.equal(load.order_ref,t.to);
    assert.deepEqual(load.line_snapshot,targetSnapshot(after.lines.find(r=>r.id===t.toLine)));
    assert.equal(Number(after.lines.find(r=>r.id===t.toLine).loaded_qty),t.toQty);
    const split = after.splits.find(r=>r.split_ref===t.from), old = before.splits.find(r=>r.split_ref===t.from);
    assert.equal(split.active,true); assert.deepEqual(split.full_order.items,old.full_order.items);
    assert.equal(split.full_order.salesQty,old.full_order.salesQty);
    for (const id of [t.fromId,t.parentId]) {
      const header = after.headers.find(r=>r.netsuite_id===id);
      assert.equal(header.operator_status,"open"); assert.equal(header.local_yard_order_status,"Open");
      for (const line of after.lines.filter(r=>r.sales_order_id===id)) {
        for (const field of [...packedFields,"loaded_qty"]) { assert.equal(Number(line[field]),0); }
        assert.equal(line.confirmed,false);
      }
    }
  }
}

async function verify(before) {
  const after = await capture();
  assertPermittedChanges(before,after);
  for (const t of targets) {
    const order = await getDispatchOrderCatalogOrder(t.from);
    assert.equal(order.operatorStatus,"open"); assert.equal(order.localYardOrderStatus,"Open");
    assert.ok(!order.dispatchPlanningRestricted); assert.ok(!order.dispatchPlanned);
    const sibling = await getDispatchOrderCatalogOrder(t.to);
    assert.equal(sibling.dispatchCompletionStatus,"completed");
  }
  return after;
}

const apply = process.argv.includes("--apply");
const expected = apply ? process.argv[process.argv.indexOf("--apply")+1] : "";
try {
  const result = await withTransaction(async()=>{
    await acquireLocks();
    const before = await capture();
    await validateBefore(before);
    const beforeHash = fingerprint(before);
    if (apply) { assert.equal(beforeHash,expected,"Target data changed since rehearsal"); }
    let backup = null;
    if (apply) {
      await mkdir("/app/data/support-fixes",{recursive:true,mode:0o700});
      backup = `/app/data/support-fixes/${repairId}-${Date.now()}.json`;
      await writeFile(backup,JSON.stringify({repairId,beforeHash,before},null,2),{mode:0o600,flag:"wx"});
    }
    for (const target of targets) { await moveRecord(target,before); }
    await refreshCatalog();
    await verify(before);
    await refreshCatalog();
    const after = await verify(before);
    const audit = await writeDispatchAudit({action:"sales_split_loading_records_corrected",entityType:"sales_order_split",entityId:repairId,
      source:"user-confirmed-correction",before,after,details:{repairId,backup,recordsMoved:recordIds,reopened:targets.map(t=>t.from),userInstruction:"Move S2 loading records to S1 and reopen S2. Operator error; no application change."}});
    return {mode:apply?"applied":"rehearsed-and-rolled-back",beforeHash,backup,auditId:audit.id,
      moved:targets.map(t=>({recordId:t.recordId,from:t.from,to:t.to,quantity:t.toQty,unit:"SQFT"})),reopened:targets.map(t=>t.from),
      photosAndTimestampsPreserved:true,completionAndDriverHistoryPreserved:true,refreshVerifiedTwice:true};
  },{rollback:!apply});
  console.log(JSON.stringify(result));
} finally { await closeDb(); }
