import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCustomerSpreadsheetMl,
  CUSTOMER_IMPORT_DEFAULTS,
  CUSTOMER_SPREADSHEET_HEADERS,
  syntheticCustomerRow,
  syntheticScaleWorkbook,
  TARGET_SUBSIDIARY
} from "../support/master-data-import-fixtures.js";

function futureSpreadsheetMl() {
  return import("../../../src/mbt/customer-spreadsheetml.js");
}

/** @param {unknown} error @param {string} code */
function hasCode(error, code) {
  return Boolean(error && typeof error === "object" && error.code === code);
}

test("P3-F06 SpreadsheetML: exact observed headers and explicit defaults normalize eligible customers", async () => {
  const { parseCustomerSpreadsheetMl } = await futureSpreadsheetMl();
  const rows = [
    syntheticCustomerRow({
      id: "930001",
      Name: "730001 Synthetic North & East",
      Phone: "+1-555-1001",
      Email: "north-east@example.invalid"
    }),
    syntheticCustomerRow({
      id: "930002",
      Name: "Synthetic Customer Without Number",
      Phone: "",
      Email: ""
    }),
    syntheticCustomerRow({
      id: "930003",
      "Primary Subsidiary": "Example Other Subsidiary"
    }),
    syntheticCustomerRow({
      id: "930004",
      Status: "PROJECT-Active"
    })
  ];
  const workbook = buildCustomerSpreadsheetMl(rows, {
    rawCells: new Set(["0:Name"])
  });
  const parsed = await parseCustomerSpreadsheetMl(Buffer.from(workbook), CUSTOMER_IMPORT_DEFAULTS);

  assert.equal(parsed.schemaVersion, "mbt-customer-spreadsheetml-v1");
  assert.equal(parsed.sourceKind, "csv_bootstrap");
  assert.deepEqual(parsed.headers, CUSTOMER_SPREADSHEET_HEADERS);
  assert.deepEqual(parsed.ignoredHeaders, ["Primary Contact", "Category", "Sales Rep", "Partner"]);
  assert.match(parsed.fileHash, /^[0-9a-f]{64}$/);
  assert.match(parsed.normalizedHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(parsed.summary, {
    totalRows: 4,
    eligibleRows: 2,
    skippedRows: 2,
    skippedSubsidiaryRows: 1,
    skippedStatusRows: 1,
    incompleteEntityNumberRows: 1,
    blankEmailRows: 1,
    blankPhoneRows: 1,
    repairedDataNodeAmpersands: 1
  });
  assert.equal(parsed.rows.length, 2);
  assert.deepEqual(parsed.rows.map((row) => ({
    rowNumber: row.rowNumber,
    customerInternalId: row.customerInternalId,
    entityNumber: row.entityNumber,
    entityNumberIncomplete: row.entityNumberIncomplete,
    legalName: row.legalName,
    displayName: row.displayName,
    currency: row.currency,
    sourceAccountId: row.sourceAccountId,
    sourceModifiedAt: row.sourceModifiedAt,
    sourceKind: row.sourceKind
  })), [
    {
      rowNumber: 2,
      customerInternalId: "930001",
      entityNumber: "730001",
      entityNumberIncomplete: false,
      legalName: "730001 Synthetic North & East",
      displayName: "730001 Synthetic North & East",
      currency: "CAD",
      sourceAccountId: "synthetic-account",
      sourceModifiedAt: "2026-08-03T12:00:00.000Z",
      sourceKind: "csv_bootstrap"
    },
    {
      rowNumber: 3,
      customerInternalId: "930002",
      entityNumber: "NSID-930002",
      entityNumberIncomplete: true,
      legalName: "Synthetic Customer Without Number",
      displayName: "Synthetic Customer Without Number",
      currency: "CAD",
      sourceAccountId: "synthetic-account",
      sourceModifiedAt: "2026-08-03T12:00:00.000Z",
      sourceKind: "csv_bootstrap"
    }
  ]);
  assert.ok(parsed.rows.every((row) => (
    !Object.hasOwn(row, "primaryContact")
      && !Object.hasOwn(row, "category")
      && !Object.hasOwn(row, "salesRep")
      && !Object.hasOwn(row, "partner")
  )));
});

test("P3-F06 workbook compatibility: benign Microsoft Company metadata is accepted without widening executable XML", async () => {
  const { parseCustomerSpreadsheetMl } = await futureSpreadsheetMl();
  const workbook = buildCustomerSpreadsheetMl([
    syntheticCustomerRow({ id: "930005", Name: "730005 Synthetic Metadata Customer" })
  ], {
    beforeWorksheet: [
      '<DocumentProperties xmlns="urn:schemas-microsoft-com:office:office">',
      "<Author>Synthetic Exporter</Author>",
      "<Company>Synthetic Export Company</Company>",
      "</DocumentProperties>"
    ].join("")
  });

  const parsed = await parseCustomerSpreadsheetMl(workbook, CUSTOMER_IMPORT_DEFAULTS);

  assert.equal(parsed.summary.totalRows, 1);
  assert.equal(parsed.summary.eligibleRows, 1);
  assert.equal(parsed.rows[0].customerInternalId, "930005");

  const misplaced = buildCustomerSpreadsheetMl([
    syntheticCustomerRow({ id: "930006", Name: "730006 Synthetic Misplaced Metadata" })
  ], { beforeWorksheet: "<Company>Synthetic but structurally misplaced</Company>" });
  await assert.rejects(
    () => parseCustomerSpreadsheetMl(misplaced, CUSTOMER_IMPORT_DEFAULTS),
    (error) => hasCode(error, "MBT_IMPORT_SPREADSHEETML_STRUCTURE_INVALID")
  );
});

test("P3-F06 SpreadsheetML: a synthetic 1,262-row workbook matches every approved aggregate", {
  timeout: 30_000
}, async () => {
  const { parseCustomerSpreadsheetMl } = await futureSpreadsheetMl();
  const parsed = await parseCustomerSpreadsheetMl(
    Buffer.from(syntheticScaleWorkbook()),
    CUSTOMER_IMPORT_DEFAULTS
  );
  assert.deepEqual(parsed.headers, CUSTOMER_SPREADSHEET_HEADERS);
  assert.deepEqual(parsed.summary, {
    totalRows: 1262,
    eligibleRows: 1251,
    skippedRows: 11,
    skippedSubsidiaryRows: 10,
    skippedStatusRows: 1,
    incompleteEntityNumberRows: 39,
    blankEmailRows: 182,
    blankPhoneRows: 2,
    repairedDataNodeAmpersands: 1
  });
  assert.equal(parsed.rows.length, 1251);
  assert.equal(parsed.rows.some(({ customerInternalId }) => customerInternalId === "921251"), false);
  assert.equal(parsed.rows.some(({ customerInternalId }) => customerInternalId === "921252"), false);
});

test("P3-F06 SpreadsheetML: file and normalized hashes are deterministic and content-sensitive", async () => {
  const { parseCustomerSpreadsheetMl } = await futureSpreadsheetMl();
  const workbook = buildCustomerSpreadsheetMl([syntheticCustomerRow({ id: "931001" })]);
  const first = await parseCustomerSpreadsheetMl(workbook, CUSTOMER_IMPORT_DEFAULTS);
  const replay = await parseCustomerSpreadsheetMl(Buffer.from(workbook), { ...CUSTOMER_IMPORT_DEFAULTS });
  const changed = await parseCustomerSpreadsheetMl(
    buildCustomerSpreadsheetMl([syntheticCustomerRow({ id: "931001", Name: "731001 Changed Synthetic" })]),
    CUSTOMER_IMPORT_DEFAULTS
  );
  assert.equal(replay.fileHash, first.fileHash);
  assert.equal(replay.normalizedHash, first.normalizedHash);
  assert.notEqual(changed.fileHash, first.fileHash);
  assert.notEqual(changed.normalizedHash, first.normalizedHash);
});

test("P3-F08 SpreadsheetML: acceptance is content-based and rejects OLE, ZIP, and the wrong namespace", async () => {
  const { parseCustomerSpreadsheetMl } = await futureSpreadsheetMl();
  const cases = [
    [Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), "MBT_IMPORT_BINARY_OLE_REJECTED"],
    [Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]), "MBT_IMPORT_ZIP_REJECTED"],
    [Buffer.from("<Workbook xmlns=\"urn:example:wrong\"></Workbook>"), "MBT_IMPORT_SPREADSHEETML_NAMESPACE_INVALID"]
  ];
  for (const [content, code] of cases) {
    await assert.rejects(
      () => parseCustomerSpreadsheetMl(content, CUSTOMER_IMPORT_DEFAULTS),
      (error) => hasCode(error, code),
      code
    );
  }
});

test("P3-F08 SpreadsheetML: DTD/entities, formulas, links, and macros are rejected", async () => {
  const { parseCustomerSpreadsheetMl } = await futureSpreadsheetMl();
  const base = buildCustomerSpreadsheetMl([syntheticCustomerRow({ id: "932001" })]);
  const cases = [
    [base.replace("<Workbook", '<!DOCTYPE Workbook [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><Workbook'), "MBT_IMPORT_XML_DECLARATION_REJECTED"],
    [base.replace("<Cell><Data", '<Cell ss:Formula="=1+1"><Data'), "MBT_IMPORT_FORMULA_REJECTED"],
    [base.replace("<Cell><Data", '<Cell ss:HRef="https://example.invalid"><Data'), "MBT_IMPORT_EXTERNAL_LINK_REJECTED"],
    [base.replace("</Workbook>", "<Macros><Macro>synthetic</Macro></Macros></Workbook>"), "MBT_IMPORT_MACRO_REJECTED"]
  ];
  for (const [workbook, code] of cases) {
    await assert.rejects(
      () => parseCustomerSpreadsheetMl(workbook, CUSTOMER_IMPORT_DEFAULTS),
      (error) => hasCode(error, code),
      code
    );
  }
});

test("P3-F08 SpreadsheetML: bare ampersands repair only inside bounded Data text", async () => {
  const { parseCustomerSpreadsheetMl } = await futureSpreadsheetMl();
  const repaired = await parseCustomerSpreadsheetMl(buildCustomerSpreadsheetMl([
    syntheticCustomerRow({ id: "933001", Name: "733001 Synthetic & Customer" })
  ], { rawCells: new Set(["0:Name"]) }), CUSTOMER_IMPORT_DEFAULTS);
  assert.equal(repaired.rows[0].displayName, "733001 Synthetic & Customer");
  assert.equal(repaired.summary.repairedDataNodeAmpersands, 1);

  const outsideData = buildCustomerSpreadsheetMl([syntheticCustomerRow({ id: "933002" })])
    .replace("<Table>", '<Table ss:Name="unsafe & value">');
  await assert.rejects(
    () => parseCustomerSpreadsheetMl(outsideData, CUSTOMER_IMPORT_DEFAULTS),
    (error) => hasCode(error, "MBT_IMPORT_XML_MALFORMED")
  );
});

test("P3-F08 SpreadsheetML: malformed shape, duplicate IDs, and unsafe IDs fail before normalization", async () => {
  const { parseCustomerSpreadsheetMl } = await futureSpreadsheetMl();
  const duplicateRows = [
    syntheticCustomerRow({ id: "934001" }),
    syntheticCustomerRow({ id: "934001", Name: "734002 Duplicate Synthetic" })
  ];
  const cases = [
    [buildCustomerSpreadsheetMl(duplicateRows), "MBT_IMPORT_DUPLICATE_ID"],
    [buildCustomerSpreadsheetMl([syntheticCustomerRow({ id: "0" })]), "MBT_IMPORT_CUSTOMER_ID_INVALID"],
    [buildCustomerSpreadsheetMl([syntheticCustomerRow({ id: "1.5" })]), "MBT_IMPORT_CUSTOMER_ID_INVALID"],
    [buildCustomerSpreadsheetMl([syntheticCustomerRow()], {
      headers: [...CUSTOMER_SPREADSHEET_HEADERS, "Unexpected"]
    }), "MBT_IMPORT_UNKNOWN_HEADER"],
    [buildCustomerSpreadsheetMl([syntheticCustomerRow()]).replace("</Table>", "</Worksheet></Table>"), "MBT_IMPORT_XML_MALFORMED"]
  ];
  for (const [workbook, code] of cases) {
    await assert.rejects(
      () => parseCustomerSpreadsheetMl(workbook, CUSTOMER_IMPORT_DEFAULTS),
      (error) => hasCode(error, code),
      code
    );
  }
});

test("P3-F06 SpreadsheetML: defaults are mandatory and never inferred from workbook text", async () => {
  const { parseCustomerSpreadsheetMl } = await futureSpreadsheetMl();
  const workbook = buildCustomerSpreadsheetMl([syntheticCustomerRow({ id: "935001" })]);
  const requiredDefaults = [
    "sourceAccountId",
    "approvedSubsidiary",
    "defaultCurrency",
    "exportedAt"
  ];
  for (const missing of requiredDefaults) {
    const defaults = { ...CUSTOMER_IMPORT_DEFAULTS };
    delete defaults[missing];
    await assert.rejects(
      () => parseCustomerSpreadsheetMl(workbook, defaults),
      (error) => hasCode(error, "MBT_IMPORT_DEFAULT_REQUIRED"),
      missing
    );
  }

  const wrongScope = await parseCustomerSpreadsheetMl(workbook, {
    ...CUSTOMER_IMPORT_DEFAULTS,
    approvedSubsidiary: TARGET_SUBSIDIARY.toLowerCase()
  });
  assert.equal(wrongScope.summary.eligibleRows, 0, "Subsidiary matching must be exact, not fuzzy.");
});
