import assert from "node:assert/strict";
import {query,withTransaction,hasActiveTransaction} from "../src/db.js";
import {DISPATCH_FLEET_PLANNING_LOCK} from "../src/dispatch-fleet-status.js";
import {isLocalCoLoaded} from "../src/local-co-loaded-policy.js";
import {readCleanupState,createCleanupManifest,digest} from "./so-delivery-cleanup-repository.mjs";
import {normalizeRef} from "./so-delivery-cleanup-domain.mjs";

async function capture() {
  const so=await readCleanupState();
  const cos=(await query("SELECT * FROM local_co_orders ORDER BY id")).rows;
  const lines=(await query("SELECT * FROM local_co_order_lines ORDER BY co_id,id")).rows;
  const groups=(await query(`SELECT g.group_ref,g.active,array_agg(m.member_order_ref ORDER BY m.position) AS members
    FROM dispatch_delivery_groups g JOIN dispatch_delivery_group_members m ON m.group_ref=g.group_ref GROUP BY g.group_ref ORDER BY g.group_ref`)).rows;
  const completions=(await query(`SELECT completion_event_id,order_ref,completion_evidence_type FROM dispatch_order_completion_status
    WHERE completion_evidence_type IN ('driver_job','manual_dispatch','direct_dependency','reconciliation') ORDER BY order_ref`)).rows;
  return JSON.parse(JSON.stringify({so,cos,lines,groups,completions}));
}
export async function readCoCleanupState() {
  if(hasActiveTransaction()) return capture();
  return withTransaction(async()=>{await query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");return capture();});
}

function missingRecordedList(value) {
  return value===undefined||value===null||(Array.isArray(value)&&!value.length);
}

function recordedCoGroupMembers(co) {
  const details=co.details||{},members=details.childOrderIds;
  if(missingRecordedList(members)) return undefined;
  if(!Array.isArray(members)||members.length<2||
    normalizeRef(details.sourceOrderId)!==normalizeRef(co.source_order_ref)||
    normalizeRef(details.sourceOrderType)!=="so") return null;
  const refs=members.map(normalizeRef),children=details.childOrderDetails;
  if(members.some(value=>typeof value!=="string")||refs.some(ref=>!ref||ref===normalizeRef(co.source_order_ref))||
    new Set(refs).size!==refs.length) return null;
  // Older COs persisted member IDs before full child cards were stored.
  if(missingRecordedList(children)) return members;
  if(!Array.isArray(children)||children.length!==refs.length) return null;
  const childRefs=children.map(child=>normalizeRef(child?.id));
  if(new Set(childRefs).size!==refs.length||childRefs.some(ref=>!refs.includes(ref))||
    children.some(child=>normalizeRef(child?.type)!=="so")) return null;
  return members;
}

function sourceResolver(state,remote,skipSourceRefs) {
  const sourcePlan=createCleanupManifest(state.so,remote);
  const skipped=new Set([...skipSourceRefs,...sourcePlan.held.map(row=>row.ref)].map(normalizeRef));
  const sales=new Map(sourcePlan.entries.map(entry=>[normalizeRef(entry.ref),entry]));
  const groups=new Map(state.groups.map(group=>[normalizeRef(group.group_ref),group]));
  const completions=new Map(state.completions.map(row=>[normalizeRef(row.order_ref),row]));
  const resolve=(rawRef,seen=new Set())=>{
    const ref=normalizeRef(rawRef);
    if(skipped.has(ref)||seen.has(ref)) return null;
    const next=new Set([...seen,ref]),group=groups.get(ref);
    if(group) {
      if(!group.active||!group.members.length) return null;
      const children=group.members.map(member=>resolve(member,next));
      return children.every(Boolean)?{kind:"group",ref:rawRef,members:children}:null;
    }
    const source=sales.get(ref);
    if(source?.evidence) return {kind:"netsuite",...source.evidence};
    if(source?.guard.locallyCompleted) return {kind:"local_dispatch_completion",ref:source.ref};
    const completion=completions.get(ref);
    return completion?{kind:"dispatch",ref:rawRef,eventId:completion.completion_event_id,type:completion.completion_evidence_type}:null;
  };
  return co=>{
    const members=recordedCoGroupMembers(co);
    if(members===null||skipped.has(normalizeRef(co.source_order_ref))) return null;
    if(members===undefined) return resolve(co.source_order_ref);
    // This is the CO's original cargo membership, even after its source group
    // retires or moves registries. Snapshot statuses never prove completion.
    const children=members.map(member=>resolve(member,new Set([normalizeRef(co.source_order_ref)])));
    return children.every(Boolean)?{kind:"recorded_co_group",ref:co.source_order_ref,members:children}:null;
  };
}

export function createCoCleanupManifest(state,remote,{candidateIds=null,skipSourceRefs=[]}={}) {
  const resolve=sourceResolver(state,remote,skipSourceRefs),selected=candidateIds?new Set(candidateIds.map(String)):null;
  const entries=[],skipped=[];
  for(const co of state.cos) {
    if(selected&&!selected.has(String(co.id))) continue;
    if(["cancelled","completed"].includes(co.status)) continue;
    const source=resolve(co);
    const claimed=state.so.claims.some(row=>[String(co.delivery_order_id),normalizeRef(co.co_ref)].includes(normalizeRef(row.order_key)));
    if(!source||co.preparing_operator_id||claimed) {skipped.push({ref:co.co_ref,source:co.source_order_ref,reason:!source?"source_not_verified_complete_or_skipped":"active_operator_work"});continue;}
    const lines=state.lines.filter(line=>String(line.co_id)===String(co.id));
    const after=isLocalCoLoaded(co)?co:{...co,status:"planned",details:{...co.details,sourceLoaded:true,
      sourceCompletionCleanup:{observedAt:remote.completedAt,physicalLoadedAt:null,evidence:source,evidenceSha256:digest(source)}}};
    entries.push({id:String(co.id),ref:co.co_ref,source,before:{order:co,lines},after:{order:after,lines}});
  }
  return {version:1,createdAt:new Date().toISOString(),remote,skipSourceRefs,entries,skipped};
}

export async function applyCoCleanupManifest(manifest,{rollback=false}={}) {
  assert.equal(manifest.version,1);
  const age=Date.now()-Date.parse(manifest.remote.completedAt);
  assert(Number.isFinite(age)&&age>=-60000&&age<=90*60000,"CO source evidence is expired or invalid");
  return withTransaction(async()=>{
    await query("SET LOCAL lock_timeout='3s'");await query("SET LOCAL statement_timeout='60s'");
    await query("SELECT pg_advisory_xact_lock(hashtext($1))",[DISPATCH_FLEET_PLANNING_LOCK]);
    for(const entry of [...manifest.entries].sort((a,b)=>a.id.localeCompare(b.id))) {
      await query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`operator-delivery-load:${entry.before.order.delivery_order_id}`]);
    }
    await query(`LOCK TABLE local_co_orders,local_co_order_lines,sales_orders,sales_order_lines,
      dispatch_scm_so_splits,dispatch_delivery_groups,dispatch_delivery_group_members,operator_reload_cycles,
      operator_consolidated_load_claims,operator_netsuite_posting_order_claims,dispatch_so_po_allocations,
      order_dependencies,order_dependency_lines,dispatch_order_completion_events IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
    const before=await readCoCleanupState();
    const fresh=createCoCleanupManifest(before,manifest.remote,{candidateIds:manifest.entries.map(entry=>entry.id),skipSourceRefs:manifest.skipSourceRefs});
    const current=new Map(fresh.entries.map(entry=>[entry.id,entry])),pending=[];
    for(const entry of manifest.entries) {
      const next=current.get(entry.id);
      assert(next,`CO source or Operator work changed: ${entry.ref}`);
      assert.equal(digest(next.source),digest(entry.source),`CO source changed: ${entry.ref}`);
      assert.equal(digest(next.after),digest(entry.after),`CO projection changed: ${entry.ref}`);
      assert([digest(entry.before),digest(entry.after)].includes(digest(next.before)),`CO before-image is stale: ${entry.ref}`);
      if(digest(next.before)!==digest(next.after)) pending.push(next);
    }
    await query(`UPDATE local_co_orders target SET status=value.status,details=value.details
      FROM jsonb_to_recordset($1::jsonb) AS value(id bigint,status text,details jsonb) WHERE target.id=value.id`,[JSON.stringify(pending.map(entry=>entry.after.order))]);
    const after=await readCoCleanupState(),expected=new Map(pending.map(entry=>[entry.id,entry.after.order]));
    assert.deepEqual(after.cos,before.cos.map(co=>expected.get(String(co.id))||co));
    assert.deepEqual(after.lines,before.lines,"CO cargo or receiving quantity changed");
    assert.deepEqual(after.so,before.so,"CO cleanup changed source, Dispatch, Driver, or posting state");
    return {mode:rollback?"transaction-rollback-rehearsal":"applied",changedCos:pending.length,manifestSha256:digest(manifest),completedAt:new Date().toISOString()};
  },{rollback});
}
