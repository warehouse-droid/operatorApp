import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [router, localMaster, rateService, assetService, configHtml, configClient,
  assetsHtml, assetsClient, frontdeskHtml, frontdeskClient, frontdeskService, migration,
  multiItemMigration] = await Promise.all([
  readFile(new URL("../../../src/mbt/router.js", import.meta.url), "utf8"),
  readFile(new URL("../../../src/mbt/local-master-data-service.js", import.meta.url), "utf8"),
  readFile(new URL("../../../src/mbt/rate-card-configuration-service.js", import.meta.url), "utf8"),
  readFile(new URL("../../../src/mbt/asset-registry-service.js", import.meta.url), "utf8"),
  readFile(new URL("../../../public/mbt-config.html", import.meta.url), "utf8"),
  readFile(new URL("../../../public/mbt-shell.js", import.meta.url), "utf8"),
  readFile(new URL("../../../public/mbt-assets.html", import.meta.url), "utf8"),
  readFile(new URL("../../../public/mbt-assets.js", import.meta.url), "utf8"),
  readFile(new URL("../../../public/mbt-frontdesk.html", import.meta.url), "utf8"),
  readFile(new URL("../../../public/mbt-frontdesk.js", import.meta.url), "utf8"),
  readFile(new URL("../../../src/mbt/frontdesk-service.js", import.meta.url), "utf8"),
  readFile(new URL("../../../migrations/128_mbt_guarded_deletion_item_rate_cards_delivery_orders.sql", import.meta.url), "utf8"),
  readFile(new URL("../../../migrations/130_mbt_multi_item_quoted_distance_pricing.sql", import.meta.url), "utf8")
]);

test("configuration exposes reversible state and guarded delete commands", () => {
  for (const source of [configHtml, configClient]) {
    assert.match(source, /Inactive|Inactivate/u);
    assert.match(source, /Delete/u);
  }
  assert.match(localMaster, /export async function setLocalMasterDataActive/u);
  assert.match(localMaster, /export async function deleteLocalMasterDataEntity/u);
  assert.match(rateService, /export async function setLocalRateCardActive/u);
  assert.match(rateService, /export async function deleteLocalRateCard/u);
  assert.match(router, /config\/local\/items\/:itemCode\/state/u);
  assert.match(router, /config\/dump-sites\/:dumpSiteCode\/state/u);
  assert.match(router, /config\/rate-cards\/:versionId\/state/u);
});

test("asset registry exposes the same inactive and guarded delete actions", () => {
  assert.match(assetsHtml + assetsClient, /Inactive|Inactivate/u);
  assert.match(assetsHtml + assetsClient, /Delete/u);
  assert.match(assetService, /export async function deleteMbtBinAsset/u);
  assert.match(router, /assets\/:assetId["']/u);
  assert.match(router, /router\.delete\(\s*["']\/assets\/:assetId/u);
});

test("schema evolves legacy item-owned cards into child-row multi-item pricing", () => {
  assert.match(migration, /ALTER TABLE mbt_rate_cards[\s\S]*ADD COLUMN IF NOT EXISTS item_code text/u);
  assert.match(multiItemMigration, /DROP INDEX IF EXISTS idx_mbt_rate_cards_item_unique/u);
  assert.match(multiItemMigration, /UPDATE mbt_rate_cards[\s\S]*SET item_code = NULL/u);
  assert.match(migration, /mbt_local_item_settings/u);
  assert.match(rateService, /distanceBands/u);
  assert.match(rateService, /components/u);
  assert.match(rateService, /dumpTariffs/u);
});

test("distance pricing discovers every active Bin item instead of fixing three sizes", () => {
  assert.match(configClient, /localItemState\.items\.filter\(\(item\) => \(\s*item\.itemType === "bin"/u);
  assert.doesNotMatch(configClient, /for \(const code of \["14YD", "20YD", "40YD"\]\)/u);
});

test("a newly saved rate renders the mutation result without a fallible refresh", () => {
  const saveStart = configClient.indexOf("async function saveRateCardDraft");
  const saveEnd = configClient.indexOf("async function runRateCardLifecycle", saveStart);
  const saveSource = configClient.slice(saveStart, saveEnd);
  assert.ok(saveStart >= 0 && saveEnd > saveStart);
  assert.match(saveSource, /upsertRateCardVersion\(result\.version/u);
  assert.doesNotMatch(saveSource, /await\s+loadRateCards\(/u);
});

test("delete is server guarded and never relies on a browser-only confirmation", () => {
  assert.match(migration, /mbt\.delete_local_item/u);
  assert.match(migration, /mbt\.delete_bin_asset/u);
  assert.match(localMaster, /MBT_ENTITY_IN_USE/u);
  assert.match(rateService, /MBT_ENTITY_IN_USE/u);
  assert.match(assetService, /MBT_ENTITY_IN_USE/u);
});

test("Front Desk reveals only fields related to Delivery or BIN", () => {
  assert.match(frontdeskHtml, /id=["']orderKind["']/u);
  assert.match(frontdeskHtml, /value=["']delivery["'][^>]*>Delivery/u);
  assert.match(frontdeskHtml, /value=["']bin["'][^>]*>BIN/u);
  assert.match(frontdeskHtml, /id=["']deliveryOrderFields["']/u);
  assert.match(frontdeskHtml, /id=["']binOrderFields["']/u);
  assert.match(frontdeskClient, /function syncOrderKindFields/u);
  assert.match(frontdeskClient, /configuration\.deliveryItems/u);
  assert.match(frontdeskClient, /configuration\.binItems/u);
  assert.match(frontdeskService, /item_type = 'delivery_fee'/u);
  assert.match(frontdeskService, /item_type = 'bin'/u);
  assert.match(router, /frontdesk\/delivery-orders/u);
});

test("Front Desk makes the 150-yard price choice explicit and durable", () => {
  assert.match(frontdeskHtml, /id=["']orderFrom150["']/u);
  assert.match(frontdeskHtml, /Order from 150/u);
  assert.match(frontdeskHtml, /3445\s*\/\s*2967/u);
  assert.match(frontdeskClient, /pricingOriginYardCode:\s*orderFrom150\.checked\s*\?\s*["']150["']\s*:\s*["']3445["']/u);
  assert.match(router, /pricingOriginYardCode:\s*body\.pricingOriginYardCode/u);
  assert.match(frontdeskService, /pricingOriginYardCode/u);
  assert.match(frontdeskService, /\["3445",\s*"150"\]/u);
  assert.match(frontdeskService, /originYardCode:\s*pricingOriginYardCode/u);
  assert.match(frontdeskService, /pricingOriginYardCode,?\s*$/mu);
  assert.match(configClient, /Standard price[^\n]*3445\s*\/\s*2967/u);
  assert.match(configClient, /150 price/u);
  assert.match(configClient, /originYardCodes[^\n]*join/u);
});
