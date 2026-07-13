process.env.MBBS_ENABLE_ROLLBACK_TESTS = "1";

const { app } = await import("./server.js");
const { createOperator } = await import("./auth-repository.js");
const { closeDb, query } = await import("./db.js");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const runId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const tempIds = {
  delivery: 9900000000 + Number(runId.slice(-6)),
  pickup: 9910000000 + Number(runId.slice(-6)),
  receiving: 9920000000 + Number(runId.slice(-6))
};

function normalizeJson(value) {
  return JSON.stringify(value, Object.keys(value).sort());
}

async function optionalCount(table) {
  const exists = await query("SELECT to_regclass($1) AS name", [table]);
  if (!exists.rows[0]?.name) return null;
  const result = await query(`SELECT COUNT(*)::int AS count FROM ${table}`);
  return result.rows[0]?.count ?? null;
}

async function fingerprint(fixtures) {
  const tables = [
    "operators",
    "operator_sessions",
    "delivery_audit_log",
    "dispatch_audit_log",
    "dispatch_plans",
    "dispatch_plan_snapshots",
    "dispatch_delivery_groups",
    "dispatch_delivery_group_members",
    "dispatch_operator_requests",
    "dispatch_so_po_allocations",
    "sales_orders",
    "sales_order_lines",
    "operator_load_records",
    "delivery_fulfillment_records",
    "customer_pickup_load_records",
    "purchase_orders",
    "purchase_order_lines",
    "receiving_receipt_records",
    "inventory_items",
    "cycle_count_records",
    "cycle_count_lines",
    "operator_record_warnings",
    "local_co_orders",
    "local_co_order_lines",
    "local_co_receipt_records"
  ];
  const counts = {};
  for (const table of tables) counts[table] = await optionalCount(table);

  const delivery = await query(
    `SELECT o.operator_status, o.local_yard_order_status, o.fulfillment_status,
            l.packed_pallet_qty, l.packed_layer_qty, l.packed_section_qty, l.packed_piece_qty,
            l.loaded_qty, l.loaded_uom
       FROM sales_orders o
       JOIN sales_order_lines l ON l.sales_order_id = o.netsuite_id
      WHERE o.netsuite_id = $1
      ORDER BY l.id`,
    [fixtures.deliveryOrderId]
  );
  const pickup = await query(
    `SELECT o.local_yard_order_status, l.packed_piece_qty, l.loaded_qty, l.loaded_uom
       FROM sales_orders o
       JOIN sales_order_lines l ON l.sales_order_id = o.netsuite_id
      WHERE o.netsuite_id = $1
      ORDER BY l.id`,
    [fixtures.pickupOrderId]
  );
  const receiving = await query(
    `SELECT o.receipt_status, l.received_pallet_qty, l.received_layer_qty,
            l.received_section_qty, l.received_piece_qty
       FROM purchase_orders o
       JOIN purchase_order_lines l ON l.purchase_order_id = o.netsuite_id
      WHERE o.netsuite_id = $1
      ORDER BY l.id`,
    [fixtures.receivingOrderId]
  );
  const plan = await query(
    `SELECT p.status, p.note, s.orders, s.trucks, s.summary
       FROM dispatch_plans p
       LEFT JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
      WHERE p.id = $1`,
    [fixtures.planId]
  );
  const targetOperator = await query(
    `SELECT active, updated_at IS NOT NULL AS has_updated_at
       FROM operators
      WHERE id = $1`,
    [fixtures.targetOperatorId]
  );

  return {
    counts,
    delivery: delivery.rows,
    pickup: pickup.rows,
    receiving: receiving.rows,
    plan: plan.rows,
    targetOperator: targetOperator.rows
  };
}

async function createFixtures() {
  const admin = await createOperator({
    username: `rollback_admin_${runId}`,
    displayName: "Rollback Harness Admin",
    password: "Rollback123",
    role: "admin"
  });
  const targetOperator = await createOperator({
    username: `rollback_operator_${runId}`,
    displayName: "Rollback Harness Operator",
    password: "Rollback123",
    role: "operator"
  });

  const lineIdBase = Number(runId.slice(-6));
  await query(
    `INSERT INTO sales_orders (
       netsuite_id, tranid, trandate, customer, status, status_text,
       outbound_location_id, outbound_location, sales_order_type,
       operator_status, local_yard_order_status, fulfillment_status, netsuite_active
     ) VALUES ($1, $2, current_date, 'Rollback Customer', 'B', 'Pending Fulfillment',
       1, '3445', 'Delivery', 'packed', 'Open', 'open', true)`,
    [tempIds.delivery, `ROLLBACK-SO-${runId}`]
  );
  const deliveryLine = await query(
    `INSERT INTO sales_order_lines (
       sales_order_id, line_id, item_id, item_name, sku, quantity, unit,
       location_id, location, piece_qty, packed_piece_qty, to_pcs, netsuite_active
     ) VALUES ($1, $2, 100001, 'Rollback Delivery Item', 'ROLLBACK-DEL', 2, 'PC',
       1, '3445', 2, 2, 1, true)
     RETURNING id`,
    [tempIds.delivery, lineIdBase]
  );

  await query(
    `INSERT INTO sales_orders (
       netsuite_id, tranid, trandate, customer, status, status_text,
       outbound_location_id, outbound_location, sales_order_type,
       operator_status, local_yard_order_status, fulfillment_status, netsuite_active
     ) VALUES ($1, $2, current_date, 'Rollback Pickup Customer', 'B', 'Pending Fulfillment',
       1, '3445', 'Pick-Up', 'Open', 'Open', 'open', true)`,
    [tempIds.pickup, `ROLLBACK-PICKUP-${runId}`]
  );
  const pickupLine = await query(
    `INSERT INTO sales_order_lines (
       sales_order_id, line_id, item_id, item_name, sku, quantity, unit,
       location_id, location, piece_qty, packed_piece_qty, to_pcs, netsuite_active
     ) VALUES ($1, $2, 100002, 'Rollback Pickup Item', 'ROLLBACK-PICK', 3, 'PC',
       1, '3445', 3, 1, 1, true)
     RETURNING id`,
    [tempIds.pickup, lineIdBase + 1]
  );

  await query(
    `INSERT INTO purchase_orders (
       netsuite_id, tranid, trandate, vendor_id, vendor, status, status_text,
       destination_location_id, destination_location, receipt_status, netsuite_active
     ) VALUES ($1, $2, current_date, 990001, 'Rollback Vendor',
       'pendingReceipt', 'Pending Receipt', 1, '3445', 'open', true)`,
    [tempIds.receiving, `ROLLBACK-PO-${runId}`]
  );
  const receivingLine = await query(
    `INSERT INTO purchase_order_lines (
       purchase_order_id, line_id, item_id, item_name, sku, quantity, unit,
       location_id, location, pallet_qty, to_plt, netsuite_active
     ) VALUES ($1, $2, 100003, 'Rollback Receiving Item', 'ROLLBACK-REC', 1, 'PC',
       1, '3445', 1, 1, true)
     RETURNING id`,
    [tempIds.receiving, lineIdBase + 2]
  );

  const plan = await query(
    `INSERT INTO dispatch_plans (plan_date, status, note)
     VALUES ($1::date, 'draft', 'rollback harness')
     RETURNING id`,
    [`2099-12-${String(10 + Number(runId.slice(-1))).padStart(2, "0")}`]
  );
  await query(
    `INSERT INTO dispatch_plan_snapshots (plan_id, orders, trucks, summary)
     VALUES ($1, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb)`,
    [plan.rows[0].id]
  );

  const parserRule = await query("SELECT rule_key AS key, rule_value AS value FROM dispatch_parser_rules ORDER BY rule_key LIMIT 1");
  const vendorYard = await query("SELECT id FROM dispatch_vendor_yards WHERE active = true ORDER BY id LIMIT 1");
  const inventory = await query(
    `SELECT item_id, product_type, brand, series
       FROM inventory_items
      ORDER BY item_id
      LIMIT 1`
  );

  return {
    admin,
    targetOperator,
    targetOperatorId: targetOperator.id,
    deliveryOrderId: tempIds.delivery,
    deliveryOrderRef: `ROLLBACK-SO-${runId}`,
    deliveryLineId: deliveryLine.rows[0].id,
    pickupOrderId: tempIds.pickup,
    pickupOrderRef: `ROLLBACK-PICKUP-${runId}`,
    pickupLineId: pickupLine.rows[0].id,
    receivingOrderId: tempIds.receiving,
    receivingOrderRef: `ROLLBACK-PO-${runId}`,
    receivingLineId: receivingLine.rows[0].id,
    planId: plan.rows[0].id,
    parserRule: parserRule.rows[0] || null,
    vendorYardId: vendorYard.rows[0]?.id || null,
    inventoryItem: inventory.rows[0] || null
  };
}

async function cleanupFixtures(fixtures) {
  const operatorIds = [fixtures?.admin?.id, fixtures?.targetOperator?.id].filter(Boolean);
  if (operatorIds.length) {
    await query("DELETE FROM operator_sessions WHERE operator_id = ANY($1::text[])", [operatorIds]);
    await query("DELETE FROM delivery_audit_log WHERE actor_operator_id = ANY($1::text[]) OR actor_operator_id = ANY($1::text[])", [operatorIds]).catch(() => null);
    await query("DELETE FROM delivery_audit_log WHERE actor_operator_id = ANY($1::text[])", [operatorIds]).catch(() => null);
    await query("DELETE FROM operators WHERE id = ANY($1::text[])", [operatorIds]);
  }
  await query("DELETE FROM local_co_orders WHERE source_order_ref = $1 OR co_ref = $2", [fixtures.deliveryOrderRef, `CO-${fixtures.deliveryOrderRef}`]).catch(() => null);
  await query("DELETE FROM dispatch_operator_requests WHERE order_ref IN ($1, $2)", [fixtures.deliveryOrderRef, String(fixtures.deliveryOrderId)]).catch(() => null);
  await query("DELETE FROM dispatch_plan_snapshots WHERE plan_id = $1", [fixtures.planId]).catch(() => null);
  await query("DELETE FROM dispatch_plans WHERE id = $1", [fixtures.planId]).catch(() => null);
  await query("DELETE FROM purchase_orders WHERE netsuite_id = $1", [fixtures.receivingOrderId]).catch(() => null);
  await query("DELETE FROM sales_orders WHERE netsuite_id = ANY($1::bigint[])", [[fixtures.deliveryOrderId, fixtures.pickupOrderId]]).catch(() => null);
}

async function login(baseUrl, username, password) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password })
  });
  if (!response.ok) throw new Error(`Login failed: ${response.status} ${await response.text()}`);
  return response.json();
}

async function request(baseUrl, token, testCase) {
  const response = await fetch(`${baseUrl}${testCase.path}`, {
    method: testCase.method,
    headers: {
      "authorization": `Bearer ${token}`,
      "content-type": "application/json",
      "x-mbbs-rollback-test": "1"
    },
    body: testCase.body === undefined ? undefined : JSON.stringify(testCase.body)
  });
  const text = await response.text();
  const body = text ? safeJson(text) : null;
  return { status: response.status, body, text };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function buildCases(fixtures) {
  const cases = [
    {
      name: "POST /api/operators",
      method: "POST",
      path: "/api/operators",
      body: {
        username: `rollback_created_${runId}`,
        displayName: "Rollback Created Operator",
        password: "Rollback123",
        role: "operator"
      }
    },
    {
      name: "POST /api/operators/:id/active",
      method: "POST",
      path: `/api/operators/${fixtures.targetOperatorId}/active`,
      body: { active: false }
    },
    {
      name: "POST /api/operators/:id/password",
      method: "POST",
      path: `/api/operators/${fixtures.targetOperatorId}/password`,
      body: { password: "Rollback456" }
    },
    {
      name: "POST /api/dispatch/plans",
      method: "POST",
      path: "/api/dispatch/plans",
      body: { planDate: "2099-11-11", note: "rollback create plan", audit: { sessionId: "rollback-harness" } }
    },
    {
      name: "PUT /api/dispatch/plans/:id",
      method: "PUT",
      path: `/api/dispatch/plans/${fixtures.planId}`,
      body: { orders: [], trucks: [], summary: { rollback: true }, audit: { sessionId: "rollback-harness" } }
    },
    {
      name: "POST /api/dispatch/plans/:id/confirm",
      method: "POST",
      path: `/api/dispatch/plans/${fixtures.planId}/confirm`,
      body: { note: "rollback confirm", audit: { sessionId: "rollback-harness" } }
    },
    {
      name: "POST /api/dispatch/plans/:id/reopen",
      method: "POST",
      path: `/api/dispatch/plans/${fixtures.planId}/reopen`,
      body: { note: "rollback reopen", audit: { sessionId: "rollback-harness" } }
    },
    {
      name: "POST /api/dispatch/audit",
      method: "POST",
      path: "/api/dispatch/audit",
      body: { action: "rollback_test", entityType: "harness", entityId: runId, details: { runId } }
    },
    {
      name: "PUT /api/dispatch/orders/:id/details",
      method: "PUT",
      path: `/api/dispatch/orders/${fixtures.deliveryOrderRef}/details`,
      body: {
        type: "SO",
        sourceTable: "sales_orders",
        address: "Rollback Address",
        expectedDeliveryDate: "2099-12-31",
        windowStart: "0700",
        windowEnd: "1900",
        audit: { sessionId: "rollback-harness" }
      }
    },
    {
      name: "PUT /api/dispatch/orders/:id/vendor-yard",
      method: "PUT",
      path: `/api/dispatch/orders/${fixtures.receivingOrderRef}/vendor-yard`,
      body: {
        vendorYardId: fixtures.vendorYardId,
        audit: { sessionId: "rollback-harness" }
      },
      skip: !fixtures.vendorYardId
    },
    {
      name: "POST /api/dispatch/co-orders",
      method: "POST",
      path: "/api/dispatch/co-orders",
      body: {
        sourceOrderRef: fixtures.deliveryOrderRef,
        fromYard: "3445",
        toYard: "12441",
        order: {
          id: fixtures.deliveryOrderRef,
          customer: "Rollback Customer",
          items: [
            { lineId: 1, itemId: 100001, itemName: "Rollback Delivery Item", sku: "ROLLBACK-DEL", quantity: 2, unit: "PC", pieces: 2, toPcs: 1 }
          ]
        },
        planId: fixtures.planId,
        planDate: "2099-12-31",
        truckPlate: "ROLLBACK",
        loadName: "Load 1",
        audit: { sessionId: "rollback-harness" }
      }
    },
    {
      name: "POST /api/dispatch/operator-requests",
      method: "POST",
      path: "/api/dispatch/operator-requests",
      body: {
        requestType: "unpack",
        orderRef: fixtures.deliveryOrderRef,
        sourceOrderType: "SO",
        requestedBy: "rollback-harness",
        details: { reason: "rollback test" },
        audit: { sessionId: "rollback-harness" }
      }
    },
    {
      name: "PUT /api/dispatch/parser-rules/:key",
      method: "PUT",
      path: `/api/dispatch/parser-rules/${encodeURIComponent(fixtures.parserRule?.key || "")}`,
      body: { value: fixtures.parserRule?.value || "" },
      skip: !fixtures.parserRule
    },
    {
      name: "POST /api/control/order-data/clear",
      method: "POST",
      path: "/api/control/order-data/clear",
      body: { confirmText: "CLEAR ORDERS" }
    },
    {
      name: "POST /api/customer-pickup/lookup",
      method: "POST",
      path: "/api/customer-pickup/lookup",
      body: { code: fixtures.pickupOrderRef, locationId: 1 }
    },
    {
      name: "POST /api/customer-pickup/orders/:id/lines/:lineId/confirm",
      method: "POST",
      path: `/api/customer-pickup/orders/${fixtures.pickupOrderId}/lines/${fixtures.pickupLineId}/confirm`,
      body: { pieces: 1 }
    },
    {
      name: "POST /api/customer-pickup/orders/:id/clear-draft",
      method: "POST",
      path: `/api/customer-pickup/orders/${fixtures.pickupOrderId}/clear-draft`,
      body: {}
    },
    {
      name: "POST /api/customer-pickup/orders/:id/load",
      method: "POST",
      path: `/api/customer-pickup/orders/${fixtures.pickupOrderId}/load`,
      body: { photoDataUrl: "data:image/png;base64,cm9sbGJhY2s=" }
    },
    {
      name: "POST /api/delivery/sync",
      method: "POST",
      path: "/api/delivery/sync",
      body: { locationId: 1, orderType: "sales_order" }
    },
    {
      name: "POST /api/delivery/orders/:id/prepared",
      method: "POST",
      path: `/api/delivery/orders/${fixtures.deliveryOrderId}/prepared`,
      body: { operatorName: "Rollback Harness", notes: "rollback" }
    },
    {
      name: "POST /api/delivery/orders/:id/status",
      method: "POST",
      path: `/api/delivery/orders/${fixtures.deliveryOrderId}/status`,
      body: { status: "preparing" }
    },
    {
      name: "POST /api/delivery/orders/:id/lines/:lineId/confirm",
      method: "POST",
      path: `/api/delivery/orders/${fixtures.deliveryOrderId}/lines/${fixtures.deliveryLineId}/confirm`,
      body: { pieces: 1 }
    },
    {
      name: "POST /api/delivery/orders/:id/lines/:lineId/packed-quantity",
      method: "POST",
      path: `/api/delivery/orders/${fixtures.deliveryOrderId}/lines/${fixtures.deliveryLineId}/packed-quantity`,
      body: { pieces: 1 }
    },
    {
      name: "POST /api/delivery/orders/:id/lines/:lineId/unpack",
      method: "POST",
      path: `/api/delivery/orders/${fixtures.deliveryOrderId}/lines/${fixtures.deliveryLineId}/unpack`,
      body: { pieces: 1 }
    },
    {
      name: "POST /api/delivery/orders/:id/unpack",
      method: "POST",
      path: `/api/delivery/orders/${fixtures.deliveryOrderId}/unpack`,
      body: {}
    },
    {
      name: "POST /api/delivery/orders/:id/load",
      method: "POST",
      path: `/api/delivery/orders/${fixtures.deliveryOrderId}/load`,
      body: { photoDataUrl: "data:image/png;base64,cm9sbGJhY2s=" }
    },
    {
      name: "POST /api/receiving/sync",
      method: "POST",
      path: "/api/receiving/sync",
      body: { orderType: "purchase_order", destinationLocationId: 1 }
    },
    {
      name: "POST /api/receiving/orders/:id/lines/:lineId/confirm",
      method: "POST",
      path: `/api/receiving/orders/${fixtures.receivingOrderId}/lines/${fixtures.receivingLineId}/confirm`,
      body: { pallets: 1 }
    },
    {
      name: "PUT /api/inventory/classifications/:itemId",
      method: "PUT",
      path: `/api/inventory/classifications/${fixtures.inventoryItem?.item_id || ""}`,
      body: {
        productType: fixtures.inventoryItem?.product_type || "Rollback",
        brand: fixtures.inventoryItem?.brand || "Rollback",
        series: fixtures.inventoryItem?.series || "Rollback"
      },
      skip: !fixtures.inventoryItem
    },
    {
      name: "POST /api/cycle-count/submit",
      method: "POST",
      path: "/api/cycle-count/submit",
      body: {}
    }
  ];
  return cases.filter((testCase) => !testCase.skip);
}

async function main() {
  let server;
  let fixtures;
  const results = [];
  const skipped = [
    "NetSuite OAuth, webhook, admin sync-now, delivery fulfill, receiving receive, inventory sync, cycle-count line confirm",
    "Samsara external test/driver duty endpoints",
    "Driver job photo/start endpoints without a deterministic confirmed driver fixture",
    "Dispatch setup/env file endpoints that intentionally write local JSON/env files"
  ];

  try {
    fixtures = await createFixtures();
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;
    const loginResult = await login(baseUrl, fixtures.admin.username, "Rollback123");
    const baseline = await fingerprint(fixtures);
    const baselineText = normalizeJson(baseline);

    for (const testCase of buildCases(fixtures)) {
      const startedAt = Date.now();
      const response = await request(baseUrl, loginResult.token, testCase);
      await sleep(100);
      const after = await fingerprint(fixtures);
      const rolledBack = normalizeJson(after) === baselineText;
      const okStatus = response.status >= 200 && response.status < 300;
      results.push({
        name: testCase.name,
        method: testCase.method,
        path: testCase.path,
        status: response.status,
        okStatus,
        rolledBack,
        ms: Date.now() - startedAt,
        preview: typeof response.body === "string"
          ? response.body.slice(0, 160)
          : JSON.stringify(response.body || {}).slice(0, 160)
      });
      if (!okStatus || !rolledBack) {
        throw new Error(`${testCase.name} failed: status=${response.status}, rolledBack=${rolledBack}, body=${response.text}`);
      }
    }

    console.log(JSON.stringify({
      ok: true,
      tested: results.length,
      skipped,
      results
    }, null, 2));
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (fixtures) await cleanupFixtures(fixtures);
    await closeDb();
  }
}

await main();
