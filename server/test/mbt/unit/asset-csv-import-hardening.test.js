// @ts-check

import assert from "node:assert/strict";
import test from "node:test";
import { TextEncoder } from "node:util";

import {
  assetCsvRows,
  buildAssetCsvFile
} from "../support/asset-csv-import-fixtures.js";
import { parseMbtBinAssetCsv } from "../../../src/mbt/asset-csv-import.js";

/** @param {string} label @param {Record<string, unknown>} rowChanges */
async function rejectsRow(label, rowChanges) {
  const rows = assetCsvRows(`HARD_${label}`);
  Object.assign(rows[0], rowChanges);
  await assert.rejects(
    () => parseMbtBinAssetCsv(buildAssetCsvFile({ rows }).content),
    (error) => error?.status === 400 && error?.code === "MBT_ASSET_CSV_ROW_INVALID",
    label
  );
}

test("P3-F11 CSV hardening: missing values and incompatible opening states fail with row evidence", async () => {
  await rejectsRow("missing_asset", { asset_code: "" });
  await rejectsRow("incompatible_state", {
    initial_lifecycle_status: "available",
    initial_location_kind: "unknown",
    initial_location_identity: ""
  });
  await rejectsRow("unknown_with_identity", {
    initial_lifecycle_status: "lost",
    initial_location_kind: "unknown",
    initial_location_identity: "somewhere"
  });
});

test("P3-F11 CSV hardening: byte forms, stream rejection, and source filenames remain exact", async () => {
  const file = buildAssetCsvFile({ suffix: "HARD_BYTES" });
  const bytes = new TextEncoder().encode(file.content);
  const parsed = await parseMbtBinAssetCsv(bytes, { fileName: "opening-assets.csv" });
  assert.equal(parsed.summary.rowCount, 2);
  assert.equal(parsed.fileName, "opening-assets.csv");

  const stream = {
    async *[Symbol.asyncIterator]() {
      yield bytes.subarray(0, 31);
      yield bytes.subarray(31);
    }
  };
  await assert.rejects(
    () => parseMbtBinAssetCsv(stream, { fileName: "opening-assets.csv" }),
    (error) => error?.status === 400 && error?.code === "MBT_ASSET_CSV_INPUT_INVALID"
  );
  await assert.rejects(
    () => parseMbtBinAssetCsv(file.content, { fileName: "../opening-assets.csv" }),
    (error) => error?.status === 400 && error?.code === "MBT_ASSET_CSV_FILENAME_INVALID"
  );
});
