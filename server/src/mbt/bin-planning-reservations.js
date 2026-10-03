// @ts-check
import crypto from "node:crypto";
import { query } from "../db.js";
import { releaseAssetReservation } from "./asset-service.js";
import { planningError } from "./bin-planning-repository.js";

/** @param {any} visit @param {any} input */
export async function releasePlanningReservations(visit, input) {
  const reservations = await query(`SELECT r.*,s.lifecycle_status,s.location_kind,
      GREATEST(now(),m.occurred_at) AS occurred_at
    FROM mbt_bin_asset_reservations r JOIN mbt_bin_asset_state s ON s.asset_id=r.asset_id
    JOIN mbt_bin_movements m ON m.movement_id=s.last_movement_id
    WHERE r.visit_id=$1 AND r.released_at IS NULL ORDER BY r.asset_id FOR UPDATE OF r,s`, [visit.service_visit_id]);
  for (const row of reservations.rows) {
    if (row.lifecycle_status === "reserved" && row.location_kind === "yard") {
      await releaseAssetReservation(/** @type {any} */ ({ query, ambientTransaction: true }), {
        reservationId: row.reservation_id, releasedBy: input.actor.operatorId,
        releaseReason: input.reason, source: "mbt-bin-planning", actorType: "operator",
        actorId: input.actor.operatorId, occurredAt: row.occurred_at
      });
    } else {
      // A logical hold can end without moving a customer's bin or a bin aboard
      // a truck. Driver evidence remains the authority for physical custody.
      await query(`UPDATE mbt_bin_asset_reservations SET released_at=now(),released_by=$2,
        release_reason=$3,revision=revision+1,updated_at=now() WHERE reservation_id=$1`,
      [row.reservation_id, input.actor.operatorId, input.reason]);
    }
  }
}

/** @param {any} visit @param {any} assignment @param {string} truckId @param {any} input */
export async function reserveResumedPlanningAsset(visit, assignment, truckId, input) {
  const { rows } = await query(`SELECT s.*,a.active,a.under_maintenance,a.bin_type_id,
      m.service_visit_id AS last_visit_id
    FROM mbt_bin_asset_state s JOIN mbt_bin_assets a ON a.asset_id=s.asset_id
    JOIN mbt_bin_movements m ON m.movement_id=s.last_movement_id
    WHERE s.asset_id=$1 FOR UPDATE OF s,a`, [assignment.assetId]);
  const state = rows[0];
  if (!state?.active || state.under_maintenance || !matchesCustody(state, visit, truckId)
      || String(state.bin_type_id) !== String(visit.bin_type_id)
      || String(state.last_visit_id) !== String(visit.service_visit_id)) {
    throw planningError(409, "MBT_BIN_CUSTODY_CONFLICT", "Resume this visit with the truck and bin's recorded physical custody.");
  }
  const reservationId = crypto.randomUUID();
  await query(`INSERT INTO mbt_bin_asset_reservations
    (reservation_id,asset_id,contract_id,visit_id,reservation_slot,reserved_from,reserved_until,reserved_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [reservationId, assignment.assetId, visit.contract_id,
    visit.service_visit_id, assignment.reservationSlot, input.reservationStartAt, input.reservationEndAt, input.actor.operatorId]);
  return { reservationId };
}

/** @param {any} state @param {any} visit @param {string} truckId */
function matchesCustody(state, visit, truckId) {
  if (state.location_kind === "truck") {return String(state.truck_id) === truckId;}
  if (state.location_kind === "customer_site") {return String(state.customer_site_profile_id) === String(visit.customer_site_profile_id);}
  return ["yard", "dump_site"].includes(state.location_kind);
}
