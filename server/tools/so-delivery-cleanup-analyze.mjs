// Offline dry run: reads captured evidence and writes only local reports.
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync,writeFileSync} from "node:fs";
import path from "node:path";
import vm from "node:vm";
import {fileURLToPath} from "node:url";
import {isNetSuiteSalesOrderFulfilled} from "../src/sales-order-reconciliation.js";
import {applyOperatorLinkedQuantityProjection} from "../src/operator-linked-quantity-domain.js";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const dir=path.resolve(process.argv[2]||path.join(root,"test-artifacts/so-delivery-cleanup-20260915"));
const read=(name)=>JSON.parse(readFileSync(path.join(dir,name),"utf8"));
const snapshot=read("snapshot.json"), remote=read("netsuite-statuses.json"), planning=read("planning-checks.json");
const referenceLookups=read("missing-reference-checks.json");
const originalHash=createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
for(const [name,hash] of Object.entries(snapshot.sourceHashes)) {
  assert.equal(createHash("sha256").update(readFileSync(path.join(root,"src",name))).digest("hex"),hash,
    `Local ${name} differs from the deployed source used for capture.`);
}
// Execute the application's pure quantity and group-display functions as written.
const repository=readFileSync(path.join(root,"src/delivery-repository.js"),"utf8");
const frontend=readFileSync(path.join(root,"public/operator.js"),"utf8");
function extract(source,name) {
  const start=source.indexOf(`function ${name}(`);
  assert(start>=0,`Missing function ${name}`);
  const end=source.indexOf("\n}",start);
  assert(end>start);
  return source.slice(start,end+2);
}
const repositoryFunctions=["normalizeNumber","normalizeQuantity","positiveQuantity","roundQuantity",
  "hasConversion","hasRequiredCustomQuantity","lineUnitsToSalesQuantity","lineRequiredSalesQuantity",
  "linePackedSalesQuantity","lineLoadedSalesQuantity","isPalletSalesItem","isLegacySalesQuantityOnlyLine",
  "isExcludedDeliveryServiceLine","isDeliveryPickableLine","lineHasPackedQuantity","lineHasOpenQuantity",
  "buildDispatchGroupDeliveryListOrder"];
const frontendFunctions=["orderWarningCount","orderUnderpackCount","isVrmaReferenceOrder",
  "orderStatusText","orderStatusClass"];
const context=vm.createContext({t:(_key,fallback)=>fallback,qty:(value)=>Number(value||0),
  statusText:(value)=>value,selectedOrder:null});
vm.runInContext([...repositoryFunctions.map((name)=>extract(repository,name)),
  ...frontendFunctions.map((name)=>extract(frontend,name))].join("\n"),context);
const qty=(value)=>Math.max(0,Number(value||0));
const key=(value)=>String(value||"").trim().toLowerCase();
const orders=snapshot.orders.filter((o)=>o.sales_order_type==="Delivery"&&!o.is_test_fixture);
const byId=new Map(snapshot.orders.map((o)=>[String(o.netsuite_id),o]));
const idsByRef=new Map();
for(const order of snapshot.orders) {
  const ref=key(order.tranid),ids=idsByRef.get(ref)||[];
  ids.push(String(order.netsuite_id));idsByRef.set(ref,ids);
}
const lookupByRef=new Map(referenceLookups.rows.map((row)=>[key(row.ref),row.result]));
const live=new Map(remote.rows.map((o)=>[String(o.id),o]));
assert.equal(live.size,remote.rows.length,"NetSuite returned duplicate transaction IDs");
const completed=new Map(snapshot.completions.map((c)=>[key(c.order_ref),c]));
const driverRefs=new Set(snapshot.driverCompletedRefs);
const billedRefs=new Set(snapshot.billedFamilyRefs.map((o)=>key(o.ref)));
const closedRefs=new Set(snapshot.closedOrders.map((o)=>key(o.requestedRef)));
const activeReloadIds=new Set(snapshot.reloadCycles.filter((r)=>["authorized","preparing","packed","in_progress"].includes(r.status))
  .flatMap((r)=>[String(r.sales_order_id),String(r.reattempt_order_id)]));
const parentById=new Map(snapshot.splits.filter((s)=>s.status==="active").map((s)=>[String(s.split_so_id),String(s.source_so_id)]));
const allocations=new Map(snapshot.allocations.map((a)=>[String(a.sales_line_id),a]));
const linesByOrder=new Map();
for(const line of snapshot.lines) {
  const rows=linesByOrder.get(String(line.sales_order_id))||[];
  rows.push(line); linesByOrder.set(String(line.sales_order_id),rows);
}
function fulfillmentEvidence(order,seen=new Set()) {
  const id=String(order.netsuite_id);
  if(seen.has(id)) return null;
  seen.add(id);
  if(Number(id)>0) {
    const retained=live.get(id);
    if(!retained||key(retained.tranid)!==key(order.tranid)||!isNetSuiteSalesOrderFulfilled(retained)) return null;
    return {orderRef:retained.tranid,netsuiteId:id,status:retained.status,inherited:false};
  }
  const parent=byId.get(parentById.get(id));
  const evidence=parent?fulfillmentEvidence(parent,seen):null;
  return evidence?{...evidence,inherited:true}:null;
}
function effective(line) {
  return applyOperatorLinkedQuantityProjection({...line},{linkedPo:allocations.get(String(line.id))||{}});
}
const packedFields=["packed_pallet_qty","packed_layer_qty","packed_section_qty","packed_piece_qty","packed_sales_qty"];
function lineProjection(line) {
  if(!line.netsuite_active||!context.isDeliveryPickableLine(line)) return {...line};
  const required=context.lineRequiredSalesQuantity(effective(line));
  const after={...line,loaded_qty:Math.max(qty(line.loaded_qty),required),
    loaded_uom:line.unit||line.loaded_uom||"",confirmed:false};
  for(const field of packedFields) after[field]=0;
  return after;
}
function displayedLines(lines) {
  return lines.filter((l)=>l.netsuite_active||context.lineHasPackedQuantity(l)).map(effective);
}
function presentation(order,lines) {
  const shown=displayedLines(lines);
  const pickable=shown.filter(context.isDeliveryPickableLine);
  const open=pickable.filter(context.lineHasOpenQuantity);
  const progress=pickable.some((l)=>qty(l.loaded_qty)>0||context.lineHasPackedQuantity(l));
  const view={...order,warning_count:shown.filter((l)=>l.sync_exception&&context.lineHasPackedQuantity(l)).length,
    underpack_count:progress?open.length:0};
  return {label:context.orderStatusText(view),cssClass:context.orderStatusClass(view),
    openLines:open.length,underpack:view.underpack_count,warnings:view.warning_count};
}
const records=[],lineChanges=[],allBefore={},allAfter={},review=[];
let assertions=0;
for(const order of orders) {
  const id=String(order.netsuite_id),ref=key(order.tranid),lines=linesByOrder.get(id)||[];
  const evidence=fulfillmentEvidence(order);
  const completion=completed.get(ref);
  const local=driverRefs.has(ref)||["manual_dispatch","direct_dependency"].includes(completion?.completion_evidence_type);
  const qualifies=Boolean(evidence||local),reasons=[];
  const missing=Number(id)>0&&!live.has(id);
  if(qualifies) {
    if(idsByRef.get(ref).length>1) reasons.push("duplicate_local_order_reference");
    if(["cancelled","canceled"].includes(key(order.operator_status))||["cancelled","canceled"].includes(key(order.local_yard_order_status))) reasons.push("locally_cancelled");
    if(activeReloadIds.has(id)) reasons.push("active_reload_or_reattempt");
    if(order.has_preparing_operator) reasons.push("operator_draft_in_progress");
    for(const line of lines) {
      if(qty(line.loaded_qty)>0&&line.loaded_uom&&line.loaded_uom!==(line.unit||"")) reasons.push("loaded_unit_differs_from_sales_unit");
      if(!line.netsuite_active&&context.lineHasPackedQuantity(line)) reasons.push("inactive_line_has_packed_quantity");
      if(line.sync_exception&&context.lineHasPackedQuantity(line)) reasons.push("packed_line_has_sync_exception");
      if(line.netsuite_active&&effective(line).linked_quantity_blocked) reasons.push("linked_allocation_exceeds_order");
    }
  }
  const holds=[...new Set(reasons)],eligible=qualifies&&!holds.length;
  const after=eligible?{...order,operator_status:"loaded",local_yard_order_status:"Loaded"}:{...order};
  const afterLines=eligible?lines.map(lineProjection):lines.map((l)=>({...l}));
  const beforeView=presentation(order,lines),afterView=presentation(after,afterLines);
  const changes=[];
  for(let i=0;i<lines.length;i++) {
    const before=lines[i],next=afterLines[i];
    const changed=["loaded_qty","loaded_uom","confirmed",...packedFields].filter((f)=>{
      if(["loaded_qty",...packedFields].includes(f)) return Math.abs(qty(before[f])-qty(next[f]))>0.000001;
      if(f==="confirmed") return Boolean(before[f])!==Boolean(next[f]);
      return String(before[f]||"")!==String(next[f]||"");
    });
    if(changed.length) {changes.push(before.id);lineChanges.push({order_ref:order.tranid,line_id:before.id,
      changed_fields:changed,loaded_qty_before:before.loaded_qty,loaded_qty_after:next.loaded_qty,
      loaded_uom_before:before.loaded_uom,loaded_uom_after:next.loaded_uom,
      packed_before:Object.fromEntries(packedFields.map((f)=>[f,before[f]]))});}
    assert.equal(next.quantity,before.quantity); assert.equal(next.unit,before.unit);
    assert(qty(next.loaded_qty)>=qty(before.loaded_qty)); assertions+=3;
  }
  if(eligible) {
    assert.equal(afterView.label,"Loaded",order.tranid);assert.equal(afterView.openLines,0,order.tranid);
    assert.equal(afterView.warnings,0,order.tranid);assert.equal(afterView.underpack,0,order.tranid);
    assert.equal(after.fulfillment_status,order.fulfillment_status);
    assert.equal(after.status,order.status);assert.equal(after.dispatch_planned,order.dispatch_planned);
    const second=afterLines.map(lineProjection);
    assert.deepEqual(second,afterLines,`Line proposal is not idempotent: ${order.tranid}`);assertions+=8;
  } else {assert.deepEqual(after,order);assert.deepEqual(afterLines,lines);assertions+=2;}
  // Reference-based group reads must not replace a verified canonical row with an inactive duplicate.
  if(!allBefore[ref]||(!live.has(String(allBefore[ref].netsuite_id))&&live.has(id))) {
    allBefore[ref]={...order,lines:displayedLines(lines)};
    allAfter[ref]={...after,lines:displayedLines(afterLines)};
  }
  const record={order_ref:order.tranid,order_id:id,local_netsuite_status:order.status,
    verified_netsuite_status:live.get(id)?.status||"",netsuite_evidence:evidence,
    local_delivery_completed:local,qualifies,disposition:eligible?"proposed":qualifies?"review":"unchanged",
    review_reasons:holds,missing_netsuite_id:missing,
    reference_lookup_netsuite_id:lookupByRef.get(ref)?.id||"",
    reference_lookup_status:lookupByRef.get(ref)?.status||"",
    duplicate_local_ids:idsByRef.get(ref).length>1?idsByRef.get(ref):[],
    operator_status_before:order.operator_status,operator_status_after:after.operator_status,
    yard_status_before:order.local_yard_order_status,yard_status_after:after.local_yard_order_status,
    fulfillment_status_before:order.fulfillment_status,fulfillment_status_after:after.fulfillment_status,
    current_completion:completion?.completion_evidence_type||"",
    add_dispatch_completion:eligible&&!completion,completion_evidence_proposed:eligible&&!completion?"netsuite_fulfillment":"",
    currently_hidden_as_billed:billedRefs.has(ref),driver_replanning_blocked:driverRefs.has(ref),
    closed_planning_blocked:closedRefs.has(ref),
    billed_after_status_refresh:evidence?.status==="G",
    netsuite_active:order.netsuite_active,header_change:eligible&&(order.operator_status!=="loaded"||order.local_yard_order_status!=="Loaded"),
    line_changes:changes.length,loaded_qty_changes:changes.filter((lid)=>{
      const before=lines.find((l)=>l.id===lid),next=afterLines.find((l)=>l.id===lid);
      return Math.abs(qty(before.loaded_qty)-qty(next.loaded_qty))>0.000001;
    }).length,
    before_presentation:beforeView,after_presentation:afterView,
    header_only_presentation:presentation({...order,operator_status:"loaded",local_yard_order_status:"Loaded"},lines)};
  records.push(record);
  if(holds.length||missing) review.push({...record,review_reasons:[...holds,...(missing?
    [lookupByRef.get(ref)?"incorrect_netsuite_id_and_duplicate_reference":"netsuite_order_not_found_by_id_or_reference"]:[])]});
}
const groupChecks=[];
for(const group of snapshot.groups.filter((g)=>g.active)) {
  const refs=group.members.map(key),known=refs.filter((ref)=>allBefore[ref]);
  if(!known.length) continue;
  if(known.length!==refs.length) {groupChecks.push({group_ref:group.group_ref,result:"mixed_or_non_sales_group_not_simulated"});continue;}
  const definition={id:group.group_ref,planDate:group.plan_date};
  const before=context.buildDispatchGroupDeliveryListOrder(definition,refs.map((ref)=>allBefore[ref]));
  const after=context.buildDispatchGroupDeliveryListOrder(definition,refs.map((ref)=>allAfter[ref]));
  const allLoaded=refs.every((ref)=>allAfter[ref].local_yard_order_status==="Loaded");
  if(allLoaded) {assert.equal(after.local_yard_order_status,"Loaded");assert.equal(after.underpack_count,0);assertions+=2;}
  else {assert.notEqual(after.local_yard_order_status,"Loaded");assertions++;}
  groupChecks.push({group_ref:group.group_ref,members:group.members,before:context.orderStatusText(before),
    after:context.orderStatusText(after),underpack_after:after.underpack_count,all_members_loaded:allLoaded,result:"passed"});
}
const qualifying=records.filter((r)=>r.qualifies),proposed=records.filter((r)=>r.disposition==="proposed");
const count=(rows,predicate)=>rows.filter(predicate).length;
const statuses=Object.fromEntries(["A","B","E","F","G","H"].map((code)=>[code,count(remote.rows,(r)=>r.status===code)]));
const stats={deliveryOrders:orders.length,pickupOrdersExcluded:snapshot.orders.length-orders.length,
  positiveIdsRequested:remote.requested.length,idsReturned:remote.rows.length,missingIds:count(records,(r)=>r.missing_netsuite_id),
  missingByIdAndReference:referenceLookups.rows.filter((row)=>!row.result).length,
  incorrectIdsWithDuplicateReferences:referenceLookups.rows.filter((row)=>row.result).length,
  liveNetSuiteStatuses:statuses,staleStoredStatuses:count(records,(r)=>r.verified_netsuite_status&&r.verified_netsuite_status!==r.local_netsuite_status),
  directNetSuiteFulfilled:count(qualifying,(r)=>r.netsuite_evidence&&!r.netsuite_evidence.inherited),
  splitChildrenWithFulfilledSource:count(qualifying,(r)=>r.netsuite_evidence?.inherited),
  locallyDelivered:count(qualifying,(r)=>r.local_delivery_completed),
  overlap:count(qualifying,(r)=>r.local_delivery_completed&&r.netsuite_evidence),
  localDeliveryOnly:count(qualifying,(r)=>r.local_delivery_completed&&!r.netsuite_evidence),
  qualifyingOrders:qualifying.length,qualifyingHeldForReview:count(qualifying,(r)=>r.disposition==="review"),
  proposedOrders:proposed.length,headersToChange:count(proposed,(r)=>r.header_change),
  newlyLoadedFromOpenOrPartial:count(proposed,(r)=>["Open","Partial Loaded"].includes(r.yard_status_before)),
  shippedToLoadedNormalization:count(proposed,(r)=>r.yard_status_before==="Shipped"),
  loadedHeaderStatusCorrections:count(proposed,(r)=>r.yard_status_before==="Loaded"&&r.header_change),
  linesToChange:lineChanges.length,loadedQuantitiesToIncrease:proposed.reduce((sum,r)=>sum+r.loaded_qty_changes,0),
  ordersWithLineChanges:count(proposed,(r)=>r.line_changes>0),
  newDispatchCompletions:count(proposed,(r)=>r.add_dispatch_completion),
  alreadyFullyConsistent:count(proposed,(r)=>!r.header_change&&!r.line_changes&&!r.add_dispatch_completion),
  headerOnlyStillUnderpacked:count(proposed,(r)=>r.header_only_presentation.underpack>0),
  currentlyBilledAndHidden:count(qualifying,(r)=>r.currently_hidden_as_billed),
  billedWhenFreshStatusesApplied:count(qualifying,(r)=>r.billed_after_status_refresh),
  currentDriverReplanningBlocks:count(qualifying,(r)=>r.driver_replanning_blocked),
  fullyFulfilledAlsoDriverBlocked:count(qualifying,(r)=>r.netsuite_evidence&&r.driver_replanning_blocked),
  groupsVerified:count(groupChecks,(g)=>g.result==="passed"),
  groupsLoadedAfter:count(groupChecks,(g)=>g.result==="passed"&&g.after==="Loaded"),
  groupsWithRemainingWork:count(groupChecks,(g)=>g.result==="passed"&&g.after!=="Loaded"),
  assertions};
assert.equal(stats.directNetSuiteFulfilled+stats.splitChildrenWithFulfilledSource+stats.locallyDelivered-stats.overlap,stats.qualifyingOrders);
assert.equal(createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"),originalHash,"Captured evidence was mutated");
const controls=["SOA08404-S2","SOM06256-S2","SOM06255-S2","SOA08695"];
for(const ref of controls) assert.equal(records.find((r)=>r.order_ref===ref)?.disposition,"unchanged",ref);
assert.equal(records.find((r)=>r.order_ref==="SOM05681")?.disposition,"review");
assert.equal(records.find((r)=>r.order_ref==="SOR00107")?.disposition,"review");
assert.equal(planning.results.find((r)=>r.ref==="SOB119972").searchReturned,false);
assert.equal(planning.results.find((r)=>r.ref==="SOV02345").guards.driverCompletion.allowed,false);
assert.equal(planning.results.find((r)=>r.ref==="SOR00030").guards.driverCompletion.allowed,true);
const output={mode:"offline-dry-run-no-database-mutations",databaseSnapshotAt:snapshot.database.captured_at,
  netSuiteVerifiedFrom:remote.startedAt,netSuiteVerifiedThrough:remote.completedAt,
  result:"operator_projection_passes_for_proposed_rows; overall_requirement_blocked_by_existing_dispatch_planning_rules",
  stats,records,review,lineChanges,groupChecks,referenceLookups,
  planningChecks:planning.results.map(({operator,...rest})=>rest)};
writeFileSync(path.join(dir,"dry-run.json"),`${JSON.stringify(output,null,2)}\n`);
function csv(name,rows,columns) {
  const cell=(value)=>`"${String(typeof value==="object"?JSON.stringify(value):value??"").replaceAll('"','""')}"`;
  writeFileSync(path.join(dir,name),[columns.join(","),...rows.map((r)=>columns.map((c)=>cell(r[c])).join(","))].join("\n")+"\n");
}
csv("orders.csv",records,["order_ref","order_id","disposition","review_reasons","local_netsuite_status","verified_netsuite_status",
  "netsuite_evidence","local_delivery_completed","operator_status_before","operator_status_after","yard_status_before","yard_status_after",
  "line_changes","current_completion","add_dispatch_completion","currently_hidden_as_billed","driver_replanning_blocked"]);
csv("review.csv",review,["order_ref","order_id","review_reasons","local_netsuite_status","verified_netsuite_status","yard_status_before",
  "reference_lookup_netsuite_id","reference_lookup_status","duplicate_local_ids"]);
csv("line-changes.csv",lineChanges,["order_ref","line_id","changed_fields","loaded_qty_before","loaded_qty_after",
  "loaded_uom_before","loaded_uom_after","packed_before"]);
console.log(JSON.stringify(stats,null,2));
console.log("Review:",JSON.stringify(review.map((r)=>({ref:r.order_ref,reasons:r.review_reasons}))));
