import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [html, client, frontdesk, migration] = await Promise.all([
  readFile(new URL("../../../public/mbt-config.html", import.meta.url), "utf8"),
  readFile(new URL("../../../public/mbt-shell.js", import.meta.url), "utf8"),
  readFile(new URL("../../../public/mbt-frontdesk.js", import.meta.url), "utf8"),
  readFile(new URL("../../../migrations/126_mbt_item_owned_pricing.sql", import.meta.url), "utf8")
]);

test("configuration exposes dump items, not a second material catalog", () => {
  assert.match(html, />Dump Sites</u);
  assert.match(html, /id=["']dumpSiteItemAcceptances["']/u);
  assert.match(html, /data-dump-acceptance-items/u);
  assert.match(html, /Accepted dump items/u);
  assert.doesNotMatch(html, /id=["']materialForm["']/u);
  assert.doesNotMatch(html, /id=["']newMaterialButton["']/u);
  assert.doesNotMatch(html, />Materials</u);
  assert.match(client, /function\s+renderDumpSiteAcceptanceOptions\s*\(/u);
  assert.match(client, /dataset\.dumpAcceptanceItem/u);
  assert.match(client, /itemType\s*===\s*["']dump["']/u);
});

test("rate-card editor selects an item and shows only its charging mechanism", () => {
  assert.match(html, /id=["']ratePricingItem["']/u);
  assert.match(html, /id=["']rateItemEditor["']/u);
  assert.match(client, /function\s+renderRateItemEditor\s*\(/u);
  assert.match(client, /function\s+activateRatePricingItem\s*\(/u);
  for (const itemType of ["bin", "surcharge", "dump", "delivery_fee"]) {
    assert.match(client, new RegExp(`case ["']${itemType}["']`, "u"));
  }
  assert.match(client, /itemCode/u);
  assert.match(client, /rentalPeriodDays/u);
});

test("loading a saved rate graph cannot overwrite hydrated item pricing with the old editor", () => {
  assert.match(
    client,
    /function\s+populateSimplifiedRateEditor\s*\([\s\S]*?activateRatePricingItem\(firstConfigured,\s*\{\s*captureCurrent:\s*false\s*\}\)/u
  );
  assert.match(
    client,
    /function\s+newRateCardEditor\s*\([\s\S]*?activateRatePricingItem\([\s\S]*?captureCurrent:\s*false/u
  );
});

test("item-owned schema keeps legacy material links only as compatibility projections", () => {
  assert.match(migration, /CREATE TABLE mbt_dump_site_items/u);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS item_code text/u);
  assert.match(migration, /mbt_dump_site_materials/u);
  assert.match(migration, /mbt_materials/u);
  assert.match(migration, /item_type = 'dump'/u);
});

test("item-owned pricing migration never rewrites children of used rate versions", () => {
  const immutableGuards = migration.match(/version\.first_used_at IS NOT NULL/gu) || [];
  assert.equal(immutableGuards.length, 3);
  assert.match(migration, /mbt_rate_distance_bands\.rate_card_version_id/u);
  assert.match(migration, /component\.rate_card_version_id/u);
  assert.match(migration, /tariff\.rate_card_version_id/u);
});

test("touching a customer result invalidates delayed searches before selection", () => {
  assert.match(frontdesk, /pointerdown[\s\S]{0,700}clearTimeout\(searchTimer\)/u);
  assert.match(frontdesk, /pointerdown[\s\S]{0,700}searchSequence\s*\+=\s*1/u);
});
