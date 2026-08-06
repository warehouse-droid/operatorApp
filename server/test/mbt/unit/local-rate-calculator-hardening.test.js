// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateDumpRate,
  calculateLocalRate
} from "../../../src/mbt/local-rate-calculator.js";

const BAND_ID = "10000000-0000-4000-8000-000000000099";

function localInput(overrides = {}) {
  return {
    rateCardVersionId: "20000000-0000-4000-8000-000000000099",
    serviceCode: "delivery",
    binTypeCode: "14YD",
    rawDistanceMetres: 0,
    downtown: false,
    currency: "CAD",
    distanceBands: [{
      rateDistanceBandId: BAND_ID,
      serviceCode: "delivery",
      binTypeCode: "14YD",
      sequenceNumber: 0,
      minimumMetres: 0,
      maximumMetres: null,
      amountMinor: 1_000,
      downtownSurchargeMinor: 0,
      currency: "CAD"
    }],
    components: [],
    componentQuantities: {},
    ...overrides
  };
}

function tariff(overrides = {}) {
  return {
    dumpTariffId: "30000000-0000-4000-8000-000000000099",
    dumpSiteId: "site-a",
    materialId: null,
    tariffCode: "general",
    pricingBasis: "per_quantity",
    unitOfMeasure: "TONNE",
    amountMinor: 125,
    minimumAmountMinor: 0,
    currency: "CAD",
    active: true,
    ...overrides
  };
}

function dumpInput(overrides = {}) {
  return {
    currency: "CAD",
    dumpSiteId: "site-a",
    materialId: "material-a",
    quantity: 2,
    unitOfMeasure: "TONNE",
    actualCostMinor: 100,
    tariffs: [tariff()],
    ...overrides
  };
}

/** @param {() => unknown} operation @param {string} code */
function rejectsCode(operation, code) {
  assert.throws(
    operation,
    (error) => error?.status === 400 && error?.code === code,
    code
  );
}

test("P3-F12 hardening: malformed calculator envelopes and evidence fail closed", () => {
  rejectsCode(() => calculateLocalRate(null), "MBT_RATE_INPUT_INVALID");
  rejectsCode(() => calculateLocalRate([]), "MBT_RATE_INPUT_INVALID");
  rejectsCode(() => calculateLocalRate(localInput({ currency: "USD" })), "MBT_RATE_CURRENCY_MISMATCH");
  rejectsCode(() => calculateLocalRate(localInput({ rawDistanceMetres: -1 })), "MBT_RATE_DISTANCE_INVALID");
  rejectsCode(() => calculateLocalRate(localInput({ distanceBands: null })), "MBT_RATE_BANDS_INVALID");
  rejectsCode(() => calculateLocalRate(localInput({ components: null })), "MBT_RATE_COMPONENTS_INVALID");

  const bandCases = [
    ["minimumMetres", -1, "MBT_RATE_DISTANCE_INVALID"],
    ["maximumMetres", -1, "MBT_RATE_DISTANCE_INVALID"],
    ["amountMinor", -1, "MBT_RATE_MONEY_INVALID"],
    ["downtownSurchargeMinor", -1, "MBT_RATE_MONEY_INVALID"],
    ["currency", "USD", "MBT_RATE_CURRENCY_MISMATCH"]
  ];
  for (const [field, value, code] of bandCases) {
    const input = localInput();
    input.distanceBands[0][field] = value;
    rejectsCode(() => calculateLocalRate(input), code);
  }

  const invalidGroup = localInput();
  invalidGroup.distanceBands[0].maximumMetres = 100;
  rejectsCode(() => calculateLocalRate(invalidGroup), "MBT_RATE_BANDS_INVALID");
});

test("P3-F12 hardening: component bases, quantities, filtering, and overflow are exact", () => {
  const components = [
    {
      componentCode: "weekly",
      componentKind: "rental",
      serviceCode: null,
      binTypeCode: undefined,
      rateBasis: "per_week",
      amountMinor: 300,
      currency: "CAD",
      active: true
    },
    {
      componentCode: "unit",
      componentKind: "other",
      serviceCode: undefined,
      binTypeCode: null,
      rateBasis: "per_unit",
      amountMinor: 40,
      currency: "CAD",
      active: true
    }
  ];
  const result = calculateLocalRate(localInput({
    components,
    componentQuantities: { weekly: 2 }
  }));
  assert.deepEqual(result.lines.slice(1).map(({ lineCode, quantity, unitOfMeasure, netAmountMinor }) => ({
    lineCode,
    quantity,
    unitOfMeasure,
    netAmountMinor
  })), [
    { lineCode: "unit", quantity: 1, unitOfMeasure: "EA", netAmountMinor: 40 },
    { lineCode: "weekly", quantity: 2, unitOfMeasure: "WEEK", netAmountMinor: 600 }
  ]);

  const invalidQuantity = structuredClone(components);
  rejectsCode(() => calculateLocalRate(localInput({
    components: invalidQuantity,
    componentQuantities: { weekly: -1 }
  })), "MBT_RATE_QUANTITY_INVALID");
  rejectsCode(() => calculateLocalRate(localInput({
    components: [{ ...components[0], currency: "USD" }]
  })), "MBT_RATE_CURRENCY_MISMATCH");
  rejectsCode(() => calculateLocalRate(localInput({
    components: [{ ...components[0], amountMinor: -1 }]
  })), "MBT_RATE_MONEY_INVALID");
  rejectsCode(() => calculateLocalRate(localInput({
    components: [{ ...components[0], rateBasis: "percentage" }]
  })), "MBT_RATE_COMPONENT_BASIS_INVALID");
  rejectsCode(() => calculateLocalRate(localInput({
    components: [{ ...components[0], amountMinor: Number.MAX_SAFE_INTEGER }],
    componentQuantities: { weekly: 2 }
  })), "MBT_RATE_MONEY_OVERFLOW");
});

test("P3-F25 hardening: dump tariff selection and fixed/minimum branches remain separate", () => {
  const result = calculateDumpRate(dumpInput({
    quantity: 99,
    actualCostMinor: 900,
    tariffs: [
      tariff({ tariffCode: "z-general", amountMinor: 50 }),
      tariff({
        tariffCode: "a-fixed",
        pricingBasis: "fixed",
        unitOfMeasure: null,
        amountMinor: 1_000,
        minimumAmountMinor: undefined
      })
    ]
  }));
  assert.equal(result.dumpTariffId, tariff().dumpTariffId);
  assert.equal(result.pricingBasis, "fixed");
  assert.equal(result.calculatedTariffMinor, 1_000);
  assert.equal(result.minimumAmountMinor, 0);
  assert.equal(result.customerChargeMinor, 1_000);
  assert.equal(result.actualCostMinor, 900);
  assert.equal(result.marginMinor, 100);
});

test("P3-F25 hardening: malformed dump receipt and tariff evidence fails closed", () => {
  rejectsCode(() => calculateDumpRate(undefined), "MBT_RATE_INPUT_INVALID");
  rejectsCode(() => calculateDumpRate(dumpInput({ currency: "USD" })), "MBT_RATE_CURRENCY_MISMATCH");
  rejectsCode(() => calculateDumpRate(dumpInput({ quantity: -1 })), "MBT_RATE_QUANTITY_INVALID");
  rejectsCode(() => calculateDumpRate(dumpInput({ actualCostMinor: -1 })), "MBT_RATE_MONEY_INVALID");
  rejectsCode(() => calculateDumpRate(dumpInput({ tariffs: null })), "MBT_DUMP_TARIFF_INVALID");
  rejectsCode(() => calculateDumpRate(dumpInput({
    tariffs: [tariff({ active: false })]
  })), "MBT_DUMP_TARIFF_NOT_FOUND");
  rejectsCode(() => calculateDumpRate(dumpInput({
    tariffs: [tariff({ dumpSiteId: "site-b" })]
  })), "MBT_DUMP_TARIFF_NOT_FOUND");
  rejectsCode(() => calculateDumpRate(dumpInput({
    tariffs: [tariff({ materialId: "material-b" })]
  })), "MBT_DUMP_TARIFF_NOT_FOUND");
  rejectsCode(() => calculateDumpRate(dumpInput({
    tariffs: [tariff({ currency: "USD" })]
  })), "MBT_RATE_CURRENCY_MISMATCH");
  rejectsCode(() => calculateDumpRate(dumpInput({
    tariffs: [tariff({ unitOfMeasure: "KG" })]
  })), "MBT_DUMP_TARIFF_UNIT_MISMATCH");
  rejectsCode(() => calculateDumpRate(dumpInput({
    tariffs: [tariff({ amountMinor: -1 })]
  })), "MBT_RATE_MONEY_INVALID");
  rejectsCode(() => calculateDumpRate(dumpInput({
    tariffs: [tariff({ minimumAmountMinor: -1 })]
  })), "MBT_RATE_MONEY_INVALID");
  rejectsCode(() => calculateDumpRate(dumpInput({
    quantity: 2,
    tariffs: [tariff({ amountMinor: Number.MAX_SAFE_INTEGER })]
  })), "MBT_RATE_MONEY_OVERFLOW");
});
