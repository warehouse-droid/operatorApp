import test,{after} from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {query,closeDb,withTransaction} from "../../../src/db.js";
import {planningFixture} from "../support/bin-planning-fixtures.js";
import {recordAssetMovement} from "../../../src/mbt/asset-service.js";
import {getBinOrderWorkflowOptions,configureBinOrderWorkflow} from "../../../src/mbt/bin-order-workflow-service.js";
after(closeDb);
let offset=5800;
async function material(code=crypto.randomUUID()) {
  return (await query(`INSERT INTO mbt_materials(material_id,material_code,display_name,created_by,updated_by)
    VALUES ($1,$2,$2,'test','test') ON CONFLICT(material_code) DO UPDATE SET active=true RETURNING material_id`,
  [crypto.randomUUID(),code])).rows[0].material_id;
}
async function fixture(initialContent=null) {
  const f=await planningFixture(offset++),lineId=crypto.randomUUID(),materialId=await material(),dumpSiteId=crypto.randomUUID();
  await query(`INSERT INTO mbt_contract_service_lines(service_line_id,contract_id,line_number,bin_type_id,
    customer_site_profile_id,site_snapshot,pricing_snapshot)
    SELECT $1,contract_id,1,bin_type_id,customer_site_profile_id,site_snapshot,pricing_snapshot
    FROM mbt_contracts WHERE contract_id=$2`,[lineId,f.contractId]);
  await query("UPDATE mbt_service_visits SET service_line_id=$1 WHERE contract_id=$2",[lineId,f.contractId]);
  await query("UPDATE mbt_service_visits SET material_id=$2 WHERE service_visit_id=$1",[f.successorVisitId,materialId]);
  if(initialContent) await query("UPDATE mbt_service_visits SET service_snapshot=service_snapshot || $2::jsonb WHERE service_visit_id=$1",[f.frontVisitId,JSON.stringify({contentCode:initialContent})]);
  await withTransaction(()=>recordAssetMovement({query,ambientTransaction:true},{assetId:f.assetId,movementType:"deliver_bin_expected",
    afterStatus:"at_customer",afterLocation:{kind:"customer_site",customerSiteProfileId:f.siteProfileId,reference:"100 Test Route"},
    source:"order-material-test",actorType:"system",actorId:"test",occurredAt:`${f.planDate}T10:00:00Z`}));
  await query("UPDATE mbt_service_visits SET status='completed',actual_completed_at=$2 WHERE service_visit_id=$1",[f.frontVisitId,`${f.planDate}T10:00:00Z`]);
  await query("UPDATE mbt_bin_rental_numbers SET current_asset_id=$2 WHERE service_line_id=$1",[lineId,f.assetId]);
  await query(`INSERT INTO mbt_dump_sites(dump_site_id,dump_site_code,display_name,address_line_1,created_by,updated_by)
    VALUES ($1,$2,'Accepted dump','500 Dump Road','test','test')`,[dumpSiteId,dumpSiteId]);
  await accepted(dumpSiteId,materialId);
  return {...f,lineId,materialId,dumpSiteId};
}
async function accepted(dumpSiteId,materialId) {
  await query(`INSERT INTO mbt_dump_site_materials(dump_site_material_id,dump_site_id,material_id,accepted,created_by,updated_by)
    VALUES ($1,$2,$3,true,'test','test') ON CONFLICT(dump_site_id,material_id) DO UPDATE SET active=true,accepted=true`,
  [crypto.randomUUID(),dumpSiteId,materialId]);
}
function command(f,extra={}) {
  return {visitId:f.successorVisitId,expectedRevision:1,actor:f.actor,idempotencyKey:crypto.randomUUID(),
    correlationId:crypto.randomUUID(),requestId:crypto.randomUUID(),dumpSiteId:f.dumpSiteId,
    collectionWindow:{startAt:`${f.planDate}T13:00:00Z`,endAt:`${f.planDate}T15:00:00Z`},
    destination:{kind:"yard",yardId:"00000000-0000-4000-8000-000000012441"},...extra};
}
async function exchange(f,contentCode="concrete",binTypeId=f.binTypeId) {
  const id=crypto.randomUUID();
  await query(`INSERT INTO mbt_service_visits(service_visit_id,contract_id,service_line_id,visit_number,visit_reference,
    service_template_version_id,service_action,status,customer_site_profile_id,bin_type_id,expected_asset_id,
    scheduled_start_at,scheduled_end_at,customer_snapshot,site_snapshot,service_snapshot,created_by,updated_by)
    SELECT $1::uuid,contract_id,service_line_id,50,$1::uuid::text,service_template_version_id,'exchange_bin','ready',
    customer_site_profile_id,$4,$2,scheduled_start_at,scheduled_end_at,customer_snapshot,site_snapshot,
    service_snapshot || $5::jsonb,'test','test' FROM mbt_service_visits WHERE service_visit_id=$3`,
  [id,f.assetId,f.frontVisitId,binTypeId,JSON.stringify({contentCode})]);
  return id;
}
async function charge(f,bin) {
  const id=crypto.randomUUID();
  await query(`INSERT INTO mbt_frontdesk_charge_requests(charge_request_id,request_number,request_kind,
    contract_id,service_line_id,payment_method,payment_category,tax_mode,netsuite_export_policy,
    pricing_snapshot,pre_tax_revenue_minor,request_total_minor,resulting_contract_total_minor,
    billing_address_text,service_address_text,contract_telephone,reason,created_by,updated_by)
    VALUES ($1::uuid,$1::uuid::text,'exchange_bin',$2,$3,'cash','cash','included','excluded_cash',$4::jsonb,
    0,0,0,'1 Billing Road','2 Service Road','416-555-0100','Order material regression','test','test')`,
  [id,f.contractId,f.lineId,JSON.stringify({bin})]);
  return id;
}
async function receiving(f,binTypeId) {
  const target=await planningFixture(offset++),line=crypto.randomUUID();
  await query(`INSERT INTO mbt_contract_service_lines(service_line_id,contract_id,line_number,bin_type_id,
    customer_site_profile_id,site_snapshot,pricing_snapshot) SELECT $1,contract_id,1,$3,
    customer_site_profile_id,site_snapshot,pricing_snapshot FROM mbt_contracts WHERE contract_id=$2`,[line,target.contractId,binTypeId]);
  await query("UPDATE mbt_service_visits SET service_line_id=$1,bin_type_id=$3 WHERE contract_id=$2",[line,target.contractId,binTypeId]);
  return target;
}
test("order material: options expose the fixed material and only accepting dump sites",async()=>{
  const f=await fixture(),other=await material();await accepted(f.dumpSiteId,other);
  const options=await getBinOrderWorkflowOptions(f.successorVisitId);
  assert.equal(options.orderMaterial.materialId,f.materialId);
  assert.equal(options.orderMaterial.issue,null);
  assert.deepEqual(options.dumping.map(d=>d.material_id),[f.materialId]);
});
test("order material: a stale or hostile client cannot replace the ordered material",async()=>{
  const f=await fixture(),other=await material();await accepted(f.dumpSiteId,other);
  await assert.rejects(configureBinOrderWorkflow(command(f,{materialId:other})),/material.*order|order.*material/i);
  assert.equal((await query("SELECT configuration FROM mbt_bin_orders WHERE order_id=$1",[f.successorVisitId])).rows[0].configuration,null);
  const saved=await configureBinOrderWorkflow(command(f));
  assert.equal(saved.body.configuration.materialId,f.materialId);
  const part=saved.body.parts[0];
  assert.equal((await query("SELECT material_id FROM mbt_service_visits WHERE service_visit_id=$1",[part.visitId])).rows[0].material_id,f.materialId);
});
test("order material: fixed-price order contents resolve without a planner-supplied material",async()=>{
  const f=await fixture(),soil=await material("SOIL");await accepted(f.dumpSiteId,soil);
  await query("UPDATE mbt_service_visits SET material_id=NULL WHERE service_visit_id=$1",[f.successorVisitId]);
  await query("UPDATE mbt_contract_service_lines SET material_id=NULL,pricing_snapshot=$2::jsonb WHERE service_line_id=$1",[f.lineId,JSON.stringify({contentCode:"soil"})]);
  const options=await getBinOrderWorkflowOptions(f.successorVisitId);assert.equal(options.orderMaterial.materialId,soil);
  const saved=await configureBinOrderWorkflow(command(f));assert.equal(saved.body.configuration.materialId,soil);
});
test("order material: missing or ambiguous order definitions cannot be filled by Dispatch",async()=>{
  const f=await fixture();
  await query("UPDATE mbt_service_visits SET material_id=NULL WHERE service_visit_id=$1",[f.successorVisitId]);
  await query("UPDATE mbt_contract_service_lines SET material_id=NULL,pricing_snapshot='{}' WHERE service_line_id=$1",[f.lineId]);
  await assert.rejects(configureBinOrderWorkflow(command(f,{materialId:f.materialId})),/order.*material|material.*order/i);
  assert.match((await getBinOrderWorkflowOptions(f.successorVisitId)).orderMaterial.issue,/Front Desk/i);
  await material("SOIL");await material("DUMP_SOIL");
  await query("UPDATE mbt_contract_service_lines SET pricing_snapshot=$2::jsonb WHERE service_line_id=$1",[f.lineId,JSON.stringify({contentCode:"soil"})]);
  await assert.rejects(configureBinOrderWorkflow(command(f)),/ambiguous|multiple/i);
});
test("order material: an exchange collects the previous order's contents, not the replacement's",async()=>{
  const f=await fixture("soil"),soil=await material("SOIL"),concrete=await material("CONCRETE"),exchangeId=crypto.randomUUID();
  await query("UPDATE mbt_materials SET active=false WHERE material_code='DUMP_SOIL'");
  await accepted(f.dumpSiteId,soil);await accepted(f.dumpSiteId,concrete);
  await query("UPDATE mbt_contract_service_lines SET material_id=NULL,pricing_snapshot=$2::jsonb WHERE service_line_id=$1",[f.lineId,JSON.stringify({contentCode:"concrete"})]);
  await query(`INSERT INTO mbt_service_visits(service_visit_id,contract_id,service_line_id,visit_number,visit_reference,
    service_template_version_id,service_action,status,customer_site_profile_id,bin_type_id,expected_asset_id,
    scheduled_start_at,scheduled_end_at,customer_snapshot,site_snapshot,service_snapshot,created_by,updated_by)
    SELECT $1::uuid,contract_id,service_line_id,50,$1::uuid::text,service_template_version_id,'exchange_bin','ready',
    customer_site_profile_id,bin_type_id,$2,scheduled_start_at,scheduled_end_at,customer_snapshot,site_snapshot,
    service_snapshot || '{"contentCode":"concrete"}'::jsonb,'test','test' FROM mbt_service_visits WHERE service_visit_id=$3`,
  [exchangeId,f.assetId,f.frontVisitId]);
  assert.equal((await getBinOrderWorkflowOptions(exchangeId)).orderMaterial.materialId,soil);
});

test("order material: a changed-size exchange delivers first and only reuses the old size for onward orders",async()=>{
  const f=await fixture("soil"),soil=await material("SOIL"),type20="00000000-0000-4000-8000-000000000020";
  await accepted(f.dumpSiteId,soil);
  const replacement=await receiving(f,type20),matching=await receiving(f,f.binTypeId);
  // This fixture's new physical asset has not been assigned or moved.
  await query("UPDATE mbt_bin_assets SET bin_type_id=$2 WHERE asset_id=$1",[replacement.assetId,type20]);
  const id=await exchange(f,"garbage",type20);
  const options=await getBinOrderWorkflowOptions(id);
  assert.ok(options.targets.some(t=>t.order_id===matching.frontVisitId));
  assert.ok(!options.targets.some(t=>t.order_id===replacement.frontVisitId));
  const input=command(f,{visitId:id,deliveryAssetId:replacement.assetId,reuse:"different_bin",sequence:"collection_first",
    deliveryWindow:{startAt:`${f.planDate}T11:00:00Z`,endAt:`${f.planDate}T12:00:00Z`}});
  await assert.rejects(configureBinOrderWorkflow(input),/different.*(size|type).*delivery first/i);
  await assert.rejects(configureBinOrderWorkflow({...input,idempotencyKey:crypto.randomUUID(),reuse:"same_bin"}),/type|size/i);
  await assert.rejects(configureBinOrderWorkflow({...input,idempotencyKey:crypto.randomUUID(),sequence:"delivery_first",
    destination:{kind:"delivery",orderId:replacement.frontVisitId}}),/different bin type/i);
  assert.equal((await query("SELECT count(*)::int AS n FROM mbt_bin_order_parts WHERE order_id=$1",[id])).rows[0].n,0);
  const saved=await configureBinOrderWorkflow({...input,idempotencyKey:crypto.randomUUID(),sequence:"delivery_first"});
  assert.equal(saved.body.configuration.materialId,soil);
  assert.equal(saved.body.parts.find(p=>p.role==="collection").assetId,f.assetId);
  assert.equal(saved.body.parts.find(p=>p.role==="delivery").assetId,replacement.assetId);
  const deps=await query(`SELECT d.dependent_action_code,d.prerequisite_action_code FROM mbt_bin_workflow_dependencies d
    JOIN mbt_bin_order_parts p ON p.visit_id=d.dependent_visit_id WHERE p.order_id=$1`,[id]);
  assert.deepEqual(deps.rows,[{dependent_action_code:"pickup_bin",prerequisite_action_code:"deliver_bin"}]);
});

test("order material: charged outgoing contents override replacement material evidence",async()=>{
  const f=await fixture(),soil=await material("SOIL"),concrete=await material("CONCRETE");
  const chargeId=await charge(f,{calculator:{incomingContentCode:"concrete",outgoingContentCode:"soil"},
    itemEvidence:{fixedDumpItemCode:"CONCRETE"}});
  const id=await exchange(f);
  await query("UPDATE mbt_service_visits SET service_snapshot=service_snapshot || $2::jsonb WHERE service_visit_id=$1",[id,JSON.stringify({chargeRequestId:chargeId})]);
  await accepted(f.dumpSiteId,soil);await accepted(f.dumpSiteId,concrete);
  await query("UPDATE mbt_dump_site_materials SET active=false WHERE material_id=$1 AND dump_site_id<>$2",[soil,f.dumpSiteId]);
  const options=await getBinOrderWorkflowOptions(id);
  assert.equal(options.orderMaterial.materialId,soil);
  assert.deepEqual(options.dumping.map(d=>d.material_id),[soil]);
});

test("order material: final collection uses current charged contents instead of the original delivery charge",async()=>{
  const f=await fixture(),soil=await material("SOIL"),concrete=await material("CONCRETE");
  const initial=await charge(f,{calculator:{incomingContentCode:"soil"},itemEvidence:{fixedDumpItemCode:"SOIL"}});
  const replacement=await charge(f,{calculator:{incomingContentCode:"concrete"},itemEvidence:{fixedDumpItemCode:"CONCRETE"}});
  await query("UPDATE mbt_service_visits SET material_id=NULL,service_snapshot=service_snapshot || $2::jsonb WHERE service_visit_id=$1",[f.successorVisitId,JSON.stringify({chargeRequestId:initial})]);
  await query("UPDATE mbt_contract_service_lines SET pricing_snapshot=$2::jsonb WHERE service_line_id=$1",[f.lineId,JSON.stringify({chargeRequestId:replacement,contentCode:"concrete"})]);
  await accepted(f.dumpSiteId,soil);await accepted(f.dumpSiteId,concrete);
  const saved=await configureBinOrderWorkflow(command(f));
  assert.equal(saved.body.configuration.materialId,concrete);
});

test("order material: inactive material blocks planning and a matching stale-client material remains compatible",async()=>{
  const f=await fixture();await query("UPDATE mbt_materials SET active=false WHERE material_id=$1",[f.materialId]);
  const options=await getBinOrderWorkflowOptions(f.successorVisitId);
  assert.match(options.orderMaterial.issue,/inactive/i);assert.deepEqual(options.dumping,[]);
  await assert.rejects(configureBinOrderWorkflow(command(f)),/inactive/i);
  await query("UPDATE mbt_materials SET active=true WHERE material_id=$1",[f.materialId]);
  const saved=await configureBinOrderWorkflow(command(f,{materialId:f.materialId}));
  assert.equal(saved.body.configuration.materialId,f.materialId);
});

test("order material: retargeting a draft final collection validates and updates its replacement contents atomically",async()=>{
  const f=await fixture("soil"),soil=await material("SOIL"),garbage=await material("GARBAGE"),type20="00000000-0000-4000-8000-000000000020";
  await accepted(f.dumpSiteId,soil);
  await query("UPDATE mbt_service_visits SET material_id=NULL WHERE service_visit_id=$1",[f.successorVisitId]);
  await query("UPDATE mbt_contract_service_lines SET pricing_snapshot=$2::jsonb WHERE service_line_id=$1",[f.lineId,JSON.stringify({contentCode:"soil"})]);
  const final=await configureBinOrderWorkflow(command(f));
  const replacement=await receiving(f,type20);
  await query("UPDATE mbt_bin_assets SET bin_type_id=$2 WHERE asset_id=$1",[replacement.assetId,type20]);
  const id=await exchange(f,"garbage",type20);
  await query("UPDATE mbt_contract_service_lines SET pricing_snapshot=$2::jsonb WHERE service_line_id=$1",[f.lineId,JSON.stringify({contentCode:"garbage"})]);
  const input=command(f,{visitId:id,sequence:"delivery_first",reuse:"different_bin",deliveryAssetId:replacement.assetId,
    deliveryWindow:{startAt:`${f.planDate}T11:00:00Z`,endAt:`${f.planDate}T12:00:00Z`}});
  await assert.rejects(configureBinOrderWorkflow(input),/accept.*material|material.*accept/i);
  const unchanged=(await query("SELECT material_id,expected_asset_id FROM mbt_service_visits WHERE service_visit_id=$1",[final.body.parts[0].visitId])).rows[0];
  assert.equal(unchanged.material_id,soil);assert.equal(unchanged.expected_asset_id,f.assetId);
  assert.equal((await query("SELECT count(*)::int AS n FROM mbt_bin_order_parts WHERE order_id=$1",[id])).rows[0].n,0);
  await accepted(f.dumpSiteId,garbage);
  await configureBinOrderWorkflow({...input,idempotencyKey:crypto.randomUUID()});
  const updated=(await query("SELECT material_id,expected_asset_id,bin_type_id FROM mbt_service_visits WHERE service_visit_id=$1",[final.body.parts[0].visitId])).rows[0];
  assert.equal(updated.material_id,garbage);assert.equal(updated.expected_asset_id,replacement.assetId);assert.equal(updated.bin_type_id,type20);
  assert.equal((await query("SELECT configuration FROM mbt_bin_orders WHERE order_id=$1",[f.successorVisitId])).rows[0].configuration.materialId,garbage);
});

test("order material: the replacement order supersedes a legacy final collection's original material ID",async()=>{
  const f=await fixture("soil"),concrete=await material("CONCRETE");
  await query("UPDATE mbt_contract_service_lines SET pricing_snapshot=$2::jsonb WHERE service_line_id=$1",
    [f.lineId,JSON.stringify({materialId:f.materialId})]);
  const id=await exchange(f,"concrete");
  await accepted(f.dumpSiteId,concrete);
  const options=await getBinOrderWorkflowOptions(f.successorVisitId);
  assert.equal(options.orderMaterial.materialId,concrete);
  const saved=await configureBinOrderWorkflow(command(f));
  assert.equal(saved.body.configuration.materialId,concrete);
  // Resolving the current definition never rewrites the immutable source order.
  assert.equal((await query("SELECT material_id FROM mbt_service_visits WHERE service_visit_id=$1",[f.successorVisitId])).rows[0].material_id,f.materialId);
  assert.equal((await query("SELECT configuration FROM mbt_bin_orders WHERE order_id=$1",[id])).rows[0].configuration,null);
});
