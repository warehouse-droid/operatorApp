import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [html, client, dispatchSource] = await Promise.all([
  readFile(new URL("../../../public/mbt-config.html", import.meta.url), "utf8"),
  readFile(new URL("../../../public/mbt-shell.js", import.meta.url), "utf8"),
  readFile(new URL("../../../src/dispatch-setup-repository.js", import.meta.url), "utf8")
]);

test("P3-F06/P3-F07 config UI exposes NetSuite sync plus bounded CSV/SpreadsheetML preview and apply", () => {
  assert.match(html, /Customer Sync\s*&\s*Import/i);
  assert.match(html, /Sync from NetSuite/i);
  assert.match(html, /Upload NetSuite export/i);
  assert.match(html, /accept=["'][^"']*(\.csv|text\/csv)[^"']*(\.xls|application\/vnd\.ms-excel)/i);
  assert.match(html, /preview/i);
  assert.match(html, /provenance|source freshness/i);
  assert.match(client, /\/api\/mbt\/customers\/sync/);
  assert.match(client, /\/api\/mbt\/config\/imports\/customers\/preview/);
  assert.match(client, /\/api\/mbt\/config\/imports\/customers\//);
  assert.match(client, /FormData|arrayBuffer\s*\(/);
  assert.match(client, /cache:\s*["']no-store["']/);
  assert.doesNotMatch(client, /FileReader[\s\S]{0,120}readAsDataURL/);
});

test("P3-F09/P3-F10 config UI has one local setup surface without duplicate yard or truck masters", () => {
  for (const label of [
    /Local Items/i,
    /Dump Sites/i,
    /Rate Cards/i
  ]) {
    assert.match(html, label);
  }
  assert.doesNotMatch(html, /Service Templates/i);
  assert.doesNotMatch(html, /id=["']serviceTemplates(?:Tab|Panel)["']/u);
  assert.doesNotMatch(html, /id=["']materialForm["']/u);
  assert.match(client, /\/api\/mbt\/config\/dump-sites/);
  assert.doesNotMatch(client, /\/api\/mbt\/config\/service-templates/);
  assert.match(client, /\/api\/mbt\/config\/rate-cards/);
  assert.doesNotMatch(html, /Import Yards|MBT Trucks|Register Truck/i);
});

test("P3-F10 established Dispatch setup projection carries typed shared truck capabilities", () => {
  assert.match(dispatchSource, /truckType/);
  assert.match(dispatchSource, /binSlotCapacity/);
  assert.match(dispatchSource, /supportedBinTypeCodes/);
  assert.match(dispatchSource, /listDispatchOwnYards/);
});
