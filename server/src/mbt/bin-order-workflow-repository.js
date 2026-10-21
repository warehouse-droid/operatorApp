// @ts-check
import crypto from "node:crypto";
import { query } from "../db.js";
import { MbtError } from "./errors.js";
import { binOrderReference } from "./bin-order-workflow-domain.js";

/** @param {number} status @param {string} message @param {string} [code] */
export function binWorkflowError(status, message, code = "MBT_BIN_WORKFLOW_INVALID") {
  return new MbtError({status,code,message});
}

/** @param {string} visitId @param {boolean} [lock] */
export async function binWorkflowOrder(visitId, lock = false) {
  if (lock) {
    await query(`SELECT c.contract_id FROM mbt_contracts c JOIN mbt_service_visits v ON v.contract_id=c.contract_id
      WHERE v.service_visit_id=$1 FOR UPDATE OF c`,[visitId]);
  }
  const {rows} = await query(`SELECT v.*,o.order_kind,o.exchange_number,o.display_reference,o.configuration,
      o.revision AS workflow_revision,r.rental_number::text,r.current_asset_id,r.recovery_pending,l.status AS rental_status
    FROM mbt_bin_orders o JOIN mbt_service_visits v ON v.service_visit_id=o.order_id
    JOIN mbt_bin_rental_numbers r ON r.service_line_id=o.service_line_id
    JOIN mbt_contract_service_lines l ON l.service_line_id=o.service_line_id
    WHERE o.order_id=$1 OR o.order_id=(SELECT order_id FROM mbt_bin_order_parts WHERE visit_id=$1)
    ${lock ? "FOR UPDATE OF v,o,r,l" : ""}`,[visitId]);
  if (!rows[0]) {throw binWorkflowError(404,"This visit has no BIN rental order.");}
  return rows[0];
}

/** @param {string} visitId @param {string} [actionCode] */
export async function binVisitDisplayReference(visitId, actionCode) {
  const {rows} = await query(`SELECT o.order_kind,o.exchange_number,o.display_reference,r.rental_number::text,
      p.part_role,p.display_reference AS part_reference
    FROM mbt_bin_orders o JOIN mbt_bin_rental_numbers r ON r.service_line_id=o.service_line_id
    LEFT JOIN mbt_bin_order_parts p ON p.order_id=o.order_id AND p.visit_id=$1
    WHERE o.order_id=$1 OR p.visit_id=$1`,[visitId]);
  const row = rows[0];
  if (!row) {return null;}
  const action = actionCode?.includes("dump") ? "dump"
    : actionCode?.includes("return") ? "return"
      : actionCode === "deliver_bin" || actionCode === "collect_empty_bin" ? "delivery"
        : actionCode?.startsWith("pickup") ? "collection" : row.part_role;
  return binOrderReference(row.rental_number,{kind:row.order_kind,exchangeNumber:row.exchange_number,action});
}

/** @param {any} row */
function address(row) {
  return [row.address_line_1,row.address_line_2,row.city,row.region,row.postal_code].filter(Boolean).join(", ");
}

/** @param {string} kind @param {string} id */
export async function binWorkflowLocation(kind, id) {
  const table = kind === "yard" ? "mbt_yards" : "mbt_dump_sites";
  const key = kind === "yard" ? "yard_id" : "dump_site_id";
  const row = (await query(`SELECT * FROM ${table} WHERE ${key}=$1 AND active`,[id])).rows[0];
  if (!row) {throw binWorkflowError(409,`Choose an active ${kind === "yard" ? "return yard" : "dump site"}.`);}
  return {kind,id:String(id),name:String(row.display_name || row.yard_code || row.dump_site_code),
    address:address(row) || String(row.yard_code || row.dump_site_code || ""),yardCode:row.yard_code || null};
}

/** @param {string} assetId @param {boolean} [lock] */
export async function binWorkflowAsset(assetId, lock = false) {
  const {rows} = await query(`SELECT a.*,s.lifecycle_status,s.location_kind,s.location_reference,s.current_address,
      s.yard_id,s.customer_site_profile_id,s.dump_site_id,s.truck_id,s.revision AS state_revision,m.movement_type,m.occurred_at
    FROM mbt_bin_assets a JOIN mbt_bin_asset_state s ON s.asset_id=a.asset_id
    JOIN mbt_bin_movements m ON m.movement_id=s.last_movement_id
    WHERE a.asset_id=$1 ${lock ? "FOR UPDATE OF a,s" : ""}`,[assetId]);
  const row = rows[0];
  if (!row?.active || row.under_maintenance) {throw binWorkflowError(409,"The selected physical bin is unavailable.");}
  return row;
}

/** @param {any} asset */
export async function binWorkflowAssetLocation(asset) {
  if (asset.location_kind === "yard") {return binWorkflowLocation("yard",asset.yard_id);}
  if (asset.location_kind === "dump_site") {return binWorkflowLocation("dump_site",asset.dump_site_id);}
  if (asset.location_kind === "truck") {
    const truck = (await query("SELECT plate FROM dispatch_trucks WHERE id=$1",[asset.truck_id])).rows[0];
    return {kind:"truck",id:String(asset.truck_id),name:`On truck ${truck?.plate || asset.truck_id}`,
      address:`Already on truck ${truck?.plate || asset.truck_id}`};
  }
  return {kind:asset.location_kind,id:String(asset.customer_site_profile_id || ""),name:asset.location_reference,
    address:asset.current_address};
}

/** @param {any} root */
export function binWorkflowSite(root) {
  const site = root.site_snapshot || {};
  return {kind:"customer_site",id:String(root.customer_site_profile_id),name:String(site.displayName || site.siteName || "Customer site"),
    address:[site.addressLine1,site.addressLine2,site.addressLine3,site.city,site.region,site.postalCode].filter(Boolean).join(", ")};
}

/** @param {string} orderId */
export async function binWorkflowParts(orderId) {
  return (await query(`SELECT p.*,v.status,v.revision,v.planned_truck_id,v.dispatch_plan_id,v.dispatch_load_id,
      v.actual_started_at,v.actual_completed_at,v.service_snapshot,v.scheduled_start_at,v.scheduled_end_at,
      a.asset_code FROM mbt_bin_order_parts p JOIN mbt_service_visits v ON v.service_visit_id=p.visit_id
      JOIN mbt_bin_assets a ON a.asset_id=p.asset_id WHERE p.order_id=$1 ORDER BY p.part_role DESC`,[orderId])).rows;
}

/** @param {any} step @param {string} visitId @param {number} index @param {string} assetId */
function mandatoryStop(step, visitId, index, assetId) {
  const role = step.actionCode === "return_bin" ? "return_yard"
    : step.actionCode === "collect_empty_bin" ? "source_location" : step.location.kind;
  return {...step,stopId:`${visitId}:S${index+1}`,sequence:index+1,locationRole:role,assetId,
    yardId:step.location.kind === "yard" ? step.location.id : null,yardCode:step.location.yardCode || null,
    siteProfileId:step.location.kind === "customer_site" ? step.location.id : null,
    planningAddress:step.location.address};
}

/** @param {any} root @param {any} flow @param {any} part @param {string} actorId @param {number} visitNumber */
export async function insertBinWorkflowPart(root, flow, part, actorId, visitNumber) {
  const visitId = part.visitId || crypto.randomUUID();
  const stops = part.steps.map((/** @type {any} */ s,/** @type {number} */ i)=>mandatoryStop(s,visitId,i,part.assetId));
  const snapshot = {schemaVersion:"mbt-bin-service-snapshot-v1",displayName:`${flow.kind} · ${part.role}`,
    serviceAction:`bin_${part.role}_part`,mandatoryStops:stops,
    binWorkflow:{version:1,orderId:String(root.service_visit_id),kind:flow.kind,role:part.role,
      reference:part.reference,sequence:flow.sequence || null,source:part.source || null,
      sameDay:flow.sameDay,destination:part.destination || null,billingOwnerVisitId:String(root.service_visit_id)}};
  await query(`INSERT INTO mbt_service_visits
    (service_visit_id,contract_id,visit_number,visit_reference,service_template_version_id,service_action,status,
     customer_site_profile_id,bin_type_id,expected_asset_id,outgoing_asset_id,dump_site_id,material_id,
     service_line_id,scheduled_start_at,scheduled_end_at,customer_snapshot,site_snapshot,service_snapshot,
     billing_ownership,created_by,updated_by)
    VALUES ($1,$2,$3,$4,$5,$6,'ready',$7,$8,$9,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17::jsonb,'none',$18,$18)
    ON CONFLICT(service_visit_id) DO UPDATE SET bin_type_id=EXCLUDED.bin_type_id,expected_asset_id=EXCLUDED.expected_asset_id,
      outgoing_asset_id=EXCLUDED.outgoing_asset_id,dump_site_id=EXCLUDED.dump_site_id,material_id=EXCLUDED.material_id,
      scheduled_start_at=EXCLUDED.scheduled_start_at,scheduled_end_at=EXCLUDED.scheduled_end_at,
      service_snapshot=EXCLUDED.service_snapshot,status='ready',revision=mbt_service_visits.revision+1,
      updated_by=EXCLUDED.updated_by,updated_at=now()`,
  [visitId,root.contract_id,visitNumber,`BIN-WORK-${visitId}`,root.service_template_version_id,
    `bin_${part.role}_part`,root.customer_site_profile_id,part.binTypeId,part.assetId,
    part.role === "collection" ? flow.dumpSiteId : null,part.role === "collection" ? flow.materialId : null,
    root.service_line_id,part.window.startAt,part.window.endAt,JSON.stringify(root.customer_snapshot),
    JSON.stringify(root.site_snapshot),JSON.stringify(snapshot),actorId]);
  await query(`INSERT INTO mbt_bin_order_parts(visit_id,order_id,part_role,asset_id,display_reference)
    VALUES ($1,$2,$3,$4,$5) ON CONFLICT(visit_id) DO UPDATE SET asset_id=EXCLUDED.asset_id,
      linked_delivery_visit_id=NULL`,[visitId,root.service_visit_id,part.role,part.assetId,part.reference]);
  for (const [index,stop] of stops.entries()) {
    const stepId = crypto.randomUUID();
    await query(`INSERT INTO mbt_visit_steps(visit_step_id,service_visit_id,sequence_number,action_code,
      display_name,location_role,expected_asset_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [stepId,visitId,index,stop.actionCode,stop.displayName,stop.locationRole,part.assetId]);
    const evidence = stop.actionCode === "dump_bin"
      ? [["bin_scan","bin_scan"],["dump_receipt_photo","photo"],["dump_receipt","receipt"]]
      : [["bin_scan","bin_scan"],["bin_photo","photo"]];
    for (const [code,type] of evidence) {
      await query(`INSERT INTO mbt_visit_evidence_requirements
        (visit_evidence_requirement_id,service_visit_id,visit_step_id,evidence_code,evidence_type)
        VALUES ($1,$2,$3,$4,$5)`,[crypto.randomUUID(),visitId,stepId,code,type]);
    }
  }
  return {...part,visitId,steps:stops};
}
