// @ts-check

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { normalizeLocalRateCardGraph } from "../../../src/mbt/rate-card-configuration-service.js";

const migration = await readFile(
  new URL("../../../migrations/166_mbt_mbbs_po_vrma_vendor_route_rates.sql", import.meta.url),
  "utf8"
).catch(() => "");

function graph() {
  return {
    rateCard: {
      rateCardCode: "DELIVERY_CHARGE_MBBS",
      displayName: "Delivery Charge MBBS",
      description: "MBBS cross charge",
      itemCode: null,
      customerNetSuiteId: null,
      subsidiaryNetSuiteId: null,
      serviceTemplateCode: null,
      currency: "CAD",
      active: true
    },
    version: {
      versionNumber: 3,
      effectiveFrom: "2026-01-01T05:00:00.000Z",
      effectiveTo: null,
      defaultRentalCalendarDays: 14,
      calculationNotes: "PO/VRMA vendor-yard rate matrix"
    },
    distanceBands: [{
      itemCode: "DELIVERY_CHARGE_MBBS",
      serviceCode: "mbbs_cross_charge",
      binTypeCode: null,
      sequenceNumber: 0,
      minimumMetres: 0,
      maximumMetres: null,
      amountMinor: 20_000,
      pricingBasis: "flat",
      boundaryRule: "upper_inclusive",
      originYardCodes: [],
      downtownSurchargeMinor: 0,
      currency: "CAD",
      description: "Fallback"
    }],
    components: [],
    dumpTariffs: [],
    depositRules: [],
    mbbsChargingPolicy: {
      schemaVersion: 2,
      currency: "CAD",
      directPickupUnitAmountMinor: 10_000,
      poVrmaAdditionalStopUnitAmountMinor: 10_000,
      soChargeBasis: "per_order_group_as_one",
      toReplenishmentChargeBasis: "full_route_once",
      toDirectPickupChargeBasis: "fixed_unit_once",
      poChargeBasis: "shared_leg_equal_split",
      dispatchLoadSplitBasis: "ignored_for_charge",
      poVrmaBaseChargeBasis: "vendor_yard_pair_then_distance_band",
      vrmaDirectionBasis: "same_pair_reverse",
      poVrmaAdditionalStopBasis: "each_distinct_stop_after_base_pair",
      endpointOverrideBasis: "flat_default_user_may_choose_distance"
    },
    mbbsVendorRouteRates: [{
      rateName: "Bestway Stone - Uxbridge to 12441",
      displayName: "Bestway Stone - Uxbridge to 12441",
      localVendorId: 6,
      localVendorName: "BWS",
      vendorYardName: "BWS Uxbridge",
      vendorYardAddress: "65 Anderson Blvd, Uxbridge, ON L9P 0C7",
      destinationYardCode: "12441",
      baseAmountMinor: 20_000,
      currency: "CAD"
    }]
  };
}

test("M1 rate-card graph accepts schema-v2 matrix rows and rejects rows on schema v1", () => {
  const normalized = normalizeLocalRateCardGraph(graph(), { sourceKind: "manual" });
  assert.equal(normalized.mbbsChargingPolicy.schemaVersion, 2);
  assert.deepEqual(normalized.mbbsVendorRouteRates, graph().mbbsVendorRouteRates);

  const legacy = graph();
  legacy.mbbsChargingPolicy = {
    schemaVersion: 1,
    currency: "CAD",
    directPickupUnitAmountMinor: 10_000,
    poAdditionalDropUnitAmountMinor: 10_000,
    soChargeBasis: "per_order_group_as_one",
    toReplenishmentChargeBasis: "full_route_once",
    toDirectPickupChargeBasis: "fixed_unit_once",
    poChargeBasis: "shared_leg_equal_split",
    poAdditionalDropBasis: "each_distinct_drop_after_first",
    dispatchLoadSplitBasis: "ignored_for_charge"
  };
  assert.throws(
    () => normalizeLocalRateCardGraph(legacy, { sourceKind: "manual" }),
    (error) => error?.code === "MBT_RATE_CARD_INPUT_INVALID"
  );
});

test("M1 migration owns exact-CAD matrix rows, schema-v1/v2 constraints, and immutable lifecycle triggers", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS mbt_mbbs_vendor_route_rates/iu);
  assert.match(migration, /local_vendor_id bigint NOT NULL[\s\S]*REFERENCES dispatch_local_vendors/iu);
  assert.match(migration, /destination_yard_id uuid NOT NULL[\s\S]*REFERENCES mbt_yards/iu);
  assert.match(migration, /base_amount_minor bigint NOT NULL/iu);
  assert.match(migration, /CHECK \(base_amount_minor >= 0\)/iu);
  assert.match(migration, /schema_version IN \(1, 2\)/iu);
  assert.match(migration, /trg_mbt_mbbs_vendor_route_rate_immutable/iu);
  assert.match(migration, /UNIQUE[\s\S]*rate_card_version_id[\s\S]*local_vendor_id/iu);
});
