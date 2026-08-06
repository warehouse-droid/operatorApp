// Synthetic-only Phase 3 import fixtures. Values deliberately use reserved
// example domains and invented identifiers; never copy production workbook rows.

export const CUSTOMER_SPREADSHEET_HEADERS = Object.freeze([
  "Internal ID",
  "Name",
  "Primary Contact",
  "Category",
  "Primary Subsidiary",
  "Sales Rep",
  "Partner",
  "Status",
  "Phone",
  "Email"
]);

export const TARGET_SUBSIDIARY = "Example Holdings : Example Trucking";

export const CUSTOMER_IMPORT_DEFAULTS = Object.freeze({
  sourceAccountId: "synthetic-account",
  approvedSubsidiary: TARGET_SUBSIDIARY,
  defaultCurrency: "CAD",
  exportedAt: "2026-08-03T12:00:00.000Z"
});

/** @param {unknown} value */
function xmlText(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/**
 * @param {Record<string, unknown>} row
 * @param {object} [options]
 * @param {readonly string[]} [options.headers]
 * @param {ReadonlySet<string>} [options.rawHeaders]
 * @param {Readonly<Record<string, string>>} [options.cellAttributes]
 */
function spreadsheetRow(row, {
  headers = CUSTOMER_SPREADSHEET_HEADERS,
  rawHeaders = new Set(),
  cellAttributes = {}
} = {}) {
  const cells = headers.map((header) => {
    const value = rawHeaders.has(header) ? String(row[header] ?? "") : xmlText(row[header]);
    const attributes = String(cellAttributes[header] || "");
    return `<Cell${attributes}><Data ss:Type="String">${value}</Data></Cell>`;
  }).join("");
  return `<Row>${cells}</Row>`;
}

/**
 * Build the narrow Excel 2003 XML shape accepted by Phase 3. `rawCells` is
 * test-only and permits one deliberately malformed data-node ampersand.
 *
 * @param {readonly Record<string, unknown>[]} rows
 * @param {object} [options]
 * @param {readonly string[]} [options.headers]
 * @param {ReadonlySet<string>} [options.rawCells]
 * @param {Readonly<Record<string, string>>} [options.cellAttributes]
 * @param {string} [options.beforeWorksheet]
 * @param {string} [options.afterWorksheet]
 * @param {string} [options.worksheetName]
 */
export function buildCustomerSpreadsheetMl(rows, {
  headers = CUSTOMER_SPREADSHEET_HEADERS,
  rawCells = new Set(),
  cellAttributes = {},
  beforeWorksheet = "",
  afterWorksheet = "",
  worksheetName = "CustomersProjects"
} = {}) {
  const header = spreadsheetRow(
    Object.fromEntries(headers.map((name) => [name, name])),
    { headers }
  );
  const body = rows.map((row, index) => spreadsheetRow(row, {
    headers,
    rawHeaders: new Set(headers.filter((name) => rawCells.has(`${index}:${name}`))),
    cellAttributes
  })).join("");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"',
    ' xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">',
    beforeWorksheet,
    `<Worksheet ss:Name="${xmlText(worksheetName)}"><Table>${header}${body}</Table></Worksheet>`,
    afterWorksheet,
    "</Workbook>"
  ].join("");
}

/** @param {Partial<Record<(typeof CUSTOMER_SPREADSHEET_HEADERS)[number], unknown>> & {id?: number | string}} [overrides] */
export function syntheticCustomerRow(overrides = {}) {
  const id = String(overrides.id ?? overrides["Internal ID"] ?? "910001");
  return {
    "Internal ID": id,
    Name: `710001 Synthetic Customer ${id}`,
    "Primary Contact": `Ignored Contact ${id}`,
    Category: "Synthetic",
    "Primary Subsidiary": TARGET_SUBSIDIARY,
    "Sales Rep": "Ignored Rep",
    Partner: "Ignored Partner",
    Status: "CUSTOMER-Closed Won",
    Phone: "+1-555-0100",
    Email: `customer-${id}@example.invalid`,
    ...overrides,
    "Internal ID": id
  };
}

/** @param {number} index */
function syntheticScaleGapFlags(index) {
  return {
    incompleteEntity: index < 39 || (index >= 1251 && index < 1259),
    blankEmail: index < 182 || (index >= 1251 && index < 1256),
    blankPhone: index < 2 || (index >= 1251 && index < 1260)
  };
}

/**
 * Structurally equivalent scale fixture for the approved aggregate counts.
 * It has 1,262 rows, 1,252 target-subsidiary rows, one target project row,
 * and the observed workbook's aggregate gaps: 47 incomplete entity numbers,
 * 187 blank emails, and 11 blank phones overall; 39, 182, and 2 respectively
 * among the 1,251 eligible customer rows. One Data node contains a recoverable
 * bare ampersand.
 */
export function syntheticScaleWorkbook() {
  const rows = [];
  for (let index = 0; index < 1262; index += 1) {
    const id = String(920000 + index);
    const completeName = `${String(720000 + index).slice(-6)} Synthetic Customer ${index}`;
    const { incompleteEntity, blankEmail, blankPhone } = syntheticScaleGapFlags(index);
    rows.push(syntheticCustomerRow({
      id,
      Name: incompleteEntity ? `Synthetic Customer Without Code ${index}` : completeName,
      "Primary Subsidiary": index < 1252 ? TARGET_SUBSIDIARY : "Example Other Subsidiary",
      Status: index === 1251 ? "PROJECT-Active" : "CUSTOMER-Closed Won",
      Phone: blankPhone ? "" : `+1-555-${String(index).padStart(4, "0")}`,
      Email: blankEmail ? "" : `scale-${index}@example.invalid`
    }));
  }
  rows[200].Name = "720200 Synthetic & Customer";
  return buildCustomerSpreadsheetMl(rows, {
    rawCells: new Set(["200:Name"])
  });
}

/** @param {readonly Record<string, unknown>[]} rows */
export function customerCsv(rows) {
  const quote = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  return [
    CUSTOMER_SPREADSHEET_HEADERS.map(quote).join(","),
    ...rows.map((row) => CUSTOMER_SPREADSHEET_HEADERS.map((header) => quote(row[header])).join(","))
  ].join("\r\n");
}
