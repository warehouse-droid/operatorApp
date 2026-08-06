// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

import { parseRateCardCsvBundle } from "../../../src/mbt/rate-card-csv-import.js";
import {
  buildRateCardCsvFiles,
  rateCardCsvRows
} from "../support/rate-card-csv-import-fixtures.js";

/** @param {() => Promise<unknown>} operation @param {string} code */
async function rejectsCode(operation, code) {
  await assert.rejects(
    operation,
    (error) => error?.status === 400 && error?.code === code,
    code
  );
}

test("P3-F12 CSV hardening: binary inputs and independently defaulted downward limits stay canonical", async () => {
  const binaryFiles = /** @type {Record<string, any>} */ (buildRateCardCsvFiles({ suffix: "BINARY" }));
  binaryFiles.rate_cards.content = Buffer.from(binaryFiles.rate_cards.content, "utf8");
  binaryFiles.distance_bands.content = new Uint8Array(Buffer.from(binaryFiles.distance_bands.content, "utf8"));
  const binary = await parseRateCardCsvBundle(binaryFiles, {
    limits: { maxBytesPerFile: 8_000 }
  });
  assert.equal(binary.graph.rateCard.rateCardCode, "P36CSV_BINARY");

  const totalOnly = await parseRateCardCsvBundle(buildRateCardCsvFiles({ suffix: "TOTALONLY" }), {
    limits: { maxTotalBytes: 12_000 }
  });
  assert.equal(totalOnly.summary.fileCount, 5);

  const nullableRows = /** @type {Record<string, any[]>} */ (rateCardCsvRows("NULLABLE"));
  nullableRows.distance_bands.forEach((row) => { row.bin_type_code = ""; });
  nullableRows.dump_tariffs.push({
    ...nullableRows.dump_tariffs[0],
    dump_site_code: "P36DUMP_SECOND",
    material_code: "",
    tariff_code: "second_tariff"
  });
  const nullable = await parseRateCardCsvBundle(buildRateCardCsvFiles({ rows: nullableRows }));
  assert.equal(nullable.graph.distanceBands[0].binTypeCode, null);
  assert.equal(nullable.graph.dumpTariffs.length, 2);
});

test("P3-F12 CSV hardening: malformed envelopes and unsafe limit overrides fail before parsing", async () => {
  const scenarios = [
    {
      code: "MBT_RATE_CSV_FILES_REQUIRED",
      operation: () => parseRateCardCsvBundle(null)
    },
    {
      code: "MBT_RATE_CSV_FILES_REQUIRED",
      operation: () => parseRateCardCsvBundle([])
    },
    {
      code: "MBT_IMPORT_LIMIT_INVALID",
      operation: () => parseRateCardCsvBundle(buildRateCardCsvFiles(), { limits: null })
    },
    {
      code: "MBT_IMPORT_LIMIT_INVALID",
      operation: () => parseRateCardCsvBundle(buildRateCardCsvFiles(), { limits: { extra: 1 } })
    },
    {
      code: "MBT_IMPORT_LIMIT_INVALID",
      operation: () => parseRateCardCsvBundle(buildRateCardCsvFiles(), {
        limits: { maxBytesPerFile: 0 }
      })
    },
    {
      code: "MBT_IMPORT_LIMIT_INVALID",
      operation: () => parseRateCardCsvBundle(buildRateCardCsvFiles(), {
        limits: { maxBytesPerFile: 1.5 }
      })
    },
    {
      code: "MBT_IMPORT_LIMIT_INVALID",
      operation: () => parseRateCardCsvBundle(buildRateCardCsvFiles(), {
        limits: { maxTotalBytes: 15 * 1024 * 1024 + 1 }
      })
    }
  ];
  for (const scenario of scenarios) {
    await rejectsCode(scenario.operation, scenario.code);
  }

  for (const mutate of [
    (files) => { files.components = null; },
    (files) => { files.components.extra = true; },
    (files) => { files.components.content = null; }
  ]) {
    const files = /** @type {Record<string, any>} */ (buildRateCardCsvFiles({ suffix: "ENVELOPE" }));
    mutate(files);
    await rejectsCode(
      () => parseRateCardCsvBundle(files),
      "MBT_RATE_CSV_CONTENT_REQUIRED"
    );
  }

  const blankName = /** @type {Record<string, any>} */ (buildRateCardCsvFiles({ suffix: "NAME" }));
  blankName.components.fileName = "";
  await rejectsCode(
    () => parseRateCardCsvBundle(blankName),
    "MBT_RATE_CSV_FILENAME_INVALID"
  );
});

test("P3-F12 CSV hardening: blank, minimum, lexical, and finite scalar branches fail exactly", async () => {
  const scenarios = [
    { mutate: (rows) => { rows.rate_cards[0].display_name = ""; } },
    { mutate: (rows) => { rows.rate_cards[0].version_number = "0"; } },
    { mutate: (rows) => { rows.rate_cards[0].version_number = "01"; } },
    { mutate: (rows) => { rows.rate_cards[0].effective_from = ""; } },
    { mutate: (rows) => { rows.rate_cards[0].customer_netsuite_id = "0"; } },
    { mutate: (rows) => { rows.components[0].default_quantity = "0"; } },
    { mutate: (rows) => { rows.components[0].default_quantity = "9".repeat(400); } }
  ];
  for (const [index, scenario] of scenarios.entries()) {
    const rows = /** @type {Record<string, any[]>} */ (rateCardCsvRows(`SCALAR${index}`));
    scenario.mutate(rows);
    await rejectsCode(
      () => parseRateCardCsvBundle(buildRateCardCsvFiles({ rows })),
      "MBT_RATE_CSV_ROW_INVALID"
    );
  }
});
