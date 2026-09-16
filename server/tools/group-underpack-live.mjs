import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { pool, query, withTransaction, closeDb } from "../src/db.js";
import { getDeliveryOrder, listDeliveryOrders } from "../src/delivery-repository.js";

pool.options.options = "-c default_transaction_read_only=on -c jit=off -c statement_timeout=60000";
const refs = ["SOB120124", "SOB120358"];
const mode = process.argv[2] || "before";
assert(["before", "predeploy", "after"].includes(mode));
const directory = "test-artifacts/group-underpack-20260915";
try {
  const report = await withTransaction(async () => {
    await query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    const headers = (await query("SELECT * FROM sales_orders WHERE tranid=ANY($1::text[]) ORDER BY tranid", [refs])).rows;
    assert.equal(headers.length, 2);
    const rawLines = (await query("SELECT * FROM sales_order_lines WHERE sales_order_id=ANY($1::bigint[]) ORDER BY sales_order_id,line_id,id", [headers.map(row => row.netsuite_id)])).rows;
    const groups = (await query(`SELECT g.*,array_agg(m.member_order_ref ORDER BY m.position) AS members
      FROM dispatch_delivery_groups g JOIN dispatch_delivery_group_members m ON m.group_ref=g.group_ref
      WHERE g.active AND g.group_ref IN (SELECT group_ref FROM dispatch_delivery_group_members WHERE member_order_ref=ANY($1::text[]))
      GROUP BY g.group_ref ORDER BY g.group_ref`, [refs])).rows;
    const details = [];
    for (const id of [...headers.map(row => row.netsuite_id), ...groups.map(row => row.group_ref)]) {
      details.push(await getDeliveryOrder(id));
    }
    const lists = {};
    for (const status of ["active", "packed"]) {
      const all = await listDeliveryOrders({ locationId: headers[0].outbound_location_id, status });
      lists[status] = all.filter(row => refs.includes(row.tranid) || groups.some(group => group.group_ref === row.netsuite_id));
    }
    if (mode === "after") {
      const grouped = details.find(row => row?.netsuite_id === "GOB-120124-120358");
      assert(grouped); assert.equal(grouped.underpack_count, 0);
      assert.equal(grouped.operator_status, "packed"); assert.equal(grouped.lines.length, 5);
      assert.equal(lists.packed.find(row => row.netsuite_id === grouped.netsuite_id)?.underpack_count, 0);
      assert(!lists.active.some(row => row.netsuite_id === grouped.netsuite_id));
    }
    assert.deepEqual((await query("SELECT * FROM sales_order_lines WHERE sales_order_id=ANY($1::bigint[]) ORDER BY sales_order_id,line_id,id", [headers.map(row => row.netsuite_id)])).rows, rawLines);
    return { checkedAt: new Date().toISOString(), headers, rawLines, groups, details, lists, dataUnchanged: true };
  }, { rollback: true });
  mkdirSync(directory, { recursive: true });
  writeFileSync(`${directory}/live-${mode}.json`, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ checkedAt: report.checkedAt, groups: report.groups.map(row => ({ ref: row.group_ref, members: row.members })),
    details: report.details.map(row => row && ({ ref: row.tranid, id: row.netsuite_id, underpack: row.underpack_count, status: row.operator_status, yardStatus: row.local_yard_order_status,
      lines: row.lines.map(line => ({ id: line.id, sku: line.sku, itemType: line.item_type, active: line.netsuite_active, quantity: line.quantity,
        required: [line.pallet_qty,line.layer_qty,line.section_qty,line.piece_qty], conversions: [line.to_plt,line.to_lyr,line.to_sec,line.to_pcs],
        packed: [line.packed_pallet_qty,line.packed_layer_qty,line.packed_section_qty,line.packed_piece_qty,line.packed_sales_qty], loaded: line.loaded_qty,
        confirmed: line.confirmed, exception: line.sync_exception, linkedBlocked: line.linked_quantity_blocked, sourceLines: line.source_lines })) })),
    lists: Object.fromEntries(Object.entries(report.lists).map(([status, rows]) => [status, rows.map(row => ({ ref: row.tranid, underpack: row.underpack_count, status: row.operator_status }))])),
    dataUnchanged: report.dataUnchanged }));
} finally { await closeDb(); }
