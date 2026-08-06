// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

import { assetCsvRows, buildAssetCsvFile } from "../support/asset-csv-import-fixtures.js";

const ADAPTER_PATH = "../../../src/mbt/" + "asset-csv-import.js";
const adapter = /** @type {Record<string, Function>} */ (await import(ADAPTER_PATH).catch(() => ({})));

/** @param {string} name */
function requiredOperation(name) {
  const operation = adapter[name];
  assert.equal(typeof operation, "function", `P3.5a requires asset-csv-import.${name}.`);
  return operation;
}

function generator(seed) {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(value, 1_664_525) + 1_013_904_223) >>> 0;
    return value;
  };
}

test("P3-F11 CSV property: 1,000 safe tare values and quoted notes convert exactly", async () => {
  const parseMbtBinAssetCsv = requiredOperation("parseMbtBinAssetCsv");
  const next = generator(0x35a5c001);
  for (let index = 0; index < 1_000; index += 1) {
    const whole = next() % 999_999_999;
    const fraction = next() % 1_000;
    const tare = `${whole}.${String(fraction).padStart(3, "0")}`;
    const note = `Generated ${index}, \"quoted\"\nline ${next()}`;
    const rows = [assetCsvRows(`PROP_${index}`)[0]];
    rows[0].tare_weight_kg = tare;
    rows[0].operational_notes = note;
    const parsed = await parseMbtBinAssetCsv(buildAssetCsvFile({ rows }).content);
    assert.equal(parsed.rows[0].tareWeightKg, tare);
    assert.equal(parsed.rows[0].operationalNotes, note);
  }
});

test("P3-F11 CSV property: 1,000 repeated parses retain one canonical identity", async () => {
  const parseMbtBinAssetCsv = requiredOperation("parseMbtBinAssetCsv");
  const next = generator(0x35a5c002);
  for (let index = 0; index < 1_000; index += 1) {
    const rows = assetCsvRows(`DETERMINISTIC_${next()}`);
    const file = buildAssetCsvFile({ rows });
    const first = await parseMbtBinAssetCsv(file.content, { fileName: file.fileName });
    const second = await parseMbtBinAssetCsv(Buffer.from(file.content, "utf8"), {
      fileName: file.fileName
    });
    assert.equal(second.fileHash, first.fileHash);
    assert.equal(second.normalizedHash, first.normalizedHash);
    assert.deepEqual(second.rows, first.rows);
  }
});
