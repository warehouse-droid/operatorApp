import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { closeDb, query, withTransaction } from "../../../src/db.js";
import { assignMbtBinFrontLeg } from "../../../src/mbt/bin-dispatch-service.js";
import {
  binAssignmentCommand,
  binDispatchPlanDate,
  createBinDispatchFixture,
  enabledBinDispatchBoundary
} from "../support/bin-dispatch-fixtures.js";
import { createFrontdeskPrerequisites } from "../support/frontdesk-fixtures.js";

after(async () => closeDb());

test("P3-F21 hardening: a customer-located BIN can only be reserved for its server-owned visit site", async () => {
  const fixture = await createBinDispatchFixture({
    label: "customer-reservation-site",
    planDate: binDispatchPlanDate(12_500 + crypto.randomInt(0, 1_000))
  });
  const unrelated = await createFrontdeskPrerequisites({ label: "unrelated-reservation-site" });
  const movementId = crypto.randomUUID();
  const occurredAt = `${fixture.planDate}T07:00:00.000Z`;

  await withTransaction(async () => {
    await query(
      `INSERT INTO mbt_bin_movements (
         movement_id, asset_id, asset_sequence, movement_type,
         before_status, after_status, before_location_kind,
         before_location_reference, after_location_kind,
         after_location_reference, from_yard_id, to_customer_site_profile_id,
         source, actor_type, actor_id, occurred_at
       ) VALUES (
         $1, $2, 2, 'synthetic_wrong_customer_delivery',
         'available', 'at_customer', 'yard', $3, 'customer_site',
         $4::text, $5, $4::uuid, 'p3_driver_reservation_hardening', 'system',
         'p3-driver-reservation-hardening', $6::timestamptz
       )`,
      [
        movementId,
        fixture.assetId,
        "12441",
        unrelated.siteProfileId,
        "00000000-0000-4000-8000-000000012441",
        occurredAt
      ]
    );
    await query(
      `UPDATE mbt_bin_asset_state
          SET lifecycle_status = 'at_customer', location_kind = 'customer_site',
              location_reference = $2::text, yard_id = NULL,
              customer_site_profile_id = $2::uuid, dump_site_id = NULL,
              truck_id = NULL, last_movement_id = $3, revision = 2,
              changed_at = $4::timestamptz
        WHERE asset_id = $1`,
      [fixture.assetId, unrelated.siteProfileId, movementId, occurredAt]
    );
    await query(
      `UPDATE mbt_service_visits
          SET service_action = 'loaded_pickup',
              service_snapshot = jsonb_set(
                service_snapshot,
                '{mandatoryStops,0,actionCode}',
                '"pickup_loaded_bin"'::jsonb
              )
        WHERE service_visit_id = $1`,
      [fixture.frontVisitId]
    );
  });

  await assert.rejects(
    assignMbtBinFrontLeg(
      binAssignmentCommand(fixture, "wrong-customer-site", {
        assetAssignments: [{
          reservationSlot: "outgoing",
          assetId: fixture.assetId,
          expectedStateRevision: 2
        }]
      }),
      { capability: enabledBinDispatchBoundary }
    ),
    (error) => error?.status === 409
      && error?.code === "MBT_RESERVATION_SITE_CONFLICT"
  );

  const retained = await query(
    `SELECT state.lifecycle_status, state.location_kind,
            state.customer_site_profile_id::text,
            (SELECT count(*)::int FROM mbt_bin_asset_reservations reservation
              WHERE reservation.asset_id = state.asset_id) AS reservations,
            (SELECT count(*)::int FROM mbt_bin_movements movement
              WHERE movement.asset_id = state.asset_id) AS movements,
            (SELECT revision::int FROM dispatch_plans WHERE id = $2) AS plan_revision
       FROM mbt_bin_asset_state state
      WHERE state.asset_id = $1`,
    [fixture.assetId, fixture.planId]
  );
  assert.deepEqual(retained.rows[0], {
    lifecycle_status: "at_customer",
    location_kind: "customer_site",
    customer_site_profile_id: unrelated.siteProfileId,
    reservations: 0,
    movements: 2,
    plan_revision: 1
  });
});
