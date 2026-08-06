// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRateCardCsvFiles,
  expectedRateCardGraph,
  RATE_CARD_CSV_HEADERS,
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

/** @param {string} content @param {string} header @param {string} replacement */
function replaceHeader(content, header, replacement) {
  return content.replace(header, replacement);
}

test("P3-F12 CSV: all five exact files aggregate into the canonical typed graph", async () => {
  const parseRateCardCsvBundle = requiredOperation("parseRateCardCsvBundle");
  const parsed = await parseRateCardCsvBundle(buildRateCardCsvFiles({ suffix: "UNIT" }));
  assert.equal(parsed.schemaVersion, "mbt-rate-card-csv-v1");
  assert.deepEqual(parsed.graph, expectedRateCardGraph("UNIT"));
  assert.match(parsed.fileHash, /^[0-9a-f]{64}$/);
  assert.match(parsed.normalizedHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(parsed.summary, {
    fileCount: 5,
    totalRows: 7,
    rowsByFile: {
      rate_cards: 1,
      distance_bands: 2,
      components: 2,
      dump_tariffs: 1,
      deposit_rules: 1
    }
  });
  assert.equal(JSON.stringify(parsed).includes("rawFiles"), false);
});

test("P3-F12 CSV: missing, extra, misnamed, malformed, or unbounded bundles fail closed", async () => {
  const parseRateCardCsvBundle = requiredOperation("parseRateCardCsvBundle");
  const scenarios = [
    {
      label: "missing file",
      mutate(files) { delete files.deposit_rules; },
      code: "MBT_RATE_CSV_FILES_REQUIRED"
    },
    {
      label: "extra file",
      mutate(files) { files.other = { fileName: "other.csv", content: "x\r\n" }; },
      code: "MBT_RATE_CSV_FILES_REQUIRED"
    },
    {
      label: "wrong filename",
      mutate(files) { files.components.fileName = "fees.csv"; },
      code: "MBT_RATE_CSV_FILENAME_INVALID"
    },
    {
      label: "unknown header",
      mutate(files) {
        files.components.content = replaceHeader(
          files.components.content,
          RATE_CARD_CSV_HEADERS.components[0],
          "unexpected"
        );
      },
      code: "MBT_IMPORT_UNKNOWN_HEADER"
    },
    {
      label: "duplicate header",
      mutate(files) {
        files.components.content = replaceHeader(
          files.components.content,
          RATE_CARD_CSV_HEADERS.components[1],
          RATE_CARD_CSV_HEADERS.components[0]
        );
      },
      code: "MBT_IMPORT_DUPLICATE_HEADER"
    },
    {
      label: "malformed quote",
      mutate(files) { files.components.content += "\r\n\"unclosed"; },
      code: "MBT_IMPORT_CSV_MALFORMED"
    },
    {
      label: "per-file byte limit",
      mutate(files) { files.components.content += "x".repeat(300); },
      code: "MBT_IMPORT_FILE_TOO_LARGE",
      options: { limits: { maxBytesPerFile: 256, maxTotalBytes: 2_000 } }
    },
    {
      label: "aggregate byte limit",
      mutate() {},
      code: "MBT_RATE_CSV_TOTAL_TOO_LARGE",
      options: { limits: { maxBytesPerFile: 2_000, maxTotalBytes: 256 } }
    }
  ];
  for (const scenario of scenarios) {
    const files = structuredClone(buildRateCardCsvFiles({ suffix: "BAD" }));
    scenario.mutate(files);
    await assert.rejects(
      () => parseRateCardCsvBundle(files, scenario.options),
      (error) => error?.status === 400 && error?.code === scenario.code,
      scenario.label
    );
  }
});

test("P3-F12 CSV: row counts and exact scalar types fail before a preview can persist", async () => {
  const parseRateCardCsvBundle = requiredOperation("parseRateCardCsvBundle");
  const scenarios = [
    {
      label: "header row missing",
      mutate(rows) { rows.rate_cards = []; },
      code: "MBT_RATE_CSV_ROW_COUNT_INVALID"
    },
    {
      label: "two headers",
      mutate(rows) { rows.rate_cards.push({ ...rows.rate_cards[0], rate_card_code: "SECOND" }); },
      code: "MBT_RATE_CSV_ROW_COUNT_INVALID"
    },
    {
      label: "no bands",
      mutate(rows) { rows.distance_bands = []; },
      code: "MBT_RATE_CSV_ROW_COUNT_INVALID"
    },
    {
      label: "boolean",
      mutate(rows) { rows.rate_cards[0].active = "yes"; },
      code: "MBT_RATE_CSV_ROW_INVALID"
    },
    {
      label: "unsafe cents",
      mutate(rows) { rows.distance_bands[0].amount_minor = "9007199254740992"; },
      code: "MBT_RATE_CSV_ROW_INVALID"
    },
    {
      label: "fractional metres",
      mutate(rows) { rows.distance_bands[0].minimum_metres = "1.5"; },
      code: "MBT_RATE_CSV_ROW_INVALID"
    },
    {
      label: "bad decimal",
      mutate(rows) { rows.components[0].default_quantity = "NaN"; },
      code: "MBT_RATE_CSV_ROW_INVALID"
    },
    {
      label: "bad date",
      mutate(rows) { rows.rate_cards[0].effective_from = "not-a-date"; },
      code: "MBT_RATE_CSV_ROW_INVALID"
    },
    {
      label: "not CAD",
      mutate(rows) { rows.rate_cards[0].currency = "USD"; },
      code: "MBT_RATE_CARD_CURRENCY_INVALID"
    },
    {
      label: "graph gap",
      mutate(rows) { rows.distance_bands[1].maximum_metres = "9999"; },
      code: "MBT_RATE_CARD_INVALID"
    }
  ];
  for (const scenario of scenarios) {
    const rows = rateCardCsvRows("TYPE");
    scenario.mutate(rows);
    await assert.rejects(
      () => parseRateCardCsvBundle(buildRateCardCsvFiles({ rows })),
      (error) => error?.status === 400 && error?.code === scenario.code,
      scenario.label
    );
  }
});
