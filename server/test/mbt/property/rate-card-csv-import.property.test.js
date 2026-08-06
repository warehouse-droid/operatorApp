// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRateCardCsvFiles,
  rateCardCsvRows
} from "../support/rate-card-csv-import-fixtures.js";

const ADAPTER_PATH = "../../../src/mbt/" + "rate-card-csv-import.js";
const adapter = /** @type {Record<string, Function>} */ (await import(ADAPTER_PATH).catch(() => ({})));

/** @param {string} name */
function requiredOperation(name) {
  const operation = adapter[name];
  assert.equal(typeof operation, "function", `P3.6a requires rate-card-csv-import.${name}.`);
  return operation;
}

function generator(seed) {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(value, 1_664_525) + 1_013_904_223) >>> 0;
    return value;
  };
}

test("P3-F12 CSV property: 1,000 generated safe cents/metres survive exact server conversion", async () => {
  const parseRateCardCsvBundle = requiredOperation("parseRateCardCsvBundle");
  const next = generator(0x36a5c001);
  for (let index = 0; index < 1_000; index += 1) {
    const boundary = (next() % 1_000_000) + 1;
    const localAmount = next() % 10_000_000;
    const extendedAmount = next() % 10_000_000;
    const rows = rateCardCsvRows(`PROP${index}`);
    rows.distance_bands[0].minimum_metres = String(boundary);
    rows.distance_bands[0].amount_minor = String(extendedAmount);
    rows.distance_bands[1].maximum_metres = String(boundary);
    rows.distance_bands[1].amount_minor = String(localAmount);
    const parsed = await parseRateCardCsvBundle(buildRateCardCsvFiles({ rows }));
    assert.equal(parsed.graph.distanceBands[0].minimumMetres, 0);
    assert.equal(parsed.graph.distanceBands[0].maximumMetres, boundary);
    assert.equal(parsed.graph.distanceBands[0].amountMinor, localAmount);
    assert.equal(parsed.graph.distanceBands[1].minimumMetres, boundary);
    assert.equal(parsed.graph.distanceBands[1].maximumMetres, null);
    assert.equal(parsed.graph.distanceBands[1].amountMinor, extendedAmount);
  }
});

test("P3-F12 CSV property: 1,000 file/child permutations retain one normalized graph identity", async () => {
  const parseRateCardCsvBundle = requiredOperation("parseRateCardCsvBundle");
  const baselineRows = rateCardCsvRows("ORDER");
  const baseline = await parseRateCardCsvBundle(buildRateCardCsvFiles({ rows: baselineRows }));
  const next = generator(0x36a5c002);
  for (let index = 0; index < 1_000; index += 1) {
    const rows = structuredClone(baselineRows);
    if (next() % 2) {
      rows.distance_bands.reverse();
    }
    if (next() % 2) {
      rows.components.reverse();
    }
    const entries = Object.entries(buildRateCardCsvFiles({ rows }));
    if (next() % 2) {
      entries.reverse();
    } else {
      entries.sort(() => (next() % 3) - 1);
    }
    const parsed = await parseRateCardCsvBundle(Object.fromEntries(entries));
    assert.equal(parsed.normalizedHash, baseline.normalizedHash);
    assert.deepEqual(parsed.graph, baseline.graph);
  }
});
