// @ts-check
import crypto from "node:crypto";
import { query } from "../db.js";
import { DISPATCH_FLEET_PLANNING_LOCK } from "../dispatch-fleet-status.js";
import { executeMbtCommand } from "./command-repository.js";
import { buildBinOrderWorkflow } from "./bin-order-workflow-domain.js";
import { binWorkflowError,binWorkflowOrder,binWorkflowParts,binWorkflowAsset,binWorkflowAssetLocation,
  binWorkflowLocation,binWorkflowSite,insertBinWorkflowPart } from "./bin-order-workflow-repository.js";

/** @param {string} visitId */
export async function getBinOrderWorkflow(visitId) {
  const root = await binWorkflowOrder(visitId);
  const parts = await binWorkflowParts(String(root.service_visit_id));
  const events=await query("SELECT action,visit_id,details,created_at FROM mbt_bin_workflow_events WHERE order_id=$1 ORDER BY created_at DESC LIMIT 100",[root.service_visit_id]);
  return JSON.parse(JSON.stringify({orderId:String(root.service_visit_id),reference:root.display_reference,rentalNumber:root.rental_number,
    serviceLineId:String(root.service_line_id),kind:root.order_kind,exchangeNumber:root.exchange_number,
    revision:Number(root.workflow_revision),configured:Boolean(root.configuration),configuration:root.configuration,
    status:root.status,currentAssetId:root.current_asset_id,recoveryPending:root.recovery_pending,events:events.rows,
    parts:parts.map((/** @type {any} */ p)=>({visitId:String(p.visit_id),role:p.part_role,reference:p.display_reference,
      assetId:String(p.asset_id),assetCode:p.asset_code,status:p.status,revision:Number(p.revision),
      planId:p.dispatch_plan_id,truckId:p.planned_truck_id,loadId:p.dispatch_load_id,
      linkedDeliveryVisitId:p.linked_delivery_visit_id,window:{startAt:p.scheduled_start_at,endAt:p.scheduled_end_at},
      steps:p.service_snapshot.mandatoryStops}))}));
}

/** @param {any} actor */
function assertActor(actor) {
  if (!actor?.operatorId || !actor.roles?.some((/** @type {string} */ r)=>["admin","dispatcher"].includes(r))) {
    throw binWorkflowError(403,"Dispatcher or Admin access is required.");
  }
}

/** @param {any} root @param {any} input */
async function assertConfigurable(root, input) {
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision !== Number(root.workflow_revision)) {
    throw binWorkflowError(409,"The BIN workflow revision changed. Refresh before retrying.");
  }
  const issued = await query(`SELECT 1 FROM mbt_bin_planning_assignments WHERE service_visit_id=$1
    AND released_at IS NOT NULL LIMIT 1`,[root.service_visit_id]);
  if (root.dispatch_plan_id || root.actual_started_at || ["completed","cancelled"].includes(root.status) || issued.rowCount) {
    throw binWorkflowError(409,"Issued or started BIN work retains its existing instructions; finish or recover that work first.");
  }
  if (root.configuration) {
    const parts=await binWorkflowParts(String(root.service_visit_id));
    const childIssued=await query(`SELECT 1 FROM mbt_bin_planning_assignments a JOIN mbt_bin_order_parts p
      ON p.visit_id=a.service_visit_id WHERE p.order_id=$1 AND a.released_at IS NOT NULL LIMIT 1`,[root.service_visit_id]);
    if (childIssued.rowCount || parts.some((/** @type {any} */ p)=>p.dispatch_plan_id || p.actual_started_at)) {
      throw binWorkflowError(409,"Only unassigned, unissued workflows can be changed. Unplan the draft parts first.");
    }
    const external=await query(`SELECT 1 FROM mbt_bin_workflow_dependencies d
      JOIN mbt_bin_order_parts p ON p.visit_id=d.dependent_visit_id
      JOIN mbt_bin_order_parts q ON q.visit_id=d.prerequisite_visit_id
      WHERE p.order_id<>q.order_id AND (p.order_id=$1 OR q.order_id=$1) LIMIT 1`,[root.service_visit_id]);
    if (external.rowCount) {throw binWorkflowError(409,"This workflow is linked to another rental. Its linked route must be retained.");}
  }
  if (root.rental_status === "closed") {throw binWorkflowError(409,"This BIN rental is already closed.");}
}

/** @param {any} root @param {any} input */
async function selectedAssets(root, input) {
  const result = /** @type {any} */ ({});
  if (root.order_kind !== "delivery") {
    Object.assign(result,await selectedCollection(root,input));
  }
  if (root.order_kind !== "collection") {
    result.delivery=await selectedDelivery(root,input,result.collection);
  }
  return result;
}

/** @param {any} root */
async function latestPlacement(root) {
  return (await query(`SELECT p.asset_id,p.visit_id,v.status FROM mbt_bin_order_parts p
    JOIN mbt_bin_orders o ON o.order_id=p.order_id JOIN mbt_service_visits v ON v.service_visit_id=p.visit_id
    WHERE o.service_line_id=$1 AND p.part_role='delivery' AND o.order_id<>$2 AND v.status<>'cancelled'
    ORDER BY o.exchange_number DESC LIMIT 1`,[root.service_line_id,root.service_visit_id])).rows[0];
}

/** @param {any} root @param {any} placement */
function expectedCollection(root, placement) {
  if (root.order_kind==="collection") {
    if (placement && placement.status!=="completed") {return placement.asset_id;}
    return root.current_asset_id || placement?.asset_id || root.expected_asset_id;
  }
  return root.expected_asset_id || root.current_asset_id;
}

/** @param {any} root @param {any} input */
async function selectedCollection(root, input) {
  const placement=await latestPlacement(root),expected=expectedCollection(root,placement);
  const chosen=input.collectionAssetId || expected;
  if (!chosen || (expected && String(expected)!==String(chosen))) {
    throw binWorkflowError(409,"Choose the rental's current physical collection bin.");
  }
  const collection=await binWorkflowAsset(chosen,true);
  const pendingPlacement=root.order_kind==="collection" && placement?.asset_id===chosen && placement.status!=="completed";
  const collectionPlacementId=pendingPlacement ? placement.visit_id : null;
  if (!pendingPlacement && (collection.location_kind!=="customer_site"
      || String(collection.customer_site_profile_id)!==String(root.customer_site_profile_id))) {
    throw binWorkflowError(409,"The collection bin is not recorded at this customer's site.");
  }
  await assertNoUnrelatedCollection(root,chosen,collectionPlacementId);
  return {collection,collectionPlacementId};
}

/** @param {any} root @param {string} assetId @param {string | null} placementId */
async function assertNoUnrelatedCollection(root, assetId, placementId) {
  const pending=await query(`WITH RECURSIVE ancestors(id) AS (
    SELECT $3::uuid UNION SELECT d.prerequisite_visit_id FROM mbt_bin_workflow_dependencies d
      JOIN ancestors a ON d.dependent_visit_id=a.id)
    SELECT 1 FROM mbt_bin_order_parts p JOIN mbt_service_visits v ON v.service_visit_id=p.visit_id
    JOIN mbt_bin_orders o ON o.order_id=p.order_id
    WHERE p.asset_id=$1 AND p.order_id<>$2 AND p.part_role='collection' AND v.status NOT IN ('completed','cancelled')
      AND NOT EXISTS(SELECT 1 FROM ancestors a WHERE a.id=p.visit_id)
      AND NOT ($4='exchange' AND o.order_kind='collection' AND o.service_line_id=$5
        AND v.dispatch_plan_id IS NULL AND v.actual_started_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM mbt_bin_planning_assignments a WHERE a.service_visit_id=p.visit_id AND a.released_at IS NOT NULL))
      LIMIT 1`,[assetId,root.service_visit_id,placementId,root.order_kind,root.service_line_id]);
  if (pending.rowCount) {throw binWorkflowError(409,"This physical bin already has an outstanding collection.");}
}

/** @param {any} root @param {any} input @param {any} collection */
async function selectedDelivery(root, input, collection) {
  const chosen=root.order_kind==="exchange" && input.reuse==="same_bin" ? collection.asset_id : input.deliveryAssetId;
  if (!chosen) {throw binWorkflowError(400,"Choose the physical delivery bin.");}
  const delivery=await binWorkflowAsset(chosen,true);
  if (String(delivery.bin_type_id)!==String(root.bin_type_id)) {throw binWorkflowError(409,"The delivery bin type does not match the order.");}
  const empty=["available","at_dump"].includes(delivery.lifecycle_status)
    || (delivery.lifecycle_status==="on_truck" && /dump|empty/u.test(delivery.movement_type));
  if (chosen!==collection?.asset_id && !empty) {throw binWorkflowError(409,"Choose an empty available bin or link its preceding Collection.");}
  return delivery;
}

/** @param {any} root @param {any} input */
async function dumpConfiguration(root, input) {
  if (root.order_kind === "delivery") {return {};}
  const materialId = input.materialId || root.material_id;
  if (!input.dumpSiteId || !materialId) {throw binWorkflowError(400,"Choose a dump site and collected material.");}
  const accepted = await query(`SELECT 1 FROM mbt_dump_site_materials a JOIN mbt_materials m ON m.material_id=a.material_id
    WHERE a.dump_site_id=$1 AND a.material_id=$2 AND a.active AND a.accepted AND m.active`,[input.dumpSiteId,materialId]);
  if (!accepted.rowCount) {throw binWorkflowError(409,"The selected dump site does not accept this material.");}
  return {materialId,dumpSiteId:input.dumpSiteId,dumpSite:await binWorkflowLocation("dump_site",input.dumpSiteId)};
}

/** @param {any} root @param {any} input @param {any} assets @param {any} dump */
async function destinationConfiguration(root, input, assets, dump) {
  if (root.order_kind === "delivery" || (input.sequence === "collection_first" && input.reuse === "same_bin")) {return null;}
  if (input.destination?.kind === "delivery") {
    const target = await binWorkflowOrder(input.destination.orderId || input.destination.visitId,true);
    if (String(target.service_visit_id) === String(root.service_visit_id) || target.order_kind === "collection") {
      throw binWorkflowError(409,"Choose a different receiving Delivery or Exchange order.");
    }
    const delivery=await receivingDelivery(target,input,assets.collection,dump);
    return {kind:"delivery",visitId:String(delivery.visit_id),orderId:String(target.service_visit_id),
      reference:delivery.display_reference,binTypeId:String(target.bin_type_id)};
  }
  if (!input.destination?.yardId) {throw binWorkflowError(400,"Choose a return yard or the next delivery order.");}
  return {kind:"yard",location:await binWorkflowLocation("yard",input.destination.yardId)};
}

/** @param {any} target @param {any} input @param {any} asset @param {any} dump */
async function receivingDelivery(target, input, asset, dump) {
  const parts=await binWorkflowParts(String(target.service_visit_id));
  let delivery=parts.find((/** @type {any} */ p)=>p.part_role==="delivery");
  if (!delivery && target.order_kind==="delivery") {
    await assertConfigurable(target,{expectedRevision:Number(target.workflow_revision)});
    if (String(target.bin_type_id)!==String(asset.bin_type_id)) {throw binWorkflowError(409,"The receiving order requires a different bin type.");}
    const receiving=buildBinOrderWorkflow({rentalNumber:target.rental_number,kind:"delivery",
      binTypeId:String(target.bin_type_id),deliveryAssetId:asset.asset_id,source:{...dump.dumpSite,planned:true},
      sourceDeliveryVisitId:"pending_collection",site:binWorkflowSite(target),
      deliveryWindow:await workflowWindow(input.destination.deliveryWindow) || {startAt:target.scheduled_start_at,endAt:target.scheduled_end_at}});
    await persistWorkflow(target,receiving,String(input.actor.operatorId));
    delivery=(await binWorkflowParts(String(target.service_visit_id)))[0];
  }
  if (!delivery || delivery.dispatch_plan_id || delivery.actual_started_at || ["completed","cancelled"].includes(delivery.status)) {
    throw binWorkflowError(409,"Configure the receiving delivery first and leave it unassigned before linking the collected bin.");
  }
  const issued=await query("SELECT 1 FROM mbt_bin_planning_assignments WHERE service_visit_id=$1 AND released_at IS NOT NULL LIMIT 1",[delivery.visit_id]);
  if (issued.rowCount) {throw binWorkflowError(409,"A previously issued delivery cannot be relinked to another bin.");}
  return delivery;
}
/** @param {any} root @param {any} input */
async function compileWorkflow(root, input) {
  const assets = await selectedAssets(root,input);
  const dump = await dumpConfiguration(root,input);
  const destination = await destinationConfiguration(root,input,assets,dump);
  const parameters = {rentalNumber:root.rental_number,kind:root.order_kind,exchangeNumber:root.exchange_number,
    sequence:input.sequence,reuse:input.reuse,binTypeId:String(root.bin_type_id),
    collectionBinTypeId:assets.collection ? String(assets.collection.bin_type_id) : null,
    deliveryAssetId:assets.delivery?.asset_id,collectionAssetId:assets.collection?.asset_id,
    source:assets.delivery ? await binWorkflowAssetLocation(assets.delivery) : null,
    site:binWorkflowSite(root),...dump,destination,deliveryWindow:await workflowWindow(input.deliveryWindow),collectionWindow:await workflowWindow(input.collectionWindow)};
  try {return {...buildBinOrderWorkflow(parameters),...dump,collectionPlacementId:assets.collectionPlacementId || null,
    sequence:input.sequence || null,reuse:input.reuse || null};}
  catch (error) {throw binWorkflowError(400,error instanceof Error ? error.message : String(error));}
}

/** @param {any} window */
async function workflowWindow(window) {
  if (!window?.startLocal && !window?.endLocal) {return window;}
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(window.startLocal || "")
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(window.endLocal || "")) {
    throw binWorkflowError(400,"Enter both schedule times in Toronto local time.");
  }
  const {rows:[row]}=await query(`SELECT $1::timestamp AT TIME ZONE 'America/Toronto' AS start,
    $2::timestamp AT TIME ZONE 'America/Toronto' AS finish`,[window.startLocal,window.endLocal]);
  return {startAt:row.start.toISOString(),endAt:row.finish.toISOString()};
}

/** @param {any} root @param {any} flow @param {string} actorId */
async function persistWorkflow(root, flow, actorId) {
  let number = Number((await query("SELECT COALESCE(max(visit_number),0)::int AS n FROM mbt_service_visits WHERE contract_id=$1",
    [root.contract_id])).rows[0].n);
  const parts = [];
  const existing=await binWorkflowParts(String(root.service_visit_id));
  const ids=existing.map((/** @type {any} */ p)=>p.visit_id);
  if (ids.length) {
    await query("DELETE FROM mbt_bin_workflow_dependencies WHERE dependent_visit_id=ANY($1::uuid[]) OR prerequisite_visit_id=ANY($1::uuid[])",[ids]);
    await query("DELETE FROM mbt_visit_evidence_requirements WHERE service_visit_id=ANY($1::uuid[])",[ids]);
    await query("DELETE FROM mbt_visit_steps WHERE service_visit_id=ANY($1::uuid[])",[ids]);
  }
  for (const part of flow.parts) {
    const prior=existing.find((/** @type {any} */ p)=>p.part_role===part.role);
    parts.push(await insertBinWorkflowPart(root,flow,{...part,visitId:prior?.visit_id},actorId,++number));
  }
  const byRole = new Map(parts.map(p=>[p.role,p]));
  for (const edge of flow.dependencies) {
    await query(`INSERT INTO mbt_bin_workflow_dependencies
      (dependent_visit_id,dependent_action_code,prerequisite_visit_id,prerequisite_action_code,same_day)
      VALUES ($1,$2,$3,$4,$5)`,[byRole.get(edge.part).visitId,edge.actionCode,
      byRole.get(edge.requiresPart).visitId,edge.requiresActionCode,flow.sameDay]);
  }
  if (flow.collectionPlacementId) {
    await query(`INSERT INTO mbt_bin_workflow_dependencies(dependent_visit_id,dependent_action_code,prerequisite_visit_id,prerequisite_action_code)
      VALUES ($1,'pickup_bin',$2,'deliver_bin')`,[byRole.get("collection").visitId,flow.collectionPlacementId]);
  }
  for (const part of parts) {
    if (part.destination?.kind !== "delivery") {continue;}
    const targetId = part.destination.part ? byRole.get(part.destination.part).visitId : part.destination.visitId;
    await query("UPDATE mbt_bin_order_parts SET linked_delivery_visit_id=$2 WHERE visit_id=$1",[part.visitId,targetId]);
    if (!part.destination.part) {
      // External link setup replaces the target's unissued pickup and asset
      // identity; the delivery itself remains the receiving rental's job.
      await linkBinWorkflowDelivery(part.visitId,targetId,part.assetId);
    }
  }
  if (root.order_kind==="exchange") {await retargetFinalCollection(root,byRole.get("delivery"),actorId);}
  await query(`UPDATE mbt_bin_orders SET configuration=$2::jsonb,configured_at=now(),revision=revision+1 WHERE order_id=$1`,
    [root.service_visit_id,JSON.stringify({...flow,parts})]);
}

/** A draft final collection takes the replacement; older exchange collections retain their bins.
 * @param {any} root @param {any} delivery @param {string} actorId */
async function retargetFinalCollection(root,delivery,actorId) {
  const {rows:[final]}=await query(`SELECT v.*,p.order_id,p.linked_delivery_visit_id,o.configuration
    FROM mbt_bin_orders o JOIN mbt_bin_order_parts p ON p.order_id=o.order_id
    JOIN mbt_service_visits v ON v.service_visit_id=p.visit_id WHERE o.service_line_id=$1
      AND o.order_kind='collection' AND v.status NOT IN ('completed','cancelled') FOR UPDATE OF o,p,v`,[root.service_line_id]);
  if (!final) {return;}
  const issued=await query("SELECT 1 FROM mbt_bin_planning_assignments WHERE service_visit_id=$1 AND released_at IS NOT NULL LIMIT 1",[final.service_visit_id]);
  if (final.dispatch_plan_id || final.actual_started_at || issued.rowCount) {
    throw binWorkflowError(409,"The final collection already has issued or assigned instructions. Resolve that collection before adding a replacement.");
  }
  const snapshot=final.service_snapshot;
  snapshot.mandatoryStops=snapshot.mandatoryStops.map((/** @type {any} */ s)=>({...s,assetId:delivery.assetId}));
  await query(`UPDATE mbt_bin_order_parts SET asset_id=$2 WHERE visit_id=$1`,[final.service_visit_id,delivery.assetId]);
  await query(`UPDATE mbt_visit_steps SET expected_asset_id=$2 WHERE service_visit_id=$1`,[final.service_visit_id,delivery.assetId]);
  await query(`UPDATE mbt_service_visits SET expected_asset_id=$2,outgoing_asset_id=$2,bin_type_id=$3,
    service_snapshot=$4::jsonb,revision=revision+1,updated_by=$5,updated_at=now() WHERE service_visit_id=$1`,
  [final.service_visit_id,delivery.assetId,delivery.binTypeId,JSON.stringify(snapshot),actorId]);
  await query("DELETE FROM mbt_bin_workflow_dependencies WHERE dependent_visit_id=$1 AND dependent_action_code='pickup_bin'",[final.service_visit_id]);
  await query(`INSERT INTO mbt_bin_workflow_dependencies(dependent_visit_id,dependent_action_code,prerequisite_visit_id,prerequisite_action_code)
    VALUES ($1,'pickup_bin',$2,'deliver_bin')`,[final.service_visit_id,delivery.visitId]);
  if (final.linked_delivery_visit_id) {await linkBinWorkflowDelivery(final.service_visit_id,final.linked_delivery_visit_id,delivery.assetId);}
  const configuration={...final.configuration,parts:final.configuration.parts.map((/** @type {any} */ p)=>({
    ...p,assetId:delivery.assetId,binTypeId:delivery.binTypeId,steps:snapshot.mandatoryStops}))};
  await query("UPDATE mbt_bin_orders SET configuration=$2::jsonb,revision=revision+1 WHERE order_id=$1",
    [final.order_id,JSON.stringify(configuration)]);
  await query(`INSERT INTO mbt_bin_workflow_events(event_id,order_id,visit_id,action,details)
    VALUES ($1,$2,$3,'draft_collection_retargeted',$4::jsonb)`,[crypto.randomUUID(),final.order_id,final.service_visit_id,
    JSON.stringify({previousAssetId:final.expected_asset_id,assetId:delivery.assetId,afterDelivery:delivery.reference,actorId})]);
}

/** @param {string} collectionId @param {string} deliveryId @param {string} assetId */
async function linkBinWorkflowDelivery(collectionId, deliveryId, assetId) {
  const target = (await query("SELECT * FROM mbt_service_visits WHERE service_visit_id=$1 FOR UPDATE",[deliveryId])).rows[0];
  const issued=await query("SELECT 1 FROM mbt_bin_planning_assignments WHERE service_visit_id=$1 AND released_at IS NOT NULL LIMIT 1",[deliveryId]);
  if (target.dispatch_plan_id || target.actual_started_at || ["completed","cancelled"].includes(target.status) || issued.rowCount) {
    throw binWorkflowError(409,"The onward delivery is already assigned or issued and cannot be retargeted.");
  }
  const source = (await query("SELECT * FROM mbt_service_visits WHERE service_visit_id=$1",[collectionId])).rows[0];
  const asset = await binWorkflowAsset(assetId,true);
  if (String(target.bin_type_id) !== String(asset.bin_type_id)) {throw binWorkflowError(409,"The receiving order requires a different bin type.");}
  const existing = await query("SELECT 1 FROM mbt_bin_order_parts WHERE linked_delivery_visit_id=$1 AND visit_id<>$2",[deliveryId,collectionId]);
  if (existing.rowCount) {throw binWorkflowError(409,"This delivery already receives a bin from another Collection.");}
  const cycle = await query(`WITH RECURSIVE chain(id) AS (
    SELECT prerequisite_visit_id FROM mbt_bin_workflow_dependencies WHERE dependent_visit_id=$1
    UNION SELECT d.prerequisite_visit_id FROM mbt_bin_workflow_dependencies d JOIN chain c ON d.dependent_visit_id=c.id
  ) SELECT 1 FROM chain WHERE id=$2`,[collectionId,deliveryId]);
  if (cycle.rowCount) {throw binWorkflowError(409,"This reuse link would create a circular dependency.");}
  const dump = source.service_snapshot.mandatoryStops.find((/** @type {any} */ s)=>s.actionCode === "dump_bin");
  const snapshot = target.service_snapshot;
  snapshot.mandatoryStops = snapshot.mandatoryStops.filter((/** @type {any} */ s)=>s.actionCode !== "collect_empty_bin")
    .map((/** @type {any} */ s,/** @type {number} */ i)=>({...s,sequence:i+1,assetId}));
  snapshot.binWorkflow.source = {...dump.location,planned:true,predecessorVisitId:collectionId};
  await query("DELETE FROM mbt_visit_evidence_requirements WHERE visit_step_id IN (SELECT visit_step_id FROM mbt_visit_steps WHERE service_visit_id=$1 AND action_code='collect_empty_bin')",[deliveryId]);
  await query("DELETE FROM mbt_visit_steps WHERE service_visit_id=$1 AND action_code='collect_empty_bin'",[deliveryId]);
  await query("UPDATE mbt_visit_steps SET expected_asset_id=$2 WHERE service_visit_id=$1",[deliveryId,assetId]);
  await query(`UPDATE mbt_service_visits SET expected_asset_id=$2,outgoing_asset_id=$2,service_snapshot=$3::jsonb,
    revision=revision+1 WHERE service_visit_id=$1`,[deliveryId,assetId,JSON.stringify(snapshot)]);
  await query("UPDATE mbt_bin_order_parts SET asset_id=$2 WHERE visit_id=$1",[deliveryId,assetId]);
  await query(`INSERT INTO mbt_bin_workflow_dependencies(dependent_visit_id,dependent_action_code,prerequisite_visit_id,prerequisite_action_code)
    VALUES ($1,'deliver_bin',$2,'dump_bin') ON CONFLICT DO NOTHING`,[deliveryId,collectionId]);
  const targetRoot=await binWorkflowOrder(deliveryId,true);
  const configuration={...targetRoot.configuration,parts:targetRoot.configuration.parts.map((/** @type {any} */ p)=>
    p.role==="delivery" ? {...p,assetId,source:snapshot.binWorkflow.source,steps:snapshot.mandatoryStops} : p)};
  await query("UPDATE mbt_bin_orders SET configuration=$2::jsonb,revision=revision+1 WHERE order_id=$1",
    [targetRoot.service_visit_id,JSON.stringify(configuration)]);
  await retargetFinalCollection(targetRoot,{visitId:deliveryId,assetId,binTypeId:String(target.bin_type_id),
    reference:snapshot.binWorkflow.reference},"linked-bin-delivery");
}

/** @param {any} input */
export async function configureBinOrderWorkflow(input) {
  assertActor(input.actor);
  const {actor,idempotencyKey,correlationId,requestId,...payload} = input;
  return executeMbtCommand({actor,commandName:"mbt.bin_workflow.configure",idempotencyKey,correlationId,requestId,payload,
    mutation:async()=>{
      await query("SELECT pg_advisory_xact_lock(hashtext($1))",[DISPATCH_FLEET_PLANNING_LOCK]);
      const root = await binWorkflowOrder(input.visitId,true);
      await assertConfigurable(root,input);
      const flow = await compileWorkflow(root,input);
      await persistWorkflow(root,flow,String(actor.operatorId));
      const body = await getBinOrderWorkflow(String(root.service_visit_id));
      await query(`INSERT INTO mbt_bin_workflow_events(event_id,order_id,action,details)
        VALUES ($1,$2,'configured',$3::jsonb)`,[crypto.randomUUID(),root.service_visit_id,JSON.stringify({actorId:actor.operatorId,reference:body.reference})]);
      return {status:201,body,audit:{action:"mbt.bin_workflow.configured",entityType:"mbt_bin_order",
        entityId:String(root.service_visit_id),beforeState:{revision:Number(root.workflow_revision)},afterState:body,
        reason:input.reason || "Configure BIN workflow",revisionBefore:Number(root.workflow_revision),
        revisionAfter:body.revision,source:"bin_planning"}};
    }});
}

/** Dispatcher choices are resolved from physical state and open orders.
 * @param {string} visitId */
export async function getBinOrderWorkflowOptions(visitId) {
  const root=await binWorkflowOrder(visitId);
  const workflow=await getBinOrderWorkflow(visitId);
  const collectionAssetId=expectedCollection(root,await latestPlacement(root));
  const assets=await query(`SELECT a.asset_id,a.asset_code,a.bin_type_id,b.type_code,s.lifecycle_status,s.location_kind,
      s.location_reference,s.current_address,s.yard_id,s.truck_id,s.customer_site_profile_id,s.revision AS state_revision,
      y.display_name AS yard_name,t.plate,m.movement_type,
      CASE s.location_kind WHEN 'yard' THEN
        COALESCE(NULLIF(concat_ws(', ',y.address_line_1,y.address_line_2,y.city,y.region,y.postal_code),''),y.yard_code)
        WHEN 'dump_site' THEN COALESCE(NULLIF(concat_ws(', ',d.address_line_1,d.city,d.region,d.postal_code),''),d.display_name)
        WHEN 'truck' THEN concat('Already aboard truck ',t.plate)
        ELSE COALESCE(NULLIF(NULLIF(s.current_address,'Unknown'),'undefined'),s.location_reference) END AS source_address
    FROM mbt_bin_assets a JOIN mbt_bin_asset_state s ON s.asset_id=a.asset_id JOIN mbt_bin_types b ON b.bin_type_id=a.bin_type_id
    JOIN mbt_bin_movements m ON m.movement_id=s.last_movement_id
    LEFT JOIN mbt_yards y ON y.yard_id=s.yard_id LEFT JOIN dispatch_trucks t ON t.id=s.truck_id
    LEFT JOIN mbt_dump_sites d ON d.dump_site_id=s.dump_site_id
    WHERE a.active AND NOT a.under_maintenance AND (a.bin_type_id=$1 OR a.asset_id=$2) ORDER BY a.asset_code`,
  [root.bin_type_id,collectionAssetId]);
  const yards=await query("SELECT yard_id,yard_code,display_name FROM mbt_yards WHERE active ORDER BY yard_code");
  const dumping=await query(`SELECT d.dump_site_id,d.display_name AS dump_name,m.material_id,m.display_name AS material_name
    FROM mbt_dump_site_materials a JOIN mbt_dump_sites d ON d.dump_site_id=a.dump_site_id
    JOIN mbt_materials m ON m.material_id=a.material_id
    WHERE a.active AND a.accepted AND d.active AND m.active ORDER BY d.display_name,m.display_name`);
  const targets=await query(`SELECT o.order_id,o.display_reference,o.order_kind,v.scheduled_start_at,v.scheduled_end_at,
      v.customer_snapshot->>'displayName' AS customer,v.site_snapshot
    FROM mbt_bin_orders o JOIN mbt_service_visits v ON v.service_visit_id=o.order_id
    LEFT JOIN mbt_bin_order_parts p ON p.order_id=o.order_id AND p.part_role='delivery'
    LEFT JOIN mbt_service_visits child ON child.service_visit_id=p.visit_id
    WHERE o.order_id<>$1 AND v.status NOT IN ('completed','cancelled') AND v.dispatch_plan_id IS NULL
      AND v.bin_type_id=COALESCE((SELECT bin_type_id FROM mbt_bin_assets WHERE asset_id=$3),$2)
      AND (o.order_kind='delivery' OR (o.order_kind='exchange' AND p.visit_id IS NOT NULL))
      AND (child.service_visit_id IS NULL OR (child.dispatch_plan_id IS NULL AND child.actual_started_at IS NULL
        AND child.status NOT IN ('completed','cancelled')))
      AND NOT EXISTS(SELECT 1 FROM mbt_bin_order_parts source WHERE source.linked_delivery_visit_id=p.visit_id)
    ORDER BY v.scheduled_start_at NULLS LAST,o.display_reference LIMIT 100`,
  [root.service_visit_id,root.bin_type_id,collectionAssetId]);
  const trucks=await query("SELECT id::text,plate FROM dispatch_trucks WHERE active AND truck_type='bin' AND bin_service_enabled ORDER BY plate");
  return {workflow,binTypeId:String(root.bin_type_id),collectionAssetId,trucks:trucks.rows,
    defaultWindow:{startAt:root.scheduled_start_at,endAt:root.scheduled_end_at},assets:assets.rows,yards:yards.rows,
    dumping:dumping.rows,targets:targets.rows};
}
