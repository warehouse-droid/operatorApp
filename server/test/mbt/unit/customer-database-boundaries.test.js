// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

import {
  customerDatabase,
  withCustomerTransaction
} from "../../../src/mbt/customer-database.js";

test("P3-F04 customer database rejects every non-query boundary", async () => {
  for (const value of [null, undefined, false, "query", [], {}, { query: 1 }]) {
    assert.throws(
      () => customerDatabase(value),
      (error) => error instanceof TypeError
        && error.message === "A customer database query boundary is required."
    );
  }
  await assert.rejects(
    () => withCustomerTransaction({
      async query() {
        return { rows: [] };
      },
      async connect() {
        return {};
      }
    }, async () => "not reached"),
    (error) => error instanceof TypeError
      && error.message === "A customer database query boundary is required."
  );
});

test("P3-F04 customer query boundaries never acquire or release an existing transaction", async () => {
  const calls = [];
  const boundary = {
    async query(sql) {
      calls.push(sql);
      return { rows: [{ value: "kept" }], rowCount: 1 };
    }
  };
  const result = await withCustomerTransaction(boundary, async (client) => (
    (await client.query("SELECT synthetic")).rows[0].value
  ));
  assert.equal(result, "kept");
  assert.deepEqual(calls, ["SELECT synthetic"]);
});

test("P3-F04 owned transactions preserve the original error when rollback also fails", async () => {
  const calls = [];
  let releases = 0;
  const original = new Error("synthetic operation failure");
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql === "ROLLBACK") {
        throw new Error("synthetic rollback failure");
      }
      return { rows: [] };
    },
    release() {
      releases += 1;
    }
  };
  await assert.rejects(
    () => withCustomerTransaction({
      async query() {
        return { rows: [] };
      },
      async connect() {
        return client;
      }
    }, async () => {
      throw original;
    }),
    (error) => error === original
  );
  assert.deepEqual(calls, ["BEGIN", "ROLLBACK"]);
  assert.equal(releases, 1);
});
