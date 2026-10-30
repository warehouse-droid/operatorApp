// @ts-check
import crypto from 'node:crypto';
import {query} from '../db.js';
import {transportError} from './bin-transport-domain.js';
import {assertBinCargoReady} from './bin-cargo-repository.js';

/** @param {string} [tripId] */
export async function transportDeliveryChoices(tripId) {
  return (await query(`SELECT p.visit_id AS "visitId",p.display_reference AS reference,p.asset_id AS "assetId",
    a.asset_code AS "assetCode",v.bin_type_id AS "binTypeId",v.scheduled_start_at AS "startAt",v.scheduled_end_at AS "endAt"
    FROM mbt_bin_order_parts p JOIN mbt_service_visits v ON v.service_visit_id=p.visit_id JOIN mbt_bin_assets a ON a.asset_id=p.asset_id
    WHERE p.part_role='delivery' AND v.dispatch_plan_id IS NULL AND v.actual_started_at IS NULL AND v.status='ready'
      AND NOT EXISTS(SELECT 1 FROM mbt_bin_order_parts c WHERE c.linked_delivery_visit_id=p.visit_id)
      AND NOT EXISTS(SELECT 1 FROM mbt_transport_delivery_links l WHERE l.delivery_visit_id=p.visit_id AND l.released_at IS NULL AND l.trip_id IS DISTINCT FROM $1::uuid)
    ORDER BY p.display_reference LIMIT 200`,[tripId || null])).rows;
}

/** @param {any} trip @param {string} actorId */
export async function linkTransportDelivery(trip,actorId) {
  await unlinkTransportDelivery(trip.trip_id,actorId);
  if (trip.route.returnDestination.kind!=='delivery') {return;}
  const id=trip.route.returnDestination.visitId;
  const visit=(await query(`SELECT v.*,p.order_id,p.part_role FROM mbt_service_visits v JOIN mbt_bin_order_parts p ON p.visit_id=v.service_visit_id
    WHERE v.service_visit_id=$1 FOR UPDATE OF v,p`,[id])).rows[0];
  if (!visit || visit.part_role!=='delivery' || visit.expected_asset_id!==trip.asset_id || visit.dispatch_plan_id || visit.actual_started_at
      || visit.status!=='ready' || !(await transportDeliveryChoices(trip.trip_id)).some((/** @type {any} */ row)=>row.visitId===id)) {
    throw transportError('Choose an unplanned Delivery with this same bin. Configure its bin and required cargo route in Plan Delivery first.');
  }
  await assertBinCargoReady(visit);
  const steps=(await query("SELECT visit_step_id,required,completion_blocking FROM mbt_visit_steps WHERE service_visit_id=$1 AND action_code='collect_empty_bin'",[id])).rows;
  const requirements=(await query('SELECT visit_evidence_requirement_id,required FROM mbt_visit_evidence_requirements WHERE visit_step_id=ANY($1::uuid[])',[steps.map((/** @type {any} */ s)=>s.visit_step_id)])).rows;
  await query(`INSERT INTO mbt_transport_delivery_links(link_id,trip_id,delivery_visit_id,original_snapshot,original_steps,original_requirements)
    VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb)`,[crypto.randomUUID(),trip.trip_id,id,JSON.stringify(visit.service_snapshot),JSON.stringify(steps),JSON.stringify(requirements)]);
  const snapshot=structuredClone(visit.service_snapshot);
  snapshot.mandatoryStops=snapshot.mandatoryStops.filter((/** @type {any} */ stop)=>stop.actionCode!=='collect_empty_bin')
    .map((/** @type {any} */ stop,/** @type {number} */ i)=>({...stop,sequence:i+1}));
  snapshot.binWorkflow.source={...trip.route.destination,planned:true,transportTripId:trip.trip_id};
  // The incoming truck already carries this bin. Retain the unused pickup rows,
  // but remove their requirements rather than manufacture execution evidence.
  await query("UPDATE mbt_visit_steps SET required=false,completion_blocking=false WHERE service_visit_id=$1 AND action_code='collect_empty_bin'",[id]);
  await query('UPDATE mbt_visit_evidence_requirements SET required=false WHERE visit_step_id=ANY($1::uuid[])',[steps.map((/** @type {any} */ s)=>s.visit_step_id)]);
  await saveDeliverySnapshot(visit,snapshot,actorId);
}

/** @param {string} tripId @param {string} actorId */
export async function unlinkTransportDelivery(tripId,actorId) {
  const link=(await query('SELECT * FROM mbt_transport_delivery_links WHERE trip_id=$1 AND released_at IS NULL FOR UPDATE',[tripId])).rows[0];
  if (!link) {return;}
  const visit=(await query(`SELECT v.*,p.order_id FROM mbt_service_visits v JOIN mbt_bin_order_parts p ON p.visit_id=v.service_visit_id
    WHERE v.service_visit_id=$1 FOR UPDATE OF v`,[link.delivery_visit_id])).rows[0];
  if (visit.dispatch_plan_id || visit.actual_started_at || visit.status!=='ready') {throw transportError('Unplan the linked delivery before changing this transport route.');}
  for (const step of link.original_steps) {
    await query('UPDATE mbt_visit_steps SET required=$2,completion_blocking=$3 WHERE visit_step_id=$1',[step.visit_step_id,step.required,step.completion_blocking]);
  }
  for (const requirement of link.original_requirements) {
    await query('UPDATE mbt_visit_evidence_requirements SET required=$2 WHERE visit_evidence_requirement_id=$1',[requirement.visit_evidence_requirement_id,requirement.required]);
  }
  await saveDeliverySnapshot(visit,link.original_snapshot,actorId);
  await query('UPDATE mbt_transport_delivery_links SET released_at=now() WHERE link_id=$1',[link.link_id]);
}

/** @param {any} visit @param {any} snapshot @param {string} actorId */
async function saveDeliverySnapshot(visit,snapshot,actorId) {
  await query('UPDATE mbt_service_visits SET service_snapshot=$2::jsonb,revision=revision+1,updated_by=$3,updated_at=now() WHERE service_visit_id=$1',
    [visit.service_visit_id,JSON.stringify(snapshot),actorId]);
  const root=(await query('SELECT configuration FROM mbt_bin_orders WHERE order_id=$1 FOR UPDATE',[visit.order_id])).rows[0];
  const configuration={...root.configuration,parts:root.configuration.parts.map((/** @type {any} */ part)=>part.role==='delivery'
    ?{...part,source:snapshot.binWorkflow.source,steps:snapshot.mandatoryStops}:part)};
  await query('UPDATE mbt_bin_orders SET configuration=$2::jsonb,revision=revision+1 WHERE order_id=$1',[visit.order_id,JSON.stringify(configuration)]);
}

/** @param {any} plan */
export async function validateTransportDeliveryLinks(plan) {
  const links=(await query(`SELECT l.*,t.plan_id,t.load_id,t.truck_id,t.asset_id,v.dispatch_plan_id,v.dispatch_load_id,
    v.planned_truck_id,v.expected_asset_id FROM mbt_transport_delivery_links l JOIN mbt_transport_trips t USING(trip_id)
    JOIN mbt_service_visits v ON v.service_visit_id=l.delivery_visit_id WHERE l.released_at IS NULL
    AND (t.plan_id=$1 OR v.dispatch_plan_id=$1::text)`,[plan.id])).rows;
  for (const link of links) {
    const load=plan.trucks.flatMap((/** @type {any} */ t)=>t.loads || []).find((/** @type {any} */ l)=>l.id===link.load_id);
    const source=load?.stops.map((/** @type {any} */ s)=>s.mbt?.visitId).lastIndexOf(link.trip_id),target=load?.stops.findIndex((/** @type {any} */ s)=>s.mbt?.visitId===link.delivery_visit_id);
    if (String(link.plan_id)!==link.dispatch_plan_id || link.load_id!==link.dispatch_load_id || String(link.truck_id)!==String(link.planned_truck_id)
        || link.asset_id!==link.expected_asset_id || !load || source<0 || target<=source) {
      throw transportError('Keep the linked BIN delivery after its cargo drop in the same load, with the same bin and truck.');
    }
  }
}

/** @param {any} visit @param {Date} at */
export async function assertTransportDeliveryEvidence(visit,at) {
  const id=visit.service_snapshot?.binWorkflow?.source?.transportTripId;
  if (!id) {return;}
  const trip=(await query('SELECT cargo_delivered_at,truck_id FROM mbt_transport_trips WHERE trip_id=$1',[id])).rows[0];
  if (!trip?.cargo_delivered_at || new Date(trip.cargo_delivered_at)>at || String(trip.truck_id)!==String(visit.planned_truck_id)) {
    throw transportError('Complete the preceding transport cargo drop before this BIN delivery.');
  }
}
