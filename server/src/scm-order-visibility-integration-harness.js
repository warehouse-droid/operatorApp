import assert from "node:assert/strict";
import { createOperator } from "./auth-repository.js";
import { closeDb, query } from "./db.js";

const { app } = await import("./server.js");

const seed = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const prefix = `VISIBILITY-${seed}`;
const password = "Rollback123";
const baseId = -(800000000000000 + Number(seed.slice(-9)) * 20);
const vendorId = 700000000 + Number(seed.slice(-7));
const itemId = 600000000 + Number(seed.slice(-7));

const purchaseFixtures = [
  { id: baseId - 1, ref: `${prefix}-PO-QUEUED`, status: "Queued" },
  { id: baseId - 2, ref: `${prefix}-PO-BLANKET`, status: "Queued", blanket: true },
  { id: baseId - 3, ref: `${prefix}-PO-HOLD`, status: "Hold" },
  { id: baseId - 4, ref: `${prefix}-PO-COMPLETED`, status: "Completed" },
  { id: baseId - 5, ref: `${prefix}-PO-CANCELLED`, status: "Cancelled" },
  {
    id: baseId - 6,
    ref: `${prefix}-PO-INITIAL-HOLD-QUEUED`,
    status: "Queued",
    initialStatus: "Hold",
    scheduleStatus: "Queued"
  },
  {
    id: baseId - 7,
    ref: `${prefix}-PO-INITIAL-HOLD-PLANNED`,
    status: "Planned",
    initialStatus: "Hold",
    scheduleStatus: "Planned"
  },
  {
    id: baseId - 8,
    ref: `${prefix}-PO-SPLIT-CHILD`,
    status: "Queued",
    splitFromRef: `${prefix}-PO-HOLD`
  }
];
const transferFixtures = [
  { id: baseId - 11, ref: `${prefix}-TO-QUEUED`, status: "Queued" },
  { id: baseId - 12, ref: `${prefix}-TO-HOLD`, status: "Hold" },
  { id: baseId - 13, ref: `${prefix}-TO-COMPLETED`, status: "Completed" },
  { id: baseId - 14, ref: `${prefix}-TO-CANCELLED`, status: "Cancelled" }
];
const allFixtures = [...purchaseFixtures, ...transferFixtures];
const restrictedRefs = new Set(
  allFixtures
    .filter((fixture) => fixture.blanket || (
      !fixture.scheduleStatus
      && ["Hold", "Completed", "Cancelled"].includes(fixture.initialStatus || fixture.status)
    ) || ["Hold", "Completed", "Cancelled"].includes(fixture.scheduleStatus))
    .map((fixture) => fixture.ref)
);
const normalRefs = new Set(
  allFixtures.filter((fixture) => !restrictedRefs.has(fixture.ref)).map((fixture) => fixture.ref)
);
const operatorAccounts = [];
let server = null;

async function requestJson(baseUrl, pathname, {
  method = "GET",
  token = "",
  body = null
} = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  return { response, payload };
}

function fixtureRows(payload) {
  return (Array.isArray(payload) ? payload : [])
    .filter((row) => String(row?.orderRef ?? row?.id ?? "").startsWith(prefix));
}

function fixtureRefs(payload) {
  return fixtureRows(payload).map((row) => String(row.orderRef ?? row.id));
}

function assertNoRestricted(payload, label) {
  const returnedRestricted = fixtureRefs(payload).filter((ref) => restrictedRefs.has(ref));
  assert.deepEqual(returnedRestricted, [], `${label} leaked restricted rows: ${returnedRestricted.join(", ")}`);
}

function assertHasNormalControls(payload, label) {
  const returned = new Set(fixtureRefs(payload));
  for (const ref of normalRefs) {
    assert(returned.has(ref), `${label} did not return eligible control row ${ref}.`);
  }
}

async function insertPurchaseFixture(fixture, index) {
  await query(
    `INSERT INTO purchase_orders (
       netsuite_id, tranid, trandate, vendor_id, vendor, status, status_text,
       source_location_id, source_location, destination_location_id, destination_location,
       dispatch_vendor_yard, dispatch_address, receipt_status,
       initial_scm_status, is_blanket_po, netsuite_active, synced_at
     ) VALUES (
       $1, $2, DATE '2026-07-30', $3, $4, 'pendingReceipt', 'Purchase Order : Pending Receipt',
       NULL, $5, 1, '3445',
       $5, '3445 Kennedy Road, Toronto, ON', 'not_received',
       $6, $7, true, now()
     )`,
    [
      fixture.id,
      fixture.ref,
      vendorId,
      `${prefix} Vendor`,
      `${prefix} Vendor Yard`,
      fixture.initialStatus || (fixture.status === "Hold" ? "Hold" : "Queued"),
      fixture.blanket === true
    ]
  );
  await query(
    `INSERT INTO purchase_order_lines (
       id, purchase_order_id, line_id, item_id, item_name, sku, quantity, unit,
       item_weight, pallet_qty, layer_qty, section_qty, piece_qty,
       to_plt, to_lyr, to_sec, to_pcs, location_id, location,
       netsuite_received_qty, netsuite_received_baseline_qty,
       received_pallet_qty, received_layer_qty, received_section_qty, received_piece_qty,
       netsuite_active, synced_at, raw
     ) VALUES (
       $1, $2, $3, $4, $5, $6, 10, 'EA',
       5, 1, 0, 0, 0,
       10, 0, 0, 1, 1, '3445',
       0, 0,
       0, 0, 0, 0,
       true, now(), '{}'::jsonb
     )`,
    [
      baseId - 100 - index,
      fixture.id,
      1000 + index,
      itemId + index,
      `${prefix} Purchase Item ${index}`,
      `${prefix}-PO-ITEM-${index}`
    ]
  );
  if (fixture.scheduleStatus || ["Completed", "Cancelled"].includes(fixture.status)) {
    await insertScheduleFixture("PO", {
      ...fixture,
      status: fixture.scheduleStatus || fixture.status
    });
  }
}

async function insertTransferFixture(fixture, index) {
  await query(
    `INSERT INTO transfer_orders (
       netsuite_id, tranid, trandate, status, status_text,
       from_location_id, from_location, to_location_id, to_location,
       outbound_operator_status, local_yard_order_status,
       receiving_status, fulfillment_status, netsuite_active, synced_at
     ) VALUES (
       $1, $2, DATE '2026-07-30', 'B', 'Transfer Order : Pending Receipt',
       1, '3445', 28, '2967',
       'Open', 'Open',
       'not_received', 'fulfilled', true, now()
     )`,
    [fixture.id, fixture.ref]
  );
  await query(
    `INSERT INTO transfer_order_lines (
       id, line_stage, transfer_order_id, line_id, item_id, item_name, sku,
       quantity, unit, item_weight,
       pallet_qty, layer_qty, section_qty, piece_qty,
       to_plt, to_lyr, to_sec, to_pcs,
       loaded_qty, netsuite_received_qty, location_id, location,
       netsuite_active, synced_at, raw
     ) VALUES
       ($1, 'outbound', $2, $3, $4, $5, $6,
        10, 'EA', 5,
        1, 0, 0, 0,
        10, 0, 0, 1,
        0, 0, 1, '3445',
        true, now(), '{}'::jsonb),
       ($7, 'receiving', $2, $8, $4, $5, $6,
        10, 'EA', 5,
        1, 0, 0, 0,
        10, 0, 0, 1,
        0, 0, 28, '2967',
        true, now(), '{}'::jsonb)`,
    [
      baseId - 200 - (index * 2),
      fixture.id,
      2000 + (index * 2),
      itemId + 100 + index,
      `${prefix} Transfer Item ${index}`,
      `${prefix}-TO-ITEM-${index}`,
      baseId - 201 - (index * 2),
      2001 + (index * 2)
    ]
  );
  if (fixture.status !== "Queued") {
    await insertScheduleFixture("TO", fixture);
  }
}

async function insertScheduleFixture(orderKind, fixture) {
  await query(
    `INSERT INTO scm_transport_schedule (
       order_kind, source_table, source_id, order_ref, display_ref,
       method, pickup_point, dropoff_point, brand, content, weight_lbs, status,
       created_by, updated_by
     ) VALUES (
       $1, $2, $3, $4, $4,
       'MBT', $5, $6, $7, $8, 50, $9,
       'visibility-harness', 'visibility-harness'
     )`,
    [
      orderKind,
      orderKind === "PO" ? "purchase_orders" : "transfer_orders",
      fixture.id,
      fixture.ref,
      orderKind === "PO" ? `${prefix} Vendor Yard` : "3445",
      orderKind === "PO" ? "3445" : "2967",
      orderKind === "PO" ? `${prefix} Vendor` : "Transfer",
      `${fixture.ref} integration fixture`,
      fixture.status
    ]
  );
}

async function login(baseUrl, account) {
  const result = await requestJson(baseUrl, "/api/auth/login", {
    method: "POST",
    body: { username: account.username, password }
  });
  assert.equal(result.response.status, 200, `${account.role} login should succeed.`);
  assert(result.payload?.token, `${account.role} login did not return a token.`);
  return result.payload.token;
}

async function assertRestrictedScheduleHidden(baseUrl, token, label, endpoint = "/api/scm/schedule") {
  const queries = [
    `view=completed&search=${encodeURIComponent(prefix)}`,
    `view=blanket&search=${encodeURIComponent(prefix)}`,
    `status=Hold&search=${encodeURIComponent(prefix)}`
  ];
  for (const queryString of queries) {
    const result = await requestJson(baseUrl, `${endpoint}?${queryString}`, { token });
    assert.equal(result.response.status, 200, `${label} schedule request should succeed: ${queryString}`);
    assertNoRestricted(result.payload, `${label} schedule ${queryString}`);
  }
}

try {
  for (const [index, fixture] of purchaseFixtures.entries()) {
    await insertPurchaseFixture(fixture, index);
  }
  for (const fixture of purchaseFixtures.filter((row) => row.splitFromRef)) {
    const parent = purchaseFixtures.find((row) => row.ref === fixture.splitFromRef);
    assert(parent, `Split fixture parent is missing for ${fixture.ref}.`);
    await query(
      `INSERT INTO dispatch_scm_po_splits (
         source_po_id, source_po_ref, split_po_id, split_po_ref,
         status, created_by, details
       ) VALUES ($1, $2, $3, $4, 'active', 'visibility-harness', '{}'::jsonb)`,
      [parent.id, parent.ref, fixture.id, fixture.ref]
    );
  }
  for (const [index, fixture] of transferFixtures.entries()) {
    await insertTransferFixture(fixture, index);
  }

  const accountSpecs = [
    { key: "dispatcher", role: "dispatcher", yardLocationIds: [] },
    { key: "sales", role: "sales", yardLocationIds: [1] },
    { key: "yardManager", role: "yard_manager", yardLocationIds: [1] },
    { key: "scm", role: "scm", yardLocationIds: [] },
    { key: "admin", role: "admin", yardLocationIds: [] }
  ];
  const accounts = {};
  for (const spec of accountSpecs) {
    const account = await createOperator({
      username: `${prefix}-${spec.key}`.toLowerCase(),
      displayName: `${prefix} ${spec.key}`,
      password,
      role: spec.role,
      roles: [spec.role],
      yardLocationIds: spec.yardLocationIds
    });
    operatorAccounts.push(account);
    accounts[spec.key] = account;
  }

  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const tokens = {};
  for (const [key, account] of Object.entries(accounts)) {
    tokens[key] = await login(baseUrl, account);
  }

  for (const [role, token] of [
    ["Dispatcher", tokens.dispatcher],
    ["Sales", tokens.sales],
    ["Admin", tokens.admin]
  ]) {
    const dispatch = await requestJson(
      baseUrl,
      `/api/dispatch/orders?search=${encodeURIComponent(prefix)}&includeHiddenScm=true`,
      { token }
    );
    assert.equal(dispatch.response.status, 200, `${role} dispatch order request should succeed.`);
    assertNoRestricted(dispatch.payload, `${role} dispatch response`);
    assertHasNormalControls(dispatch.payload, `${role} dispatch response`);
  }

  await assertRestrictedScheduleHidden(baseUrl, tokens.dispatcher, "Dispatcher");
  const dispatcherNormal = await requestJson(
    baseUrl,
    `/api/scm/schedule?view=dispatch&search=${encodeURIComponent(prefix)}`,
    { token: tokens.dispatcher }
  );
  assert.equal(dispatcherNormal.response.status, 200);
  assertHasNormalControls(dispatcherNormal.payload, "Dispatcher normal schedule");

  await assertRestrictedScheduleHidden(baseUrl, tokens.sales, "Sales", "/api/sales/schedule");
  const salesNormal = await requestJson(
    baseUrl,
    `/api/sales/schedule?view=yard%20manager&search=${encodeURIComponent(prefix)}`,
    { token: tokens.sales }
  );
  assert.equal(salesNormal.response.status, 200);
  assertHasNormalControls(salesNormal.payload, "Sales normal schedule");

  await assertRestrictedScheduleHidden(baseUrl, tokens.yardManager, "Yard Manager");
  const yardManagerNormal = await requestJson(
    baseUrl,
    `/api/scm/schedule?view=yard%20manager&search=${encodeURIComponent(prefix)}`,
    { token: tokens.yardManager }
  );
  assert.equal(yardManagerNormal.response.status, 200, "Yard Manager must receive narrowly allowed schedule read access.");
  assertHasNormalControls(yardManagerNormal.payload, "Yard Manager normal schedule");
  const yardManagerScmBypass = await requestJson(baseUrl, "/api/scm/local-vendors", {
    token: tokens.yardManager
  });
  assert.equal(yardManagerScmBypass.response.status, 403,
    "Yard Manager schedule access must not broaden into general SCM API access.");

  for (const [role, token] of [["SCM", tokens.scm], ["Admin", tokens.admin]]) {
    const completed = await requestJson(
      baseUrl,
      `/api/scm/schedule?view=completed&search=${encodeURIComponent(prefix)}`,
      { token }
    );
    assert.equal(completed.response.status, 200, `${role} Completed schedule should succeed.`);
    const completedRefs = new Set(fixtureRefs(completed.payload));
    for (const fixture of allFixtures.filter((row) => ["Completed", "Cancelled"].includes(row.status))) {
      assert(completedRefs.has(fixture.ref), `${role} Completed view did not return ${fixture.ref}.`);
    }

    const blanket = await requestJson(
      baseUrl,
      `/api/scm/schedule?view=blanket&search=${encodeURIComponent(prefix)}`,
      { token }
    );
    assert.equal(blanket.response.status, 200, `${role} Blanket schedule should succeed.`);
    assert(
      fixtureRefs(blanket.payload).includes(`${prefix}-PO-BLANKET`),
      `${role} Blanket view did not return the flagged purchase order.`
    );

    const hold = await requestJson(
      baseUrl,
      `/api/scm/schedule?search=${encodeURIComponent(`${prefix}-PO-HOLD`)}`,
      { token }
    );
    assert.equal(hold.response.status, 200, `${role} Hold schedule search should succeed.`);
    assert(
      fixtureRefs(hold.payload).includes(`${prefix}-PO-HOLD`),
      `${role} could not retrieve a Hold purchase order.`
    );
  }

  console.log("SCM restricted-order DB/API integration harness passed.");
} finally {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }

  const purchaseIds = purchaseFixtures.map((fixture) => fixture.id);
  const transferIds = transferFixtures.map((fixture) => fixture.id);
  const refs = allFixtures.map((fixture) => fixture.ref);
  await query("DELETE FROM scm_transport_schedule WHERE order_ref = ANY($1::text[])", [refs]).catch(() => null);
  await query("DELETE FROM transfer_order_lines WHERE transfer_order_id = ANY($1::bigint[])", [transferIds]).catch(() => null);
  await query("DELETE FROM transfer_orders WHERE netsuite_id = ANY($1::bigint[])", [transferIds]).catch(() => null);
  await query("DELETE FROM purchase_order_lines WHERE purchase_order_id = ANY($1::bigint[])", [purchaseIds]).catch(() => null);
  await query("DELETE FROM purchase_orders WHERE netsuite_id = ANY($1::bigint[])", [purchaseIds]).catch(() => null);

  const operatorIds = operatorAccounts.map((account) => account.id);
  const usernames = operatorAccounts.map((account) => account.username);
  if (operatorIds.length) {
    await query("DELETE FROM operator_sessions WHERE operator_id = ANY($1::text[])", [operatorIds]).catch(() => null);
    await query(
      `DELETE FROM delivery_audit_log
        WHERE actor_operator_id = ANY($1::text[])
           OR details->>'username' = ANY($2::text[])`,
      [operatorIds, usernames]
    ).catch(() => null);
    await query("DELETE FROM dispatch_audit_log WHERE operator_id = ANY($1::text[])", [operatorIds]).catch(() => null);
    await query("DELETE FROM operators WHERE id = ANY($1::text[])", [operatorIds]).catch(() => null);
  }
  await closeDb();
}
