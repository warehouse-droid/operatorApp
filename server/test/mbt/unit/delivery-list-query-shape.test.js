// The operator delivery list runs on every yard device every 10 seconds (notifications) and on each
// delivery screen load. These checks keep the three per-row costs measured in production out of it:
// a correlated split-child LIKE scan, a CO details lookup per order, and a line summary of every order.
import assert from 'node:assert/strict';
import test from 'node:test';
import { pool } from '../../../src/db.js';
import { listDeliveryOrders, listDeliveryLoadTrucks } from '../../../src/delivery-repository.js';
import { routeOperatorSalesOrders, operatorCoRouteJoinSql, operatorCoCandidatesSql } from '../../../src/operator-co-routing.js';

/** Records the SQL each call sends; the stubbed pool never reaches a database. @param {() => Promise<unknown>} run */
async function capture(run, marker) {
  const original = { query: pool.query, connect: pool.connect }, seen = [];
  pool.query = async text => { seen.push(String(text)); return { rows: [], rowCount: 0 }; };
  pool.connect = async () => { throw new Error('No database connection in query-shape tests.'); };
  try { await run(); } finally { Object.assign(pool, original); }
  const sql = seen.filter(text => text.includes(marker)).at(-1);
  assert.ok(sql, `captured the ${marker} query`);
  return sql;
}

test('the delivery list reads open COs once and finds split parents with one uncorrelated lookup', async () => {
  for (const status of ['active', 'packed']) {
    for (const orderType of ['sales_order', 'transfer_order']) {
      const sql = await capture(() => listDeliveryOrders({ locationId: 1, status, orderType }), 'delivery_order_source');
      assert.match(sql, /^WITH operator_co_candidates AS MATERIALIZED \(/);
      assert.match(sql, /FROM operator_co_candidates co\s+WHERE \(co\.source_order_ref=sales_orders\.tranid OR co\.child_order_ids \? sales_orders\.tranid\)/);
      assert.doesNotMatch(sql, /co\.details->'childOrderIds' \? sales_orders\.tranid/, 'no CO details lookup per order');
      assert.doesNotMatch(sql, /split_child\.tranid LIKE delivery_order_source\.tranid/, 'no split-child scan per order');
      assert.equal((sql.match(/delivery_order_source\.tranid IS NOT NULL AND delivery_order_source\.tranid IN \(\s*SELECT split_part\(split_child\.tranid, '-S', 1\)/g) || []).length, 2);
      assert.match(sql, /LEFT JOIN active_sales_line_allocations line_allocation ON line_allocation\.sales_line_id = l\.id\s+(--[^\n]*\n\s*)?WHERE o\.fulfillment_status <> 'fulfilled'/,
        'the line summary covers only orders the list can return');
    }
  }
});

test('every query using the CO route join defines its candidates', async () => {
  const trucks = await capture(() => listDeliveryLoadTrucks({ locationId: 1, planDate: '2099-01-01' }), 'planned_delivery_orders');
  const route = await capture(() => routeOperatorSalesOrders([{ order_type: 'sales_order', netsuite_id: 1 }]), 'operator_co_route');
  for (const sql of [trucks, route]) {
    assert.match(sql, /^WITH operator_co_candidates AS MATERIALIZED \(/);
    assert.match(sql, /FROM operator_co_candidates co/);
  }
  assert.match(operatorCoCandidatesSql(), /FROM local_co_orders co\s+WHERE co\.status <> 'cancelled'/);
  assert.throws(() => operatorCoRouteJoinSql('bad alias'), /Invalid CO routing SQL alias/);
});
