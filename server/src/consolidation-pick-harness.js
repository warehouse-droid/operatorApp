const { createOperator } = await import("./auth-repository.js");
const { beginRollbackContext, closeDb, query } = await import("./db.js");
const {
  assertNoActiveConsolidationClaimsByRefs,
  confirmConsolidationItem,
  getActiveConsolidationBatch,
  getSavedConsolidationQueue,
  packConsolidationOrder,
  releaseConsolidationBatch,
  startSavedConsolidationBatch,
  updateConsolidationLine
} = await import("./delivery-consolidation-repository.js");

const runId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const orderIds = [
  9981000000 + Number(runId.slice(-5)),
  9982000000 + Number(runId.slice(-5)),
  -(9983000000 + Number(runId.slice(-5)))
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function createFixtureOrder(orderId, suffix, quantity, packed = 0) {
  const tranid = `CONSOL-${suffix}-${runId}`;
  await query(
    `INSERT INTO sales_orders (
       netsuite_id, tranid, trandate, customer, status, status_text,
       outbound_location_id, outbound_location, sales_order_type,
       operator_status, local_yard_order_status, fulfillment_status,
       netsuite_active, dispatch_planned, dispatch_plan_date,
       dispatch_truck_plate, dispatch_load_name
     ) VALUES (
       $1, $2, current_date, 'Consolidation Harness', 'B', 'Pending Fulfillment',
       1, '3445', 'Delivery', 'open', 'Open', 'open',
       true, true, current_date, $3, $4
     )`,
    [orderId, tranid, `TEST-${suffix}`, `Load ${suffix}`]
  );
  const line = await query(
    `INSERT INTO sales_order_lines (
       sales_order_id, line_id, item_id, item_name, sku, item_description,
       item_type, quantity, unit, pallet_qty, to_plt,
       packed_pallet_qty, packed_layer_qty, packed_section_qty, packed_piece_qty,
       loaded_qty, netsuite_active, location_id, location
     ) VALUES (
       $1, $2, 771001, 'Consolidation Test Block', 'CONSOL-SKU', 'Shared test SKU',
       'InvtPart', $3, 'EA', $3, 1,
       $4, 0, 0, 0,
       0, true, 1, '3445'
     ) RETURNING id`,
    [orderId, Number(`${suffix}${runId.slice(-5)}`), quantity, packed]
  );
  return { orderId, tranid, lineId: String(line.rows[0].id), quantity, packed };
}

const rollback = await beginRollbackContext();
try {
  await rollback.run(async () => {
    const operator = await createOperator({
      username: `consolidation_${runId}`,
      displayName: "Consolidation Harness",
      password: "Rollback123",
      role: "operator"
    });
    const first = await createFixtureOrder(orderIds[0], 1, 10, 0);
    const second = await createFixtureOrder(orderIds[1], 2, 8, 2);
    const split = await createFixtureOrder(orderIds[2], 5, 5, 0);
    const plan = await query(
      `INSERT INTO dispatch_plans (plan_date, status, note)
       SELECT candidate::date, 'confirmed', 'Consolidation assignment harness'
         FROM generate_series(DATE '2098-01-01', DATE '2098-12-31', INTERVAL '1 day') candidate
        WHERE NOT EXISTS (SELECT 1 FROM dispatch_plans p WHERE p.plan_date = candidate::date)
        ORDER BY candidate
        LIMIT 1
       RETURNING id, plan_date`
    );
    const planOrders = [first, second, split].map((order) => ({ id: order.tranid, type: "SO" }));
    const planTruck = {
      plate: "CONSOL-TRUCK",
      loads: [{
        name: "Load 1",
        stops: [first, second, split].map((order, index) => ({
          id: `consol-drop-${index + 1}`,
          type: "drop",
          orderId: order.tranid
        }))
      }]
    };
    await query(
      `UPDATE sales_orders
          SET dispatch_plan_date = $2::date,
              dispatch_truck_plate = 'CONSOL-TRUCK',
              dispatch_load_name = 'Load 1'
        WHERE netsuite_id = ANY($1::bigint[])`,
      [orderIds, plan.rows[0].plan_date]
    );
    await query(
      `INSERT INTO dispatch_plan_snapshots (plan_id, orders, trucks, summary)
       VALUES ($1, $2::jsonb, $3::jsonb, '{}'::jsonb)`,
      [plan.rows[0].id, JSON.stringify(planOrders), JSON.stringify([planTruck])]
    );
    for (const order of [first, second, split]) {
      await query(
        `INSERT INTO operator_saved_delivery_orders (
           operator_id, location_id, order_key, order_ref, order_type
         ) VALUES ($1, 1, $2, $3, 'sales_order')`,
        [operator.id, String(order.orderId), order.tranid]
      );
    }
    await query(
      `INSERT INTO operator_saved_delivery_orders (
         operator_id, location_id, order_key, order_ref, order_type
       ) VALUES ($1, 1, '9989999999', 'CONSOL-IGNORED-TO', 'transfer_order')`,
      [operator.id]
    );

    const queue = await getSavedConsolidationQueue(operator.id, { locationId: 1 });
    assert(queue.total === 3 && queue.eligible === 3, "Normal and split saved SOs must be eligible while saved TOs are ignored.");

    await query(
      `UPDATE sales_orders
          SET dispatch_planned = false,
              dispatch_plan_date = null,
              dispatch_truck_plate = '',
              dispatch_load_name = ''
        WHERE netsuite_id = $1`,
      [second.orderId]
    );
    const unplannedQueue = await getSavedConsolidationQueue(operator.id, { locationId: 1 });
    assert(
      unplannedQueue.total === 3 && unplannedQueue.eligible === 3,
      "A starred unplanned Sales Order must remain eligible for consolidation."
    );
    await query(
      `UPDATE sales_orders SET outbound_location_id = 28, outbound_location = '2967' WHERE netsuite_id = $1`,
      [second.orderId]
    );
    let startBlocked = false;
    try {
      await startSavedConsolidationBatch(operator.id, { locationId: 1 });
    } catch (error) {
      startBlocked = error.code === "CONSOLIDATION_BATCH_BLOCKED" && error.details?.some((item) => item.orderRef === second.tranid);
    }
    assert(startBlocked, "A saved SO moved to another yard must still block the all-or-nothing batch start.");
    const partialBatch = await query(
      `SELECT COUNT(*)::int AS count FROM operator_consolidation_batches WHERE operator_id = $1`,
      [operator.id]
    );
    assert(partialBatch.rows[0].count === 0, "Blocked startup must not create a partial batch.");
    await query(`UPDATE sales_orders SET outbound_location_id = 1, outbound_location = '3445' WHERE netsuite_id = $1`, [second.orderId]);

    let batch = await startSavedConsolidationBatch(operator.id, { locationId: 1 });
    assert(batch.summary.orders === 3, "Batch must contain normal and split saved SOs.");
    assert(batch.summary.items === 1, "Common SKU must aggregate into one item.");
    const total = batch.items[0].totals.find((unit) => unit.key === "pallets");
    assert(Number(total?.required) === 21, "Existing packed quantity must be deducted and split SO quantity included.");

    let blocked = false;
    try {
      await assertNoActiveConsolidationClaimsByRefs([first.tranid], "split this order");
    } catch (error) {
      blocked = error.code === "CONSOLIDATION_ORDER_RESERVED";
    }
    assert(blocked, "Dispatch structural changes must be blocked while an SO is reserved.");

    const firstOrder = batch.orders.find((order) => order.orderKey === String(first.orderId));
    batch = await confirmConsolidationItem(operator.id, batch.batch.id, batch.items[0].key);
    assert(batch.summary.ready === 3, "Confirming one SKU must confirm its normal and split order lines together.");

    batch = await packConsolidationOrder(operator.id, firstOrder.id);
    assert(batch.summary.packed === 1, "Packing must remain an individual order action.");
    const savedAfterPack = await query(
      `SELECT order_key FROM operator_saved_delivery_orders WHERE operator_id = $1 ORDER BY order_key`,
      [operator.id]
    );
    assert(savedAfterPack.rows.length === 3, "Packing must unstar only that order and leave saved TO untouched.");

    await releaseConsolidationBatch(operator.id, { locationId: 1 });
    assert(!await getActiveConsolidationBatch(operator.id, { locationId: 1 }), "Released batch must no longer be active.");
    const quantities = await query(
      `SELECT sales_order_id, packed_pallet_qty
         FROM sales_order_lines
        WHERE sales_order_id = ANY($1::bigint[])
        ORDER BY sales_order_id`,
      [orderIds]
    );
    const byOrder = new Map(quantities.rows.map((row) => [Number(row.sales_order_id), Number(row.packed_pallet_qty)]));
    assert(byOrder.get(first.orderId) === 10, "Release must not undo an already packed order.");
    assert(byOrder.get(second.orderId) === 2, "Release must remove only the unfinished batch contribution.");
    assert(byOrder.get(split.orderId) === 0, "Release must remove the unfinished split-order contribution.");

    await query(
      `DELETE FROM operator_saved_delivery_orders WHERE operator_id = $1`,
      [operator.id]
    );
    const third = await createFixtureOrder(orderIds[0] + 300000, 3, 3, 0);
    const fourth = await createFixtureOrder(orderIds[1] + 400000, 4, 4, 0);
    const groupPlan = await query(
      `INSERT INTO dispatch_plans (plan_date, status, note)
       SELECT candidate::date, 'confirmed', 'Consolidation group harness'
         FROM generate_series(DATE '2099-01-01', DATE '2099-12-31', INTERVAL '1 day') candidate
        WHERE NOT EXISTS (SELECT 1 FROM dispatch_plans p WHERE p.plan_date = candidate::date)
        ORDER BY candidate
        LIMIT 1
       RETURNING id, plan_date`
    );
    const groupRef = `GOA-CONSOL-${runId}`;
    await query(
      `INSERT INTO dispatch_delivery_groups (
         group_ref, plan_id, plan_date, order_type, truck_plate, load_name, active
       ) VALUES ($1, $2, $3, 'sales_order', 'GROUP-TRUCK', 'Load G', true)`,
      [groupRef, groupPlan.rows[0].id, groupPlan.rows[0].plan_date]
    );
    await query(
      `INSERT INTO dispatch_delivery_group_members (group_ref, member_order_ref, position)
       VALUES ($1, $2, 0), ($1, $3, 1)`,
      [groupRef, third.tranid, fourth.tranid]
    );
    await query(
      `INSERT INTO dispatch_plan_snapshots (plan_id, orders, trucks, summary)
       VALUES ($1, $2::jsonb, $3::jsonb, '{}'::jsonb)`,
      [
        groupPlan.rows[0].id,
        JSON.stringify([{ id: groupRef, type: "SO", childOrders: [third.tranid, fourth.tranid] }]),
        JSON.stringify([{
          plate: "GROUP-TRUCK",
          loads: [{ name: "Load G", stops: [{ id: "group-drop", type: "drop", orderId: groupRef }] }]
        }])
      ]
    );
    await query(
      `INSERT INTO operator_saved_delivery_orders (
         operator_id, location_id, order_key, order_ref, order_type
       ) VALUES ($1, 1, $2, $2, 'group_order')`,
      [operator.id, groupRef]
    );

    batch = await startSavedConsolidationBatch(operator.id, { locationId: 1 });
    assert(batch.summary.orders === 1 && batch.summary.items === 1, "Grouped SO must remain one operational consolidation order.");
    const groupedOrder = batch.orders[0];
    const groupedAllocation = batch.items[0].allocations[0];
    assert(Number(groupedAllocation.units.find((unit) => unit.key === "pallets")?.required) === 7, "Grouped child requirements must aggregate.");
    batch = await updateConsolidationLine(operator.id, groupedOrder.id, groupedAllocation.lineKey, { pallets: 7 });
    assert(batch.summary.ready === 1, "Grouped SO must become ready after its aggregate line is confirmed.");
    const groupedPacked = await query(
      `SELECT sales_order_id, packed_pallet_qty
         FROM sales_order_lines
        WHERE sales_order_id = ANY($1::bigint[])
        ORDER BY sales_order_id`,
      [[third.orderId, fourth.orderId]]
    );
    assert(groupedPacked.rows.reduce((sum, row) => sum + Number(row.packed_pallet_qty), 0) === 7, "Grouped confirmation must allocate to canonical child lines exactly once.");
    const completedGroup = await packConsolidationOrder(operator.id, groupedOrder.id);
    assert(completedGroup.completed === true, "Packing the grouped SO must complete its one-order batch.");
    const childStatuses = await query(
      `SELECT operator_status FROM sales_orders WHERE netsuite_id = ANY($1::bigint[])`,
      [[third.orderId, fourth.orderId]]
    );
    assert(childStatuses.rows.every((row) => row.operator_status === "packed"), "Grouped pack must update every canonical child order.");
  });
  console.log("Consolidation rollback harness passed.");
} finally {
  await rollback.rollback();
  await closeDb();
}
