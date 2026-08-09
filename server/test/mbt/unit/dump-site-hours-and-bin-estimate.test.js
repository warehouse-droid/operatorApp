import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const localMasterUrl = new URL("../../../src/mbt/local-master-data-service.js", import.meta.url);
const frontdeskUrl = new URL("../../../src/mbt/frontdesk-service.js", import.meta.url);
const migrationUrl = new URL("../../../migrations/129_mbt_dump_site_hours_and_bin_estimates.sql", import.meta.url);
const configPageUrl = new URL("../../../public/mbt-config.html", import.meta.url);
const frontdeskPageUrl = new URL("../../../public/mbt-frontdesk.html", import.meta.url);
const frontdeskClientUrl = new URL("../../../public/mbt-frontdesk.js", import.meta.url);

const BIN_14 = "00000000-0000-4000-8000-000000000014";
const BIN_20 = "00000000-0000-4000-8000-000000000020";
const SITE = "10000000-0000-4000-8000-000000000001";

function dumpSiteInput(overrides = {}) {
  return {
    dumpSiteCode: "TEST_DUMP",
    displayName: "Test dump site",
    addressLine1: "100 Test Road",
    addressLine2: "",
    city: "Toronto",
    region: "ON",
    postalCode: "M1M 1M1",
    countryCode: "CA",
    phone: "",
    latitude: null,
    longitude: null,
    itemAcceptances: [
      { itemCode: "SOIL", accepted: true, scaleTicketRequired: true, notes: "", active: true },
      { itemCode: "CONCRETE", accepted: true, scaleTicketRequired: false, notes: "Clean only", active: true }
    ],
    openingHours: [
      { isoWeekday: 6, opensAt: "08:00", closesAt: "13:00" },
      { isoWeekday: 1, opensAt: "07:00", closesAt: "17:30" }
    ],
    notes: "",
    active: true,
    ...overrides
  };
}

test("dump-site input retains multiple dump items and canonical weekly opening hours", async () => {
  const { normalizeLocalMasterDataRow } = await import(localMasterUrl.href);
  const normalized = normalizeLocalMasterDataRow("dump_sites", dumpSiteInput());

  assert.deepEqual(normalized.itemAcceptances.map(({ itemCode }) => itemCode), ["CONCRETE", "SOIL"]);
  assert.deepEqual(normalized.openingHours, [
    { isoWeekday: 1, opensAt: "07:00", closesAt: "17:30" },
    { isoWeekday: 6, opensAt: "08:00", closesAt: "13:00" }
  ]);
});

test("dump-site input rejects duplicate acceptances, duplicate weekdays, and backwards hours", async () => {
  const { normalizeLocalMasterDataRow } = await import(localMasterUrl.href);
  assert.throws(() => normalizeLocalMasterDataRow("dump_sites", dumpSiteInput({
    itemAcceptances: [
      { itemCode: "SOIL", accepted: true, scaleTicketRequired: true, notes: "", active: true },
      { itemCode: "soil", accepted: true, scaleTicketRequired: false, notes: "", active: true }
    ]
  })), /dump-site row is invalid/i);
  assert.throws(() => normalizeLocalMasterDataRow("dump_sites", dumpSiteInput({
    openingHours: [
      { isoWeekday: 1, opensAt: "07:00", closesAt: "17:00" },
      { isoWeekday: 1, opensAt: "08:00", closesAt: "12:00" }
    ]
  })), /dump-site row is invalid/i);
  assert.throws(() => normalizeLocalMasterDataRow("dump_sites", dumpSiteInput({
    openingHours: [{ isoWeekday: 2, opensAt: "17:00", closesAt: "07:00" }]
  })), /dump-site row is invalid/i);
});

test("Front Desk expands one shared contract site into individual bins with one dump item each", async () => {
  const { normalizeFrontdeskServiceLines } = await import(frontdeskUrl.href);
  const lines = normalizeFrontdeskServiceLines({
    siteProfileId: SITE,
    serviceLines: [
      {
        binItemCode: "14YD",
        binTypeId: BIN_14,
        dumpItemCode: "SOIL",
        estimatedTonnes: "1.250",
        proposedDeliveryAt: "2037-08-03T12:00:00.000Z",
        proposedReturnAt: "2037-08-17T12:00:00.000Z"
      },
      {
        binItemCode: "20YD",
        binTypeId: BIN_20,
        dumpItemCode: "CONCRETE",
        estimatedTonnes: "2.75",
        proposedDeliveryAt: "2037-08-05T12:00:00.000Z",
        proposedReturnAt: "2037-08-19T12:00:00.000Z"
      }
    ]
  });

  assert.deepEqual(lines.map((line) => ({
    lineNumber: line.lineNumber,
    siteProfileId: line.siteProfileId,
    dumpItemCode: line.dumpItemCode,
    estimatedWeightKg: line.estimatedWeightKg
  })), [
    { lineNumber: 1, siteProfileId: SITE, dumpItemCode: "SOIL", estimatedWeightKg: 1250 },
    { lineNumber: 2, siteProfileId: SITE, dumpItemCode: "CONCRETE", estimatedWeightKg: 2750 }
  ]);
});

test("Front Desk rejects quantity expansion, missing dump evidence, and multiple sites", async () => {
  const { normalizeFrontdeskServiceLines } = await import(frontdeskUrl.href);
  const validLine = {
    binItemCode: "14YD",
    binTypeId: BIN_14,
    dumpItemCode: "SOIL",
    estimatedTonnes: "1.000",
    proposedDeliveryAt: "2037-08-03T12:00:00.000Z",
    proposedReturnAt: "2037-08-17T12:00:00.000Z"
  };
  assert.throws(() => normalizeFrontdeskServiceLines({
    siteProfileId: SITE,
    serviceLines: [{ ...validLine, quantity: 2 }]
  }), /one physical bin/i);
  assert.throws(() => normalizeFrontdeskServiceLines({
    siteProfileId: SITE,
    serviceLines: [{ ...validLine, dumpItemCode: "" }]
  }), /dump item/i);
  assert.throws(() => normalizeFrontdeskServiceLines({
    siteProfileId: SITE,
    serviceLines: [{ ...validLine, estimatedTonnes: "0" }]
  }), /estimated tonnes/i);
  assert.throws(() => normalizeFrontdeskServiceLines({
    serviceLines: [
      { ...validLine, siteProfileId: SITE },
      { ...validLine, siteProfileId: "10000000-0000-4000-8000-000000000002" }
    ]
  }), /one service site/i);
});

test("Front Desk accepts explicit manual surcharge cents and rejects duplicate surcharge items", async () => {
  const { normalizeFrontdeskSurcharges } = await import(frontdeskUrl.href);
  assert.deepEqual(normalizeFrontdeskSurcharges([
    { itemCode: "downtown", amountMinor: 12_500 },
    { itemCode: "OVERTIME", amountMinor: 7_500 }
  ]), [
    { itemCode: "DOWNTOWN", amountMinor: 12_500 },
    { itemCode: "OVERTIME", amountMinor: 7_500 }
  ]);
  assert.throws(() => normalizeFrontdeskSurcharges([
    { itemCode: "DOWNTOWN", amountMinor: 100 },
    { itemCode: "downtown", amountMinor: 200 }
  ]), /once/i);
  assert.throws(() => normalizeFrontdeskSurcharges([
    { itemCode: "OVERTIME", amountMinor: -1 }
  ]), /surcharge amount/i);
});

test("estimated dump charge uses integer kilograms, nearest-cent rounding, and the configured minimum", async () => {
  const { normalizeEstimatedDumpWeightKg, calculateEstimatedDumpChargeMinor } = await import(frontdeskUrl.href);
  assert.equal(normalizeEstimatedDumpWeightKg("1.250", "Estimated tonnes"), 1250);
  assert.equal(calculateEstimatedDumpChargeMinor({
    amountMinorPerTonne: 12_345,
    minimumAmountMinor: 2_000,
    estimatedWeightKg: 1_250
  }), 15_431);
  assert.equal(calculateEstimatedDumpChargeMinor({
    amountMinorPerTonne: 10_000,
    minimumAmountMinor: 2_500,
    estimatedWeightKg: 100
  }), 2_500);
  assert.throws(() => normalizeEstimatedDumpWeightKg("1.2345", "Estimated tonnes"), /estimated tonnes/i);
});

test("Front Desk pricing origin defaults to standard and accepts only the two quoted tables", async () => {
  const { normalizePricingOriginYardCode } = await import(frontdeskUrl.href);
  assert.equal(normalizePricingOriginYardCode(undefined), "3445");
  assert.equal(normalizePricingOriginYardCode("3445"), "3445");
  assert.equal(normalizePricingOriginYardCode("150"), "150");
  assert.throws(() => normalizePricingOriginYardCode("12441"), /pricing origin/i);
  assert.throws(() => normalizePricingOriginYardCode("2967"), /pricing origin/i);
});

test("schema retains legacy dump evidence while the customer-charge browser uses fixed prices", async () => {
  const [migration, configPage, frontdeskPage, frontdeskClient] = await Promise.all([
    readFile(migrationUrl, "utf8"),
    readFile(configPageUrl, "utf8"),
    readFile(frontdeskPageUrl, "utf8"),
    readFile(frontdeskClientUrl, "utf8")
  ]);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS mbt_dump_site_opening_hours/i);
  assert.match(migration, /iso_weekday/i);
  assert.match(migration, /opens_at[\s\S]*closes_at/i);
  assert.match(migration, /ALTER TABLE mbt_contract_service_lines[\s\S]*dump_item_code/i);
  assert.match(migration, /estimated_weight_kg/i);
  assert.match(configPage, /data-dump-acceptance-item/i);
  assert.match(configPage, /data-dump-opening-day/i);
  assert.match(frontdeskPage, /id="serviceAddressText"/i);
  assert.match(frontdeskPage, /id="chargeDeliveryItemCode"/i);
  assert.match(frontdeskPage, /id="binContentCode"/i);
  assert.match(frontdeskPage, /id="binDiscountCad"/i);
  assert.doesNotMatch(frontdeskPage, /data-line-dump-item|data-line-estimated-tonnes|Estimated tonnes/i);
  assert.doesNotMatch(frontdeskClient, /estimatedTonnes/i);
  assert.doesNotMatch(frontdeskPage, /data-line-quantity/i);
  assert.match(frontdeskClient, /customer-charge\/configuration/i);
});
