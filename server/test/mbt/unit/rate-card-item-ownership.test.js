import assert from "node:assert/strict";
import test from "node:test";

import { normalizeLocalRateCardGraph } from "../../../src/mbt/rate-card-configuration-service.js";

function deliveryGraph(overrides = {}) {
  return {
    rateCard: {
      rateCardCode: "DELIVERY_LOCAL",
      displayName: "Local delivery",
      description: "One item rate card",
      itemCode: "DELIVERY_CROSS_CHARGE",
      customerNetSuiteId: null,
      subsidiaryNetSuiteId: null,
      serviceTemplateCode: null,
      currency: "CAD",
      active: true
    },
    version: {
      versionNumber: 1,
      effectiveFrom: "2026-08-05T12:00:00.000Z",
      effectiveTo: null,
      defaultRentalCalendarDays: 14,
      calculationNotes: ""
    },
    distanceBands: [{
      itemCode: "DELIVERY_CROSS_CHARGE",
      serviceCode: "delivery",
      binTypeCode: null,
      sequenceNumber: 0,
      minimumMetres: 0,
      maximumMetres: null,
      amountMinor: 15000,
      downtownSurchargeMinor: 0,
      currency: "CAD",
      description: "All distance"
    }],
    components: [],
    dumpTariffs: [],
    depositRules: [],
    ...overrides
  };
}

test("a new item-owned rate graph retains its single item identity", () => {
  const graph = normalizeLocalRateCardGraph(deliveryGraph(), { sourceKind: "manual" });
  assert.equal(graph.rateCard.itemCode, "DELIVERY_CROSS_CHARGE");
});

test("one named rate card can contain pricing rows for multiple local items", () => {
  const graph = deliveryGraph({
    rateCard: {
      ...deliveryGraph().rateCard,
      itemCode: null,
      description: "2026 multi-item price sheet"
    },
    components: [{
      itemCode: "14YD",
      componentCode: "rental_14yd",
      componentKind: "rental",
      serviceCode: "delivery",
      binTypeCode: "14YD",
      rateBasis: "flat",
      amountMinor: 50000,
      percentageBasisPoints: null,
      defaultQuantity: 1,
      currency: "CAD",
      taxable: true,
      active: true,
      description: "Wrong item"
    }]
  });
  const normalized = normalizeLocalRateCardGraph(graph, { sourceKind: "manual" });
  assert.equal(normalized.rateCard.itemCode, null);
  assert.equal(normalized.distanceBands[0].itemCode, "DELIVERY_CROSS_CHARGE");
  assert.equal(normalized.components[0].itemCode, "14YD");
});

test("distance rows accept explicit yard scope, quoted boundary rule, and per-km pricing", () => {
  const graph = deliveryGraph();
  graph.distanceBands[0] = {
    ...graph.distanceBands[0],
    originYardCodes: ["2967", "3445"],
    boundaryRule: "upper_inclusive",
    pricingBasis: "per_km",
    amountMinor: 700
  };
  const normalized = normalizeLocalRateCardGraph(graph, { sourceKind: "manual" });
  assert.deepEqual(normalized.distanceBands[0].originYardCodes, ["2967", "3445"]);
  assert.equal(normalized.distanceBands[0].boundaryRule, "upper_inclusive");
  assert.equal(normalized.distanceBands[0].pricingBasis, "per_km");
});
