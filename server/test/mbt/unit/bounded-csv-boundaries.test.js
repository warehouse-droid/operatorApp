import assert from "node:assert/strict";
import test from "node:test";

function futureCsv() {
  return import("../../../src/mbt/bounded-csv.js");
}

/** @param {unknown} error @param {string} code @param {Record<string, unknown>} [details] */
function exactImportError(error, code, details = {}) {
  return Boolean(error && typeof error === "object"
    && error.name === "MbtError"
    && error.status === 400
    && error.code === code
    && assert.deepEqual(error.details, details) === undefined);
}

/** @param {unknown} error @param {string} message */
function exactTypeError(error, message) {
  return error instanceof TypeError && error.message === message;
}

/** @param {readonly unknown[]} chunks */
async function* chunked(chunks) {
  for (const chunk of chunks) {
    yield chunk;
  }
}

test("P3-F08 CSV boundaries: cumulative streams stop at the byte cap and reject non-byte chunks", async () => {
  const { parseBoundedCsv } = await futureCsv();
  let yielded = 0;
  async function* oversized() {
    yielded += 1;
    yield "id\n";
    yielded += 1;
    yield new Uint8Array([49, 10]);
    yielded += 1;
    yield "2";
    yielded += 1;
    throw new Error("the parser must stop before consuming this chunk");
  }

  await assert.rejects(
    parseBoundedCsv(oversized(), {
      requiredHeaders: ["id"],
      limits: { maxBytes: 5 }
    }),
    (error) => exactImportError(error, "MBT_IMPORT_FILE_TOO_LARGE")
  );
  assert.equal(yielded, 3, "the bounded collector must not read beyond the failing chunk");

  await assert.rejects(
    parseBoundedCsv(chunked(["id\n", { unsafe: true }]), { requiredHeaders: ["id"] }),
    (error) => exactTypeError(error, "CSV input chunks must be UTF-8 text or bytes.")
  );
  await assert.rejects(
    parseBoundedCsv({ value: "id\n1" }, { requiredHeaders: ["id"] }),
    (error) => exactTypeError(error, "CSV input must be text, bytes, or an asynchronous byte stream.")
  );
});

test("P3-F08 CSV boundaries: limit policy rejects malformed, unknown, and non-downward overrides", async (t) => {
  const { parseBoundedCsv } = await futureCsv();
  const cases = [
    ["non-object", null, "MBT_IMPORT_LIMIT_INVALID", {}],
    ["array", [], "MBT_IMPORT_LIMIT_INVALID", {}],
    ["unknown", { maxMagic: 1 }, "MBT_IMPORT_LIMIT_INVALID", { limit: "maxMagic" }],
    ["zero", { maxRows: 0 }, "MBT_IMPORT_LIMIT_INVALID", { limit: "maxRows" }],
    ["fractional", { maxColumns: 1.5 }, "MBT_IMPORT_LIMIT_INVALID", { limit: "maxColumns" }],
    ["NaN", { maxErrors: Number.NaN }, "MBT_IMPORT_LIMIT_INVALID", { limit: "maxErrors" }]
  ];
  for (const [name, limits, code, details] of cases) {
    await t.test(name, async () => {
      await assert.rejects(
        parseBoundedCsv("id\n1", { requiredHeaders: ["id"], limits }),
        (error) => exactImportError(error, code, details)
      );
    });
  }

  const parsed = await parseBoundedCsv(new Uint8Array(Buffer.from("id,name\r1,A\n2,B")), {
    requiredHeaders: ["id"],
    optionalHeaders: ["name"],
    limits: { maxRows: 2 }
  });
  assert.deepEqual(parsed.rows.map(({ rowNumber, values }) => ({ rowNumber, values })), [
    { rowNumber: 2, values: { id: "1", name: "A" } },
    { rowNumber: 3, values: { id: "2", name: "B" } }
  ]);
});

test("P3-F08 CSV boundaries: malformed quote states are distinct fail-closed grammar errors", async (t) => {
  const { parseBoundedCsv } = await futureCsv();
  const cases = [
    ["quote in plain cell", "id,name\n1,a\"b", "A CSV quote appears outside a quoted cell."],
    ["characters after quote", "id,name\n1,\"a\"tail", "Quoted CSV data has trailing characters."],
    ["unclosed quote", "id,name\n1,\"a", "A quoted CSV cell is not closed."]
  ];
  for (const [name, input, message] of cases) {
    await t.test(name, async () => {
      await assert.rejects(
        parseBoundedCsv(input, { requiredHeaders: ["id", "name"] }),
        (error) => Boolean(error && typeof error === "object"
          && error.code === "MBT_IMPORT_CSV_MALFORMED"
          && error.status === 400
          && error.message === message)
      );
    });
  }
});

test("P3-F08 CSV boundaries: header contracts reject invalid declarations before producing rows", async (t) => {
  const { parseBoundedCsv } = await futureCsv();
  const cases = [
    ["required is not a list", { requiredHeaders: "id" }, "Required headers must be a list of non-empty header names."],
    ["required contains blank", { requiredHeaders: ["id", ""] }, "Required headers must be a list of non-empty header names."],
    ["optional contains non-text", { requiredHeaders: ["id"], optionalHeaders: [7] }, "Optional headers must be a list of non-empty header names."]
  ];
  for (const [name, options, message] of cases) {
    await t.test(name, async () => {
      await assert.rejects(
        parseBoundedCsv("id\n1", options),
        (error) => exactTypeError(error, message)
      );
    });
  }

  const sparse = await parseBoundedCsv("id,name,detail\n1,A", {
    requiredHeaders: ["id", "name"],
    optionalHeaders: ["detail"]
  });
  assert.deepEqual(sparse.rows, [{
    rowNumber: 2,
    values: { id: "1", name: "A", detail: "" }
  }]);
});

test("P3-F08 CSV boundaries: serialization rejects non-record rows and renders nulls safely", async () => {
  const { parseBoundedCsv, serializeCsv } = await futureCsv();
  for (const rows of [null, {}, [null], [[]]]) {
    assert.throws(
      () => serializeCsv({ headers: ["value"], rows }),
      (error) => exactTypeError(error, "CSV rows must be records.")
    );
  }
  assert.throws(
    () => serializeCsv({ headers: [""], rows: [] }),
    (error) => exactTypeError(error, "CSV headers must be a list of non-empty header names.")
  );

  const output = serializeCsv({
    headers: ["kind", "value"],
    rows: [
      { kind: "null", value: null },
      { kind: "missing" },
      { kind: "formula", value: " \t=1+1" },
      { kind: "plain", value: "not-a-formula" },
      { kind: "quoted", value: "a,\"b\"\r\nc" }
    ]
  });
  const parsed = await parseBoundedCsv(output, { requiredHeaders: ["kind", "value"] });
  assert.deepEqual(parsed.rows.map(({ values }) => values), [
    { kind: "null", value: "" },
    { kind: "missing", value: "" },
    { kind: "formula", value: "' \t=1+1" },
    { kind: "plain", value: "not-a-formula" },
    { kind: "quoted", value: "a,\"b\"\r\nc" }
  ]);
});
