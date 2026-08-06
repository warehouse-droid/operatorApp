import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const serviceUrl = new URL("../../../src/mbt/frontdesk-service.js", import.meta.url);
const migrationUrl = new URL("../../../migrations/123_mbt_contract_service_lines.sql", import.meta.url);
const siteMigrationUrl = new URL("../../../migrations/124_mbt_bin_order_sites.sql", import.meta.url);
const pageUrl = new URL("../../../public/mbt-frontdesk.html", import.meta.url);
const scriptUrl = new URL("../../../public/mbt-frontdesk.js", import.meta.url);

const BIN_14 = "00000000-0000-4000-8000-000000000014";
const BIN_20 = "00000000-0000-4000-8000-000000000020";
const SITE_A = "10000000-0000-4000-8000-000000000001";

test("MBT Front Desk multi-bin: each requested row is one independently addressable physical bin", async () => {
  const service = await import(serviceUrl.href);
  assert.equal(typeof service.normalizeFrontdeskServiceLines, "function");

  const lines = service.normalizeFrontdeskServiceLines({
    binTypeId: BIN_14,
    siteProfileId: SITE_A,
    dumpItemCode: "SOIL",
    estimatedTonnes: "1.000",
    proposedDeliveryAt: "2037-08-03T12:00:00.000Z",
    proposedReturnAt: "2037-08-17T12:00:00.000Z",
    serviceLines: [
      {
        binItemCode: "14YD",
        binTypeId: BIN_14,
        dumpItemCode: "SOIL",
        estimatedTonnes: "1.000",
        proposedDeliveryAt: "2037-08-03T12:00:00.000Z",
        proposedReturnAt: "2037-08-17T12:00:00.000Z"
      },
      {
        binItemCode: "20YD",
        binTypeId: BIN_20,
        dumpItemCode: "CONCRETE",
        estimatedTonnes: "2.000",
        proposedDeliveryAt: "2037-08-05T12:00:00.000Z",
        proposedReturnAt: "2037-08-19T12:00:00.000Z"
      }
    ]
  });

  assert.deepEqual(lines.map((line) => ({
    lineNumber: line.lineNumber,
    binTypeId: line.binTypeId,
    binItemCode: line.binItemCode,
    siteProfileId: line.siteProfileId,
    proposedDeliveryAt: line.proposedDeliveryAt,
    proposedReturnAt: line.proposedReturnAt
  })), [
    {
      lineNumber: 1,
      binTypeId: BIN_14,
      binItemCode: "14YD",
      siteProfileId: SITE_A,
      proposedDeliveryAt: "2037-08-03T12:00:00.000Z",
      proposedReturnAt: "2037-08-17T12:00:00.000Z"
    },
    {
      lineNumber: 2,
      binTypeId: BIN_20,
      binItemCode: "20YD",
      siteProfileId: SITE_A,
      proposedDeliveryAt: "2037-08-05T12:00:00.000Z",
      proposedReturnAt: "2037-08-19T12:00:00.000Z"
    }
  ]);
});

test("MBT Front Desk BIN order: one inline contract site is retained by every physical bin", async () => {
  const service = await import(serviceUrl.href);
  const site = {
    label: "North project",
    addressLine1: "12 North Test Road",
    addressLine2: "Gate 4",
    city: "Toronto",
    region: "ON",
    postalCode: "M1M 1M1",
    countryCode: "CA",
    siteInstructions: "Call on arrival"
  };
  const lines = service.normalizeFrontdeskServiceLines({
    binTypeId: BIN_14,
    site,
    dumpItemCode: "SOIL",
    estimatedTonnes: "1.000",
    proposedDeliveryAt: "2037-08-03T12:00:00.000Z",
    proposedReturnAt: "2037-08-17T12:00:00.000Z",
    serviceLines: [{
      binItemCode: "14YD",
      binTypeId: BIN_14,
      dumpItemCode: "SOIL",
      estimatedTonnes: "1.000",
      proposedDeliveryAt: "2037-08-03T12:00:00.000Z",
      proposedReturnAt: "2037-08-17T12:00:00.000Z"
    }, {
      binItemCode: "20YD",
      binTypeId: BIN_20,
      dumpItemCode: "CONCRETE",
      estimatedTonnes: "2.000",
      proposedDeliveryAt: "2037-08-04T12:00:00.000Z",
      proposedReturnAt: "2037-08-18T12:00:00.000Z"
    }]
  });

  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((line) => line.site), [site, site]);
  assert.deepEqual(lines.map((line) => line.siteProfileId), [null, null]);
});

test("MBT Front Desk multi-bin: the additive persistence seam and accessible contract master/detail shell are declared", async () => {
  const [migration, siteMigration, page, script, service] = await Promise.all([
    readFile(migrationUrl, "utf8"),
    readFile(siteMigrationUrl, "utf8"),
    readFile(pageUrl, "utf8"),
    readFile(scriptUrl, "utf8"),
    readFile(serviceUrl, "utf8")
  ]);

  assert.match(migration, /CREATE TABLE IF NOT EXISTS mbt_contract_service_lines/i);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS service_line_id uuid/i);
  assert.match(migration, /mbt_contract_service_line_events/i);
  assert.match(migration, /customer_confirmation_status/i);
  const backfillStart = migration.indexOf("CREATE OR REPLACE FUNCTION mbt_reject_completed_visit_mutation()", migration.indexOf("legacy contract"));
  const visitBackfill = migration.indexOf("UPDATE mbt_service_visits visit", backfillStart);
  const strictRestore = migration.indexOf("CREATE OR REPLACE FUNCTION mbt_reject_completed_visit_mutation()", visitBackfill);
  assert.ok(backfillStart >= 0 && visitBackfill > backfillStart && strictRestore > visitBackfill);
  const scopedBackfill = migration.slice(backfillStart, strictRestore);
  const restoredGuard = migration.slice(strictRestore, migration.indexOf("CREATE TABLE IF NOT EXISTS mbt_contract_service_line_events"));
  assert.match(scopedBackfill, /OLD\.service_line_id IS NULL/i);
  assert.match(scopedBackfill, /NEW\.service_line_id IS NOT NULL/i);
  assert.match(scopedBackfill, /to_jsonb\(NEW\) - 'service_line_id'[\s\S]*to_jsonb\(OLD\) - 'service_line_id'/i);
  assert.match(restoredGuard, /IF OLD\.status = 'completed' THEN[\s\S]*RAISE EXCEPTION 'completed service visit % is immutable'/i);
  assert.doesNotMatch(migration, /DISABLE TRIGGER|session_replication_role/i);
  assert.match(siteMigration, /ALTER TABLE mbt_contract_service_lines[\s\S]*customer_site_profile_id/i);
  assert.match(siteMigration, /site_snapshot jsonb/i);
  assert.match(siteMigration, /ALTER TABLE mbt_contracts[\s\S]*customer_site_profile_id DROP NOT NULL/i);
  assert.match(siteMigration, /UPDATE mbt_contract_service_lines[\s\S]*mbt_contracts/i);
  assert.doesNotMatch(siteMigration, /DISABLE TRIGGER|session_replication_role/i);
  assert.match(
    page,
    /<input[\s\S]*?id="customerSearch"[\s\S]*?role="combobox"[\s\S]*?aria-autocomplete="list"[\s\S]*?aria-controls="customerResults"[\s\S]*?aria-expanded="false"/i
  );
  assert.match(page, /id="contractMaster"/i);
  assert.match(page, /id="contractDetail"/i);
  assert.match(page, /id="serviceLineActionDialog"/i);
  assert.match(page, /id="contractServiceSite"/i);
  assert.match(page, /data-contract-address-one/i);
  assert.match(page, /data-contract-postal-code/i);
  assert.match(script, /contractServiceSite/i);
  assert.doesNotMatch(service, /subsidiary_netsuite_id\s*=\s*33/i);
  assert.match(script, /Exchange bin/i);
  assert.match(script, /Collect bin/i);
  assert.match(script, /button\("Extend return", \(\) => openExtension\(\)\)/);
  assert.doesNotMatch(script, /button\("Extend return", openExtension\)/);
});
