import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { MBT_LOCAL_ITEM_POLICIES } from "../../../src/mbt/local-item-settings.js";
import { normalizeLocalRateCardGraph } from "../../../src/mbt/rate-card-configuration-service.js";
import { calculateTorontoRentalExtensionDays } from "../../../src/mbt/local-billing-calculator.js";

const [billingHtml, billingClient, configHtml, configClient, migration] = await Promise.all([
  readFile(new URL("../../../public/mbt-billing.html", import.meta.url), "utf8"),
  readFile(new URL("../../../public/mbt-billing.js", import.meta.url), "utf8"),
  readFile(new URL("../../../public/mbt-config.html", import.meta.url), "utf8"),
  readFile(new URL("../../../public/mbt-shell.js", import.meta.url), "utf8"),
  readFile(new URL("../../../migrations/122_mbt_rental_pricing_and_monthly_billing.sql", import.meta.url), "utf8")
]);

test("P4-R1: protected rental bins use the dedicated local rental pricing mode", () => {
  for (const itemCode of ["14YD", "20YD", "40YD"]) {
    const item = MBT_LOCAL_ITEM_POLICIES.find((candidate) => candidate.itemCode === itemCode);
    assert.equal(item?.priceMode, "rental_item", `${itemCode} must be a rental item.`);
  }
  assert.match(migration, /pricing_mode IN \('calculated', 'rate_card', 'rental_item', 'custom_price'\)/);
  assert.match(migration, /UPDATE mbt_local_item_settings[\s\S]*pricing_mode = 'rental_item'/);
  assert.match(migration, /NOT system_owned[\s\S]*pricing_mode = 'rental_item'/);
  assert.doesNotMatch(migration, /ADD CONSTRAINT mbt_local_item_settings_identity_shape/);
});

test("P4-R2: simplified rate graph accepts fixed 14-day rental, extension, delivery and cross-charge bands", () => {
  const graph = normalizeLocalRateCardGraph({
    rateCard: {
      rateCardCode: "P4_RENTAL", displayName: "P4 rental", description: "", customerNetSuiteId: null,
      subsidiaryNetSuiteId: null, serviceTemplateCode: null, currency: "CAD", active: true
    },
    version: {
      versionNumber: 1, effectiveFrom: "2026-08-04T00:00:00.000Z", effectiveTo: null,
      defaultRentalCalendarDays: 14, calculationNotes: "Toronto calendar rental"
    },
    distanceBands: [
      { serviceCode: "delivery", binTypeCode: "14YD", sequenceNumber: 0, minimumMetres: 0, maximumMetres: null, amountMinor: 12500, downtownSurchargeMinor: 0, currency: "CAD", description: "0+ km" },
      { serviceCode: "mbbs_cross_charge", binTypeCode: null, sequenceNumber: 0, minimumMetres: 0, maximumMetres: null, amountMinor: 9000, downtownSurchargeMinor: 0, currency: "CAD", description: "0+ km" }
    ],
    components: [
      { componentCode: "rental_14yd_14_days", componentKind: "rental", serviceCode: "delivery", binTypeCode: "14YD", rateBasis: "flat", amountMinor: 15000, percentageBasisPoints: null, defaultQuantity: 1, currency: "CAD", taxable: true, active: true, description: "14YD fixed first 14 calendar days" },
      { componentCode: "extension_14yd_day", componentKind: "extension", serviceCode: "extension", binTypeCode: "14YD", rateBasis: "per_day", amountMinor: 1200, percentageBasisPoints: null, defaultQuantity: 1, currency: "CAD", taxable: true, active: true, description: "14YD extension per day" }
    ],
    dumpTariffs: [
      { dumpSiteCode: null, materialCode: null, tariffCode: "global_mixed_tonne", pricingBasis: "per_weight", unitOfMeasure: "TONNE", amountMinor: 17500, minimumAmountMinor: 0, currency: "CAD", active: true, description: "Customer material tariff, independent of dump site" }
    ],
    depositRules: []
  }, { sourceKind: "manual" });
  assert.equal(graph.version.defaultRentalCalendarDays, 14);
  assert.equal(graph.dumpTariffs[0].dumpSiteCode, null);
  assert.equal(graph.components[0].rateBasis, "flat");
});

test("P4-R2A: rental extension days use Toronto calendar fields and round a partial extra day up", () => {
  assert.equal(
    calculateTorontoRentalExtensionDays("2026-03-01T15:00:00.000Z", "2026-03-15T15:00:01.000Z"),
    1
  );
  assert.equal(
    calculateTorontoRentalExtensionDays("2026-10-25T14:00:00.000Z", "2026-11-08T14:00:00.000Z"),
    0
  );
  assert.equal(
    calculateTorontoRentalExtensionDays("2026-01-31T15:00:00.000Z", "2026-02-15T15:00:00.000Z"),
    1,
    "A short February must not collapse a real fifteenth Toronto calendar day."
  );
});

test("P4-R3: rate-card UI has human-unit create and edit controls, not raw JSON or UUID entry", () => {
  for (const phrase of [
    /Pricing item/i, /charging mechanism/i, /Edit selected rate/i
  ]) {
    assert.match(configHtml, phrase);
  }
  for (const phrase of [/Extension CAD \/ day/i, /BIN delivery/i, /MBBS cross charge/i, /CAD \/ tonne/i, /Add distance band/i]) {
    assert.match(configClient, phrase);
  }
  assert.match(configClient, /simplifiedRateCardGraph|rateCardEditorMode/);
  assert.match(configClient, /loadRateCardForEdit/);
  assert.match(configClient, /function\s+torontoDateParts\s*\(/,
    "The browser must interpret rate-card datetime-local input as Toronto wall time, not the browser timezone.");
  assert.match(configClient, /function\s+assertNonOverlappingDistanceBands\s*\(/,
    "Overlapping or multiple open-ended bands should fail before a server round trip.");
  assert.match(configClient, /bands overlap\. The next band must start where the prior one ends/u);
  assert.match(configClient, /bands have a gap\. The next band must start where the prior one ends/u);
  assert.match(configHtml, /Effective from \(Toronto time\)/u);
  assert.match(configClient, /method:\s*editing\s*\?\s*["']PUT["']/);
  assert.doesNotMatch(configHtml, /<label>Rate-card version ID<input/i);
});

test("P4-R4: billing queue filters by actual Toronto completion month and supports audited waiver", () => {
  assert.match(billingHtml, /Billing month/i);
  assert.match(billingClient, /billingMonth/);
  assert.match(billingClient, /waiver/i);
});
