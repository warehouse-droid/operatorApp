import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { query, withTransaction, closeDb } from './src/db.js';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
try {
  const snapshot = await withTransaction(async () => {
    await query('SET TRANSACTION READ ONLY');
    const drivers = (await query(`SELECT to_jsonb(j) AS row FROM driver_job_records j
      WHERE order_refs ? 'SOA09143-S1' ORDER BY id`)).rows;
    const first = (await query(`SELECT to_jsonb(s) AS row FROM dispatch_global_order_splits s
      WHERE split_ref='SOA09143-S1'`)).rows;
    const group = (await query(`SELECT to_jsonb(g) AS row FROM dispatch_global_order_groups g
      WHERE full_order->'childOrders' ? 'SOA09143-S1' ORDER BY group_ref`)).rows;
    const assignments = (await query(`SELECT to_jsonb(a) AS row FROM dispatch_plan_order_assignments a
      WHERE order_ref='SOA09143-S1' ORDER BY plan_id`)).rows;
    const source = (await query(`SELECT s.tranid,s.operator_status,s.local_yard_order_status,s.dispatch_planned,
      jsonb_agg(jsonb_build_object('line',l.line_id,'quantity',l.quantity,'loaded',l.loaded_qty,'packed',l.packed_sales_qty) ORDER BY l.line_id) AS items
      FROM sales_orders s JOIN sales_order_lines l ON l.sales_order_id=s.netsuite_id
      WHERE s.tranid='SOA09143-S2' GROUP BY s.netsuite_id`)).rows;
    const firstOrder = first[0]?.row.full_order;
    const historical = assignments[0]?.row.assignment.plannedOrderSnapshot;
    const historicalFirst = historical?.childOrderDetails.find(order => order.id === 'SOA09143-S1');
    const cargo = items => items.map(item => ({ line: String(item.lineId), quantity: Number(item.quantity),
      pallets: Number(item.pallets || 0), layers: Number(item.layers || 0), sections: Number(item.sections || 0), pieces: Number(item.pieces || 0) }))
      .sort((a, b) => a.line.localeCompare(b.line));
    assert.deepEqual(cargo(firstOrder.items), cargo(historicalFirst.items));
    assert.equal(first[0].row.active, true);
    assert.equal(first[0].row.parent_order_ref, 'SOA09143');
    assert.equal(group[0].row.active, true);
    assert.deepEqual(group[0].row.full_order.childOrders, historical.childOrders);
    const preservedS1CargoHash = hash(cargo(firstOrder.items));
    const preservedS1MembersHash = hash(group[0].row.full_order.childOrders);
    const photos = drivers.flatMap(record => record.row.photo_data_urls || []);
    return { completedDriverHash: hash(drivers), s1DefinitionHash: hash(first), s1GroupHash: hash(group),
      s1AssignmentHash: hash(assignments), preservedS1CargoHash, preservedS1MembersHash, completedRecords: drivers.length, retainedPhotoReferences: photos.length,
      s2: source, s2Hash: hash(source), readOnly: true };
  });
  assert.equal((await fetch('http://127.0.0.1:3000/health')).status, 200);
  console.log(JSON.stringify(snapshot));
} finally { await closeDb(); }
