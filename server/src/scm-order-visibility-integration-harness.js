import assert from "node:assert/strict";
import { createOperator } from "./auth-repository.js";
import { closeDb, query } from "./db.js";

const { app } = await import("./server.js");

const seed = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const prefix = `VISIBILITY-${seed}`;
const password = "Rollback123";
const baseId = -(800000000000000 + Number(seed.slice(-9)) * 20);
const staleHoldId = Math.abs(baseId) + 1000;
const staleReconciliationHoldId = Math.abs(baseId) + 2000;
const staleReconciliationCompletedId = Math.abs(baseId) + 3000;
const vendorId = 700000000 + Number(seed.slice(-7));
const itemId = 600000000 + Number(seed.slice(-7));
const searchWindowPrefix = `PO-SPLIT-WINDOW-${seed}`;
const searchWindowTargetRef = `AAA-${searchWindowPrefix}-TARGET`;
const searchWindowBaseId = baseId - 1000000;
const searchWindowLineBaseId = baseId - 2000000;
const searchWindowFillerCount = 501;

const purchaseFixtures = [
  { id: baseId - 1, ref: `${prefix}-PO-QUEUED`, status: "Queued" },
  { id: baseId - 2, ref: `${prefix}-PO-BLANKET`, status: "Queued", blanket: true },
  { id: baseId - 3, ref: `${prefix}-PO-HOLD`, status: "Hold" },
  { id: baseId - 4, ref: `${prefix}-PO-COMPLETED`, status: "Completed" },
  { id: baseId - 5, ref: `${prefix}-PO-CANCELLED`, status: "Cancelled" },
  {
    id: staleHoldId,
    ref: `${prefix}-PO-STALE-RECON-HOLD`,
    status: "Hold",
    initialStatus: "Hold",
    scheduleStatus: "Hold"
  },
  {
    id: staleReconciliationHoldId,
    ref: `${prefix}-PO-MANUAL-QUEUED-STALE-HOLD`,
    status: "Queued",
    initialStatus: "Hold",
    scheduleStatus: "Queued",
    reconciliationStatus: "Hold",
    reconciliationFamilyStatus: "Queued"
  },
  {
    id: staleReconciliationCompletedId,
    ref: `${prefix}-PO-MANUAL-QUEUED-COMPLETED`,
    status: "Queued",
    initialStatus: "Hold",
    scheduleStatus: "Queued",
    reconciliationStatus: "Completed",
    reconciliationFamilyStatus: "Completed"
  },
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
    .filter((fixture) => fixture.blanket
      || ["Complete", "Completed"].includes(fixture.reconciliationStatus)
      || (
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

async function insertPoSplitSearchWindowFixtures() {
  await query(
    `INSERT INTO purchase_orders (
       netsuite_id, tranid, trandate, vendor_id, vendor, status, status_text,
       source_location_id, source_location, destination_location_id, destination_location,
       dispatch_vendor_yard, dispatch_address, receipt_status,
       initial_scm_status, is_blanket_po, netsuite_active, synced_at
     )
     SELECT
       $1::bigint - fixture_number,
       CASE
         WHEN fixture_number = $7::int THEN $2
         ELSE 'ZZZ-' || $3 || '-' || lpad(fixture_number::text, 4, '0')
       END,
       DATE '2026-07-30', $4, $5, 'pendingReceipt', 'Purchase Order : Pending Receipt',
       NULL, $6, 1, '3445',
       $6, '3445 Kennedy Road, Toronto, ON', 'not_received',
       'Queued', false, true, now()
     FROM generate_series(0, $7::int) AS fixture_number`,
    [
      searchWindowBaseId,
      searchWindowTargetRef,
      searchWindowPrefix,
      vendorId + 100000,
      `${searchWindowPrefix} Vendor`,
      `${searchWindowPrefix} Vendor Yard`,
      searchWindowFillerCount
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
     )
     SELECT
       $1::bigint - fixture_number,
       $2::bigint - fixture_number,
       9000 + fixture_number,
       $3::bigint + fixture_number,
       $4 || ' Item ' || fixture_number,
       $4 || '-SKU-' || fixture_number,
       10, 'EA',
       5, 1, 0, 0, 0,
       10, 0, 0, 1, 1, '3445',
       0, 0,
       0, 0, 0, 0,
       true, now(), '{}'::jsonb
     FROM generate_series(0, $5::int) AS fixture_number`,
    [
      searchWindowLineBaseId,
      searchWindowBaseId,
      itemId + 100000,
      searchWindowPrefix,
      searchWindowFillerCount
    ]
  );
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
  const staleHoldRef = `${prefix}-PO-STALE-RECON-HOLD`;
  const staleReconciliationHoldRef = `${prefix}-PO-MANUAL-QUEUED-STALE-HOLD`;
  const staleReconciliationCompletedRef = `${prefix}-PO-MANUAL-QUEUED-COMPLETED`;
  const reconciliationFixtures = [
    {
      id: staleHoldId,
      ref: staleHoldRef,
      familyStatus: "Queued",
      targetStatus: "Queued"
    },
    {
      id: staleReconciliationHoldId,
      ref: staleReconciliationHoldRef,
      familyStatus: "Queued",
      targetStatus: "Hold"
    },
    {
      id: staleReconciliationCompletedId,
      ref: staleReconciliationCompletedRef,
      familyStatus: "Completed",
      targetStatus: "Completed"
    }
  ];
  for (const fixture of reconciliationFixtures) {
    await query(
      `INSERT INTO scm_reconciliation_order_state (
         order_kind, source_order_netsuite_id, source_order_ref,
         application_status, reconciliation_status, reconciliation_source,
         ordered_qty, remaining_qty, quantity_summary, reconciled_at
       ) VALUES (
         'PO', $1, $2,
         $3, 'ok', 'manual',
         10, 10, $4::jsonb, now() - interval '10 minutes'
       )`,
      [
        fixture.id,
        fixture.ref,
        fixture.familyStatus,
        JSON.stringify({
          family: { ordered: 10, remaining: 10, applicationStatus: fixture.familyStatus },
          targets: {
            [fixture.ref]: {
              ordered: 10,
              remaining: 10,
              applicationStatus: fixture.targetStatus
            }
          }
        })
      ]
    );
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

  const mismatchedGroupRefs = [
    `${prefix}-PO-QUEUED`,
    `${prefix}-PO-HOLD`
  ];
  const mismatchedGroup = await requestJson(baseUrl, "/api/scm/schedule-groups?includeSchedule=false", {
    method: "POST",
    token: tokens.scm,
    body: { refs: mismatchedGroupRefs }
  });
  assert.equal(mismatchedGroup.response.status, 400,
    "SCM grouping must reject purchase orders with different effective statuses.");
  assert.equal(mismatchedGroup.payload?.code, "SCM_GROUP_STATUS_MISMATCH");
  assert.match(String(mismatchedGroup.payload?.error || ""), /different SCM statuses/i);
  const rejectedGroupRef = `PGOB-${mismatchedGroupRefs.join("-")}`;
  assert.equal((await query(
    "SELECT count(*)::int AS count FROM scm_schedule_groups WHERE group_ref = $1",
    [rejectedGroupRef]
  )).rows[0].count, 0, "A status-mismatched group must roll back without creating a group row.");

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

  const poSplitResponse = await requestJson(
    baseUrl,
    `/api/dispatch/scm/purchase-orders?search=${encodeURIComponent(staleHoldRef)}`,
    { token: tokens.scm }
  );
  assert.equal(poSplitResponse.response.status, 200,
    "SCM PO Split source request should succeed.");
  const staleHoldRow = fixtureRows(poSplitResponse.payload)
    .find((row) => String(row.id) === staleHoldRef);
  assert(staleHoldRow, "The stale-reconciliation PO fixture must be returned to SCM.");
  assert.equal(staleHoldRow.scm?.status, "Hold",
    "A newer saved Hold must override an older Queued reconciliation snapshot on PO Split.");

  const splitSourceSearchRef = `${prefix}-PO-HOLD`;
  const linkedSplitRef = `${prefix}-PO-SPLIT-CHILD`;
  const linkedSplitSearchResponse = await requestJson(
    baseUrl,
    `/api/dispatch/scm/purchase-orders?search=${encodeURIComponent(splitSourceSearchRef)}`,
    { token: tokens.scm }
  );
  assert.equal(linkedSplitSearchResponse.response.status, 200,
    "A PO Split source-reference search should succeed.");
  assert(
    linkedSplitSearchResponse.payload.some((row) => String(row.id) === linkedSplitRef),
    "Searching an original PO ref must keep returning its active split child."
  );

  const staleReconciliationHoldResponse = await requestJson(
    baseUrl,
    `/api/dispatch/scm/purchase-orders?search=${encodeURIComponent(staleReconciliationHoldRef)}`,
    { token: tokens.scm }
  );
  assert.equal(staleReconciliationHoldResponse.response.status, 200,
    "SCM PO Split stale-Hold source request should succeed.");
  const staleReconciliationHoldRow = fixtureRows(staleReconciliationHoldResponse.payload)
    .find((row) => String(row.id) === staleReconciliationHoldRef);
  assert(staleReconciliationHoldRow,
    "A PO with a newer manual Queued status must remain visible despite an older reconciliation Hold.");
  assert.equal(staleReconciliationHoldRow.scm?.status, "Queued",
    "A newer manual Queued status must override an older reconciliation Hold.");

  const completedResponse = await requestJson(
    baseUrl,
    `/api/dispatch/scm/purchase-orders?search=${encodeURIComponent(staleReconciliationCompletedRef)}`,
    { token: tokens.scm }
  );
  assert.equal(completedResponse.response.status, 200,
    "SCM PO Split completed source request should succeed.");
  const completedRow = fixtureRows(completedResponse.payload)
    .find((row) => String(row.id) === staleReconciliationCompletedRef);
  assert(completedRow, "SCM must retain access to the completed reconciliation fixture.");
  assert.equal(completedRow.scm?.status, "Completed",
    "Completed reconciliation must remain terminal despite a newer manual Queued status.");

  await insertPoSplitSearchWindowFixtures();
  const cappedPoSplitResponse = await requestJson(
    baseUrl,
    "/api/dispatch/scm/purchase-orders",
    { token: tokens.scm }
  );
  assert.equal(cappedPoSplitResponse.response.status, 200,
    "The default SCM PO Split request should succeed.");
  assert.equal(
    cappedPoSplitResponse.payload.some((row) => String(row.id) === searchWindowTargetRef),
    false,
    "The regression target must be outside the default 500-order PO Split window."
  );
  const searchedPoSplitResponse = await requestJson(
    baseUrl,
    `/api/dispatch/scm/purchase-orders?search=${encodeURIComponent(searchWindowTargetRef)}`,
    { token: tokens.scm }
  );
  assert.equal(searchedPoSplitResponse.response.status, 200,
    "A targeted SCM PO Split search should succeed.");
  assert(
    searchedPoSplitResponse.payload.some((row) => String(row.id) === searchWindowTargetRef),
    "A targeted PO Split search must query the database instead of filtering only the default 500-order window."
  );

  console.log("SCM restricted-order DB/API integration harness passed.");
} finally {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }

  const purchaseIds = purchaseFixtures.map((fixture) => fixture.id);
  const transferIds = transferFixtures.map((fixture) => fixture.id);
  const refs = allFixtures.map((fixture) => fixture.ref);
  await query(
    "DELETE FROM scm_reconciliation_order_state WHERE order_kind = 'PO' AND source_order_netsuite_id = ANY($1::bigint[])",
    [[staleHoldId, staleReconciliationHoldId, staleReconciliationCompletedId]]
  ).catch(() => null);
  await query("DELETE FROM scm_transport_schedule WHERE order_ref = ANY($1::text[])", [refs]).catch(() => null);
  await query("DELETE FROM transfer_order_lines WHERE transfer_order_id = ANY($1::bigint[])", [transferIds]).catch(() => null);
  await query("DELETE FROM transfer_orders WHERE netsuite_id = ANY($1::bigint[])", [transferIds]).catch(() => null);
  await query("DELETE FROM purchase_order_lines WHERE purchase_order_id = ANY($1::bigint[])", [purchaseIds]).catch(() => null);
  await query("DELETE FROM purchase_orders WHERE netsuite_id = ANY($1::bigint[])", [purchaseIds]).catch(() => null);
  await query(
    `DELETE FROM purchase_order_lines
      WHERE purchase_order_id IN (
        SELECT netsuite_id FROM purchase_orders WHERE tranid LIKE $1
      )`,
    [`%${searchWindowPrefix}%`]
  ).catch(() => null);
  await query("DELETE FROM purchase_orders WHERE tranid LIKE $1", [`%${searchWindowPrefix}%`]).catch(() => null);

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
