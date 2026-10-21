import assert from "node:assert/strict";
import test, { after } from "node:test";
import { closeDb, query, withTransaction } from "../../../src/db.js";
import { getOperatorProgressDetails } from "../../../src/operator-order-progress-repository.js";
import { evaluateDependencyMutationBlockers } from "../../../src/scm-dependency-management-policy.js";
import { reopenFixture } from "../../support/control-order-reopen-fixture.mjs";

after(closeDb);
test("current preparation ownership cannot identify who created older imported loaded quantities", () => withTransaction(async () => {
  const f = await reopenFixture();
  await query("DELETE FROM operator_load_records WHERE id=$1", [f.record.id]);
  await query("UPDATE sales_orders SET operator_status='preparing' WHERE netsuite_id=$1", [f.id]);
  const details = await getOperatorProgressDetails([f.ref]);
  assert.equal(details[0].status, "loaded");
  assert.equal(details[0].operator, null);
  const [blocker] = evaluateDependencyMutationBlockers({ operatorActivity: { refs: [f.ref], orders: details } });
  assert.match(blocker.message, /operator was not recorded/u);
  assert.doesNotMatch(blocker.message, /Pat Packer/u);
}, { rollback: true }));

test("the current preparing owner takes precedence over an older packing audit", () => withTransaction(async () => {
  const f = await reopenFixture({ loaded: 0 });
  await query(`UPDATE sales_order_lines SET packed_pallet_qty=0,packed_layer_qty=0,packed_section_qty=0,
    packed_piece_qty=0,packed_sales_qty=0,confirmed=false,confirmed_at=null WHERE sales_order_id=$1`, [f.id]);
  await query("UPDATE sales_orders SET operator_status='preparing',preparing_operator_id=$2 WHERE netsuite_id=$1", [f.id, f.actor.id]);
  const details = await getOperatorProgressDetails([f.ref]);
  assert.equal(details[0].status, "preparing");
  assert.equal(details[0].operator.id, f.actor.id);
}, { rollback: true }));
