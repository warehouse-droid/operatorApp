// @ts-check

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const shell = await readFile(new URL("../../../public/mbt-shell.js", import.meta.url), "utf8");

/** @param {string} start @param {string} next */
function functionSource(start, next) {
  const beginning = shell.indexOf(`${start}(`);
  const ending = shell.indexOf(`\n${next}(`, beginning);
  assert.ok(beginning >= 0 && ending > beginning, `${start} source block must be present.`);
  return shell.slice(beginning, ending);
}

test("P3-F12 CSV UI hardening: each preview unlocks only its own apply control", () => {
  const customer = functionSource("async function previewCustomerImport", "async function applyCustomerImport");
  assert.match(customer, /applyCustomerImportButton[\s\S]*applyButton\.disabled\s*=\s*false/u);
  assert.doesNotMatch(customer, /applyRateCardCsvButton/u);

  const local = functionSource("async function previewLocalImport", "async function applyLocalImport");
  assert.match(local, /controls\.applyId[\s\S]*applyButton\.disabled\s*=\s*false/u);
  assert.doesNotMatch(local, /applyRateCardCsvButton/u);

  const rate = functionSource("async function previewRateCardCsv", "async function applyRateCardCsv");
  assert.match(rate, /applyRateCardCsvButton[\s\S]*disabled\s*=\s*false/u);
  assert.doesNotMatch(rate, /applyCustomerImportButton|controls\.applyId/u);
});
