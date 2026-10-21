import assert from "node:assert/strict";
import test, { after } from "node:test";
import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import { listScmSchedule, updateScmScheduleEntry } from "../../../src/dispatch-repository.js";

after(closeDb);

async function fixture(run) {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      await query(`INSERT INTO operators (id, username, display_name, password_hash, password_salt, role, roles)
        VALUES ('auto-special-test', 'auto-special-test', 'TEST', 'hash', 'salt', 'admin', ARRAY['admin'])`);
      await run();
    });
  } finally { await rollback.rollback(); }
}

async function po(id, { itemId = 7001, itemName = "Pavers", sku = "PAVERS", active = true, alias = "" } = {}) {
  const ref = `PO-AUTO-SPECIAL-${id}`;
  await query(`INSERT INTO purchase_orders (netsuite_id, tranid, dispatch_ref, vendor, status, status_text,
      destination_location_id, destination_location, dispatch_vendor_yard, initial_scm_status, netsuite_active, memo)
    VALUES ($1, $2, $3, 'TEST vendor', 'B', 'Pending Receipt', 1, '3445', 'TEST vendor yard', 'Queued', true, 'Pickup at gate 2')`,
  [id, ref, alias]);
  await query(`INSERT INTO purchase_order_lines (purchase_order_id, line_id, item_id, item_name, sku,
      quantity, unit, netsuite_active) VALUES ($1, 1, $2, $3, $4, 10, 'PC', $5)`, [id, itemId, itemName, sku, active]);
  return alias || ref;
}

async function link(poId, soRef = "SOB12345", workflowKind = "special") {
  const request = (await query(`INSERT INTO sales_stock_requests
      (request_type, destination_location_id, destination_name, requested_by, workflow_version, regular_details)
    VALUES ($1, 1, '3445', 'auto-special-test', 2, $2::jsonb) RETURNING id`,
  [workflowKind === "special" ? "special" : "regular", JSON.stringify(workflowKind === "special" ? {} : { deliveryMethod: "backorder" })])).rows[0];
  await query(`INSERT INTO sales_special_stock_cases (request_id, inquiry_date, customer_name, vendor_name,
      sales_order_netsuite_id, sales_order_ref, purchase_order_netsuite_id, purchase_order_ref,
      workflow_kind, sales_order_source, purchase_order_custom_linkage)
    VALUES ($1, current_date, 'TEST customer', 'TEST vendor', $2, $3, $4, $5, $6, 'manual_link', true)`,
  [request.id, soRef ? 9901001 : null, soRef, poId, `PO-AUTO-SPECIAL-${poId}`, workflowKind]);
  return request.id;
}

async function row(ref, filters = {}) {
  const rows = await listScmSchedule({ exactRef: ref, ...filters });
  assert.equal(rows.length, 1);
  return rows[0];
}

test("active special items automatically classify POs by ID, name or SKU, without manual schedule rows", () => fixture(async () => {
  const cases = [
    [{ itemId: 2055 }, true],
    [{ itemName: " mbbs-special order " }, true],
    [{ sku: "MBBS-Special Order" }, true],
    [{ itemName: "MBBS-Special Order", active: false }, false],
    [{ itemName: "MBBS-Special Order accessory" }, false],
    [{}, false]
  ];
  for (const [index, [options, expected]] of cases.entries()) {
    const ref = await po(9971000 + index, options);
    const actual = await row(ref);
    assert.equal(actual.isSpecialOrder, expected);
    assert.equal(actual.isAutomaticSpecialOrder, expected);
    assert.equal(actual.remark, "Pickup at gate 2");
    assert.equal((await listScmSchedule({ exactRef: ref, kind: "Sp.O" })).length, expected ? 1 : 0);
  }
}));

test("request links drive Sp.O and searchable local SO prefixes across aliases, edits, sync and unlink", () => fixture(async () => {
  const id = 9971010;
  const ref = await po(id, { alias: "SN-AUTO-SPECIAL-ALIAS" });
  const requestId = await link(id);
  let actual = await row(ref, { kind: "Sp.O", remarkSearch: "for sob12345 pickup" });
  assert.equal(actual.isSpecialOrder, true);
  assert.equal(actual.remark, "For SOB12345 Pickup at gate 2");
  assert.equal(actual.remarkOverride, "");
  assert.equal((await row(ref, { search: "For SOB12345", audience: "schedule_search" })).orderRef, ref);

  await updateScmScheduleEntry({ orderKind: "PO", orderRef: ref, patch: { remarkOverride: "Call vendor" } });
  await query("UPDATE purchase_orders SET memo = 'Latest memo' WHERE netsuite_id = $1", [id]);
  actual = await row(ref, { remarkSearch: "for sob12345 call vendor" });
  assert.equal(actual.remark, "For SOB12345 Call vendor");
  assert.equal(actual.remarkOverride, "Call vendor");
  assert.equal(actual.netSuiteMemo, "Latest memo");
  await updateScmScheduleEntry({ orderKind: "PO", orderRef: ref, patch: { remarkOverride: "For SOB12345: Call vendor" } });
  assert.equal((await row(ref, { remarkSearch: "for sob12345: call" })).remark, "For SOB12345: Call vendor");
  await updateScmScheduleEntry({ orderKind: "PO", orderRef: ref, patch: { remarkOverride: "" } });
  assert.equal((await row(ref)).remark, "For SOB12345 Latest memo");
  assert.equal((await query("SELECT memo FROM purchase_orders WHERE netsuite_id = $1", [id])).rows[0].memo, "Latest memo");
  assert.equal((await query("SELECT remark_override FROM scm_transport_schedule WHERE order_ref = $1", [ref])).rows[0].remark_override, null);
  await query("UPDATE sales_special_stock_cases SET purchase_order_netsuite_id = NULL, purchase_order_ref = NULL WHERE request_id = $1", [requestId]);
  actual = await row(ref);
  assert.equal(actual.isSpecialOrder, false);
  assert.equal(actual.remark, "Latest memo");
  assert.equal((await listScmSchedule({ exactRef: ref, remarkSearch: "SOB12345" })).length, 0);
}));

test("shared requests deduplicate and order SO references; a request without an SO still marks Sp.O", () => fixture(async () => {
  const ref = await po(9971020);
  await link(9971020, "SOB22222");
  await link(9971020, "sob11111");
  await link(9971020, "SOB22222");
  assert.equal((await row(ref)).remark, "For SOB11111, SOB22222 Pickup at gate 2");
  const noSo = await po(9971021);
  await link(9971021, null);
  assert.equal((await row(noSo, { kind: "Sp.O" })).remark, "Pickup at gate 2");
  const backorder = await po(9971022);
  await link(9971022, "SOB33333", "backorder");
  assert.equal((await row(backorder)).isSpecialOrder, false);
}));

test("split and grouped POs inherit request links without duplicating schedule rows", () => fixture(async () => {
  const source = await po(9971030);
  const split = await po(9971031);
  await link(9971030);
  await query(`INSERT INTO dispatch_scm_po_splits (source_po_id, source_po_ref, split_po_id, split_po_ref, status)
    VALUES (9971030, $1, 9971031, $2, 'active')`, [source, split]);
  assert.equal((await row(split, { kind: "Sp.O" })).remark, "For SOB12345 Pickup at gate 2");
  const groupRef = "PGOB-AUTO-SPECIAL";
  await po(9971032, { alias: groupRef });
  const group = (await query("INSERT INTO scm_schedule_groups (group_ref) VALUES ($1) RETURNING id", [groupRef])).rows[0];
  await query(`INSERT INTO scm_schedule_group_members (group_id, order_kind, order_ref) VALUES ($1, 'PO', $2)`, [group.id, split]);
  assert.equal((await row(groupRef, { kind: "Sp.O" })).remark, "For SOB12345 Pickup at gate 2");
  await query("UPDATE scm_schedule_groups SET status = 'cancelled' WHERE id = $1", [group.id]);
  assert.equal((await row(groupRef)).isSpecialOrder, false);
}));

test("manual special flags remain available for ordinary POs", () => fixture(async () => {
  const ref = await po(9971040);
  await updateScmScheduleEntry({ orderKind: "PO", orderRef: ref, patch: { isSpecialOrder: true } });
  const actual = await row(ref, { kind: "Sp.O" });
  assert.equal(actual.isSpecialOrder, true);
  assert.equal(actual.isAutomaticSpecialOrder, false);
}));
