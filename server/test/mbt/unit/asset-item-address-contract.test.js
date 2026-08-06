// @ts-check

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [html, client, registry, ledger, migration] = await Promise.all([
  readFile(new URL("../../../public/mbt-assets.html", import.meta.url), "utf8"),
  readFile(new URL("../../../public/mbt-assets.js", import.meta.url), "utf8"),
  readFile(new URL("../../../src/mbt/asset-registry-service.js", import.meta.url), "utf8"),
  readFile(new URL("../../../src/mbt/asset-service.js", import.meta.url), "utf8"),
  readFile(new URL("../../../migrations/125_mbt_item_bound_assets_and_addresses.sql", import.meta.url), "utf8")
]);

test("asset registry exposes only item-bound identity and materialized current address", () => {
  assert.match(html, /id=["']assetItemCode["']/u);
  assert.match(html, /id=["']assetCurrentLocationId["']/u);
  assert.match(html, /id=["']assetCurrentAddress["']/u);
  assert.match(html, /Current address/u);
  for (const removedId of [
    "assetQrCode", "assetBarcode", "assetHomeYardId",
    "assetTareWeight", "assetOperationalNotes"
  ]) {
    assert.doesNotMatch(html, new RegExp(`id=["']${removedId}["']`, "u"));
  }
  assert.match(client, /binItems/u);
  assert.match(client, /currentLocations/u);
  assert.match(client, /manualAddress/u);
  assert.match(client, /kind:\s*["']customer_site["']/u);
  assert.match(client, /lifecycleStatus:\s*manualAddress\s*\?\s*["']at_customer["']/u);
  assert.match(client, /itemCode:\s*String\(data\.get\(["']itemCode["']/u);
  assert.doesNotMatch(client, /data\.get\(["'](?:qrCode|barcode|homeYardId|tareWeightKg|operationalNotes)["']\)/u);
});

test("manual asset creation keeps the known-address dropdown and accepts a free customer-site address", () => {
  assert.match(html, /<select[^>]+id=["']assetCurrentLocationId["']/u);
  assert.match(html, /<input[^>]+id=["']assetCurrentAddress["']/u);
  assert.match(client, /customerSiteProfileId:\s*null/u);
  assert.doesNotMatch(html, /id=["']assetReason["']/u);
});

test("asset writes bind a Bin item and atomically materialize movement addresses", () => {
  assert.match(migration, /ADD COLUMN IF NOT EXISTS item_code text/u);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS current_address text/u);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS before_address text/u);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS after_address text/u);
  assert.match(registry, /item_type\s*=\s*'bin'/u);
  assert.match(registry, /current_address/u);
  assert.match(registry, /after_address/u);
  assert.match(ledger, /resolveMbtAssetLocationAddress/u);
  assert.match(ledger, /before_address/u);
  assert.match(ledger, /after_address/u);
  assert.match(ledger, /current_address/u);
});

test("the live asset-state backfill installs its check before deferred trigger events exist", () => {
  const constraintPosition = migration.indexOf(
    "DROP CONSTRAINT IF EXISTS mbt_bin_asset_state_current_address_not_blank"
  );
  const backfillPosition = migration.indexOf("UPDATE mbt_bin_asset_state state");
  assert.notEqual(constraintPosition, -1);
  assert.notEqual(backfillPosition, -1);
  assert.ok(
    constraintPosition < backfillPosition,
    "ALTER TABLE must precede the state UPDATE that queues deferred invariant triggers"
  );
});
