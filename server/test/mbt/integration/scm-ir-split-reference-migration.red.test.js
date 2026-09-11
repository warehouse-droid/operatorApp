import assert from "node:assert/strict";
import test from "node:test";
import { closeDb, query } from "../../../src/db.js";

test.after(async () => {
  await closeDb();
});

test("migration exposes a nullable durable transaction_memo column", async () => {
  const result = await query(
    `SELECT data_type, is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'scm_reconciliation_transaction_snapshots'
        AND column_name = 'transaction_memo'`
  );
  assert.deepEqual(result.rows, [{ data_type: "text", is_nullable: "YES" }]);
});
