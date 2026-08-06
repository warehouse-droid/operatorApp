import assert from "node:assert/strict";
import test from "node:test";

import fc from "fast-check";

import {
  CUSTOMER_IMPORT_DEFAULTS,
  syntheticCustomerRow
} from "../support/master-data-import-fixtures.js";

function futureCsv() {
  return import("../../../src/mbt/bounded-csv.js");
}

function futureNormalizer() {
  return import("../../../src/mbt/customer-import-normalizer.js");
}

/** @param {unknown} error @param {string} code */
function hasCode(error, code) {
  return Boolean(error && typeof error === "object" && error.code === code);
}

const safeCell = fc.array(fc.constantFrom(
  "a", "Z", "0", "9", " ", ",", '"', "\r", "\n", "_", "-", "é", "中", "&"
), { maxLength: 80 }).map((characters) => characters.join(""));

const safeName = fc.array(fc.constantFrom(
  "a", "Z", "0", "9", " ", "_", "-", "é", "中", "&"
), { minLength: 1, maxLength: 80 })
  .map((characters) => characters.join(""))
  .filter((value) => value.trim().length > 0);

test("P3-F08 property: RFC 4180 serialization and bounded parsing round-trip 1,000 examples", async () => {
  const { parseBoundedCsv, serializeCsv } = await futureCsv();
  await fc.assert(fc.asyncProperty(
    fc.array(fc.record({ code: safeCell, detail: safeCell })
      .map(({ code, detail }) => ({ code, detail })), { maxLength: 12 }),
    async (rows) => {
      const serialized = serializeCsv({
        headers: ["code", "detail"],
        rows,
        protectFormulae: false
      });
      const parsed = await parseBoundedCsv(serialized, {
        requiredHeaders: ["code", "detail"]
      });
      assert.deepEqual(parsed.rows.map(({ values }) => values), rows);
    }
  ), { numRuns: 1000 });
});

test("P3-F06 property: normalization is deterministic, hash-sensitive, and preserves exact names", async () => {
  const { normalizeCustomerImportRows } = await futureNormalizer();
  await fc.assert(fc.asyncProperty(
    fc.integer({ min: 100_000, max: 999_999_999 }),
    safeName,
    async (id, name) => {
      const raw = [{
        rowNumber: 2,
        values: syntheticCustomerRow({ id, Name: name })
      }];
      const first = normalizeCustomerImportRows(raw, {
        ...CUSTOMER_IMPORT_DEFAULTS,
        sourceVersion: "a".repeat(64)
      });
      const replay = normalizeCustomerImportRows(structuredClone(raw), {
        ...CUSTOMER_IMPORT_DEFAULTS,
        sourceVersion: "a".repeat(64)
      });
      const changed = normalizeCustomerImportRows([{
        rowNumber: 2,
        values: syntheticCustomerRow({ id, Name: `${name} changed` })
      }], {
        ...CUSTOMER_IMPORT_DEFAULTS,
        sourceVersion: "b".repeat(64)
      });

      assert.equal(first.rows[0].customerInternalId, String(id));
      assert.equal(first.rows[0].legalName, name);
      assert.equal(first.rows[0].displayName, name);
      assert.equal(replay.normalizedHash, first.normalizedHash);
      assert.deepEqual(replay.rows, first.rows);
      assert.notEqual(changed.normalizedHash, first.normalizedHash);
    }
  ), { numRuns: 1000 });
});

test("P3-F08 property: identities are positive internal IDs and never collapse by customer name", async () => {
  const { normalizeCustomerImportRows } = await futureNormalizer();
  await fc.assert(fc.asyncProperty(
    fc.uniqueArray(fc.integer({ min: 1, max: 9_000_000_000 }), {
      minLength: 2,
      maxLength: 8
    }),
    safeName,
    async (ids, sharedName) => {
      const exactSharedName = `Synthetic ${sharedName}`;
      const normalized = normalizeCustomerImportRows(ids.map((id, index) => ({
        rowNumber: index + 2,
        values: syntheticCustomerRow({ id, Name: exactSharedName })
      })), {
        ...CUSTOMER_IMPORT_DEFAULTS,
        sourceVersion: "c".repeat(64)
      });
      assert.deepEqual(
        normalized.rows.map(({ customerInternalId }) => customerInternalId).sort(),
        ids.map(String).sort()
      );
      assert.equal(new Set(normalized.rows.map(({ entityNumber }) => entityNumber)).size, ids.length);

      const duplicate = ids.length === 0 ? "1" : String(ids[0]);
      assert.throws(() => normalizeCustomerImportRows([
        { rowNumber: 2, values: syntheticCustomerRow({ id: duplicate, Name: exactSharedName }) },
        { rowNumber: 3, values: syntheticCustomerRow({ id: duplicate, Name: `${exactSharedName} duplicate` }) }
      ], {
        ...CUSTOMER_IMPORT_DEFAULTS,
        sourceVersion: "c".repeat(64)
      }), (error) => hasCode(error, "MBT_IMPORT_DUPLICATE_ID"));
    }
  ), { numRuns: 1000 });
});

test("P3-F08 property: every formula prefix is neutralized in exported reports", async () => {
  const { parseBoundedCsv, serializeCsv } = await futureCsv();
  await fc.assert(fc.asyncProperty(
    fc.constantFrom("=", "+", "-", "@"),
    safeCell,
    async (prefix, suffix) => {
      const output = serializeCsv({
        headers: ["value"],
        rows: [{ value: `${prefix}${suffix}` }],
        protectFormulae: true
      });
      const parsed = await parseBoundedCsv(output, { requiredHeaders: ["value"] });
      assert.equal(parsed.rows[0].values.value, `'${prefix}${suffix}`);
    }
  ), { numRuns: 1000 });
});
