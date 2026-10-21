// @ts-check
import crypto from "node:crypto";
import { query } from "../db.js";
import { DISPATCH_FLEET_PLANNING_LOCK } from "../dispatch-fleet-status.js";
import { executeMbtCommand } from "./command-repository.js";
import { recordAssetMovement } from "./asset-service.js";
import { binWorkflowAsset,binWorkflowOrder,binWorkflowError } from "./bin-order-workflow-repository.js";

/** Record an actual transfer; assigning a different driver never transfers custody.
 * @param {any} input */
export async function recordBinWorkflowHandoff(input) {
  const {actor,idempotencyKey,correlationId,requestId,...payload}=input;
  if (!actor?.operatorId || !actor.roles?.some((/** @type {string} */ r)=>["admin","dispatcher"].includes(r))) {
    throw binWorkflowError(403,"Dispatcher or Admin access is required.");
  }
  if (input.confirmed!==true || !String(input.place || "").trim() || !String(input.reason || "").trim()) {
    throw binWorkflowError(400,"Confirm the physical transfer and record its location and reason.");
  }
  return executeMbtCommand({actor,commandName:"mbt.bin_workflow.handoff",idempotencyKey,correlationId,requestId,payload,
    mutation:async()=>{
      await query("SELECT pg_advisory_xact_lock(hashtext($1))",[DISPATCH_FLEET_PLANNING_LOCK]);
      const root=await binWorkflowOrder(input.visitId,true);
      const asset=await binWorkflowAsset(input.assetId,true);
      const part=(await query("SELECT visit_id FROM mbt_bin_order_parts WHERE order_id=$1 AND asset_id=$2 LIMIT 1",
        [root.service_visit_id,asset.asset_id])).rows[0];
      await assertTransfer(input,asset,part);
      const empty=/dump|empty/u.test(asset.movement_type);
      const movement=await recordAssetMovement(/** @type {any} */ ({query,ambientTransaction:true}),{
        assetId:String(asset.asset_id),movementType:empty ? "bin_handoff_empty" : "bin_handoff_loaded",
        afterStatus:"on_truck",afterLocation:{kind:"truck",truckId:String(input.toTruckId),reference:String(input.place)},
        contractId:String(root.contract_id),visitId:String(part.visit_id),truckId:String(input.toTruckId),
        source:"bin_workflow_handoff",actorType:"operator",actorId:String(actor.operatorId),
        occurredAt:new Date(Math.max(Date.now(),new Date(asset.occurred_at).getTime())),
        overrideReason:String(input.reason)});
      const body={assetId:String(asset.asset_id),assetCode:asset.asset_code,fromTruckId:String(input.fromTruckId),
        toTruckId:String(input.toTruckId),place:String(input.place),movementId:movement.movementId};
      await query(`INSERT INTO mbt_bin_workflow_events(event_id,order_id,visit_id,action,details)
        VALUES ($1,$2,$3,'physical_handoff',$4::jsonb)`,[crypto.randomUUID(),root.service_visit_id,part.visit_id,JSON.stringify(body)]);
      return {status:201,body,audit:{action:"mbt.bin_workflow.handoff",entityType:"mbt_bin_asset",entityId:String(asset.asset_id),
        beforeState:{truckId:String(asset.truck_id),revision:Number(asset.state_revision)},afterState:body,
        reason:String(input.reason),revisionBefore:Number(asset.state_revision),revisionAfter:Number(asset.state_revision)+1,source:"bin_planning"}};
    }});
}

/** @param {any} input @param {any} asset @param {any} part */
async function assertTransfer(input,asset,part) {
  if (!part || asset.location_kind!=="truck" || String(asset.truck_id)!==String(input.fromTruckId)
      || Number(asset.state_revision)!==Number(input.expectedStateRevision)) {
    throw binWorkflowError(409,"The bin's recorded custody changed. Refresh before recording a handoff.");
  }
  if (String(input.scannedBinCode || "").trim().toUpperCase()!==String(asset.asset_code).toUpperCase()
      || String(input.fromTruckId)===String(input.toTruckId)) {
    throw binWorkflowError(400,"Confirm the exact physical bin number and a different receiving truck.");
  }
  const truck=await query(`SELECT t.id FROM dispatch_trucks t JOIN dispatch_truck_bin_types b ON b.truck_id=t.id
    WHERE t.id=$1 AND t.active AND t.truck_type='bin' AND t.bin_service_enabled AND b.active AND b.bin_type_id=$2
    AND t.bin_slot_capacity>(SELECT count(*) FROM mbt_bin_asset_state s WHERE s.truck_id=t.id AND s.location_kind='truck')
    FOR UPDATE OF t`,[input.toTruckId,asset.bin_type_id]);
  if (!truck.rowCount) {throw binWorkflowError(409,"Choose a compatible receiving BIN truck with an available slot.");}
}
