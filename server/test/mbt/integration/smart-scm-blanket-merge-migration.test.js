import assert from "node:assert/strict";
import test, { after } from "node:test";

import { closeDb, query, withTransaction } from "../../../src/db.js";

after(closeDb);

async function mergeColumns() {
  const result = await query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'scm_smart_proposals'
        AND column_name = ANY($1::text[])
      ORDER BY column_name`,
    [["merged_at", "merged_by", "merged_into_proposal_id"]]
  );
  return result.rows.map((row) => row.column_name);
}

test("Blanket merge schema rollback rehearsal restores all lineage columns", async () => {
  const expected = ["merged_at", "merged_by", "merged_into_proposal_id"];
  assert.deepEqual(await mergeColumns(), expected);
  await withTransaction(async () => {
    await query(
      `ALTER TABLE scm_smart_proposals
         DROP COLUMN merged_into_proposal_id,
         DROP COLUMN merged_at,
         DROP COLUMN merged_by`
    );
    assert.deepEqual(await mergeColumns(), []);
  }, { rollback: true });
  assert.deepEqual(await mergeColumns(), expected,
    "A failed or cancelled deployment transaction must leave the pre-deploy schema intact.");
});
