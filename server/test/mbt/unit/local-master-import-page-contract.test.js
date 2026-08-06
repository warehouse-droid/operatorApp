import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [html, client] = await Promise.all([
  readFile(new URL("../../../public/mbt-config.html", import.meta.url), "utf8"),
  readFile(new URL("../../../public/mbt-shell.js", import.meta.url), "utf8")
]);

test("P3-F09 browser: custom local items have a complete manual command editor", () => {
  for (const required of [
    /id=["']customLocalItemForm["']/i,
    /id=["']customLocalItemCode["']/i,
    /id=["']customLocalItemType["']/i,
    /value=["']bin["']/i,
    /value=["']surcharge["']/i,
    /value=["']dump["']/i,
    /value=["']delivery_fee["']/i,
    /id=["']customLocalItemBinCapacityYards["']/i,
    /id=["']customLocalItemRentalDays["']/i,
    /Create custom item/i
  ]) {
    assert.match(html, required);
  }
  assert.match(client, /\/api\/mbt\/config\/local\/items/);
  assert.match(client, /sourceKind|itemType|rentalPeriodDays|binCapacityYards/);
});

test("P3-F09 browser: local items and dump sites expose real preview/apply CSV controls", () => {
  assert.match(html, /data-import-resource=["']local_items["']/i);
  assert.match(html, /id=["']localMasterImportResource["'][^>]+value=["']dump_sites["']/i);
  for (const resource of ["local-items", "dump-sites"]) {
    assert.match(html, new RegExp(`/api/mbt/config/imports/${resource}/template`, "i"));
  }
  assert.doesNotMatch(html, /data-import-resource=["']materials["']/i);
  assert.doesNotMatch(html, /\/api\/mbt\/config\/imports\/materials\/template/i);
  for (const id of [
    "localItemImportFile", "previewLocalItemImportButton", "applyLocalItemImportButton",
    "localMasterImportResource", "localMasterImportFile", "previewLocalMasterImportButton",
    "applyLocalMasterImportButton"
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`, "i"), id);
  }
  assert.match(client, /\/api\/mbt\/config\/imports\/\$\{[^}]+\}\/preview/);
  assert.match(client, /normalizedHash/);
  assert.match(client, /targetRevisionToken/);
  assert.match(client, /idempotencyKey/);
  assert.match(client, /arrayBuffer\s*\(/);
  assert.doesNotMatch(client, /FileReader\s*\(/);
});
