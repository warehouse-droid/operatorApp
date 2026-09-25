import { query, pool, withTransaction, closeDb } from "/app/src/db.js";
pool.options.options = "-c jit=off -c default_transaction_read_only=on -c statement_timeout=10000";
try {
  const snapshot = await withTransaction(async () => {
    await query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    const orders = (await query("SELECT * FROM sales_orders WHERE tranid=ANY($1::text[]) ORDER BY netsuite_id", [["SOB120487", "SOB120489"]])).rows;
    for (const order of orders) {
      order.customer = "Load timing replay";
      for (const field of ["memo", "dispatch_address", "dispatch_instructions"]) {
        order[field] = null;
      }
      order.dispatch_instruction_details = {};
    }
    const ids = orders.map(row => row.netsuite_id);
    const lines = (await query("SELECT * FROM sales_order_lines WHERE sales_order_id=ANY($1::bigint[]) ORDER BY id", [ids])).rows;
    const group = (await query("SELECT * FROM dispatch_delivery_groups WHERE group_ref='GOB-120487-120489'")).rows[0];
    const members = (await query("SELECT * FROM dispatch_delivery_group_members WHERE group_ref=$1 ORDER BY position", [group.group_ref])).rows;
    const plan = (await query("SELECT * FROM dispatch_plans WHERE id=$1", [group.plan_id])).rows[0];
    const records = (await query("SELECT order_id,order_ref,line_snapshot,photo_data_urls FROM operator_load_records WHERE order_id=ANY($1::bigint[]) ORDER BY id", [ids])).rows;
    return { capturedAt: new Date().toISOString(), orders, lines, group, members, plan, records };
  }, { rollback: true });
  console.log(JSON.stringify(snapshot));
} finally {await closeDb();}
