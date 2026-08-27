// @ts-check

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after } from "node:test";

import { closeDb, query, withTransaction } from "../../../src/db.js";

const migration = await readFile(
  new URL("../../../migrations/178_operator_netsuite_posting_gates.sql", import.meta.url),
  "utf8"
);

after(async () => {
  await closeDb();
});

test("G1 migration upgrade restores a missing cell off without changing an existing Admin choice", async () => {
  await withTransaction(async () => {
    await query(
      `UPDATE mbt_feature_flags
          SET enabled = true,
              revision = revision + 1
        WHERE flag_key = 'operator_netsuite_delivery_prep_if_12441'`
    );
    await query(
      `DELETE FROM mbt_feature_flags
        WHERE flag_key = 'operator_netsuite_customer_pickup_if_3445'`
    );
    await query(migration);
    const rows = await query(
      `SELECT flag_key, enabled
         FROM mbt_feature_flags
        WHERE flag_key IN (
          'operator_netsuite_delivery_prep_if_12441',
          'operator_netsuite_customer_pickup_if_3445'
        )
        ORDER BY flag_key`
    );
    assert.deepEqual(rows.rows, [
      { flag_key: "operator_netsuite_customer_pickup_if_3445", enabled: false },
      { flag_key: "operator_netsuite_delivery_prep_if_12441", enabled: true }
    ]);
  }, { rollback: true });
});
