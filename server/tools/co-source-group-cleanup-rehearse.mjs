import assert from "node:assert/strict";
import {readFileSync,writeFileSync} from "node:fs";
import {query,closeDb} from "../src/db.js";
import {getDeliveryOrder,listDeliveryOrders} from "../src/delivery-repository.js";
import {readCoCleanupState,applyCoCleanupManifest} from "./co-source-cleanup-repository.mjs";
import {digest} from "./so-delivery-cleanup-repository.mjs";

const directory="test-artifacts/so-delivery-cleanup-grouped-co-20260915";
const read=name=>JSON.parse(readFileSync(`${directory}/${name}`,"utf8"));
assert.equal(process.env.MBT_TEST_ISOLATED,"1","Never seed operational rehearsal data into production");
assert.equal((await query("SELECT current_database() AS name")).rows[0].name,"mbt_test");
const captured=read("co-before.json"),original=read("co-manifest.json");
const manifest={...original,entries:original.entries.filter(entry=>digest(entry.before)!==digest(entry.after))};
assert.equal(manifest.entries.length,12,"Rehearse exactly the reviewed correction");
const coIds=new Set(manifest.entries.map(entry=>entry.id));
const cos=captured.cos.filter(co=>coIds.has(String(co.id)));
const sourceRefs=new Set(cos.flatMap(co=>co.details.childOrderIds));
const sources=captured.so.orders.filter(order=>sourceRefs.has(order.tranid));
const sourceIds=new Set(sources.map(order=>String(order.netsuite_id)));
const sourceLines=captured.so.lines.filter(line=>sourceIds.has(String(line.sales_order_id)));
const sourceLineIds=new Set(sourceLines.map(line=>String(line.id)));
assert.equal(sources.length,sourceRefs.size,"The captured source identities must be unique");
assert(!captured.so.allocations.some(row=>sourceLineIds.has(String(row.sales_line_id))),"Allocation fixtures need an explicit reproduction");
assert(!captured.so.splits.some(row=>sourceIds.has(String(row.split_so_id))),"Split fixtures need an explicit reproduction");

async function insert(table,records) {
  if(!records.length) return;
  const columns=(await query(`SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name=$1 AND is_generated='NEVER' ORDER BY ordinal_position`,[table])).rows
    .map(row=>row.column_name).filter(column=>records.some(record=>Object.hasOwn(record,column)));
  const names=columns.map(name=>`"${name}"`).join(",");
  await query(`INSERT INTO ${table} (${names}) SELECT ${names} FROM jsonb_populate_recordset(NULL::${table},$1::jsonb)`,[JSON.stringify(records)]);
}

try {
  await insert("sales_orders",sources);
  await insert("sales_order_lines",sourceLines);
  const plans=[...new Set(cos.map(co=>co.dispatch_plan_id).filter(Boolean))].map(id=>({id,
    plan_date:cos.find(co=>co.dispatch_plan_id===id).dispatch_plan_date,status:"draft"}));
  await insert("dispatch_plans",plans);
  for(const co of cos) {
    const group=captured.groups.find(row=>row.group_ref===co.source_order_ref);
    if(!group) continue;
    // The captured registry contains membership/lifecycle, not its old plan pointer.
    const registryPlan=plans.find(plan=>plan.id===co.dispatch_plan_id)||plans[0];
    await insert("dispatch_delivery_groups",[{group_ref:group.group_ref,plan_id:registryPlan.id,
      plan_date:registryPlan.plan_date,order_type:"sales_order",active:group.active}]);
    await insert("dispatch_delivery_group_members",group.members.map((member_order_ref,position)=>({group_ref:group.group_ref,member_order_ref,position})));
  }
  const completed=new Set(captured.so.driverCompletedRefs);
  for(const ref of sourceRefs) if(completed.has(ref.toLowerCase())) {
    await query(`INSERT INTO driver_job_records(job_id,driver_login,stop_type,order_refs,status,started_at,completed_at)
      VALUES($1,'isolated-co-rehearsal','dropoff',$2::jsonb,'complete',now(),now())`,[`isolated-co-${ref}`,JSON.stringify([ref])]);
  }
  await insert("local_co_orders",cos);
  await insert("local_co_order_lines",captured.lines.filter(line=>coIds.has(String(line.co_id))));
  const before=await readCoCleanupState();
  const rollback=await applyCoCleanupManifest(manifest,{rollback:true});
  assert.equal(rollback.changedCos,12);
  assert.deepEqual(await readCoCleanupState(),before,"Rollback rehearsal must leave every fixture unchanged");
  const result=await applyCoCleanupManifest(manifest);
  assert.equal(result.changedCos,12);
  const after=await readCoCleanupState();
  assert.deepEqual(after.lines,before.lines);
  assert.deepEqual(after.so,before.so);
  assert.deepEqual(after.groups,before.groups,"Historical groups must retain their registry state");
  for(const entry of manifest.entries) assert.deepEqual(after.cos.find(co=>String(co.id)===entry.id),entry.after.order,entry.ref);
  const details=[];
  for(const co of cos) {
    const detail=await getDeliveryOrder(co.co_ref);
    assert(detail,co.co_ref);
    assert.equal(detail.operator_status,"loaded",co.co_ref);
    assert.equal(detail.local_yard_order_status,"Loaded",co.co_ref);
    details.push({ref:co.co_ref,status:detail.operator_status,yardStatus:detail.local_yard_order_status,lines:detail.lines.length});
  }
  const active=await listDeliveryOrders({status:"active",orderType:"sales_order"});
  assert(!active.some(order=>cos.some(co=>co.co_ref===order.tranid)),"Corrected COs must leave the active Operator feed");
  assert.equal((await applyCoCleanupManifest(manifest)).changedCos,0);
  const report={mode:"isolated-captured-CO-rehearsal",changedCos:12,sourceSOs:sources.length,cargoLines:after.lines.length,
    rollbackVerified:true,idempotent:true,sourceAndDriverStateUnchanged:true,cargoAndReceiptsUnchanged:true,
    groupRegistryUnchanged:true,removedFromActiveFeed:true,details,completedAt:new Date().toISOString()};
  writeFileSync(`${directory}/rehearsal.json`,JSON.stringify(report,null,2)+"\n");
  console.log(JSON.stringify(report));
} finally {await closeDb();}
