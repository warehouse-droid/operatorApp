import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [html, client] = await Promise.all([
  readFile(new URL("../../../public/mbt-config.html", import.meta.url), "utf8"),
  readFile(new URL("../../../public/mbt-shell.js", import.meta.url), "utf8")
]);

test("P3-F12 CSV browser: five-file preview has optional context/apply controls and starts locked", () => {
  for (const id of [
    "rateCardHeaderCsv", "rateCardBandsCsv", "rateCardComponentsCsv",
    "rateCardTariffsCsv", "rateCardDepositsCsv"
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`, "u"));
  }
  assert.match(html, /id=["']previewRateCardCsvButton["']/u);
  assert.match(html, /id=["']applyRateCardCsvButton["'][^>]*disabled/u);
  assert.match(html, /id=["']rateCardCsvReason["']/u);
  assert.doesNotMatch(html, /id=["']rateCardCsvReason["'][^>]*required/u);
  assert.match(html, /Apply five-file draft/i);
});

test("P3-F12 CSV browser: preview reads all file content and renders server-normalized evidence", () => {
  assert.match(client, /async function previewRateCardCsv\s*\(/u);
  assert.match(client, /\.text\s*\(\s*\)/u);
  assert.match(client, /\/api\/mbt\/config\/rate-card-imports\/preview/u);
  assert.match(client, /rateCardState\.csvPreview\s*=\s*result/u);
  assert.match(client, /rateCardCsvPreview[\s\S]{0,500}(?:normalizedHash|rowsByFile|result)/u);
  assert.match(client, /applyRateCardCsvButton[\s\S]{0,160}disabled\s*=\s*false/u);
});

test("P3-F12 CSV browser: apply sends only preview identities, refreshes lifecycle, and can recover", () => {
  assert.match(client, /async function applyRateCardCsv\s*\(/u);
  assert.match(client, /\/api\/mbt\/config\/rate-card-imports\/apply/u);
  for (const identity of ["batchId", "normalizedHash", "targetRevisionToken"]) {
    assert.match(client, new RegExp(`rateCardState\\.csvPreview[\\s\\S]{0,500}${identity}`, "u"));
  }
  assert.match(client, /commandIdentity\s*\(["']mbt-rate-card-csv-apply["']\)/u);
  assert.match(client, /updateRateLifecycle\s*\(/u);
  assert.match(client, /await loadRateCards\s*\(\s*\)/u);
  assert.match(client, /applyRateCardCsvButton[\s\S]{0,260}disabled\s*=\s*true/u);
  assert.match(client, /addEventListener\s*\(["']click["']\s*,\s*applyRateCardCsv/u);
});
