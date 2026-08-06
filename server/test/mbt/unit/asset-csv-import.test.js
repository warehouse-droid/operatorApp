// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

import {
  ASSET_CSV_HEADERS,
  assetCsvRows,
  buildAssetCsvFile,
  expectedParsedAssetRows
} from "../support/asset-csv-import-fixtures.js";

const ADAPTER_PATH = "../../../src/mbt/" + "asset-csv-import.js";
const adapter = /** @type {Record<string, Function>} */ (await import(ADAPTER_PATH).catch(() => ({})));
const _registry = /** @type {Record<string, Function>} */ (await import(
  "../../../src/mbt/asset-registry-service.js"
));

/** @param {Record<string, Function>} source @param {string} name */
function requiredOperation(source, name) {
  const operation = source[name];
  assert.equal(typeof operation, "function", `P3.5a requires ${name}.`);
  return operation;
}

/** @param {string} content @param {string} header @param {string} replacement */
function replaceHeader(content, header, replacement) {
  return content.replace(header, replacement);
}

test("P3-F11 CSV: template and exact rows normalize into safe typed asset evidence", async () => {
  const getMbtBinAssetCsvTemplate = requiredOperation(adapter, "getMbtBinAssetCsvTemplate");
  const parseMbtBinAssetCsv = requiredOperation(adapter, "parseMbtBinAssetCsv");
  const template = getMbtBinAssetCsvTemplate();
  assert.equal(template.schemaVersion, "mbt-bin-assets-csv-v2");
  assert.equal(template.fileName, "mbt-bin-assets-v2.csv");
  assert.deepEqual(template.content.split(/\r?\n/u)[0].split(","), [
    "asset_code", "item_code", "current_address", "active", "under_maintenance", "occurred_at"
  ]);

  const file = buildAssetCsvFile({ suffix: "UNIT" });
  const parsed = await parseMbtBinAssetCsv(file.content, { fileName: file.fileName });
  assert.equal(parsed.schemaVersion, "mbt-bin-assets-csv-v1");
  assert.equal(parsed.fileName, file.fileName);
  assert.deepEqual(parsed.rows, expectedParsedAssetRows("UNIT"));
  assert.deepEqual(parsed.summary, { rowCount: 2 });
  assert.match(parsed.fileHash, /^[0-9a-f]{64}$/u);
  assert.match(parsed.normalizedHash, /^[0-9a-f]{64}$/u);
  assert.equal(JSON.stringify(parsed).includes(file.content), false);
});

test("asset CSV v2 contains only item identity and current address", async () => {
  const parseMbtBinAssetCsv = requiredOperation(adapter, "parseMbtBinAssetCsv");
  const content = [
    "asset_code,item_code,current_address,active,under_maintenance,occurred_at",
    "BIN-LOCAL-001,14YD,12441,true,false,2036-08-04T12:00:00.000Z"
  ].join("\r\n");
  const parsed = await parseMbtBinAssetCsv(content, { fileName: "mbt-bin-assets-v2.csv" });
  assert.equal(parsed.schemaVersion, "mbt-bin-assets-csv-v2");
  assert.deepEqual(parsed.rows, [{
    rowNumber: 2,
    assetCode: "BIN-LOCAL-001",
    itemCode: "14YD",
    currentAddress: "12441",
    active: true,
    underMaintenance: false,
    occurredAt: "2036-08-04T12:00:00.000Z"
  }]);
});

test("P3-F11 CSV: hostile CSV and exact structural bounds fail closed", async () => {
  const parseMbtBinAssetCsv = requiredOperation(adapter, "parseMbtBinAssetCsv");
  const base = buildAssetCsvFile({ suffix: "HOSTILE" });
  const scenarios = [
    { label: "fatal UTF-8", content: Buffer.from([0xc3, 0x28]), code: "MBT_IMPORT_INVALID_UTF8" },
    { label: "control character", content: `${base.content}\u0000`, code: "MBT_IMPORT_UNSAFE_CHARACTER" },
    { label: "malformed quote", content: `${base.content}\r\n\"open`, code: "MBT_IMPORT_CSV_MALFORMED" },
    {
      label: "unknown header",
      content: replaceHeader(base.content, ASSET_CSV_HEADERS[0], "unexpected"),
      code: "MBT_IMPORT_UNKNOWN_HEADER"
    },
    {
      label: "duplicate header",
      content: replaceHeader(base.content, ASSET_CSV_HEADERS[1], ASSET_CSV_HEADERS[0]),
      code: "MBT_IMPORT_DUPLICATE_HEADER"
    },
    {
      label: "extra cell",
      content: `${base.content},extra`,
      code: "MBT_IMPORT_EXTRA_CELL"
    },
    {
      label: "byte bound",
      content: base.content,
      options: { limits: { maxBytes: 64 } },
      code: "MBT_IMPORT_FILE_TOO_LARGE"
    }
  ];
  for (const scenario of scenarios) {
    await assert.rejects(
      () => parseMbtBinAssetCsv(scenario.content, scenario.options),
      (error) => error?.status === 400 && error?.code === scenario.code,
      scenario.label
    );
  }
});

test("P3-F11 CSV: invalid booleans, decimals, timestamps, status, and locations fail closed", async () => {
  const parseMbtBinAssetCsv = requiredOperation(adapter, "parseMbtBinAssetCsv");
  const scenarios = [
    ["boolean", "active", "yes"],
    ["maintenance boolean", "under_maintenance", "0"],
    ["negative tare", "tare_weight_kg", "-1"],
    ["precision tare", "tare_weight_kg", "1.0001"],
    ["unsafe tare", "tare_weight_kg", "1000000000"],
    ["timestamp", "occurred_at", "not-a-time"],
    ["status", "initial_lifecycle_status", "ready"],
    ["location kind", "initial_location_kind", "warehouse"],
    ["location identity", "initial_location_identity", ""]
  ];
  for (const [label, field, value] of scenarios) {
    const rows = assetCsvRows(`BAD_${label}`);
    rows[0][field] = value;
    await assert.rejects(
      () => parseMbtBinAssetCsv(buildAssetCsvFile({ rows }).content),
      (error) => error?.status === 400 && error?.code === "MBT_ASSET_CSV_ROW_INVALID",
      label
    );
  }
});

test("P3-F11 CSV: duplicate asset, QR, and barcode identities are rejected before staging", async () => {
  const parseMbtBinAssetCsv = requiredOperation(adapter, "parseMbtBinAssetCsv");
  for (const field of ["asset_code", "qr_code", "barcode"]) {
    const rows = assetCsvRows(`DUP_${field}`);
    rows[1][field] = rows[0][field];
    await assert.rejects(
      () => parseMbtBinAssetCsv(buildAssetCsvFile({ rows }).content),
      (error) => error?.status === 400
        && error?.code === "MBT_ASSET_CSV_DUPLICATE_IDENTITY"
        && error?.details?.field === field,
      field
    );
  }
});
