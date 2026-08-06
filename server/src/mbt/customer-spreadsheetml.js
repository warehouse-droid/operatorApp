// @ts-check

import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

import { DEFAULT_IMPORT_LIMITS } from "./bounded-csv.js";
import { normalizeCustomerImportRows } from "./customer-import-normalizer.js";
import { MbtError } from "./errors.js";

const SPREADSHEET_NAMESPACE = "urn:schemas-microsoft-com:office:spreadsheet";
const EXPECTED_HEADERS = Object.freeze([
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
const IGNORED_HEADERS = Object.freeze([
  "Primary Contact",
  "Category",
  "Sales Rep",
  "Partner"
]);
const ALLOWED_ELEMENTS = new Set([
  "Workbook", "DocumentProperties", "Author", "LastAuthor", "Company", "Created", "Version",
  "ExcelWorkbook", "WindowHeight", "WindowWidth", "WindowTopX", "WindowTopY",
  "ProtectStructure", "ProtectWindows", "Styles", "Style", "Alignment", "Borders",
  "Border", "Font", "Interior", "NumberFormat", "Protection", "Worksheet", "Table",
  "Column", "Row", "Cell", "Data", "WorksheetOptions", "Selected", "FreezePanes",
  "FrozenNoSplit", "SplitHorizontal", "TopRowBottomPane", "ActivePane", "Panes", "Pane",
  "Number", "ActiveRow", "ActiveCol", "ProtectObjects", "ProtectScenarios", "PageSetup",
  "Header", "Footer", "PageMargins", "Print", "ValidPrinterInfo", "HorizontalResolution",
  "VerticalResolution", "Names", "NamedRange", "NamedCell"
]);
const SAFE_ENTITY = /&(?!(?:amp|lt|gt|quot|apos);|#[0-9]+;|#x[0-9a-fA-F]+;)/gu;

/** @param {string} code @param {string} message @param {Record<string, unknown>} [details] */
function importError(code, message, details = {}) {
  return new MbtError({ status: 400, code, message, details });
}

/** @param {unknown} input */
function inputBuffer(input) {
  if (typeof input === "string") {
    return Buffer.from(input, "utf8");
  }
  if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
    return Buffer.from(input);
  }
  throw new TypeError("SpreadsheetML input must be UTF-8 text or bytes.");
}

/** @param {Buffer} buffer */
function rejectBinaryWorkbook(buffer) {
  if (buffer.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) {
    throw importError("MBT_IMPORT_BINARY_OLE_REJECTED", "Binary Excel workbooks are not accepted.");
  }
  if (buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    throw importError("MBT_IMPORT_ZIP_REJECTED", "ZIP/XLSX workbooks are not accepted.");
  }
}

/** @param {Buffer} buffer */
function decodeWorkbook(buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer).replace(/^\uFEFF/, "");
  } catch {
    throw importError("MBT_IMPORT_INVALID_UTF8", "The workbook is not valid UTF-8.");
  }
}

/** @param {string} xml */
function rejectExecutableXml(xml) {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/iu.test(xml)) {
    throw importError("MBT_IMPORT_XML_DECLARATION_REJECTED", "DTD and entity declarations are not accepted.");
  }
  if (/(?:\bFormula\s*=|<(?:[\w.-]+:)?Formula\b)/iu.test(xml)) {
    throw importError("MBT_IMPORT_FORMULA_REJECTED", "Workbook formulas are not accepted.");
  }
  if (/(?:\b(?:HRef|Href|Hyperlink)\s*=|External(?:Reference|Link))/iu.test(xml)) {
    throw importError("MBT_IMPORT_EXTERNAL_LINK_REJECTED", "External workbook links are not accepted.");
  }
  if (/<(?:[\w.-]+:)?Macros?\b|VBProject/iu.test(xml)) {
    throw importError("MBT_IMPORT_MACRO_REJECTED", "Workbook macros are not accepted.");
  }
  if (/&(?!amp;|lt;|gt;|quot;|apos;|#[0-9]+;|#x[0-9a-fA-F]+;)([A-Za-z][\w.-]*);/u.test(xml)) {
    throw importError("MBT_IMPORT_XML_DECLARATION_REJECTED", "Named XML entities are not accepted.");
  }
}

/** @param {string} xml */
function repairDataAmpersands(xml) {
  let repairs = 0;
  const repaired = xml.replace(
    /(<(?:[\w.-]+:)?Data\b[^>]*>)([\s\S]*?)(<\/(?:[\w.-]+:)?Data\s*>)/gu,
    (_whole, opening, text, closing) => {
      const safeText = String(text).replace(SAFE_ENTITY, () => {
        repairs += 1;
        return "&amp;";
      });
      return `${opening}${safeText}${closing}`;
    }
  );
  if (SAFE_ENTITY.test(repaired)) {
    SAFE_ENTITY.lastIndex = 0;
    throw importError("MBT_IMPORT_XML_MALFORMED", "A bare ampersand appears outside a Data value.");
  }
  SAFE_ENTITY.lastIndex = 0;
  return { xml: repaired, repairs };
}

/** @param {string} xml @param {number} start */
function tagEnd(xml, start) {
  let quote = "";
  for (let index = start + 1; index < xml.length; index += 1) {
    const character = xml[index];
    if (quote) {
      if (character === quote) {
        quote = "";
      }
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index;
    }
  }
  return -1;
}

/** @param {string} qualified */
function localName(qualified) {
  return qualified.includes(":") ? qualified.slice(qualified.indexOf(":") + 1) : qualified;
}

/** @param {string} token */
function xmlElementToken(token) {
  const closing = token.startsWith("/");
  const selfClosing = token.endsWith("/");
  const nameToken = token.replace(/^\//u, "").match(/^[A-Za-z_][\w.:-]*/u)?.[0] || "";
  const name = localName(nameToken);
  if (!nameToken || !ALLOWED_ELEMENTS.has(name)) {
    throw importError("MBT_IMPORT_SPREADSHEETML_STRUCTURE_INVALID", "The workbook contains an unsupported element.");
  }
  return { closing, selfClosing, name };
}

/**
 * @param {{stack: string[], firstElement: string, workbookCount: number}} structure
 * @param {{closing: boolean, selfClosing: boolean, name: string}} element
 */
function applyXmlElement(structure, element) {
  if (!structure.firstElement && !element.closing) {
    structure.firstElement = element.name;
  }
  if (element.name === "Workbook" && !element.closing) {
    structure.workbookCount += 1;
  }
  if (!element.closing
      && element.name === "Company"
      && structure.stack.at(-1) !== "DocumentProperties") {
    throw importError(
      "MBT_IMPORT_SPREADSHEETML_STRUCTURE_INVALID",
      "Company metadata is permitted only inside DocumentProperties."
    );
  }
  if (element.closing) {
    if (structure.stack.pop() !== element.name) {
      throw importError("MBT_IMPORT_XML_MALFORMED", "Workbook elements are not properly nested.");
    }
    return;
  }
  if (!element.selfClosing) {
    structure.stack.push(element.name);
  }
}

/**
 * Validate balanced XML and the narrow non-executable SpreadsheetML element
 * vocabulary before extracting any cells.
 * @param {string} xml
 */
function validateXmlStructure(xml) {
  const structure = { stack: /** @type {string[]} */ ([]), firstElement: "", workbookCount: 0 };
  for (let cursor = 0; cursor < xml.length;) {
    const start = xml.indexOf("<", cursor);
    if (start < 0) {
      break;
    }
    const end = tagEnd(xml, start);
    if (end < 0) {
      throw importError("MBT_IMPORT_XML_MALFORMED", "The workbook XML has an unclosed tag.");
    }
    const token = xml.slice(start + 1, end).trim();
    cursor = end + 1;
    if (token.startsWith("?")) {
      if (!token.endsWith("?")) {
        throw importError("MBT_IMPORT_XML_MALFORMED", "A workbook processing instruction is malformed.");
      }
      continue;
    }
    if (token.startsWith("!")) {
      throw importError("MBT_IMPORT_XML_DECLARATION_REJECTED", "Workbook declarations are not accepted.");
    }
    applyXmlElement(structure, xmlElementToken(token));
  }
  if (structure.firstElement !== "Workbook"
      || structure.workbookCount !== 1
      || structure.stack.length !== 0) {
    throw importError("MBT_IMPORT_XML_MALFORMED", "The workbook root structure is invalid.");
  }
}

/** @param {string} attributes @param {string} name */
function attribute(attributes, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const matched = new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "u").exec(attributes);
  return matched?.[2] ?? null;
}

/** @param {string} text */
function decodeXmlText(text) {
  return text.replace(/&(amp|lt|gt|quot|apos|#[0-9]+|#x[0-9a-fA-F]+);/gu, (_whole, entity) => {
    /** @type {Record<string, string>} */
    const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    const namedValue = named[String(entity)];
    if (namedValue !== undefined) {
      return namedValue;
    }
    const codePoint = String(entity).startsWith("#x")
      ? Number.parseInt(String(entity).slice(2), 16)
      : Number.parseInt(String(entity).slice(1), 10);
    try {
      return String.fromCodePoint(codePoint);
    } catch {
      throw importError("MBT_IMPORT_XML_MALFORMED", "The workbook contains an invalid character entity.");
    }
  });
}

/** @param {string} body */
function cellValue(body) {
  if (body.trim().length === 0) {
    return "";
  }
  const matches = [...body.matchAll(
    /<(?:[\w.-]+:)?Data\b([^>]*)>([\s\S]*?)<\/(?:[\w.-]+:)?Data\s*>/gu
  )];
  if (matches.length !== 1) {
    throw importError("MBT_IMPORT_SPREADSHEETML_STRUCTURE_INVALID", "Each populated cell must contain one Data value.");
  }
  const match = /** @type {RegExpMatchArray} */ (matches[0]);
  const type = attribute(match[1] || "", "ss:Type")
    ?? attribute(match[1] || "", "Type")
    ?? "String";
  if (type !== "String" && type !== "Number") {
    throw importError("MBT_IMPORT_SPREADSHEETML_STRUCTURE_INVALID", "A workbook cell type is not supported.");
  }
  return decodeXmlText(match[2] || "");
}

/** @param {string[]} cells @param {string} attributes */
function applySparseCellIndex(cells, attributes) {
  const sparseIndex = attribute(attributes, "ss:Index") ?? attribute(attributes, "Index");
  if (sparseIndex === null) {
    return;
  }
  const target = Number(sparseIndex);
  if (!Number.isSafeInteger(target) || target < 1 || target > DEFAULT_IMPORT_LIMITS.maxColumns) {
    throw importError("MBT_IMPORT_COLUMN_LIMIT", "A workbook column index is invalid.");
  }
  while (cells.length < target - 1) {
    cells.push("");
  }
}

/** @param {string[]} cells @param {RegExpMatchArray} match */
function appendWorkbookCell(cells, match) {
  applySparseCellIndex(cells, match[1] || "");
  cells.push(cellValue(match[2] || ""));
  if (cells.length > DEFAULT_IMPORT_LIMITS.maxColumns) {
    throw importError("MBT_IMPORT_COLUMN_LIMIT", "The workbook exceeds the column limit.");
  }
}

/** @param {readonly string[]} cells */
function validateWorkbookCellLengths(cells) {
  for (const value of cells) {
    if ([...value].length > DEFAULT_IMPORT_LIMITS.maxCellCharacters) {
      throw importError("MBT_IMPORT_CELL_LIMIT", "A workbook cell exceeds the character limit.");
    }
  }
}

/** @param {string} rowBody */
function rowCells(rowBody) {
  /** @type {string[]} */
  const cells = [];
  const matches = rowBody.matchAll(
    /<(?:[\w.-]+:)?Cell\b([^>]*?)(?:\/\s*>|>([\s\S]*?)<\/(?:[\w.-]+:)?Cell\s*>)/gu
  );
  for (const match of matches) {
    appendWorkbookCell(cells, match);
  }
  validateWorkbookCellLengths(cells);
  return cells;
}

/** @param {string} xml */
function worksheetTable(xml) {
  const worksheets = [...xml.matchAll(
    /<(?:[\w.-]+:)?Worksheet\b([^>]*)>([\s\S]*?)<\/(?:[\w.-]+:)?Worksheet\s*>/gu
  )];
  if (worksheets.length !== 1) {
    throw importError("MBT_IMPORT_SPREADSHEETML_STRUCTURE_INVALID", "Exactly one customer worksheet is required.");
  }
  const worksheet = /** @type {RegExpMatchArray} */ (worksheets[0]);
  const worksheetName = attribute(worksheet[1] || "", "ss:Name")
    ?? attribute(worksheet[1] || "", "Name");
  if (worksheetName !== "CustomersProjects") {
    throw importError("MBT_IMPORT_SPREADSHEETML_STRUCTURE_INVALID", "The CustomersProjects worksheet is required.");
  }
  const tables = [...String(worksheet[2] || "").matchAll(
    /<(?:[\w.-]+:)?Table\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?Table\s*>/gu
  )];
  if (tables.length !== 1) {
    throw importError("MBT_IMPORT_SPREADSHEETML_STRUCTURE_INVALID", "Exactly one worksheet table is required.");
  }
  const table = /** @type {RegExpMatchArray} */ (tables[0]);
  return table[1] || "";
}

/** @param {string[]} headers */
function validateHeaders(headers) {
  if (new Set(headers).size !== headers.length) {
    throw importError("MBT_IMPORT_DUPLICATE_HEADER", "The workbook has a duplicate header.");
  }
  const unknown = headers.find((header) => !EXPECTED_HEADERS.includes(header));
  if (unknown !== undefined) {
    throw importError("MBT_IMPORT_UNKNOWN_HEADER", "The workbook has an unknown header.", { header: unknown });
  }
  const missing = EXPECTED_HEADERS.find((header) => !headers.includes(header));
  if (missing !== undefined) {
    throw importError("MBT_IMPORT_REQUIRED_HEADER_MISSING", "The workbook is missing a required header.", {
      header: missing
    });
  }
}

/** @param {string} table */
function rawCustomerRows(table) {
  const xmlRows = [...table.matchAll(
    /<(?:[\w.-]+:)?Row\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?Row\s*>/gu
  )];
  if (xmlRows.length < 1) {
    throw importError("MBT_IMPORT_REQUIRED_HEADER_MISSING", "The workbook header row is missing.");
  }
  if (xmlRows.length - 1 > DEFAULT_IMPORT_LIMITS.maxRows) {
    throw importError("MBT_IMPORT_ROW_LIMIT", "The workbook exceeds the logical row limit.");
  }
  const headerRow = /** @type {RegExpMatchArray} */ (xmlRows[0]);
  const headers = rowCells(headerRow[1] || "");
  validateHeaders(headers);
  const rows = xmlRows.slice(1).map((match, index) => {
    const cells = rowCells(match[1] || "");
    if (cells.length > headers.length) {
      throw importError("MBT_IMPORT_EXTRA_CELL", "A workbook row has more cells than its header.", {
        rowNumber: index + 2
      });
    }
    return {
      rowNumber: index + 2,
      values: Object.fromEntries(headers.map((header, column) => [header, cells[column] ?? ""]))
    };
  });
  return { headers, rows };
}

/** @param {string} xml */
function validateNamespace(xml) {
  const root = /<(?:[\w.-]+:)?Workbook\b([^>]*)>/u.exec(xml);
  if (!root || attribute(root[1] || "", "xmlns") !== SPREADSHEET_NAMESPACE) {
    throw importError(
      "MBT_IMPORT_SPREADSHEETML_NAMESPACE_INVALID",
      "The workbook is not Excel 2003 SpreadsheetML."
    );
  }
}

/** @param {ReturnType<typeof normalizeCustomerImportRows>["summary"]} summary @param {number} repairs */
function aggregateWarnings(summary, repairs) {
  return [
    ["MBT_IMPORT_SPREADSHEETML_AMPERSAND_REPAIRED", repairs],
    ["MBT_IMPORT_CUSTOMER_ENTITY_NUMBER_INCOMPLETE", summary.incompleteEntityNumberRows],
    ["MBT_IMPORT_CUSTOMER_SUBSIDIARY_SKIPPED", summary.skippedSubsidiaryRows],
    ["MBT_IMPORT_CUSTOMER_STATUS_SKIPPED", summary.skippedStatusRows]
  ].filter(([, count]) => Number(count) > 0)
    .map(([code, count]) => ({ code, count }));
}

/**
 * Parse the bounded, non-executable Excel 2003 XML customer export shape.
 * @param {unknown} input
 * @param {unknown} defaults
 */
export async function parseCustomerSpreadsheetMl(input, defaults) {
  const buffer = inputBuffer(input);
  if (buffer.length > DEFAULT_IMPORT_LIMITS.maxBytes) {
    throw importError("MBT_IMPORT_FILE_TOO_LARGE", "The workbook exceeds the byte limit.");
  }
  rejectBinaryWorkbook(buffer);
  const originalXml = decodeWorkbook(buffer);
  rejectExecutableXml(originalXml);
  const repaired = repairDataAmpersands(originalXml);
  validateNamespace(repaired.xml);
  validateXmlStructure(repaired.xml);
  const extracted = rawCustomerRows(worksheetTable(repaired.xml));
  const fileHash = createHash("sha256").update(buffer).digest("hex");
  const normalized = normalizeCustomerImportRows(extracted.rows, {
    .../** @type {Record<string, unknown>} */ (defaults),
    sourceVersion: fileHash
  });
  return {
    schemaVersion: "mbt-customer-spreadsheetml-v1",
    sourceKind: "csv_bootstrap",
    fileHash,
    normalizedHash: normalized.normalizedHash,
    headers: extracted.headers,
    ignoredHeaders: [...IGNORED_HEADERS],
    rows: normalized.rows,
    summary: {
      ...normalized.summary,
      repairedDataNodeAmpersands: repaired.repairs
    },
    warnings: aggregateWarnings(normalized.summary, repaired.repairs)
  };
}
