// @ts-check

import { MbtError } from "./errors.js";
import { TextDecoder } from "node:util";

export const DEFAULT_IMPORT_LIMITS = Object.freeze({
  maxBytes: 20 * 1024 * 1024,
  maxRows: 50_000,
  maxColumns: 200,
  maxCellCharacters: 4_000,
  maxErrors: 200
});
const CSV_SEPARATORS = new Set([",", "\r", "\n"]);
const CSV_NEWLINES = new Set(["\r", "\n"]);

/** @typedef {keyof typeof DEFAULT_IMPORT_LIMITS} ImportLimitName */
/** @typedef {{maxBytes: number, maxRows: number, maxColumns: number, maxCellCharacters: number, maxErrors: number}} ImportLimits */
/** @typedef {{rowNumber: number, values: Record<string, string>}} ParsedCsvRow */
/** @typedef {{records: string[][], row: string[], field: string, state: string, atRecordStart: boolean}} CsvParserState */

/** @param {string} code @param {string} message @param {Record<string, unknown>} [details] */
function importError(code, message, details = {}) {
  return new MbtError({ status: 400, code, message, details });
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** @param {unknown} value @returns {value is AsyncIterable<unknown>} */
function isAsyncIterable(value) {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = /** @type {{[Symbol.asyncIterator]?: unknown}} */ (value);
  return typeof candidate[Symbol.asyncIterator] === "function";
}

/** @param {unknown} value @returns {Buffer} */
function chunkBuffer(value) {
  if (typeof value === "string") {
    return Buffer.from(value, "utf8");
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  throw new TypeError("CSV input chunks must be UTF-8 text or bytes.");
}

/**
 * @param {unknown} input
 * @param {number} maxBytes
 * @returns {Promise<Buffer>}
 */
async function collectBoundedInput(input, maxBytes) {
  if (typeof input === "string" || Buffer.isBuffer(input) || input instanceof Uint8Array) {
    const buffer = chunkBuffer(input);
    if (buffer.length > maxBytes) {
      throw importError("MBT_IMPORT_FILE_TOO_LARGE", "The import file exceeds the byte limit.");
    }
    return buffer;
  }
  if (!isAsyncIterable(input)) {
    throw new TypeError("CSV input must be text, bytes, or an asynchronous byte stream.");
  }

  /** @type {Buffer[]} */
  const chunks = [];
  let byteLength = 0;
  for await (const chunk of input) {
    const buffer = chunkBuffer(chunk);
    byteLength += buffer.length;
    if (byteLength > maxBytes) {
      throw importError("MBT_IMPORT_FILE_TOO_LARGE", "The import file exceeds the byte limit.");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, byteLength);
}

/** @param {Buffer} buffer */
function decodeUtf8(buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer).replace(/^\uFEFF/, "");
  } catch (error) {
    throw importError(
      "MBT_IMPORT_INVALID_UTF8",
      "The import file is not valid UTF-8.",
      { causeName: error instanceof Error ? error.name : "decode_error" }
    );
  }
}

/** @param {string} text */
function rejectUnsafeCharacters(text) {
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(text)) {
    throw importError(
      "MBT_IMPORT_UNSAFE_CHARACTER",
      "The import contains a prohibited control character."
    );
  }
}

/** @param {ImportLimitName} key @param {unknown} value */
function boundedLimit(key, value) {
  const approved = DEFAULT_IMPORT_LIMITS[key];
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > approved) {
    throw importError(
      "MBT_IMPORT_LIMIT_INVALID",
      "Import limits may only be configured downward.",
      { limit: key }
    );
  }
  return Number(value);
}

/** @param {unknown} overrides @returns {ImportLimits} */
function normalizedLimits(overrides) {
  if (overrides === undefined) {
    return { ...DEFAULT_IMPORT_LIMITS };
  }
  if (!isRecord(overrides)) {
    throw importError("MBT_IMPORT_LIMIT_INVALID", "Import limits must be an object.");
  }
  const unknown = Object.keys(overrides).filter((key) => !Object.hasOwn(DEFAULT_IMPORT_LIMITS, key));
  if (unknown.length > 0) {
    throw importError("MBT_IMPORT_LIMIT_INVALID", "An import limit is not supported.", {
      limit: unknown[0]
    });
  }
  /** @param {ImportLimitName} key */
  const limit = (key) => Object.hasOwn(overrides, key)
    ? boundedLimit(key, overrides[key])
    : DEFAULT_IMPORT_LIMITS[key];
  return {
    maxBytes: limit("maxBytes"),
    maxRows: limit("maxRows"),
    maxColumns: limit("maxColumns"),
    maxCellCharacters: limit("maxCellCharacters"),
    maxErrors: limit("maxErrors")
  };
}

/** @param {string} value @param {number} maxCellCharacters */
function validateCell(value, maxCellCharacters) {
  if ([...value].length > maxCellCharacters) {
    throw importError("MBT_IMPORT_CELL_LIMIT", "An import cell exceeds the character limit.");
  }
}

/** @param {CsvParserState} parser @param {ImportLimits} limits */
function finishCsvField(parser, limits) {
  validateCell(parser.field, limits.maxCellCharacters);
  parser.row.push(parser.field);
  if (parser.row.length > limits.maxColumns) {
    throw importError("MBT_IMPORT_COLUMN_LIMIT", "The import exceeds the column limit.");
  }
  parser.field = "";
}

/** @param {CsvParserState} parser @param {ImportLimits} limits */
function finishCsvRecord(parser, limits) {
  finishCsvField(parser, limits);
  parser.records.push(parser.row);
  if (parser.records.length > limits.maxRows + 1) {
    throw importError("MBT_IMPORT_ROW_LIMIT", "The import exceeds the logical row limit.");
  }
  parser.row = [];
  parser.state = "start";
  parser.atRecordStart = true;
}

/** @param {CsvParserState} parser @param {string} text @param {number} index */
function consumeQuotedCharacter(parser, text, index) {
  const character = text[index] ?? "";
  if (character !== '"') {
    parser.field += character;
    return index;
  }
  if (text[index + 1] === '"') {
    parser.field += '"';
    return index + 1;
  }
  parser.state = "after_quote";
  return index;
}

/** @param {CsvParserState} parser @param {string} text @param {number} index @param {ImportLimits} limits */
function consumeCsvNewline(parser, text, index, limits) {
  const consumed = text[index] === "\r" && text[index + 1] === "\n" ? index + 1 : index;
  finishCsvRecord(parser, limits);
  return consumed;
}

/** @param {CsvParserState} parser @param {string} text @param {number} index @param {ImportLimits} limits */
function consumePlainCharacter(parser, text, index, limits) {
  const character = text[index] ?? "";
  if (parser.state === "after_quote" && !CSV_SEPARATORS.has(character)) {
    throw importError("MBT_IMPORT_CSV_MALFORMED", "Quoted CSV data has trailing characters.");
  }
  if (character === ",") {
    finishCsvField(parser, limits);
    parser.state = "start";
    parser.atRecordStart = false;
    return index;
  }
  if (CSV_NEWLINES.has(character)) {
    return consumeCsvNewline(parser, text, index, limits);
  }
  if (character === '"') {
    if (parser.state !== "start" || parser.field.length > 0) {
      throw importError("MBT_IMPORT_CSV_MALFORMED", "A CSV quote appears outside a quoted cell.");
    }
    parser.state = "quoted";
    parser.atRecordStart = false;
    return index;
  }
  parser.field += character;
  parser.state = "unquoted";
  parser.atRecordStart = false;
  return index;
}

/** @param {string} text @param {ImportLimits} limits */
function csvRecords(text, limits) {
  /** @type {CsvParserState} */
  const parser = { records: [], row: [], field: "", state: "start", atRecordStart: true };
  for (let index = 0; index < text.length; index += 1) {
    index = parser.state === "quoted"
      ? consumeQuotedCharacter(parser, text, index)
      : consumePlainCharacter(parser, text, index, limits);
  }
  if (parser.state === "quoted") {
    throw importError("MBT_IMPORT_CSV_MALFORMED", "A quoted CSV cell is not closed.");
  }
  if (!parser.atRecordStart || parser.records.length === 0) {
    finishCsvRecord(parser, limits);
  }
  return parser.records;
}

/** @param {readonly string[]} headers @param {readonly string[]} required @param {readonly string[]} optional */
function validateHeaders(headers, required, optional) {
  if (new Set(headers).size !== headers.length) {
    throw importError("MBT_IMPORT_DUPLICATE_HEADER", "The import has a duplicate header.");
  }
  const allowed = new Set([...required, ...optional]);
  const unknown = headers.find((header) => !allowed.has(header));
  if (unknown !== undefined) {
    throw importError("MBT_IMPORT_UNKNOWN_HEADER", "The import has an unknown header.", { header: unknown });
  }
  const missing = required.find((header) => !headers.includes(header));
  if (missing !== undefined) {
    throw importError(
      "MBT_IMPORT_REQUIRED_HEADER_MISSING",
      "The import is missing a required header.",
      { header: missing }
    );
  }
}

/** @param {unknown} value @param {string} label */
function headerList(value, label) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new TypeError(`${label} must be a list of non-empty header names.`);
  }
  return /** @type {string[]} */ ([...value]);
}

/**
 * Parse bounded RFC 4180 CSV from text, bytes, or an asynchronous chunk stream.
 * Uploaded bytes are retained only for the duration of this call.
 *
 * @param {unknown} input
 * @param {object} options
 * @param {readonly string[]} options.requiredHeaders
 * @param {readonly string[]} [options.optionalHeaders]
 * @param {Partial<typeof DEFAULT_IMPORT_LIMITS>} [options.limits]
 * @returns {Promise<{headers: string[], rows: ParsedCsvRow[], rowCount: number, byteLength: number}>}
 */
export async function parseBoundedCsv(input, {
  requiredHeaders,
  optionalHeaders = [],
  limits: limitOverrides
}) {
  const limits = normalizedLimits(limitOverrides);
  const buffer = await collectBoundedInput(input, limits.maxBytes);
  const text = decodeUtf8(buffer);
  rejectUnsafeCharacters(text);
  const records = csvRecords(text, limits);
  const headers = records.shift() || [];
  const required = headerList(requiredHeaders, "Required headers");
  const optional = headerList(optionalHeaders, "Optional headers");
  validateHeaders(headers, required, optional);

  /** @type {ParsedCsvRow[]} */
  const rows = records.map((cells, index) => {
    if (cells.length > headers.length) {
      throw importError("MBT_IMPORT_EXTRA_CELL", "An import row has more cells than its header.", {
        rowNumber: index + 2
      });
    }
    return {
      rowNumber: index + 2,
      values: Object.fromEntries(headers.map((header, column) => [header, cells[column] ?? ""]))
    };
  });
  return { headers, rows, rowCount: rows.length, byteLength: buffer.length };
}

/** @param {unknown} value @param {boolean} protectFormulae */
function reportCell(value, protectFormulae) {
  const rendered = value === null || value === undefined ? "" : String(value);
  return protectFormulae && /^[\u0000-\u0020]*[=+@-]/u.test(rendered)
    ? `'${rendered}`
    : rendered;
}

/** @param {string} value */
function quoteCsv(value) {
  return /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/**
 * @param {object} input
 * @param {readonly string[]} input.headers
 * @param {readonly Record<string, unknown>[]} input.rows
 * @param {boolean} [input.protectFormulae]
 */
export function serializeCsv({ headers, rows, protectFormulae = true }) {
  const normalizedHeaders = headerList(headers, "CSV headers");
  if (!Array.isArray(rows) || rows.some((row) => !isRecord(row))) {
    throw new TypeError("CSV rows must be records.");
  }
  return [
    normalizedHeaders.map((header) => quoteCsv(header)).join(","),
    ...rows.map((row) => normalizedHeaders.map((header) => (
      quoteCsv(reportCell(row[header], protectFormulae))
    )).join(","))
  ].join("\r\n");
}
