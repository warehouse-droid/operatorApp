import assert from "node:assert/strict";
import test from "node:test";

const EXPECTED_DEFAULT_LIMITS = Object.freeze({
  maxBytes: 20 * 1024 * 1024,
  maxRows: 50_000,
  maxColumns: 200,
  maxCellCharacters: 4_000,
  maxErrors: 200
});

function futureCsv() {
  return import("../../../src/mbt/bounded-csv.js");
}

/** @param {unknown} error @param {string} code */
function hasCode(error, code) {
  return Boolean(error && typeof error === "object" && error.code === code);
}

/** @param {readonly (string | Buffer)[]} chunks */
async function* chunked(chunks) {
  for (const chunk of chunks) {
    yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
  }
}

test("P3-F08 CSV: defaults freeze the approved import bounds", async () => {
  const { DEFAULT_IMPORT_LIMITS } = await futureCsv();
  assert.deepEqual(DEFAULT_IMPORT_LIMITS, EXPECTED_DEFAULT_LIMITS);
  assert.equal(Object.isFrozen(DEFAULT_IMPORT_LIMITS), true);
});

test("P3-F08 CSV: RFC 4180 quoting survives arbitrary stream chunk boundaries", async () => {
  const { parseBoundedCsv } = await futureCsv();
  const parsed = await parseBoundedCsv(chunked([
    "\uFEFFitem_code,display_name,description\r\n",
    'BIN-14,"14 yard, synthetic","first line\r',
    '\nsecond ""quoted"" line"\r\n',
    "BIN-20,20 yard,plain\r\n"
  ]), {
    requiredHeaders: ["item_code", "display_name"],
    optionalHeaders: ["description"]
  });

  assert.deepEqual(parsed.headers, ["item_code", "display_name", "description"]);
  assert.deepEqual(parsed.rows, [
    {
      rowNumber: 2,
      values: {
        item_code: "BIN-14",
        display_name: "14 yard, synthetic",
        description: "first line\r\nsecond \"quoted\" line"
      }
    },
    {
      rowNumber: 3,
      values: {
        item_code: "BIN-20",
        display_name: "20 yard",
        description: "plain"
      }
    }
  ]);
  assert.equal(parsed.rowCount, 2);
  assert.ok(parsed.byteLength > 0);
});

test("P3-F08 CSV: invalid UTF-8, NUL, and non-tab controls fail with no partial rows", async () => {
  const { parseBoundedCsv } = await futureCsv();
  const cases = [
    [Buffer.from([0x69, 0x64, 0x0a, 0xc3, 0x28]), "MBT_IMPORT_INVALID_UTF8"],
    [Buffer.from("id,name\n1,bad\u0000value"), "MBT_IMPORT_UNSAFE_CHARACTER"],
    [Buffer.from("id,name\n1,bad\u0001value"), "MBT_IMPORT_UNSAFE_CHARACTER"]
  ];
  for (const [input, code] of cases) {
    await assert.rejects(
      () => parseBoundedCsv(input, {
        requiredHeaders: ["id", "name"]
      }),
      (error) => hasCode(error, code),
      String(code)
    );
  }
});

test("P3-F08 CSV: byte, row, column, and cell bounds fail closed at the boundary", async () => {
  const { parseBoundedCsv } = await futureCsv();
  const cases = [
    {
      input: "id,name\n1,synthetic",
      limits: { maxBytes: 8 },
      code: "MBT_IMPORT_FILE_TOO_LARGE"
    },
    {
      input: "id,name\n1,a\n2,b",
      limits: { maxRows: 1 },
      code: "MBT_IMPORT_ROW_LIMIT"
    },
    {
      input: "id,name,extra\n1,a,b",
      limits: { maxColumns: 2 },
      code: "MBT_IMPORT_COLUMN_LIMIT"
    },
    {
      input: "id,name\n1,abcd",
      limits: { maxCellCharacters: 3 },
      code: "MBT_IMPORT_CELL_LIMIT"
    }
  ];
  for (const { input, limits, code } of cases) {
    await assert.rejects(
      () => parseBoundedCsv(Buffer.from(input), {
        requiredHeaders: ["id", "name"],
        optionalHeaders: ["extra"],
        limits
      }),
      (error) => hasCode(error, code),
      code
    );
  }
});

test("P3-F08 CSV: callers may lower but never raise an approved bound", async () => {
  const { parseBoundedCsv } = await futureCsv();
  for (const [key, value] of Object.entries(EXPECTED_DEFAULT_LIMITS)) {
    await assert.rejects(
      () => parseBoundedCsv("id\n1", {
        requiredHeaders: ["id"],
        limits: { [key]: value + 1 }
      }),
      (error) => hasCode(error, "MBT_IMPORT_LIMIT_INVALID"),
      key
    );
  }

  const lowered = await parseBoundedCsv("id\n1", {
    requiredHeaders: ["id"],
    limits: { maxRows: 1, maxColumns: 1, maxCellCharacters: 2, maxBytes: 4, maxErrors: 1 }
  });
  assert.equal(lowered.rowCount, 1);
});

test("P3-F08 CSV: duplicate, unknown, missing headers and extra cells are distinct safe errors", async () => {
  const { parseBoundedCsv } = await futureCsv();
  const cases = [
    ["id,id\n1,2", "MBT_IMPORT_DUPLICATE_HEADER"],
    ["id,unexpected\n1,2", "MBT_IMPORT_UNKNOWN_HEADER"],
    ["id\n1", "MBT_IMPORT_REQUIRED_HEADER_MISSING"],
    ["id,name\n1,synthetic,extra", "MBT_IMPORT_EXTRA_CELL"]
  ];
  for (const [input, code] of cases) {
    await assert.rejects(
      () => parseBoundedCsv(input, {
        requiredHeaders: ["id", "name"]
      }),
      (error) => hasCode(error, code),
      code
    );
  }
});

test("P3-F08 CSV: exported report cells neutralize spreadsheet formula prefixes", async () => {
  const { parseBoundedCsv, serializeCsv } = await futureCsv();
  const output = serializeCsv({
    headers: ["code", "detail"],
    rows: [
      { code: "A", detail: "=WEBSERVICE(\"https://example.invalid\")" },
      { code: "B", detail: "+1+1" },
      { code: "C", detail: "-2+3" },
      { code: "D", detail: "@SUM(1,2)" }
    ],
    protectFormulae: true
  });
  const parsed = await parseBoundedCsv(output, {
    requiredHeaders: ["code", "detail"]
  });
  assert.deepEqual(
    parsed.rows.map(({ values }) => values.detail),
    [
      "'=WEBSERVICE(\"https://example.invalid\")",
      "'+1+1",
      "'-2+3",
      "'@SUM(1,2)"
    ]
  );
});
