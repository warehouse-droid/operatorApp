import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";
import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import { createScmPurchaseOrderSplit, listDispatchOrders, listScmPurchaseOrders } from "../../../src/dispatch-repository.js";
import { getReceivingOrder } from "../../../src/receiving-repository.js";
import { getScmPurchaseOrderCatalogOrder, upsertScmPurchaseOrderCatalog } from "../../../src/scm-purchase-order-catalog-repository.js";

after(closeDb);

async function fixture(operation, { header = 1, locations = [28, 1], override = "12441" } = {}) {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const token = crypto.randomUUID().slice(0, 8);
      const id = 9_650_000_000_000 + Number.parseInt(token, 16);
      const ref = `PO-RETAIN-${token}`;
      const yard = (value) => ({ 1: "3445", 15: "12441", 28: "2967", 26: "150" })[value] || null;
      await query(`INSERT INTO purchase_orders (
        netsuite_id, tranid, trandate, vendor_id, vendor, status, status_text,
        destination_location_id, destination_location, source_location_id, source_location,
        dispatch_vendor_yard, receipt_status, initial_scm_status, netsuite_active, synced_at
      ) VALUES ($1,$2,current_date,$1,'Retain destination vendor','pendingReceipt',
        'Purchase Order : Pending Receipt',$3,$4,1,'3445','Retain vendor yard','not_received','Queued',true,now())`,
      [id, ref, header, yard(header)]);
      const lines = [];
      for (const [index, location] of locations.entries()) {
        const inserted = await query(`INSERT INTO purchase_order_lines (
          purchase_order_id, line_id, item_id, item_name, sku, quantity, unit,
          location_id, location, pallet_qty, layer_qty, section_qty, piece_qty,
          to_plt, to_lyr, to_sec, to_pcs, netsuite_received_qty, netsuite_received_baseline_qty,
          netsuite_active, synced_at, raw
        ) VALUES ($1,$2,$3,$4,$4,20,'EA',$5,$6,2,0,0,0,10,0,0,1,0,0,true,now(),'{}') RETURNING id`,
        [id, index + 1, id + index + 1, `RETAIN-${token}-${index}`, location, yard(location)]);
        lines.push({ lineRowId: Number(inserted.rows[0].id), pallets: 1 });
      }
      if (override) {
        await query(`INSERT INTO scm_transport_schedule (order_kind,order_ref,method,dropoff_point,status)
          VALUES ('PO',$1,'MBT',$2,'Queued')`, [ref, override]);
      }
      await operation({ id, ref, lines });
    });
  } finally {
    await rollback.rollback();
  }
}

test("POB04006 shape: retain copies each NetSuite line destination despite source and request overrides", async () => {
  await fixture(async ({ id, ref, lines }) => {
    const before = await query("SELECT id, location_id, location, quantity, raw FROM purchase_order_lines WHERE purchase_order_id=$1 ORDER BY id", [id]);
    const source = (await listScmPurchaseOrders({ search: ref, includeAllDiscoverable: true })).find((order) => order.id === ref);
    assert.deepEqual(source.items.map((line) => Number(line.destinationLocationId)), [15, 15]);
    assert.deepEqual(source.items.map((line) => Number(line.netsuiteDestinationLocationId)), [28, 1]);
    assert.deepEqual(source.items.map((line) => line.netsuiteDestinationYard), ["2967", "3445"]);
    const splitRef = `${ref}-RETAIN`;
    const created = await createScmPurchaseOrderSplit({
      sourcePoRef: ref, newPoRef: splitRef, retainNetSuiteDestination: true,
      destinationLocationId: 15, lines: lines.map((line) => ({ ...line, destinationLocationId: 26 })),
      status: "Queued"
    });
    assert.deepEqual(created.lines.map((line) => line.destinationLocationId), [28, 1]);
    assert.equal(created.split.destinationLocationId, 28);
    const schedule = await query("SELECT dropoff_point FROM scm_transport_schedule WHERE order_kind='PO' AND order_ref=$1", [splitRef]);
    assert.equal(schedule.rows[0].dropoff_point, null, "a header override would collapse mixed destinations");
    const dispatched = (await listDispatchOrders({ type: "PO", includeHiddenScm: true, search: splitRef })).find((order) => order.id === splitRef);
    assert.deepEqual(dispatched.dropoffs.map((drop) => Number(drop.destinationLocationId)).sort((a,b) => a-b), [1, 28]);
    assert.deepEqual(dispatched.items.map((line) => Number(line.destinationLocationId)).sort((a,b) => a-b), [1, 28]);
    const receiving = await getReceivingOrder(created.split.splitPoId);
    assert.deepEqual(receiving.lines.map((line) => Number(line.location_id)).sort((a,b) => a-b), [1, 28]);
    assert.deepEqual((await query("SELECT id, location_id, location, quantity, raw FROM purchase_order_lines WHERE purchase_order_id=$1 ORDER BY id", [id])).rows, before.rows);
  });
});

test("retain uses the selected line destination rather than the source header or unselected lines", async () => {
  await fixture(async ({ ref, lines }) => {
    const created = await createScmPurchaseOrderSplit({ sourcePoRef: ref, newPoRef: `${ref}-ONE`,
      retainNetSuiteDestination: true, lines: [lines[0]] });
    assert.equal(created.split.destinationLocationId, 28);
    assert.deepEqual(created.lines.map((line) => line.destinationLocationId), [28]);
  });
});

test("an explicit yard still overrides all selected lines for legacy and new clients", async () => {
  for (const retainNetSuiteDestination of [undefined, false]) {
    await fixture(async ({ ref, lines }) => {
      const created = await createScmPurchaseOrderSplit({ sourcePoRef: ref, newPoRef: `${ref}-OVERRIDE`,
        retainNetSuiteDestination, destinationLocationId: 15, lines });
      assert.deepEqual(created.lines.map((line) => line.destinationLocationId), [15, 15]);
      const schedule = await query("SELECT dropoff_point FROM scm_transport_schedule WHERE order_ref=$1", [created.split.splitPoRef]);
      assert.equal(schedule.rows[0].dropoff_point, "12441");
    });
  }
});

test("a missing line location inherits the NetSuite header when retaining destinations", async () => {
  await fixture(async ({ ref, lines }) => {
    const created = await createScmPurchaseOrderSplit({ sourcePoRef: ref, newPoRef: `${ref}-FALLBACK`,
      retainNetSuiteDestination: true, lines });
    assert.deepEqual(created.lines.map((line) => line.destinationLocationId), [28]);
  }, { header: 28, locations: [null] });
});

test("line destinations allow retaining a PO with no header destination", async () => {
  await fixture(async ({ ref, lines }) => {
    const created = await createScmPurchaseOrderSplit({ sourcePoRef: ref, newPoRef: `${ref}-NO-HEADER`,
      retainNetSuiteDestination: true, lines });
    assert.deepEqual(created.lines.map((line) => line.destinationLocationId), [28, 1]);
  }, { header: null });
});

test("missing NetSuite destinations reject atomically without defaulting to 3445", async () => {
  await fixture(async ({ ref, lines }) => {
    const splitRef = `${ref}-MISSING`;
    await assert.rejects(createScmPurchaseOrderSplit({ sourcePoRef: ref, newPoRef: splitRef,
      retainNetSuiteDestination: true, destinationLocationId: 1, lines }), /NetSuite destination is missing/);
    const created = await query(`SELECT 1 FROM purchase_orders WHERE tranid=$1
      UNION ALL SELECT 1 FROM dispatch_scm_po_splits WHERE split_po_ref=$1
      UNION ALL SELECT 1 FROM scm_transport_schedule WHERE order_ref=$1`, [splitRef]);
    assert.equal(created.rowCount, 0);
  }, { header: null, locations: [28, null] });
});

test("the retain option rejects non-boolean input", async () => {
  for (const retainNetSuiteDestination of ["false", "true", 1, null]) {
    await assert.rejects(createScmPurchaseOrderSplit({ sourcePoRef: "SOURCE", newPoRef: "SPLIT",
      retainNetSuiteDestination, lines: [{ lineRowId: 1, pallets: 1 }] }), { status: 400 });
  }
});

test("reusing an unsplit reference cannot restore its old destination override", async () => {
  await fixture(async ({ ref, lines }) => {
    const splitRef = `${ref}-REUSE`;
    const retired = await createScmPurchaseOrderSplit({ sourcePoRef: ref, newPoRef: splitRef, destinationLocationId: 15, lines });
    await query("UPDATE dispatch_scm_po_splits SET status='cancelled', cancelled_at=now() WHERE id=$1", [retired.split.id]);
    await query("UPDATE purchase_orders SET netsuite_active=false WHERE netsuite_id=$1", [retired.split.splitPoId]);
    await query(`INSERT INTO scm_transport_schedule (order_kind,order_ref,dropoff_point,status)
      VALUES ('PO',$1,'12441','Hold') ON CONFLICT (order_kind,order_ref) DO UPDATE SET dropoff_point='12441'`, [splitRef]);
    const created = await createScmPurchaseOrderSplit({ sourcePoRef: ref, newPoRef: splitRef,
      retainNetSuiteDestination: true, lines });
    assert.deepEqual(created.lines.map((line) => line.destinationLocationId), [28, 1]);
    const dispatched = (await listDispatchOrders({ type: "PO", includeHiddenScm: true, search: splitRef })).find((order) => order.id === splitRef);
    assert.deepEqual(dispatched.dropoffs.map((drop) => Number(drop.destinationLocationId)).sort((a,b) => a-b), [1, 28]);
  });
});

test("the split POST handler carries the retain choice through to its persisted result", async () => {
  const { app } = await import("../../../src/server.js");
  const route = app._router.stack.find((layer) => layer.route?.path === "/api/dispatch/scm/purchase-order-splits" && layer.route.methods.post);
  assert.ok(route);
  await fixture(async ({ ref, lines }) => {
    let response;
    await route.route.stack[0].handle({
      body: { sourcePoRef: ref, newPoRef: `${ref}-API`, retainNetSuiteDestination: true,
        destinationLocationId: null, lines },
      operator: { role: "admin" }, query: { response: "targeted" }, get: () => ""
    }, { json(value) { response = value; } }, (error) => { throw error; });
    assert.equal(response.created.split.retainNetSuiteDestination, true);
    assert.deepEqual(response.created.lines.map((line) => line.destinationLocationId), [28, 1]);
    assert.ok(response.orders.some((order) => order.id === `${ref}-API`));
  });
});

test("existing cached PO details refresh their NetSuite destinations before the split preview", async () => {
  const { app } = await import("../../../src/server.js");
  const route = app._router.stack.find((layer) => layer.route?.path === "/api/dispatch/scm/v2/purchase-orders/:ref" && layer.route.methods.get);
  await fixture(async ({ ref }) => {
    const source = (await listScmPurchaseOrders({ search: ref, includeAllDiscoverable: true })).find((order) => order.id === ref);
    for (const item of source.items) {
      delete item.netsuiteDestinationLocationId;
      delete item.netsuiteDestinationYard;
    }
    await upsertScmPurchaseOrderCatalog({ orders: [source], source: "pre-destination-option-fixture" });
    let response;
    await route.route.stack[0].handle({ params: { ref }, operator: { role: "admin" } },
      { setHeader() {}, json(value) { response = value; } }, (error) => { throw error; });
    assert.deepEqual(response.order.items.map((line) => line.netsuiteDestinationYard), ["2967", "3445"]);
    assert.deepEqual(response.order.items.map((line) => line.destinationYard), ["12441", "12441"]);
    const cached = await getScmPurchaseOrderCatalogOrder(ref);
    assert.deepEqual(cached.items.map((line) => line.netsuiteDestinationYard), ["2967", "3445"]);
  });
});
