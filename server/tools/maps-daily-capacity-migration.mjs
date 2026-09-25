import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { closeDb, query, withTransaction } from "../src/db.js";

assert.equal(process.env.MBT_TEST_ISOLATED, "1");
try {
  await withTransaction(async () => {
    const id = crypto.randomUUID();
    await query("INSERT INTO google_maps_daily_reopens(id, day, added_units, actor_id) VALUES($1, CURRENT_DATE, 150, $2)", [id, "a".repeat(64)]);
    await withTransaction(async () => {
      await query("DROP TABLE google_maps_daily_reopens");
      await query(await readFile("migrations/219_google_maps_daily_capacity.sql", "utf8"));
      assert.equal((await query("SELECT id FROM google_maps_daily_reopens WHERE id=$1", [id])).rowCount, 0);
    }, { rollback: true });
    assert.equal((await query("SELECT id FROM google_maps_daily_reopens WHERE id=$1", [id])).rowCount, 1);
  }, { rollback: true });
  console.log("Additive migration rollback restores the existing table and its grant history.");
} finally {
  await closeDb();
}
