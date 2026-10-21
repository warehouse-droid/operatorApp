import assert from "node:assert/strict";
import test, { after } from "node:test";

import { closeDb, query } from "../../../src/db.js";
import { listDispatchOrders } from "../../../src/dispatch-repository.js";
import { upsertInboundTransferOrders, upsertOutboundTransferOrders } from "../../../src/order-sync-repository.js";
import {
  getDispatchOrderCatalogOrder,
  listDispatchOrderPool,
  upsertDispatchOrderCatalog
} from "../../../src/dispatch-order-catalog-repository.js";
import { syncDispatchDeliveryGroupsFromPlan } from "../../../src/dispatch-delivery-group-repository.js";
import {
  assertNoRestrictedScmDispatchOrders,
  loadDispatchOrdersForResponse
} from "../../../src/server.js";
import { completeDriver, scenario, seedSalesOrder } from "../support/fulfilled-so-fixture.js";
import { seedTransfer } from "../support/fulfilled-to-fixture.js";

after(closeDb);

async function emptyCatalog() {
  await query("TRUNCATE dispatch_order_catalog_entries RESTART IDENTITY CASCADE");
}

// The same regression runs against captured pre-migration production source.
// Missing first_seen_at there must yield behavioral failures, not collection errors.
async function setFirstSeenIfSupported(table, ids, timestamp) {
  assert.ok(["sales_orders", "purchase_orders", "transfer_orders"].includes(table));
  const exists = await query(`SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'first_seen_at'`, [table]);
  if (!exists.rowCount) return;
  const trigger = await query(`SELECT 1 FROM pg_trigger
    WHERE tgrelid = $1::regclass AND tgname = 'preserve_dispatch_order_first_seen_at'`, [table]);
  // Fixture initialization only, inside scenario's disposable rollback transaction.
  // Restore the exact immutability trigger before exercising production behavior.
  if (trigger.rowCount) await query(`ALTER TABLE ${table} DISABLE TRIGGER preserve_dispatch_order_first_seen_at`);
  await query(`UPDATE ${table} SET first_seen_at = $2::timestamptz WHERE netsuite_id = ANY($1::bigint[])`, [ids, timestamp]);
  if (trigger.rowCount) await query(`ALTER TABLE ${table} ENABLE TRIGGER preserve_dispatch_order_first_seen_at`);
}

test("recent cards project immutable full first-arrival timestamps while retaining NetSuite transaction dates", () => scenario(async () => {
  const salesRef = "SO-RECENT-MIRROR-DATE";
  const transferRef = "TO-RECENT-MIRROR-DATE";
  await seedSalesOrder(837150001, salesRef, { status: "B" });
  await seedTransfer(837150002, transferRef, { status: "F", scheduleStatus: "Queued" });
  await query("UPDATE sales_orders SET trandate = '2026-09-29', expected_delivery_date = '2026-12-31' WHERE netsuite_id = 837150001");
  await query("UPDATE transfer_orders SET trandate = '2026-09-29', expected_delivery_date = '2026-12-30' WHERE netsuite_id = 837150002");
  await setFirstSeenIfSupported("sales_orders", [837150001], "2026-09-29T08:12:23.456Z");
  await setFirstSeenIfSupported("transfer_orders", [837150002], "2026-09-29T09:23:34.567Z");

  const orders = await listDispatchOrders({ exactOrderRefs: [salesRef, transferRef] });
  assert.equal(orders.length, 2);
  for (const ref of [salesRef, transferRef]) {
    const order = orders.find(candidate => candidate.id === ref);
    assert.ok(order, `The NetSuite mirror order ${ref} must be discoverable.`);
    assert.equal(order.firstSeenAt, ref === salesRef ? "2026-09-29T08:12:23.456Z" : "2026-09-29T09:23:34.567Z", `${ref} must expose its full first-arrival timestamp.`);
    assert.equal(order.sourceOrderDate, "2026-09-29", `${ref} must retain its transaction date independently of the scheduled delivery date.`);
    assert.notEqual(order.sourceOrderDate, order.expectedDeliveryDate);
  }
}));

test("the first 200 cards prefer recent system arrivals over transaction dates and SCM activity and paginate every tied order once", () => scenario(async () => {
  await emptyCatalog();
  const oldOrders = Array.from({ length: 235 }, (_, index) => ({
    id: `TO-RECENT-OLD-${String(index).padStart(3, "0")}`,
    type: "TO",
    firstSeenAt: "2026-09-20T08:00:00.000Z",
    sourceOrderDate: "2026-09-30",
    expectedDeliveryDate: "2026-12-31",
    scm: { status: "Queued", method: "MBT", updatedAt: "2026-09-30T20:00:00.000Z" },
    items: [{ sku: "OLD-CARGO", quantity: 1 }]
  }));
  const recentOrders = ["TO-RECENT-01163", "TO-RECENT-01164"].map(id => ({
    id,
    type: "TO",
    firstSeenAt: "2026-09-29T08:12:23.456Z",
    sourceOrderDate: "2020-01-01",
    expectedDeliveryDate: "2026-10-01",
    scm: { status: "Queued", method: "MBT", updatedAt: "2026-09-29T08:00:00.000Z" },
    items: [{ sku: "RECENT-CARGO", quantity: 1 }]
  }));
  await upsertDispatchOrderCatalog({ source: "recent-card-regression", orders: [...recentOrders, ...oldOrders] });
  // A later logistics edit must not make an earlier system arrival look new.
  await upsertDispatchOrderCatalog({ source: "later-scm-edit", orders: [{
    ...oldOrders[0],
    scm: { ...oldOrders[0].scm, updatedAt: "2026-10-01T23:59:59.000Z" }
  }] });

  const first = await listDispatchOrderPool({ type: "TO", limit: 200 });
  assert.equal(first.orders.length, 200, "The initial card page must use the requested 200-card batch.");
  assert.deepEqual(first.orders.slice(0, 2).map(order => order.id), ["TO-RECENT-01164", "TO-RECENT-01163"]);
  assert.ok(first.nextCursor, "The remaining older cards need a cursor.");
  assert.equal(first.orders[0].firstSeenAt, "2026-09-29T08:12:23.456Z", "Compact cards must retain the full arrival timestamp used for ordering.");
  assert.equal(first.orders[0].sourceOrderDate, "2020-01-01", "Transaction dates remain metadata and do not define first-arrival order.");
  const second = await listDispatchOrderPool({ type: "TO", limit: 200, cursor: first.nextCursor });
  assert.equal(second.orders.length, 37);
  assert.equal(second.nextCursor, "");
  const actual = [...first.orders, ...second.orders].map(order => order.id);
  const expected = ["TO-RECENT-01164", "TO-RECENT-01163", ...oldOrders.map(order => order.id).sort().reverse()];
  assert.deepEqual(actual, expected, "Equal first-arrival timestamps must use a stable identity tie-break across the 200-card boundary.");
  assert.equal(new Set(actual).size, 237, "Paging must neither repeat nor omit a card.");
}));

test("the 500-order candidate window includes a newly arrived transfer with an old NetSuite transaction date", () => scenario(async () => {
  await emptyCatalog();
  const baseId = 837153000;
  const earlyIds = Array.from({ length: 501 }, (_, index) => baseId + index);
  await query(`INSERT INTO transfer_orders
    (netsuite_id, tranid, trandate, status, status_text, netsuite_active,
     from_location_id, from_location, to_location_id, to_location,
     outbound_operator_status, receiving_status, local_yard_order_status, fulfillment_status, synced_at)
    SELECT $1::bigint + n, 'TO-RECENT-EARLY-' || lpad(n::text, 3, '0'), '2026-09-30', 'F',
      'Transfer Order : Pending Receipt', true, 1, '3445', 15, '12441', 'open',
      'not_received', 'Open', 'not_fulfilled', '2026-10-02T20:00:00Z'
    FROM generate_series(0, 500) n`, [baseId]);
  await query(`INSERT INTO transfer_order_lines
    (line_stage, id, transfer_order_id, line_id, item_id, item_name, sku, item_type, quantity, unit, netsuite_active)
    SELECT 'outbound', $1::bigint + n, $1::bigint + n, 1, 837159900,
      'Recent boundary cargo', 'RECENT-BOUNDARY', 'InvtPart', 1, 'EA', true
    FROM generate_series(0, 500) n`, [baseId]);
  await setFirstSeenIfSupported("transfer_orders", earlyIds, "2026-09-20T08:00:00.000Z");
  const lateId = 837153501;
  const lateRef = "TO-RECENT-OLD-TRANSACTION-LATE-IMPORT";
  await seedTransfer(lateId, lateRef, { status: "F", scheduleStatus: "Queued" });
  await query("UPDATE transfer_orders SET trandate = '2020-01-01', synced_at = '2026-09-30T08:12:23.456Z' WHERE netsuite_id = $1", [lateId]);
  await setFirstSeenIfSupported("transfer_orders", [lateId], "2026-09-30T08:12:23.456Z");

  const candidates = await listDispatchOrders({ type: "TO" });
  assert.equal(candidates.length, 500, "The bounded source candidate window remains 500 orders.");
  assert.equal(candidates[0].id, lateRef, "An old transaction first imported recently must precede earlier imports with newer transaction dates and later syncs.");
  assert.equal(candidates[0].firstSeenAt, "2026-09-30T08:12:23.456Z");
  assert.equal(candidates[0].sourceOrderDate, "2020-01-01");
  await upsertDispatchOrderCatalog({ source: "first-arrival-boundary", orders: candidates });
  const first = await listDispatchOrderPool({ type: "TO", limit: 200 });
  assert.equal(first.orders.length, 200);
  assert.equal(first.orders[0].id, lateRef, "The 200-card page must use the same arrival ranking as the 500-order candidate feed.");
}));

test("real outbound and inbound mirror resyncs retain a transfer's original first-arrival timestamp", () => scenario(async () => {
  const id = 837150006;
  const ref = "TO-RECENT-IMMUTABLE-ARRIVAL";
  const payload = {
    id, tranid: ref, trandate: "2020-01-01", status: "F",
    status_text: "Transfer Order : Pending Receipt", source_location_id: 1, source_location: "3445",
    outbound_location_id: 1, outbound_location: "3445", destination_location_id: 15, destination_location: "12441"
  };
  await upsertOutboundTransferOrders([payload]);
  const before = (await query("SELECT to_jsonb(o)->>'first_seen_at' AS first_seen_at FROM transfer_orders o WHERE netsuite_id = $1", [id])).rows[0].first_seen_at;
  assert.ok(before, "The first actual mirror import must persist its arrival timestamp.");
  await query(`INSERT INTO transfer_order_lines
    (line_stage, id, transfer_order_id, line_id, item_id, item_name, sku, item_type, quantity, unit, netsuite_active)
    VALUES ('outbound', $1, $1, 1, 837159900, 'Arrival persistence cargo', 'RECENT-IMMUTABLE', 'InvtPart', 1, 'EA', true)`, [id]);
  await query("UPDATE transfer_orders SET synced_at = '2000-01-01' WHERE netsuite_id = $1", [id]);
  for (const upsert of [upsertOutboundTransferOrders, upsertInboundTransferOrders]) {
    await upsert([{ ...payload, trandate: "2026-09-30", memo: "Later NetSuite refresh" }]);
    const after = (await query("SELECT to_jsonb(o)->>'first_seen_at' AS first_seen_at, synced_at FROM transfer_orders o WHERE netsuite_id = $1", [id])).rows[0];
    assert.equal(after.first_seen_at, before, "ON CONFLICT updates must preserve the original first-seen value.");
    assert.notEqual(new Date(after.synced_at).toISOString(), "2000-01-01T00:00:00.000Z", "The mirror resync must actually update sync activity.");
    const orders = await listDispatchOrders({ type: "TO", exactOrderRefs: [ref] });
    assert.equal(orders.find(order => order.id === ref)?.firstSeenAt, new Date(before).toISOString());
  }
}));

test("receipt-reconciled transfer cargo pending physical delivery appears in browse and in the indexed initial cards", () => scenario(async () => {
  await emptyCatalog();
  const ref = "TO-RECENT-RECEIVED-PHYSICAL-PENDING";
  await seedTransfer(837150003, ref);
  await query("UPDATE transfer_orders SET trandate = '2026-09-29' WHERE netsuite_id = 837150003");

  const searched = await loadDispatchOrdersForResponse({ type: "TO", search: ref, includeCompletedScmSearch: true });
  assert.equal(searched.find(order => order.id === ref)?.dispatchFulfilledTransferPlanningEligible, true, "Receipt evidence already permits explicit-search planning.");
  const browsed = await loadDispatchOrdersForResponse({ type: "TO" });
  const received = browsed.find(order => order.id === ref);
  assert.ok(received, "Receiving reconciliation must not remove physical-delivery-pending cargo from the initial browse feed.");
  assert.equal(received.dispatchFulfilledTransferPlanningEligible, true);
  assert.equal(received.dispatchPlanningRestricted, false);
  assert.equal(received.items[0].quantity, 40);
  await assertNoRestrictedScmDispatchOrders([ref]);
  await upsertDispatchOrderCatalog({ source: "received-browse-refresh", orders: browsed });
  const pool = await listDispatchOrderPool({ type: "TO", limit: 200 });
  assert.ok(pool.orders.some(order => order.id === ref), "A full browse refresh must keep the received transfer in indexed cards.");
}));

test("recent-card eligibility continues to exclude Driver and manually completed transfer deliveries", () => scenario(async () => {
  const driverRef = "TO-RECENT-DRIVER-COMPLETE";
  const manualRef = "TO-RECENT-MANUAL-COMPLETE";
  await seedTransfer(837150004, driverRef);
  await seedTransfer(837150005, manualRef, { updatedBy: "operator" });
  await completeDriver(driverRef);
  await query(`INSERT INTO dispatch_order_completion_events
    (order_kind, order_ref, dispatch_completed_at, completion_evidence_type, completion_evidence_id, actor_type, actor_id, reason)
    VALUES ('TO', $1, now(), 'manual_dispatch', $1, 'operator', 'recent-card-test', 'Physical delivery confirmed manually')`, [manualRef]);

  const browsed = await loadDispatchOrdersForResponse({ type: "TO" });
  assert.ok(!browsed.some(order => [driverRef, manualRef].includes(order.id)), "Actual physical completion must continue to exclude orders from browse.");
  for (const ref of [driverRef, manualRef]) {
    const searched = await loadDispatchOrdersForResponse({ type: "TO", search: ref, includeCompletedScmSearch: true });
    const found = searched.find(order => order.id === ref);
    assert.ok(found, "Explicit search preserves completed-delivery evidence for review.");
    assert.equal(found.dispatchFulfilledTransferPlanningEligible, false);
    assert.equal(found.dispatchPlanningRestricted, true);
    await assert.rejects(assertNoRestrictedScmDispatchOrders([ref]));
  }
}));

test("global splits inherit refreshed first arrival and groups rank by the latest member arrival rather than definition edits", () => scenario(async () => {
  await emptyCatalog();
  const source = (id, firstSeenAt, netsuiteId) => ({
    id, type: "SO", sourceTable: "sales_orders", netsuiteId, netsuiteActive: true,
    firstSeenAt, sourceOrderDate: "2020-01-01", sourceYard: "3445", address: "Recent derived fixture road",
    eligible: true, items: [{ sku: "DERIVED-CARGO", quantity: 10, pallets: 1 }]
  });
  const parent = source("SO-RECENT-SPLIT-PARENT", "2026-09-30T08:12:23.456Z", 837151000);
  const firstMember = source("SO-RECENT-GROUP-OLDER", "2026-09-20T08:12:23.456Z", 837151001);
  const secondMember = source("SO-RECENT-GROUP-NEWER", "2026-09-29T08:12:23.456Z", 837151002);
  const olderCards = Array.from({ length: 205 }, (_, index) => ({
    ...source(`SO-RECENT-DERIVED-OLD-${String(index).padStart(3, "0")}`, "2026-08-01T08:12:23.456Z", 837152000 + index),
    sourceOrderDate: "2026-10-02",
    updatedAt: "2026-10-02T00:00:00.000Z"
  }));
  await upsertDispatchOrderCatalog({ source: "derived-recent-seed", orders: [parent, firstMember, secondMember, ...olderCards] });
  const planId = (await query("INSERT INTO dispatch_plans (plan_date, status, revision, note) VALUES ('2096-12-03', 'draft', 1, 'recent derived regression') RETURNING id")).rows[0].id;
  const split = {
    ...parent, id: `${parent.id}-S1`, originalOrderId: parent.id,
    firstSeenAt: "2026-07-01T08:12:23.456Z", items: [{ ...parent.items[0], quantity: 4 }]
  };
  const group = {
    id: "GO-RECENT-MAX-MEMBER", type: "SO", sourceYard: "3445", eligible: true,
    childOrders: [firstMember.id, secondMember.id], childOrderDetails: [firstMember, secondMember],
    items: [...firstMember.items, ...secondMember.items]
  };
  await syncDispatchDeliveryGroupsFromPlan({ id: planId, planDate: "2096-12-03", revision: 1, orders: [split, group], trucks: [] });
  // Authoritative source refresh replaces stale source metadata while retaining split cargo.
  await upsertDispatchOrderCatalog({ source: "derived-recent-refresh", orders: [parent, firstMember, secondMember] });
  // Editing the group's definition later than the split must not override source order recency.
  await query("UPDATE dispatch_global_order_splits SET updated_at = '2026-06-01T00:00:00Z' WHERE split_ref = $1", [split.id]);
  await query("UPDATE dispatch_global_order_groups SET updated_at = '2026-10-03T00:00:00Z' WHERE group_ref = $1", [group.id]);

  const fullSplit = await getDispatchOrderCatalogOrder(split.id);
  assert.equal(fullSplit.firstSeenAt, "2026-09-30T08:12:23.456Z", "A source refresh must replace stale split metadata with the parent's original arrival timestamp.");
  assert.equal(fullSplit.items[0].quantity, 4, "Refreshing recency must retain the split's allocated cargo.");
  const pool = await listDispatchOrderPool({ type: "SO", limit: 200 });
  assert.equal(pool.orders.length, 200);
  assert.deepEqual(pool.orders.slice(0, 2).map(order => order.id), [split.id, group.id]);
  assert.equal(pool.orders[0].firstSeenAt, "2026-09-30T08:12:23.456Z");
  assert.equal(pool.orders[1].firstSeenAt, "2026-09-29T08:12:23.456Z", "A group inherits its latest member's original system-arrival timestamp.");
  assert.ok(!pool.orders.some(order => [parent.id, firstMember.id, secondMember.id].includes(order.id)), "The recency change must preserve split-parent and grouped-member hiding.");
}));

test("recency cursors are versioned and a valid pre-recency cursor restarts the first page safely", () => scenario(async () => {
  await emptyCatalog();
  const orders = ["SO-RECENT-CURSOR-001", "SO-RECENT-CURSOR-002", "SO-RECENT-CURSOR-003"].map(id => ({
    id, type: "SO", firstSeenAt: "2026-09-29T08:12:23.456Z", sourceOrderDate: "2020-01-01", updatedAt: "2026-09-30T20:00:00.000Z"
  }));
  await upsertDispatchOrderCatalog({ source: "recent-cursor-rollout", orders });
  const first = await listDispatchOrderPool({ type: "SO", limit: 2 });
  assert.ok(first.nextCursor);
  const generated = JSON.parse(Buffer.from(first.nextCursor, "base64url").toString("utf8"));
  const oldCursor = Buffer.from(JSON.stringify({
    e: 0, d: "2026-09-30T20:00:00.000Z", k: "so-recent-cursor-002", r: "so-recent-cursor-002"
  }), "utf8").toString("base64url");
  const restarted = await listDispatchOrderPool({ type: "SO", limit: 2, cursor: oldCursor });
  assert.deepEqual({ generatedVersion: generated.v, restarted: restarted.orders.map(order => order.id) }, {
    generatedVersion: 2, restarted: ["SO-RECENT-CURSOR-003", "SO-RECENT-CURSOR-002"]
  }, "A cursor ordered by SCM activity cannot be applied to first-arrival ordering.");
  const second = await listDispatchOrderPool({ type: "SO", limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.orders.map(order => order.id), ["SO-RECENT-CURSOR-001"]);
  assert.equal(second.nextCursor, "");
}));
