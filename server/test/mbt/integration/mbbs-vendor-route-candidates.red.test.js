// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import {
  createMbbsBillingCasesFromCandidates,
  listMbbsBillingCandidates,
  previewMbbsBillingCandidate,
  previewMbbsBillingCandidatesBatch
} from "../../../src/mbt/mbbs-billing-candidate-service.js";
import { persistCalculatedMbbsCandidateBatch } from "../../../src/mbt/shadow-billing-service.js";

const ACTOR = Object.freeze({ operatorId: "vendor-route-candidate-test", roles: Object.freeze(["admin"]) });

after(closeDb);

async function rollbackTest(operation) {
  const rollback = await beginRollbackContext();
  try {
    return await rollback.run(operation);
  } finally {
    await rollback.rollback();
  }
}

async function installV4Graph({ localVendorId, vendorYardName, vendorYardAddress, destinationYardCode, flatMinor }) {
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const cardId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const destination = await query(
    "SELECT yard_id FROM mbt_yards WHERE active AND yard_code = $1",
    [destinationYardCode]
  );
  assert.equal(destination.rowCount, 1);
  await query(
    `INSERT INTO mbt_local_item_settings (
       item_code, display_name, description, item_type, category,
       pricing_mode, netsuite_mapping_local_key, system_owned,
       applicable_service_types, applicable_legacy_source_types,
       charge_basis, active, revision, created_by, updated_by
     ) VALUES (
       'DELIVERY_CHARGE_MBBS', 'Delivery Charge MBBS', 'Local MBBS delivery charge.',
       'delivery_fee', 'cross_charge', 'rate_card', 'delivery_charge_mbbs', false,
       ARRAY['delivery']::text[], ARRAY['SO','TO','PO','VRMA']::text[],
       'distance', true, 1, $1, $1
     ) ON CONFLICT (item_code) DO NOTHING`,
    [ACTOR.operatorId]
  );
  await query(
    `INSERT INTO mbt_rate_cards (
       rate_card_id, rate_card_code, display_name, currency, created_by, updated_by
     ) VALUES ($1, $2, $3, 'CAD', $4, $4)`,
    [cardId, `MBBS_VENDOR_${suffix}`, `MBBS vendor ${suffix}`, ACTOR.operatorId]
  );
  await query(
    `INSERT INTO mbt_rate_card_versions (
       rate_card_version_id, rate_card_id, version_number, status,
       effective_from, validation_snapshot, created_by, updated_by
     ) VALUES ($1, $2, 4, 'draft', now(), '{}'::jsonb, $3, $3)`,
    [versionId, cardId, ACTOR.operatorId]
  );
  await query(
    `INSERT INTO mbt_rate_distance_bands (
       rate_distance_band_id, rate_card_version_id, item_code, service_code,
       sequence_number, minimum_metres, maximum_metres, amount_minor,
       pricing_basis, boundary_rule, origin_yard_codes, currency, description
     ) VALUES
       ($1, $3, 'DELIVERY_CHARGE_MBBS', 'mbbs_cross_charge', 0, 0, 30000,
        20000, 'flat', 'upper_inclusive', ARRAY[]::text[], 'CAD', 'Short route'),
       ($2, $3, 'DELIVERY_CHARGE_MBBS', 'mbbs_cross_charge', 1, 30000, NULL,
        25000, 'flat', 'upper_inclusive', ARRAY[]::text[], 'CAD', 'Long route')`,
    [crypto.randomUUID(), crypto.randomUUID(), versionId]
  );
  await query(
    `UPDATE mbt_mbbs_rate_card_policies
        SET schema_version = 3,
            direct_pickup_unit_amount_minor = 10000,
            po_vrma_additional_stop_unit_amount_minor = 10000,
            po_vrma_base_charge_basis = 'vendor_yard_pair_then_distance_band',
            vrma_direction_basis = 'same_pair_reverse',
            po_vrma_additional_stop_basis = 'each_distinct_stop_after_base_pair',
            endpoint_override_basis = 'flat_default_user_may_choose_distance',
            to_replenishment_additional_drop_unit_amount_minor = 10000,
            to_replenishment_multi_drop_basis =
              'longest_origin_drop_plus_each_distinct_drop_after_first',
            updated_by = $2, updated_at = now(), revision = revision + 1
      WHERE rate_card_version_id = $1`,
    [versionId, ACTOR.operatorId]
  );
  const vendor = await query(
    "SELECT name FROM dispatch_local_vendors WHERE id = $1 AND active",
    [localVendorId]
  );
  assert.equal(vendor.rowCount, 1);
  await query(
    `INSERT INTO mbt_mbbs_vendor_route_rates (
       vendor_route_rate_id, rate_card_version_id, rate_name, display_name,
       local_vendor_id, vendor_yard_name, vendor_yard_address,
       destination_yard_id, base_amount_minor, currency, created_by, updated_by
     ) VALUES ($1, $2, $3, $3, $4, $5, $6, $7, $8, 'CAD', $9, $9)`,
    [
      crypto.randomUUID(), versionId, `Fixture ${vendorYardName} to ${destinationYardCode}`,
      localVendorId, vendorYardName, vendorYardAddress, destination.rows[0].yard_id,
      flatMinor, ACTOR.operatorId
    ]
  );
  await query(
    `UPDATE mbt_rate_card_versions
        SET status = 'active', activated_at = now(), updated_at = now(),
            revision = revision + 1
      WHERE rate_card_version_id = $1`,
    [versionId]
  );
  return versionId;
}

async function driverRoute({ reference, sourceType, pickup, drops, suffix }) {
  const loadId = `VENDOR-RATE-${suffix}-${reference}`;
  const orderType = sourceType === "VRMA" ? "VRMA" : "PURCHASE_ORDER";
  const stops = [
    { type: "pickup", address: pickup },
    ...drops.map((address) => ({ type: "dropoff", address }))
  ];
  for (const [index, stop] of stops.entries()) {
    await query(
      `INSERT INTO driver_job_records (
         job_id, plan_date, driver_login, truck_id, load_id, load_name,
         stop_id, stop_type, order_refs, status, started_at, completed_at, job_details
       ) VALUES (
         $1, '2039-10-10', 'vendor-rate-driver', '101', $2, 'Vendor rate load',
         $3, $4, $5::jsonb, 'complete',
         ('2039-10-10T14:00:00Z'::timestamptz + ($6 * interval '10 minutes')),
         ('2039-10-10T14:05:00Z'::timestamptz + ($6 * interval '10 minutes')),
         $7::jsonb
       )`,
      [
        `JOB-${suffix}-${sourceType}-${index}`,
        loadId,
        `STOP-${suffix}-${sourceType}-${index}`,
        stop.type,
        JSON.stringify([reference]),
        index,
        JSON.stringify({
          address: stop.address,
          orders: [{ orderRef: reference, orderType, source: "receiving" }],
          physicalVisitStopIds: [`STOP-${suffix}-${sourceType}-${index}`]
        })
      ]
    );
  }
  return loadId;
}

test("M2-M6 schema-v3 exact PO/VRMA flat rates survive route failure; override choice and distance fallback remain server-owned", async () => {
  await rollbackTest(async () => {
    const suffix = crypto.randomUUID().replaceAll("-", "").toUpperCase();
    const localVendorName = `Vendor Rate ${suffix}`;
    const vendorYardName = `Vendor Yard ${suffix}`;
    const vendorAddress = "65 Anderson Blvd, Uxbridge, ON L9P 0C7";
    const localVendor = await query(
      `INSERT INTO dispatch_local_vendors (name, active, updated_by)
       VALUES ($1, true, $2) RETURNING id::int`,
      [localVendorName, ACTOR.operatorId]
    );
    const localVendorId = Number(localVendor.rows[0].id);
    await query(
      `INSERT INTO dispatch_vendor_yards (vendor, yard, aliases, address, active)
       VALUES ($1, $2, 'uxbridge,fixture alias', $3, true)`,
      [localVendorName, vendorYardName, vendorAddress]
    );
    const mbbsYard = await query(
      `SELECT yard_code, dispatch_location_id::text,
              concat_ws(', ', address_line_1, NULLIF(address_line_2, ''), city, region, postal_code, country_code) AS address
         FROM mbt_yards WHERE active AND yard_code = '12441'`
    );
    assert.equal(mbbsYard.rowCount, 1);
    const destinationAddress = String(mbbsYard.rows[0].address);
    const versionId = await installV4Graph({
      localVendorId,
      vendorYardName,
      vendorYardAddress: vendorAddress,
      destinationYardCode: "12441",
      flatMinor: 35_000
    });
    const base = 9_960_000_000 + crypto.randomInt(100_000);
    const exactRef = `PO-EXACT-${suffix}`;
    const overrideRef = `PO-OVERRIDE-${suffix}`;
    const fallbackRef = `PO-FALLBACK-${suffix}`;
    const vrmaRef = `VRMA-${suffix}`;
    const fallbackVendor = `Unmapped Vendor ${suffix}`;
    const fallbackYard = `Unmapped Yard ${suffix}`;
    const fallbackAddress = "1 Fallback Road, Toronto, ON";
    await query(
      `INSERT INTO dispatch_local_vendors (name, active, updated_by)
       VALUES ($1, true, $2)`,
      [fallbackVendor, ACTOR.operatorId]
    );
    await query(
      `INSERT INTO dispatch_vendor_yards (vendor, yard, aliases, address, active)
       VALUES ($1, $2, '', $3, true)`,
      [fallbackVendor, fallbackYard, fallbackAddress]
    );
    await query(
      `INSERT INTO purchase_orders (
         netsuite_id, tranid, dispatch_ref, vendor, dispatch_vendor_yard,
         dispatch_pickup_address, destination_location_id, destination_location,
         receipt_status, netsuite_active, synced_at
       ) VALUES
         ($1, $2, $2, $6, $7, '', $8, '12441', 'received', true, now()),
         ($3, $4, $4, $6, $7, $5, $8, '12441', 'received', true, now()),
         ($9, $10, $10, $11, $12, '', $8, '12441', 'received', true, now())`,
      [
        base + 1, exactRef, base + 2, overrideRef,
        "99 Alternate Vendor Gate, Uxbridge, ON", localVendorName,
        vendorYardName, Number(mbbsYard.rows[0].dispatch_location_id),
        base + 3, fallbackRef, fallbackVendor, fallbackYard
      ]
    );
    await query(
      `INSERT INTO scm_vrma_orders (
         vrma_ref, vendor, local_vendor, pickup_location, dropoff_location,
         status, method, completed_at, completed_by, completion_note, completion_source
       ) VALUES ($1, $2, $2, '12441', $3, 'Completed', 'MBT',
                 '2039-10-10T16:00:00Z', $4, 'test completion', 'test')`,
      [vrmaRef, localVendorName, vendorYardName, ACTOR.operatorId]
    );
    const exactLoad = await driverRoute({
      reference: exactRef, sourceType: "PO", pickup: vendorAddress,
      drops: [destinationAddress], suffix: `${suffix}-EXACT`
    });
    const overrideLoad = await driverRoute({
      reference: overrideRef, sourceType: "PO", pickup: "99 Alternate Vendor Gate, Uxbridge, ON",
      drops: [destinationAddress], suffix: `${suffix}-OVERRIDE`
    });
    const vrmaLoad = await driverRoute({
      reference: vrmaRef, sourceType: "VRMA", pickup: destinationAddress,
      drops: [vendorAddress], suffix: `${suffix}-VRMA`
    });
    const fallbackLoad = await driverRoute({
      reference: fallbackRef, sourceType: "PO", pickup: fallbackAddress,
      drops: [destinationAddress], suffix: `${suffix}-FALLBACK`
    });
    const listed = await listMbbsBillingCandidates({
      actor: ACTOR,
      completedDate: "2039-10-10",
      search: suffix,
      limit: 100
    });
    const exact = listed.items.find((item) => item.driverLoadIds.includes(exactLoad));
    const override = listed.items.find((item) => item.driverLoadIds.includes(overrideLoad));
    const vrma = listed.items.find((item) => item.driverLoadIds.includes(vrmaLoad));
    const fallback = listed.items.find((item) => item.driverLoadIds.includes(fallbackLoad));
    assert.ok(exact);
    assert.ok(override);
    assert.ok(vrma);
    assert.ok(fallback);
    assert.equal(exact.vendorRouteEvidence.endpointOverride, false);
    assert.equal(override.vendorRouteEvidence.endpointOverride, true);
    assert.equal(vrma.vendorRouteEvidence.localVendorId, localVendorId);

    let exactRouteCalls = 0;
    const exactPreview = await previewMbbsBillingCandidate({
      actor: ACTOR,
      candidateId: exact.candidateId,
      completedMonth: "2039-10",
      completedDate: "2039-10-10",
      rateCardVersionId: versionId
    }, {
      async resolveDistance() {
        exactRouteCalls += 1;
        throw new Error("routing deliberately unavailable");
      }
    });
    assert.equal(exactRouteCalls, 0);
    assert.equal(exactPreview.pricingMethod, "vendor_yard_flat");
    assert.equal(exactPreview.charge.amountMinor, 35_000);
    assert.equal(exactPreview.distanceAvailable, false);

    const routing = {
      async resolveDistance(input) {
        return {
          provider: "vendor-rate-test",
          providerMetres: 12_000,
          routeHash: crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex")
        };
      }
    };
    const defaultOverride = await previewMbbsBillingCandidatesBatch({
      actor: ACTOR,
      candidateIds: [override.candidateId, vrma.candidateId, fallback.candidateId],
      completedMonth: "2039-10",
      completedDate: "2039-10-10",
      rateCardVersionId: versionId
    }, routing);
    assert.equal(defaultOverride.failureCount, 0);
    const overrideDefault = defaultOverride.results.find((result) => result.candidateId === override.candidateId);
    const reverse = defaultOverride.results.find((result) => result.candidateId === vrma.candidateId);
    const distanceFallback = defaultOverride.results.find((result) => result.candidateId === fallback.candidateId);
    assert.equal(overrideDefault.pricingMethod, "vendor_yard_flat");
    assert.equal(overrideDefault.charge.amountMinor, 35_000);
    assert.deepEqual(overrideDefault.pricingOptions.map((option) => option.pricingMethod), [
      "vendor_yard_flat", "distance_band"
    ]);
    assert.equal(reverse.pricingMethod, "vendor_yard_flat");
    assert.equal(reverse.charge.amountMinor, 35_000);
    assert.equal(distanceFallback.pricingMethod, "distance_band");
    assert.equal(distanceFallback.selectedVendorRouteRate, null);
    assert.equal(distanceFallback.charge.amountMinor, 20_000);

    const selectedDistance = await previewMbbsBillingCandidatesBatch({
      actor: ACTOR,
      candidateIds: [override.candidateId],
      pricingSelections: [{ candidateId: override.candidateId, pricingMethod: "distance_band" }],
      completedMonth: "2039-10",
      completedDate: "2039-10-10",
      rateCardVersionId: versionId
    }, routing);
    assert.equal(selectedDistance.results[0].pricingMethod, "distance_band");
    assert.equal(selectedDistance.results[0].charge.amountMinor, 20_000);

    const customerId = base + 9;
    await query(
      `INSERT INTO netsuite_customers (
         netsuite_id, entity_number, legal_name, display_name, currency,
         source_modified_at, source_version, payload_hash
       ) VALUES ($1, $2, $2, $2, 'CAD', now(), $3, $4)`,
      [customerId, `Vendor route customer ${suffix}`, suffix, "b".repeat(64)]
    );
    const tamperedCalculation = structuredClone(selectedDistance.results[0]);
    tamperedCalculation.selectedVendorRouteRate.baseAmountMinor += 1;
    await assert.rejects(
      persistCalculatedMbbsCandidateBatch({
        actor: ACTOR,
        customerNetsuiteId: String(customerId),
        calculations: [tamperedCalculation],
        reason: "Reject browser-authored vendor-route money",
        correlationId: `vendor-route-tamper-${suffix}`,
        completedLoadSnapshotIdsByPhysicalLoad: {}
      }),
      (error) => error?.code === "MBT_MBBS_CALCULATION_STALE"
    );
    const converted = await createMbbsBillingCasesFromCandidates({
      actor: ACTOR,
      candidateIds: [override.candidateId],
      pricingSelections: [{ candidateId: override.candidateId, pricingMethod: "distance_band" }],
      completedMonth: "2039-10",
      completedDate: "2039-10-10",
      rateCardVersionId: versionId,
      customerNetsuiteId: String(customerId),
      reason: "Verify explicit endpoint override pricing",
      idempotencyKey: `vendor-route-${suffix}`,
      correlationId: `vendor-route-correlation-${suffix}`,
      requestId: `vendor-route-request-${suffix}`
    }, routing);
    assert.deepEqual(converted.body.pricingSelections, [{
      candidateId: override.candidateId,
      pricingMethod: "distance_band"
    }]);
    const snapshot = await query(
      `SELECT source_snapshot->>'pricingMethod' AS pricing_method,
              source_snapshot->'selectedVendorRouteRate'->>'rateName' AS retained_rate_name
         FROM mbt_mbbs_completed_load_snapshots
        WHERE completed_load_snapshot_id = $1`,
      [converted.body.completedLoadSnapshotIds[0]]
    );
    assert.equal(snapshot.rows[0].pricing_method, "distance_band");
    assert.match(snapshot.rows[0].retained_rate_name, /Fixture/iu);
  });
});
