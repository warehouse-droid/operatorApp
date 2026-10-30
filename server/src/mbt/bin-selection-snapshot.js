// @ts-check
import crypto from "node:crypto";
import { query } from "../db.js";
import { binVisitDisplayReference, binWorkflowAssetLocation } from "./bin-order-workflow-repository.js";

/** Preserve action identities while changing the physical source. @param {any} visit @param {any} asset @param {any} source */
export function selectedDeliverySnapshot(visit,asset,source) {
  const snapshot=structuredClone(visit.service_snapshot);
  let stops=snapshot.mandatoryStops || [];
  const pickup=stops.find((/** @type {any} */ s)=>s.actionCode==="collect_empty_bin");
  if (source.kind==="truck") {stops=stops.filter((/** @type {any} */ s)=>s.actionCode!=="collect_empty_bin");}
  else {
    const next={...pickup,stopId:pickup?.stopId || `${visit.service_visit_id}:selection-pickup`,
      actionCode:"collect_empty_bin",stopKind:"pickup",displayName:"Pick up empty bin",locationRole:"source_location",
      location:source,planningAddress:source.address,yardId:source.kind==="yard" ? source.id : null,
      yardCode:source.yardCode || null,assetId:asset.asset_id,assetCode:asset.asset_code};
    stops=[next,...stops.filter((/** @type {any} */ s)=>s.actionCode!=="collect_empty_bin")];
  }
  snapshot.mandatoryStops=stops.map((/** @type {any} */ s,/** @type {number} */ i)=>({...s,sequence:i+1}));
  snapshot.binWorkflow={...snapshot.binWorkflow,source};
  return snapshot;
}

/** Only pending steps can enter this function. Retain every surviving step/evidence identity.
 * @param {any} visit @param {any} snapshot @param {string} oldAssetId @param {any} asset */
export async function updateBinWorkflowSteps(visit,snapshot,oldAssetId,asset) {
  const existing=(await query("SELECT * FROM mbt_visit_steps WHERE service_visit_id=$1 ORDER BY sequence_number FOR UPDATE",[visit.service_visit_id])).rows;
  const actions=snapshot.mandatoryStops.map((/** @type {any} */ s)=>s.actionCode);
  for (const step of existing.filter((/** @type {any} */ s)=>!actions.includes(s.action_code))) {
    await query("DELETE FROM mbt_visit_evidence_requirements WHERE visit_step_id=$1",[step.visit_step_id]);
    await query("DELETE FROM mbt_visit_steps WHERE visit_step_id=$1",[step.visit_step_id]);
  }
  // Move the old indices aside before inserting/reordering under the unique key.
  await query("UPDATE mbt_visit_steps SET sequence_number=sequence_number+10000 WHERE service_visit_id=$1",[visit.service_visit_id]);
  for (const [i,stop] of snapshot.mandatoryStops.entries()) {
    const previous=existing.find((/** @type {any} */ s)=>s.action_code===stop.actionCode);
    if (previous) {
      await query(`UPDATE mbt_visit_steps SET sequence_number=$2,location_role=$3,display_name=$6,
        expected_asset_id=CASE WHEN expected_asset_id=$4 OR expected_asset_id IS NULL THEN $5 ELSE expected_asset_id END
        WHERE visit_step_id=$1`,[previous.visit_step_id,i,stop.locationRole,oldAssetId,asset.asset_id,stop.displayName || stop.actionCode.replaceAll('_',' ')]);
    } else {
      const id=crypto.randomUUID();
      await query(`INSERT INTO mbt_visit_steps(visit_step_id,service_visit_id,sequence_number,action_code,display_name,location_role,expected_asset_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`,[id,visit.service_visit_id,i,stop.actionCode,
        stop.displayName || stop.actionCode.replaceAll("_"," "),stop.locationRole,asset.asset_id]);
      for (const [code,type] of [["bin_scan","bin_scan"],["bin_photo","photo"]]) {
        await query(`INSERT INTO mbt_visit_evidence_requirements(visit_evidence_requirement_id,service_visit_id,visit_step_id,evidence_code,evidence_type)
          VALUES ($1,$2,$3,$4,$5)`,[crypto.randomUUID(),visit.service_visit_id,id,code,type]);
      }
    }
  }
}

/** @param {any} context @param {any} asset @param {string} actorId */
export async function updateSelectedBin(context,asset,actorId) {
  const oldAssetId=context.delivery.expected_asset_id || context.delivery.outgoing_asset_id;
  const source=asset.planningSource || await binWorkflowAssetLocation(asset);
  for (const visit of context.visits) {
    let snapshot=structuredClone(visit.service_snapshot);
    const primary=visit.service_visit_id===context.delivery.service_visit_id;
    if (primary) {
      if (!snapshot.binWorkflow) {
        snapshot.binWorkflow={version:1,legacy:true,orderId:context.root.service_visit_id,kind:context.root.order_kind,
          role:"delivery",reference:context.root.display_reference,billingOwnerVisitId:context.root.service_visit_id};
        await registerLegacyDelivery(context,visit,asset);
      }
      snapshot=selectedDeliverySnapshot({...visit,service_snapshot:snapshot},asset,source);
    }
    for (const stop of snapshot.mandatoryStops || []) {
      if (!stop.assetId || stop.assetId===oldAssetId) {stop.assetId=asset.asset_id;stop.assetCode=asset.asset_code;}
      stop.reference=await binVisitDisplayReference(visit.service_visit_id,stop.actionCode) || stop.reference;
    }
    if (primary) {await updateBinWorkflowSteps(visit,snapshot,oldAssetId,asset);}
    else {await query("UPDATE mbt_visit_steps SET expected_asset_id=$3 WHERE service_visit_id=$1 AND expected_asset_id=$2",
      [visit.service_visit_id,oldAssetId,asset.asset_id]);}
    await query(`UPDATE mbt_service_visits SET
      expected_asset_id=CASE WHEN expected_asset_id=$2 THEN $3 ELSE expected_asset_id END,
      outgoing_asset_id=CASE WHEN outgoing_asset_id=$2 THEN $3 ELSE outgoing_asset_id END,
      incoming_asset_id=CASE WHEN incoming_asset_id=$2 THEN $3 ELSE incoming_asset_id END,
      service_snapshot=$4::jsonb,revision=revision+1,updated_by=$5,updated_at=now() WHERE service_visit_id=$1`,
    [visit.service_visit_id,oldAssetId,asset.asset_id,JSON.stringify(snapshot),actorId]);
    await query("UPDATE mbt_bin_order_parts SET asset_id=$2 WHERE visit_id=$1",[visit.service_visit_id,asset.asset_id]);
  }
  await updateConfigurations(context,asset,actorId);
}

/** The original delivery itself remains the execution and billing identity.
 * @param {any} context @param {any} visit @param {any} asset */
async function registerLegacyDelivery(context,visit,asset) {
  await query(`INSERT INTO mbt_bin_order_parts(visit_id,order_id,part_role,asset_id,display_reference)
    VALUES ($1,$1,'delivery',$2,$3)`,[visit.service_visit_id,asset.asset_id,context.root.display_reference]);
  const configuration={kind:"delivery",legacy:true,reference:context.root.display_reference,dependencies:[],sameDay:false,
    parts:[{visitId:visit.service_visit_id,role:"delivery",reference:context.root.display_reference,assetId:asset.asset_id,
      binTypeId:visit.bin_type_id,window:{startAt:visit.scheduled_start_at,endAt:visit.scheduled_end_at}}]};
  await query("UPDATE mbt_bin_orders SET configuration=$2::jsonb WHERE order_id=$1",[visit.service_visit_id,JSON.stringify(configuration)]);
}

/** @param {any} context @param {any} asset @param {string} actorId */
async function updateConfigurations(context,asset,actorId) {
  const ids=[...new Set([context.root.service_visit_id,...context.visits.map((/** @type {any} */ v)=>v.order_id).filter(Boolean)])];
  for (const id of ids) {
    const row=(await query("SELECT * FROM mbt_bin_orders WHERE order_id=$1 FOR UPDATE",[id])).rows[0];
    if (!row) {continue;}
    const configuration=row.configuration;
    if (configuration?.parts) {
      for (const part of configuration.parts) {
        if (!context.visits.some((/** @type {any} */ v)=>v.service_visit_id===part.visitId)) {continue;}
        const visit=(await query("SELECT service_snapshot FROM mbt_service_visits WHERE service_visit_id=$1",[part.visitId])).rows[0];
        Object.assign(part,{assetId:asset.asset_id,steps:visit.service_snapshot.mandatoryStops});
        if (part.role==="delivery") {part.source=visit.service_snapshot.binWorkflow.source;}
      }
    }
    await query("UPDATE mbt_bin_orders SET configuration=$2::jsonb,revision=revision+1 WHERE order_id=$1",[id,JSON.stringify(configuration)]);
    await query(`INSERT INTO mbt_bin_workflow_events(event_id,order_id,action,details)
      VALUES ($1,$2,'bin_selection_changed',$3::jsonb)`,[crypto.randomUUID(),id,
    JSON.stringify({actorId,assetId:asset.asset_id,previousAssetId:context.delivery.expected_asset_id})]);
  }
}
