// @ts-check
import { query } from "../db.js";

/** @param {any} visit @param {any} row */
function issuedLegacy(visit,row) {
  return !row.part_role && (visit.dispatch_plan_id || visit.actual_started_at || ["completed","cancelled"].includes(visit.status));
}
/** Keep opaque execution identities behind readable rental/job references.
 * @param {any} visit */
export async function projectBinWorkflowCard(visit) {
  const {rows:[row]}=await query(`SELECT o.*,r.rental_number::text,r.current_asset_id,r.recovery_pending,
      p.part_role,p.asset_id,p.display_reference AS part_reference,b.type_code,a.asset_code,s.revision AS state_revision
    FROM mbt_bin_orders o JOIN mbt_bin_rental_numbers r ON r.service_line_id=o.service_line_id
    JOIN mbt_bin_types b ON b.bin_type_id=$2
    LEFT JOIN mbt_bin_order_parts p ON p.order_id=o.order_id AND p.visit_id=$1
    LEFT JOIN mbt_bin_assets a ON a.asset_id=p.asset_id LEFT JOIN mbt_bin_asset_state s ON s.asset_id=p.asset_id
    WHERE o.order_id=$1 OR p.visit_id=$1`,[visit.service_visit_id,visit.bin_type_id]);
  if (!row) {return null;}
  if (issuedLegacy(visit,row)) {return null;}
  const dependencies=await query(`SELECT p.display_reference,s.status,d.prerequisite_action_code,d.same_day
    FROM mbt_bin_workflow_dependencies d JOIN mbt_bin_order_parts p ON p.visit_id=d.prerequisite_visit_id
    JOIN mbt_visit_steps s ON s.service_visit_id=p.visit_id AND s.action_code=d.prerequisite_action_code
    WHERE d.dependent_visit_id=$1`,[visit.service_visit_id]);
  const pending=await query(`SELECT p.display_reference,a.asset_code,v.status FROM mbt_bin_order_parts p
    JOIN mbt_bin_orders o ON o.order_id=p.order_id JOIN mbt_service_visits v ON v.service_visit_id=p.visit_id
    JOIN mbt_bin_assets a ON a.asset_id=p.asset_id WHERE o.service_line_id=$1 AND p.part_role='collection'
      AND v.status NOT IN ('completed','cancelled') ORDER BY o.exchange_number`,[row.service_line_id]);
  const reference=row.part_reference || row.display_reference;
  const site=visit.site_snapshot || {},customer=visit.customer_snapshot || {};
  const workflow=visit.service_snapshot.binWorkflow || {};
  const steps=row.part_role ? visit.service_snapshot.mandatoryStops : [];
  return {id:reference,displayReference:reference,type:"BIN",serviceAction:row.order_kind,
    customer:customer.displayName || customer.companyName || "BIN customer",
    address:[site.addressLine1,site.addressLine2,site.city,site.region,site.postalCode].filter(Boolean).join(", "),
    scheduledWindow:{startAt:visit.scheduled_start_at,endAt:visit.scheduled_end_at},
    stops:steps.map((/** @type {any} */ s)=>({...s,id:s.stopId,type:s.stopKind})),
    workflow:{orderId:String(row.order_id),reference:row.display_reference,revision:Number(row.revision),
      role:row.part_role,kind:row.order_kind,configurationRequired:!row.configuration,
      source:workflow.source || null,
      sequence:workflow.sequence,currentAssetId:row.current_asset_id,
      recoveryPending:row.recovery_pending,dependencies:dependencies.rows,pendingCollections:pending.rows},
    mbt:{visitId:String(visit.service_visit_id),contractId:String(visit.contract_id),serviceLineId:String(visit.service_line_id),
      visitReference:visit.visit_reference,displayReference:reference,visitRevision:Number(visit.revision),status:visit.status,
      binTypeId:String(visit.bin_type_id),binTypeCode:row.type_code,frontLeg:{dispatchable:Boolean(row.part_role)},
      assetRequirements:row.asset_id ? [{reservationSlot:"outgoing",exactAssetId:String(row.asset_id),
        exactAssetCode:row.asset_code,expectedStateRevision:Number(row.state_revision)}] : [],assetChoices:[],
      truckRequirements:{truckType:"bin",minimumSlots:1,supportedBinTypeCode:row.type_code},timeline:[]}};
}
