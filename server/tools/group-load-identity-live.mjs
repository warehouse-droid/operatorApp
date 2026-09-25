import assert from "node:assert/strict";
import crypto from "node:crypto";
import { pool, query, withTransaction, closeDb } from "/app/src/db.js";
import { getDeliveryOrder } from "/app/src/delivery-repository.js";
import { assertNoCoSourcePacking } from "/app/src/co-source-packing-handoff.js";

pool.options.options = "-c jit=off -c default_transaction_read_only=on -c statement_timeout=30000";
const afterDeploy = process.env.GROUP_LOAD_IDENTITY_AFTER === "1";
try {
  const result = await withTransaction(async () => {
    await query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    const order = await getDeliveryOrder("GOA-8601-8604", { includeNetSuiteClosed: true });
    assert.equal(order.is_dispatch_group, true);
    const ids = order.child_order_ids;
    const state = {
      headers: (await query(`SELECT netsuite_id,tranid,operator_status,local_yard_order_status,fulfillment_status,
        preparing_operator_id,preparing_started_at FROM sales_orders WHERE netsuite_id=ANY($1::bigint[]) ORDER BY netsuite_id`, [ids])).rows,
      lines: (await query(`SELECT id,sales_order_id,line_id,item_id,quantity,loaded_qty,packed_pallet_qty,packed_layer_qty,
        packed_section_qty,packed_piece_qty,packed_sales_qty,confirmed,confirmed_at,sync_exception
        FROM sales_order_lines WHERE sales_order_id=ANY($1::bigint[]) ORDER BY sales_order_id,id`, [ids])).rows
    };
    let guard;
    try {
      await withTransaction(() => assertNoCoSourcePacking(order));
      guard = { allowed: true };
    } catch (error) {
      guard = { allowed: false, code: error.code, message: error.message };
    }
    const sweep = { checked: 0, allowed: 0, coHandoff: 0, errors: [] };
    if (afterDeploy) {
      assert.equal(guard.allowed, true, JSON.stringify(guard));
      const groups = (await query(`SELECT g.group_ref, jsonb_agg(jsonb_build_object('netsuite_id',s.netsuite_id::text,
        'order_type','sales_order') ORDER BY m.position) AS children
        FROM dispatch_delivery_groups g JOIN dispatch_delivery_group_members m ON m.group_ref=g.group_ref
        JOIN sales_orders s ON s.tranid=m.member_order_ref
        WHERE g.active=true AND g.order_type='sales_order' GROUP BY g.group_ref`)).rows;
      for (const group of groups) {
        sweep.checked += 1;
        try {
          await withTransaction(() => assertNoCoSourcePacking({ netsuite_id: group.group_ref, order_type: "sales_order",
            is_dispatch_group: true, child_orders: group.children }));
          sweep.allowed += 1;
        } catch (error) {
          if (error.code === "CO_SOURCE_PACKING_HANDOFF") {sweep.coHandoff += 1;}
          else {sweep.errors.push({ group: group.group_ref, code: error.code, message: error.message });}
        }
      }
      assert.deepEqual(sweep.errors, []);
    }
    return { checkedAt: new Date().toISOString(), groupId: order.netsuite_id, childIds: ids, guard, sweep, state,
      stateHash: crypto.createHash("sha256").update(JSON.stringify(state)).digest("hex") };
  }, { rollback: true });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await closeDb();
}
