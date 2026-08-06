// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_IMPORT_LIMITS } from "../../../src/mbt/bounded-csv.js";
import { parseCustomerSpreadsheetMl } from "../../../src/mbt/customer-spreadsheetml.js";
import {
  buildCustomerSpreadsheetMl,
  CUSTOMER_IMPORT_DEFAULTS,
  CUSTOMER_SPREADSHEET_HEADERS,
  syntheticCustomerRow
} from "../support/master-data-import-fixtures.js";

/** @param {unknown} error @param {string} code */
function hasCode(error, code) {
  return Boolean(error && typeof error === "object" && error.code === code);
}

/** @param {unknown} workbook @param {string} code */
async function rejectsCode(workbook, code) {
  await assert.rejects(
    () => parseCustomerSpreadsheetMl(workbook, CUSTOMER_IMPORT_DEFAULTS),
    (error) => hasCode(error, code),
    code
  );
}

function validWorkbook(overrides = {}) {
  return buildCustomerSpreadsheetMl([
    syntheticCustomerRow({ id: "936001", ...overrides })
  ]);
}

test("P3-F08 SpreadsheetML boundaries accept every supported byte and namespace spelling", async () => {
  const bytes = new Uint8Array(Buffer.from(validWorkbook()));
  const byteParsed = await parseCustomerSpreadsheetMl(bytes, CUSTOMER_IMPORT_DEFAULTS);
  assert.equal(byteParsed.rows[0].customerInternalId, "936001");

  let prefixed = validWorkbook({ id: "936002" });
  for (const element of ["Worksheet", "Table", "Row", "Cell", "Data"]) {
    prefixed = prefixed.replaceAll(`<${element}`, `<ss:${element}`)
      .replaceAll(`</${element}`, `</ss:${element}`);
  }
  const prefixedParsed = await parseCustomerSpreadsheetMl(prefixed, CUSTOMER_IMPORT_DEFAULTS);
  assert.equal(prefixedParsed.rows[0].customerInternalId, "936002");

  const unqualifiedTypes = validWorkbook({ id: "936003" }).replaceAll("ss:Type=", "Type=");
  assert.equal(
    (await parseCustomerSpreadsheetMl(unqualifiedTypes, CUSTOMER_IMPORT_DEFAULTS)).rows[0].customerInternalId,
    "936003"
  );
  const implicitTypes = validWorkbook({ id: "936004" }).replaceAll(' ss:Type="String"', "");
  assert.equal(
    (await parseCustomerSpreadsheetMl(implicitTypes, CUSTOMER_IMPORT_DEFAULTS)).rows[0].customerInternalId,
    "936004"
  );
  const numericId = validWorkbook({ id: "936005" })
    .replace('ss:Type="String">936005</Data>', 'ss:Type="Number">936005</Data>');
  assert.equal(
    (await parseCustomerSpreadsheetMl(numericId, CUSTOMER_IMPORT_DEFAULTS)).rows[0].customerInternalId,
    "936005"
  );

  const unqualifiedName = validWorkbook({ id: "936006" }).replace("ss:Name=", "Name=");
  assert.equal(
    (await parseCustomerSpreadsheetMl(unqualifiedName, CUSTOMER_IMPORT_DEFAULTS)).rows[0].customerInternalId,
    "936006"
  );
});

test("P3-F08 SpreadsheetML boundaries reject unsupported inputs before customer normalization", async () => {
  await assert.rejects(
    () => parseCustomerSpreadsheetMl({ xml: validWorkbook() }, CUSTOMER_IMPORT_DEFAULTS),
    (error) => error instanceof TypeError
      && error.message === "SpreadsheetML input must be UTF-8 text or bytes."
  );
  await rejectsCode(Buffer.from([0xff]), "MBT_IMPORT_INVALID_UTF8");
  await rejectsCode(
    Buffer.alloc(DEFAULT_IMPORT_LIMITS.maxBytes + 1),
    "MBT_IMPORT_FILE_TOO_LARGE"
  );

  const namedEntity = buildCustomerSpreadsheetMl([
    syntheticCustomerRow({ id: "936007", Name: "736007 &synthetic; Customer" })
  ], { rawCells: new Set(["0:Name"]) });
  await rejectsCode(namedEntity, "MBT_IMPORT_XML_DECLARATION_REJECTED");
});

test("P3-F08 SpreadsheetML numeric entities are decoded exactly and invalid Unicode fails closed", async () => {
  const numericEntities = buildCustomerSpreadsheetMl([
    syntheticCustomerRow({ id: "936008", Name: "736008 &#x41;&#65; Customer" })
  ], { rawCells: new Set(["0:Name"]) });
  const parsed = await parseCustomerSpreadsheetMl(numericEntities, CUSTOMER_IMPORT_DEFAULTS);
  assert.equal(parsed.rows[0].displayName, "736008 AA Customer");

  const invalidEntity = buildCustomerSpreadsheetMl([
    syntheticCustomerRow({ id: "936009", Name: "736009 &#x110000; Customer" })
  ], { rawCells: new Set(["0:Name"]) });
  await rejectsCode(invalidEntity, "MBT_IMPORT_XML_MALFORMED");
});

test("P3-F08 SpreadsheetML tokenization rejects malformed instructions, declarations, tags, and roots", async (t) => {
  const workbook = validWorkbook({ id: "936010" });
  const cases = [
    ["unclosed tag", `${workbook}<`, "MBT_IMPORT_XML_MALFORMED"],
    ["processing instruction", workbook.replace("?>", ">"), "MBT_IMPORT_XML_MALFORMED"],
    ["declaration", workbook.replace("<Worksheet", "<!--synthetic--><Worksheet"), "MBT_IMPORT_XML_DECLARATION_REJECTED"],
    ["unsupported element", workbook.replace("<Worksheet", "<Script></Script><Worksheet"), "MBT_IMPORT_SPREADSHEETML_STRUCTURE_INVALID"],
    ["invalid element name", workbook.replace("<Worksheet", "<1Bad></1Bad><Worksheet"), "MBT_IMPORT_SPREADSHEETML_STRUCTURE_INVALID"],
    ["wrong first element", `<Styles></Styles>${workbook}`, "MBT_IMPORT_XML_MALFORMED"],
    ["two workbooks", workbook.replace("</Workbook>", "<Workbook></Workbook></Workbook>"), "MBT_IMPORT_XML_MALFORMED"],
    ["open root", workbook.replace("</Workbook>", ""), "MBT_IMPORT_XML_MALFORMED"]
  ];
  for (const [name, value, code] of cases) {
    await t.test(String(name), () => rejectsCode(value, String(code)));
  }
});

test("P3-F08 SpreadsheetML cell grammar covers empty, numeric, implicit, and invalid Data shapes", async () => {
  const emptyIgnoredCell = validWorkbook({
    id: "936011",
    "Primary Contact": "REMOVE_EMPTY_CELL"
  }).replace(
    '<Cell><Data ss:Type="String">REMOVE_EMPTY_CELL</Data></Cell>',
    "<Cell/>"
  );
  assert.equal(
    (await parseCustomerSpreadsheetMl(emptyIgnoredCell, CUSTOMER_IMPORT_DEFAULTS)).rows[0].customerInternalId,
    "936011"
  );

  const unsupportedType = validWorkbook({ id: "936012" })
    .replace('ss:Type="String">936012</Data>', 'ss:Type="Boolean">936012</Data>');
  await rejectsCode(unsupportedType, "MBT_IMPORT_SPREADSHEETML_STRUCTURE_INVALID");

  const noData = validWorkbook({
    id: "936013",
    "Primary Contact": "REMOVE_DATA_NODE"
  }).replace(
    '<Data ss:Type="String">REMOVE_DATA_NODE</Data>',
    "REMOVE_DATA_NODE"
  );
  await rejectsCode(noData, "MBT_IMPORT_SPREADSHEETML_STRUCTURE_INVALID");

  const twoData = validWorkbook({
    id: "936014",
    "Primary Contact": "DUPLICATE_DATA_NODE"
  }).replace(
    '<Data ss:Type="String">DUPLICATE_DATA_NODE</Data>',
    '<Data ss:Type="String">first</Data><Data ss:Type="String">second</Data>'
  );
  await rejectsCode(twoData, "MBT_IMPORT_SPREADSHEETML_STRUCTURE_INVALID");
});

test("P3-F08 SpreadsheetML sparse indexes and physical cell bounds are enforced", async (t) => {
  const validSparse = buildCustomerSpreadsheetMl([
    syntheticCustomerRow({ id: "936015" })
  ], { cellAttributes: { "Primary Contact": ' Index="3"' } });
  assert.equal(
    (await parseCustomerSpreadsheetMl(validSparse, CUSTOMER_IMPORT_DEFAULTS)).rows[0].customerInternalId,
    "936015"
  );

  for (const index of ["0", "1.5", "not-a-number", String(DEFAULT_IMPORT_LIMITS.maxColumns + 1)]) {
    await t.test(`index ${index}`, async () => {
      const workbook = buildCustomerSpreadsheetMl([
        syntheticCustomerRow({ id: "936016" })
      ], { cellAttributes: { "Primary Contact": ` ss:Index="${index}"` } });
      await rejectsCode(workbook, "MBT_IMPORT_COLUMN_LIMIT");
    });
  }

  const sparseGap = buildCustomerSpreadsheetMl([
    syntheticCustomerRow({ id: "936017" })
  ], { cellAttributes: { "Primary Contact": ' ss:Index="4"' } });
  await rejectsCode(sparseGap, "MBT_IMPORT_EXTRA_CELL");

  const tooManyCells = buildCustomerSpreadsheetMl([]).replace(
    "</Table>",
    `<Row>${"<Cell/>".repeat(DEFAULT_IMPORT_LIMITS.maxColumns + 1)}</Row></Table>`
  );
  await rejectsCode(tooManyCells, "MBT_IMPORT_COLUMN_LIMIT");

  const longCell = validWorkbook({
    id: "936018",
    "Primary Contact": "x".repeat(DEFAULT_IMPORT_LIMITS.maxCellCharacters + 1)
  });
  await rejectsCode(longCell, "MBT_IMPORT_CELL_LIMIT");
});

test("P3-F08 SpreadsheetML worksheet, table, and header cardinality is exact", async (t) => {
  const workbook = validWorkbook({ id: "936019" });
  const secondWorksheet = '<Worksheet ss:Name="CustomersProjects"><Table></Table></Worksheet>';
  const cases = [
    ["missing worksheet", workbook.replace(/<Worksheet[\s\S]*<\/Worksheet>/u, ""), "MBT_IMPORT_SPREADSHEETML_STRUCTURE_INVALID"],
    ["two worksheets", workbook.replace("</Workbook>", `${secondWorksheet}</Workbook>`), "MBT_IMPORT_SPREADSHEETML_STRUCTURE_INVALID"],
    ["missing worksheet name", workbook.replace(' ss:Name="CustomersProjects"', ""), "MBT_IMPORT_SPREADSHEETML_STRUCTURE_INVALID"],
    ["wrong worksheet name", workbook.replace("CustomersProjects", "OtherSheet"), "MBT_IMPORT_SPREADSHEETML_STRUCTURE_INVALID"],
    ["empty table", buildCustomerSpreadsheetMl([]).replace(/<Row>[\s\S]*<\/Row>/u, ""), "MBT_IMPORT_REQUIRED_HEADER_MISSING"],
    ["two tables", workbook.replace("</Table>", "</Table><Table></Table>"), "MBT_IMPORT_SPREADSHEETML_STRUCTURE_INVALID"],
    ["missing table", workbook.replace(/<Table>[\s\S]*<\/Table>/u, ""), "MBT_IMPORT_SPREADSHEETML_STRUCTURE_INVALID"],
    ["duplicate header", buildCustomerSpreadsheetMl([], { headers: [...CUSTOMER_SPREADSHEET_HEADERS, "Email"] }), "MBT_IMPORT_DUPLICATE_HEADER"],
    ["missing header", buildCustomerSpreadsheetMl([], { headers: CUSTOMER_SPREADSHEET_HEADERS.slice(0, -1) }), "MBT_IMPORT_REQUIRED_HEADER_MISSING"]
  ];
  for (const [name, value, code] of cases) {
    await t.test(String(name), () => rejectsCode(value, String(code)));
  }
});

test("P3-F08 SpreadsheetML rows reject surplus cells but fill omitted trailing values", async () => {
  const workbook = validWorkbook({ id: "936020" });
  const finalRowClose = workbook.lastIndexOf("</Row>");
  assert.ok(finalRowClose > 0);
  const extraCell = `${workbook.slice(0, finalRowClose)}<Cell/>${workbook.slice(finalRowClose)}`;
  await rejectsCode(extraCell, "MBT_IMPORT_EXTRA_CELL");

  const emailCell = '<Cell><Data ss:Type="String">customer-936020@example.invalid</Data></Cell>';
  const missingEmail = workbook.replace(emailCell, "");
  const parsed = await parseCustomerSpreadsheetMl(missingEmail, CUSTOMER_IMPORT_DEFAULTS);
  assert.equal(parsed.rows[0].email, "");
  assert.equal(parsed.summary.blankEmailRows, 1);
});
