// @ts-check
import {query,withTransaction} from '../db.js';
import {DISPATCH_FLEET_PLANNING_LOCK} from '../dispatch-fleet-status.js';
import {startDriverJob,recordDriverJobPhotos} from '../driver-repository.js';
import {completeDispatchCustomOrders} from '../dispatch-custom-order-repository.js';
import {isSorDeliveryRef} from '../sor-rental-policy.js';
import {assertSorReturnReady} from '../sor-return-readiness.js';
import {resolveSorSignature} from '../sor-signature-evidence.js';
import {sharedBinDriverEvidence as evidence} from './driver-bin-execution-service.js';
import {MBT_DRIVER_BIN_JOB_SCHEMA,hashMbtDriverCanonical} from './driver-bin-contract.js';
import {transportPlanningVisit} from './bin-transport-planning.js';
import {transportLineProgress,readTransportSource,assertTransportSourceOpen} from './bin-transport-sources.js';
import {transportError} from './bin-transport-domain.js';
import {recordAssetMovement} from './asset-service.js';
import {binWorkflowAsset} from './bin-order-workflow-repository.js';

/** @param {any} trip */
function executionHash(trip) {
  return hashMbtDriverCanonical({tripId:trip.trip_id,route:trip.route,allocations:trip.allocations,assetId:trip.asset_id,
    sourceFingerprint:trip.source_fingerprint,generation:trip.generation,assignment:trip.assignment_snapshot});
}

/** @param {any} job @param {any} trip */
function sameAssignment(job,trip) {
  return String(job.planId)===String(trip.plan_id) && String(job.loadId)===trip.load_id
    && String(job.truckId)===String(trip.truck_id)
    && String(job.driverLogin).toLowerCase()===String(trip.assignment_snapshot.driverLogin).toLowerCase();
}
/** @param {any} job @param {any} trip */
function assignedStep(job,trip) {
  const assignment=trip?.assignment_snapshot;
  const stop=assignment?.stops.find((/** @type {any} */ s)=>s.id===job.stopId);
  if (!trip?.driver_released_at || !stop || !sameAssignment(job,trip)
      || Number(job.mbt.planningGeneration)!==Number(trip.generation) || (job.mbt.visitStepId || job.mbt.stepId)!==stop.mbt.stepId) {
    throw transportError('The transport assignment changed. Refresh the Driver route.','MBT_DRIVER_BIN_REVIEW_REQUIRED');
  }
  return stop;
}

/** @param {any} job @param {any} versions */
export async function materializeTransportDriverJob(job,versions) {
  const minimumClientVersion=evidence.requiredClientBoundary(versions);
  const trip=await transportPlanningVisit(job.mbt.transportTripId),stop=assignedStep(job,trip);
  const asset=(await evidence.assetIdentities([trip.asset_id])).get(trip.asset_id);
  const cargo={description:trip.allocations.map((/** @type {any} */ row)=>`${row.quantity} ${row.unit} ${row.description}`).join(', '),
    quantity:trip.allocations.length===1?trip.allocations[0].quantity:null,weightLbs:Number(trip.weight_lbs),lines:trip.allocations};
  const requirements=stop.evidenceRequirements.map((/** @type {any} */ r)=>({requirementId:`${stop.mbt.stepId}:${r.code}`,
    evidenceCode:r.code,evidenceType:r.type,minimumCount:r.minimumCount || 1,required:true}));
  const drop=stop.actionCode==='cargo_dropoff_1';
  return {...job,address:stop.planningAddress,location:stop.planningAddress,requiredPhotos:1,orderRefs:[],orders:[],orderTypes:['BIN'],
    ...(drop?{windowStart:trip.source_snapshot.windowStart,windowEnd:trip.source_snapshot.windowEnd}:{}),
    customerSignaturePrompt:drop && isSorDeliveryRef(trip.source_ref),
    mbt:{...job.mbt,schemaVersion:MBT_DRIVER_BIN_JOB_SCHEMA,minimumClientVersion,transportTripId:trip.trip_id,
      visitId:trip.trip_id,visitReference:trip.visit_reference,displayReference:trip.visit_reference,
      sourceRef:trip.source_ref,sourceKind:trip.source_snapshot.kind,allocations:trip.allocations,
      issuedVisitRevision:trip.assignment_snapshot.visitRevision,serviceAction:'transport',actionCode:stop.actionCode,
      actionName:stop.displayName,visitStepId:stop.mbt.stepId,stepSequence:stop.mbt.stopSequence,
      binTypeId:trip.bin_type_id,binTypeCode:trip.type_code,exactAssets:{expected:asset,outgoing:null,incoming:null},
      evidenceRequirements:requirements,cargo:stop.actionCode==='cargo_pickup_1'?cargo:null,cargoDropoffs:drop?[cargo]:[],
      customer:{name:trip.source_snapshot.customer},site:{addressLine1:stop.planningAddress},
      executionSnapshotHash:executionHash(trip),assignment:{planId:String(trip.plan_id),loadId:trip.load_id,
        truckId:String(trip.truck_id),driverId:String(trip.driver_id)}}};
}

/** @param {any} input @param {any} normalized @param {any} trip @param {any} step */
async function assertExecutionReady(input,normalized,trip,step) {
  assignedStep(input.job,trip);
  if (input.job.mbt.executionSnapshotHash!==executionHash(trip) || normalized.driverLogin!==String(input.job.driverLogin).toLowerCase()
      || normalized.jobId!==input.job.jobId || input.manifest?.manifestId!==normalized.manifestId) {
    throw transportError('The transport route or event identity changed. Refresh the Driver route.','MBT_DRIVER_BIN_REVIEW_REQUIRED');
  }
  if (!step || step.status==='completed' || ['completed','cancelled'].includes(trip.status)) {
    throw transportError('This transport step is already complete or unavailable.');
  }
  await assertUnstartedSource(trip);
  await binWorkflowAsset(String(trip.asset_id),true);
  const earlier=await query("SELECT 1 FROM mbt_transport_steps WHERE trip_id=$1 AND sequence_number<$2 AND status<>'completed' LIMIT 1",[trip.trip_id,step.sequence_number]);
  if (earlier.rowCount) {throw transportError('Complete the earlier transport action first.');}
  if (trip.source_snapshot.kind==='sor_return' && step.action_code==='cargo_pickup_1') {
    await assertSorReturnReady({stopType:'pickup',orderRefs:[trip.source_ref]});
  }
}

/** @param {any} trip */
async function assertUnstartedSource(trip) {
  if (!trip.actual_started_at) {
    const current=await readTransportSource(trip.source_ref);await assertTransportSourceOpen(current);
    if (current.fingerprint!==trip.source_fingerprint) {throw transportError('The source order changed before this trip started. Dispatch must review it.','MBT_DRIVER_BIN_REVIEW_REQUIRED');}
  }
}

/** @param {any} trip @param {any} step @param {any} state */
function assertPhysicalBin(trip,step,state) {
  if (!state) {throw transportError('The physical bin state is unavailable.');}
  if (step.action_code==='collect_empty_bin') {
    const source=trip.route.source,id=state.yard_id || state.dump_site_id || state.truck_id;
    if (!['available','reserved','at_dump'].includes(state.lifecycle_status) || state.location_kind!==source.kind || String(id)!==String(source.id)) {
      throw transportError('The empty bin has not physically returned to the planned pickup point.');
    }
  } else if (state.lifecycle_status!=='on_truck' || state.location_kind!=='truck' || String(state.truck_id)!==String(trip.truck_id)) {
    throw transportError('This bin must be on the assigned truck before continuing.');
  }
}

/** @param {any} input @param {any} normalized @param {any} trip @param {any} step */
async function completeTransportStep(input,normalized,trip,step) {
  if (normalized.details.actionCode!==step.action_code || !step.started_at || step.status!=='in_progress'
      || normalized.occurredAt<step.started_at) {throw transportError('Start this transport action before completing it.');}
  const rows={evidence:step.snapshot.evidenceRequirements.map((/** @type {any} */ r)=>({visit_step_id:step.step_id,
    evidence_code:r.code,evidence_type:r.type,minimum_count:r.minimumCount || 1,required:true}))};
  evidence.validateRequirements({rows,step:{visit_step_id:step.step_id},normalized,job:input.job,photoReferences:input.photoReferences || []});
  const signature=await resolveSorSignature(input.event.details?.customerSignature,{job:{...input.job,orderRefs:[trip.source_ref]},
    photos:input.event.photos || [],offline:true});
  await recordPhysicalMovement(input,normalized,trip,step);
  await query(`UPDATE mbt_transport_steps SET status='completed',completed_at=$2,evidence=$3::jsonb WHERE step_id=$1`,
    [step.step_id,normalized.occurredAt,JSON.stringify({eventId:normalized.eventId,details:normalized.details,photos:normalized.photos,signature})]);
  if (step.action_code==='cargo_dropoff_1') {await completeTransportCargo(trip,normalized);}
  const remaining=(await query("SELECT 1 FROM mbt_transport_steps WHERE trip_id=$1 AND status<>'completed' LIMIT 1",[trip.trip_id])).rowCount;
  await query(`UPDATE mbt_transport_trips SET status=$2,actual_completed_at=CASE WHEN $2='completed' THEN $3 ELSE actual_completed_at END,
    revision=revision+1,updated_by=$4,updated_at=now() WHERE trip_id=$1`,[trip.trip_id,remaining?'in_progress':'completed',normalized.occurredAt,`driver:${normalized.driverLogin}`]);
  return {signature,completed:!remaining};
}

/** @param {any} input @param {any} normalized @param {any} trip @param {any} step */
async function recordPhysicalMovement(input,normalized,trip,step) {
  if (['collect_empty_bin','return_bin'].includes(step.action_code)) {
    const returning=step.action_code==='return_bin',location=step.snapshot.location;
    await recordAssetMovement(/** @type {any} */ ({query,ambientTransaction:true}),{assetId:trip.asset_id,movementType:returning?'return_empty_bin':'collect_empty_bin',
      afterStatus:returning?'available':'on_truck',afterLocation:returning?{kind:'yard',yardId:location.id,reference:location.address}
        :{kind:'truck',truckId:String(trip.truck_id),reference:input.job.truckPlate},truckId:String(trip.truck_id),driverId:String(trip.driver_id),
      evidenceReferences:[normalized.eventId],source:'mbt-transport-driver',actorType:'driver',
      actorId:normalized.driverLogin,occurredAt:normalized.occurredAt});
  }
}

/** @param {any} trip @param {any} normalized */
async function completeTransportCargo(trip,normalized) {
  await query('UPDATE mbt_transport_trips SET cargo_delivered_at=$2 WHERE trip_id=$1',[trip.trip_id,normalized.occurredAt]);
  const trips=(await query('SELECT allocations,status,cargo_delivered_at FROM mbt_transport_trips WHERE source_key=$1',[trip.source_key])).rows;
  const progress=transportLineProgress(trip.source_snapshot.lines,trips);
  if (!progress.every(row=>Number(row.delivered)>=Number(row.quantity))) {return;}
  await query('UPDATE mbt_transport_sources SET cargo_completed_at=$2,revision=revision+1,updated_by=$3,updated_at=now() WHERE source_key=$1',
    [trip.source_key,normalized.occurredAt,`driver:${normalized.driverLogin}`]);
  if (trip.source_snapshot.customOrderId) {await completeDispatchCustomOrders([trip.source_ref],`driver:${normalized.driverLogin}`);}
  else {
    await query(`SELECT dispatch_record_order_completion($1,$2,$3,'driver_job',$4,$5,$6,$7,'driver',$8,
      'All source quantities delivered by BIN transport',$9::jsonb)`,[trip.source_snapshot.type,trip.source_ref,normalized.occurredAt,
      normalized.jobId,trip.plan_id,trip.assignment_snapshot.planDate,trip.load_id,normalized.driverLogin,
      JSON.stringify({transportTripId:trip.trip_id,sourceRef:trip.source_ref,progress})]);
  }
}

/** @param {any} input @param {any} boundary */
export async function applyTransportDriverEvent(input,{capability,hooks={}}) {
  evidence.assertCapability(capability);
  const normalized=evidence.normalizedApplication(input.event,input.job);
  if (!['job_started','job_completed'].includes(normalized.eventType)) {throw transportError('Unsupported transport event.');}
  const hash=hashMbtDriverCanonical({payload:normalized.immutablePayloadHash,signature:input.event.details?.customerSignature || null,
    remark:input.event.details?.driverRemark || '',tripId:input.job.mbt.transportTripId,stepId:input.job.mbt.visitStepId});
  return withTransaction(async()=>{
    await query('SELECT pg_advisory_xact_lock(hashtext($1))',[DISPATCH_FLEET_PLANNING_LOCK]);
    const prior=(await query('SELECT * FROM mbt_transport_driver_events WHERE event_id=$1',[normalized.eventId])).rows[0];
    if (prior) {
      if (prior.request_hash!==hash) {throw transportError('This transport event replay changed. Retain the original evidence.');}
      return {replayed:true,body:prior.result};
    }
    const trip=await transportPlanningVisit(input.job.mbt.transportTripId,true);
    const step=(await query('SELECT * FROM mbt_transport_steps WHERE step_id=$1 AND trip_id=$2 FOR UPDATE',
      [input.job.mbt.visitStepId,trip?.trip_id])).rows[0];
    await assertExecutionReady(input,normalized,trip,step);
    const manifest=await evidence.assertCompleteManifestRoute(input.manifest,normalized),states=await evidence.lockExactAssetStates(input.job);
    evidence.assertCompleteManifestChronology(manifest,normalized,states);assertPhysicalBin(trip,step,states.get(trip.asset_id));
    let completed=false;
    if (normalized.eventType==='job_started') {
      await startDriverJob(normalized.driverLogin,normalized.jobId,{job:input.job,occurredAt:normalized.occurredAt,
        offlineTrace:await evidence.registeredOfflineTrace(normalized)});
      await query("UPDATE mbt_transport_steps SET status='in_progress',started_at=COALESCE(started_at,$2) WHERE step_id=$1",[step.step_id,normalized.occurredAt]);
      await query("UPDATE mbt_transport_trips SET status='in_progress',actual_started_at=COALESCE(actual_started_at,$2),revision=revision+1,updated_at=now() WHERE trip_id=$1",
        [trip.trip_id,normalized.occurredAt]);
    } else {
      const result=await completeTransportStep(input,normalized,trip,step);completed=result.completed;
      if (hooks.afterVisit) {await hooks.afterVisit({trip,step});}
      await recordDriverJobPhotos(normalized.driverLogin,normalized.jobId,/** @type {any} */ ({job:input.job,photoDataUrls:input.photoReferences,
        customerSignature:result.signature,occurredAt:normalized.occurredAt,offlineTrace:await evidence.registeredOfflineTrace(normalized),
        driverRemark:input.event.details?.driverRemark}));
    }
    const body={schemaVersion:'mbt-driver-bin-application-v1',eventId:normalized.eventId,eventType:normalized.eventType,jobId:normalized.jobId,
      visitId:trip.trip_id,visitStepId:step.step_id,status:completed?'completed':'in_progress',occurredAt:normalized.occurredAt.toISOString()};
    await query(`INSERT INTO mbt_transport_driver_events(event_id,trip_id,step_id,event_type,request_hash,result)
      VALUES($1,$2,$3,$4,$5,$6::jsonb)`,[normalized.eventId,trip.trip_id,step.step_id,normalized.eventType,hash,JSON.stringify(body)]);
    return {replayed:false,body};
  });
}
