// @ts-check

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [html, client, service, repository, migration] = await Promise.all([
  readFile(new URL("../../../public/mbt-config.html", import.meta.url), "utf8"),
  readFile(new URL("../../../public/mbt-shell.js", import.meta.url), "utf8"),
  readFile(new URL("../../../src/mbt/local-master-data-service.js", import.meta.url), "utf8"),
  readFile(new URL("../../../src/mbt/local-item-settings-repository.js", import.meta.url), "utf8"),
  readFile(
    new URL("../../../migrations/127_mbt_custom_bin_items_and_free_asset_addresses.sql", import.meta.url),
    "utf8"
  ).catch(() => "")
]);

test("a new Bin item asks for capacity instead of selecting a closed Bin-size catalog", () => {
  const panel = html.match(/id="localItemSettingsPanel"([\s\S]*?)id="materialsDumpSitesPanel"/u)?.[1] || "";
  assert.match(panel, /id=["']customLocalItemBinCapacityYards["']/u);
  assert.match(panel, /Capacity \(cubic yards\)/u);
  assert.doesNotMatch(panel, /id=["']customLocalItemBinType["']/u);
  assert.doesNotMatch(panel, />Bin size</u);
  assert.match(client, /binCapacityYards:\s*itemType\s*===\s*["']bin["']/u);
  assert.doesNotMatch(client, /customLocalItemBinType/u);
});

test("the server creates and returns an operational Bin-type binding for a custom item", () => {
  assert.match(service, /binCapacityYards/u);
  assert.match(service, /INSERT INTO mbt_bin_types/u);
  assert.match(service, /local_item_code/u);
  assert.match(repository, /bin_capacity_yards/u);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS local_item_code text/u);
  assert.match(migration, /DEFERRABLE INITIALLY DEFERRED/u);
  assert.match(migration, /nominal_yards/u);
});
