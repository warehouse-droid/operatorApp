import assert from "node:assert/strict";
import test, { after } from "node:test";
import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import { deactivateUnplannedDispatchSplitOrders } from "../../../src/delivery-repository.js";

after(closeDb);
async function isolated(run) {
  const rollback = await beginRollbackContext();
  try { await rollback.run(run); } finally { await rollback.rollback(); }
}

const parentRef = "TO-FAMILY-1";
const splitRefs = [`${parentRef}-S1`, `${parentRef}-S2`];

// Unsplit restores the parent's whole quantity, so every active split must go
// with it; a sibling left behind (or travelling in a group) would double it.
async function seed() {
  await query(`INSERT INTO transfer_orders(netsuite_id,tranid,status,from_location,to_location,netsuite_active)
    VALUES(8700001,$1,'B','3445','2967',true)`, [parentRef]);
  for (const [index, ref] of splitRefs.entries()) {
    await query(`INSERT INTO transfer_orders(netsuite_id,tranid,status,from_location,to_location,netsuite_active)
      VALUES($1,$2,'B','3445','2967',true)`, [8700002 + index, ref]);
  }
}

const activeSplits = () => query("SELECT tranid FROM transfer_orders WHERE tranid = ANY($1::text[]) AND netsuite_active ORDER BY tranid",
  [splitRefs]).then(result => result.rows.map(row => row.tranid));

test("unsplit refuses a request that leaves an active sibling behind", () => isolated(async () => {
  await seed();
  await assert.rejects(deactivateUnplannedDispatchSplitOrders({ originalOrderId: parentRef, orderType: "TO",
    splitOrderIds: [splitRefs[0]] }), new RegExp(`${splitRefs[1]}`, "u"));
  assert.deepEqual(await activeSplits(), splitRefs);
}));

test("unsplit refuses a family whose sibling travels inside a group", () => isolated(async () => {
  await seed();
  const plan = (await query("INSERT INTO dispatch_plans(plan_date,status) VALUES ('2097-02-01','draft') RETURNING id")).rows[0];
  await query(`INSERT INTO dispatch_global_order_groups(group_ref,order_type,source_plan_id,source_plan_date,full_order,card)
    VALUES('GTO-FAMILY-1','TO',$1,'2097-02-01','{}'::jsonb,'{}'::jsonb)`, [plan.id]);
  await query("INSERT INTO dispatch_global_order_group_members(group_ref,member_order_ref,position) VALUES('GTO-FAMILY-1',$1,0)",
    [splitRefs[1]]);
  await assert.rejects(deactivateUnplannedDispatchSplitOrders({ originalOrderId: parentRef, orderType: "TO",
    splitOrderIds: splitRefs }), /GTO-FAMILY-1|group/u);
  assert.deepEqual(await activeSplits(), splitRefs);
}));

test("unsplit of a complete, unplanned family still retires every split", () => isolated(async () => {
  await seed();
  const result = await deactivateUnplannedDispatchSplitOrders({ originalOrderId: parentRef, orderType: "TO",
    splitOrderIds: splitRefs });
  assert.deepEqual([...result.deactivated].sort(), splitRefs);
  assert.deepEqual(await activeSplits(), []);
}));
