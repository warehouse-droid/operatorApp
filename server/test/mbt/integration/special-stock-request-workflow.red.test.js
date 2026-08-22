import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import {
  claimSpecialOrderOperation,
  chooseSpecialHandoffRoute,
  completeSpecialVendorPickup,
  createSpecialStockCase,
  decideSpecialStockLine,
  getSpecialStockCase,
  linkSpecialPurchaseOrder,
  linkSpecialSalesOrder,
  requestSpecialCaseClosure,
  respondSpecialStockLine,
  saveSpecialSalesOrderDraft
} from "../../../src/special-stock-request-repository.js";

after(closeDb);

function response(overrides = {}) {
  return {
    supplyStatus: "in_stock",
    availabilityMode: "dated",
    availableDate: "2099-09-05",
    vendorId: 8_880_001,
    vendorName: "Special Test Vendor",
    vendorYard: "Vendor Test Yard",
    vendorReference: "VENDOR-READY",
    salesVisibleNote: "Ready for pickup.",
    scmInternalNote: "SCM-only note.",
    unitPurchaseCost: 2.1,
    currency: "CAD",
    itemResolution: null,
    ...overrides
  };
}

function itemResolution(overrides = {}) {
  return {
    itemId: 8_890_001,
    itemName: "SPECIAL-TEST",
    description: "Special test item",
    salesUom: "PC",
    purchaseUom: "PC",
    salesQuantity: 20,
    purchaseQuantity: 20,
    palletQuantity: 2,
    ...overrides
  };
}

function acceptedDecision(overrides = {}) {
  return {
    decision: "accepted",
    itemResolution: {
      itemId: 8_890_001,
      itemName: "SPECIAL-TEST",
      description: "Special test item",
      salesUom: "PC",
      salesQuantity: 20,
      palletQuantity: 2
    },
    ...overrides
  };
}

test("multi-line case transitions atomically from Sales to SCM and back to an exact SO draft", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const salesId = `special-sales-${suffix}`;
      const scmId = `special-scm-${suffix}`;
      await query(
        `INSERT INTO operators (id, username, display_name, password_hash, password_salt, role, roles, yard_location_ids)
         VALUES
           ($1, $1, 'Special Sales', 'hash', 'salt', 'sales', ARRAY['sales']::text[], ARRAY[15]::integer[]),
           ($2, $2, 'Special SCM', 'hash', 'salt', 'scm', ARRAY['scm']::text[], ARRAY[15]::integer[])`,
        [salesId, scmId]
      );
      await query(
        `INSERT INTO netsuite_customers (
           netsuite_id, entity_number, legal_name, display_name, currency, active,
           source_modified_at, source_version, payload_hash
         ) VALUES (8880001, '8880001', 'Special Customer', 'Special Customer', 'CAD', true,
                   now(), 'test', repeat('a', 64))
         ON CONFLICT (netsuite_id) DO NOTHING`
      );
      await query(
        `INSERT INTO inventory_items (
           item_id, item_name, display_name, item_description, item_type, stock_unit, raw, synced_at
         ) VALUES (8890001, 'SPECIAL-TEST', 'Special Test', 'Special test item', 'InvtPart', 'PC', '{}'::jsonb, now())
         ON CONFLICT (item_id) DO NOTHING`
      );

      let detail = await createSpecialStockCase({
        storeLocationId: 15,
        inquiryDate: "2099-08-21",
        customerName: "Special Customer",
        vendorName: "Special Test Vendor",
        lines: [
          { productName: "Special A", quantity: 2, uom: "PLT", requiredDate: "2099-09-01" },
          { productName: "Special B", quantity: 1, uom: "PLT", requiredDate: "2099-09-01" }
        ]
      }, { operatorId: salesId, authorizedStoreLocationIds: [15] });
      assert.match(detail.requestRef, /^SPREQ-/u);
      assert.equal(detail.lines.length, 2);
      assert.equal(detail.stage, "awaiting_purchase");

      detail = await respondSpecialStockLine(detail.id, detail.lines[0].id, {
        expectedRevision: detail.revision,
        ...response()
      }, { operatorId: scmId });
      detail = await decideSpecialStockLine(detail.id, detail.lines[0].id, {
        expectedRevision: detail.revision,
        ...acceptedDecision(),
        customerNote: "Proceed"
      }, { operatorId: salesId, authorizedStoreLocationIds: [15] });
      detail = await respondSpecialStockLine(detail.id, detail.lines[1].id, {
        expectedRevision: detail.revision,
        ...response()
      }, { operatorId: scmId });
      detail = await decideSpecialStockLine(detail.id, detail.lines[1].id, {
        expectedRevision: detail.revision,
        decision: "declined",
        reason: "Customer declined line B."
      }, { operatorId: salesId, authorizedStoreLocationIds: [15] });
      assert.equal(detail.stage, "awaiting_so");

      detail = await saveSpecialSalesOrderDraft(detail.id, {
        expectedRevision: detail.revision,
        customerId: 8880001,
        operationalYardLocationId: 15,
        fulfillmentMethod: "mbt_delivery",
        deliveryAddress: "37 Sunmount Rd, Scarborough, ON M1T 2A4",
        deliveryDate: "2099-09-10",
        windowStart: "09:00",
        windowEnd: "12:00",
        deliveryInstructions: "Call before unloading.",
        materialLines: [{ caseLineId: detail.lines[0].id, itemId: 8890001, quantity: 20, uom: "PC", rate: 4.25 }],
        ancillaryLines: []
      }, { operatorId: salesId, authorizedStoreLocationIds: [15] });
      assert.equal(detail.customerId, 8880001);
      assert.deepEqual(detail.salesOrderLines.map((line) => line.caseLineId), [detail.lines[0].id]);
      assert.equal(detail.lines[0].unitPurchaseCost, undefined);
      assert.equal((await getSpecialStockCase(detail.id, { audience: "scm" })).lines[0].unitPurchaseCost, 2.1);

      const salesOrderId = 8_910_000 + Number.parseInt(suffix.slice(0, 5), 16);
      const purchaseOrderId = 8_920_000 + Number.parseInt(suffix.slice(0, 5), 16);
      await query(
        `INSERT INTO sales_orders (
           netsuite_id, tranid, trandate, customer_id, customer, status, status_text,
           order_location_id, order_location, netsuite_active, fulfillment_status, dispatch_planned, synced_at
         ) VALUES ($1,$2,current_date,8880001,'Special Customer','B','Pending Fulfillment',15,'12441',true,'not_fulfilled',false,now())`,
        [salesOrderId, `SO-SPECIAL-${suffix}`]
      );
      await query(
        `INSERT INTO sales_order_lines (
           sales_order_id, line_id, item_id, item_name, sku, item_description,
           item_type, quantity, unit, location_id, location, netsuite_active, synced_at
         ) VALUES ($1,9001,8890001,'SPECIAL-TEST','SPECIAL-TEST','Special test item',
                   'InvtPart',20,'PC',15,'12441',true,now())`,
        [salesOrderId]
      );
      detail = await linkSpecialSalesOrder(detail.id, {
        expectedRevision: detail.revision,
        salesOrderId,
        salesOrderRef: `SO-SPECIAL-${suffix}`,
        source: "manual_link"
      }, { operatorId: salesId, authorizedStoreLocationIds: [15] });
      assert.equal(detail.salesOrderApproved, true);
      assert.equal(detail.stage, "awaiting_po");
      assert.equal(detail.lines[0].poReady, false);
      await assert.rejects(
        () => claimSpecialOrderOperation(detail.id, {
          expectedRevision: detail.revision,
          orderKind: "purchase_order",
          operationId: crypto.randomUUID()
        }, { operatorId: scmId }),
        (error) => error?.code === "SPECIAL_PO_SECOND_RESPONSE_REQUIRED"
      );
      detail = await respondSpecialStockLine(detail.id, detail.lines[0].id, {
        expectedRevision: detail.revision,
        ...response({ itemResolution: itemResolution() })
      }, { operatorId: scmId });
      const storedReadiness = await query(
        `SELECT po_ready, po_ready_response_revision
           FROM sales_special_stock_lines
          WHERE request_id = $1 AND id = $2`,
        [detail.id, detail.lines[0].id]
      );
      assert.equal(storedReadiness.rows[0].po_ready, true);
      assert.equal(detail.lines[0].poReady, true);
      assert.ok(detail.lines[0].poReadyAt);

      await query(
        `INSERT INTO purchase_orders (
           netsuite_id, tranid, trandate, vendor_id, vendor, status, status_text,
           destination_location_id, destination_location, receipt_status, netsuite_active, synced_at
         ) VALUES ($1,$2,current_date,8880001,'Special Test Vendor','B','Pending Receipt',15,'12441','not_received',true,now())`,
        [purchaseOrderId, `PO-SPECIAL-${suffix}`]
      );
      await query(
        `INSERT INTO purchase_order_lines (
           purchase_order_id, line_id, item_id, item_name, sku, item_description,
           item_type, quantity, unit, location_id, location, netsuite_active, synced_at
         ) VALUES ($1,9101,8890001,'SPECIAL-TEST','SPECIAL-TEST','Special test item',
                   'InvtPart',20,'PC',15,'12441',true,now())`,
        [purchaseOrderId]
      );
      detail = await linkSpecialPurchaseOrder(detail.id, {
        expectedRevision: detail.revision,
        purchaseOrderId,
        purchaseOrderRef: `PO-SPECIAL-${suffix}`
      }, { operatorId: scmId });
      assert.equal(detail.handoff.status, "waiting_route");
      detail = await chooseSpecialHandoffRoute(detail.id, {
        expectedRevision: detail.revision,
        requestedRoute: "direct"
      }, { operatorId: scmId });
      assert.equal(detail.handoff.status, "ready");
      assert.equal(detail.handoffRoute, "direct");
      const allocations = await query(
        `SELECT sales_order_id, po_order_id, allocated_sales_qty, status
           FROM dispatch_so_po_allocations
          WHERE sales_order_id = $1 AND po_order_id = $2`,
        [salesOrderId, purchaseOrderId]
      );
      assert.equal(allocations.rowCount, 1);
      assert.equal(Number(allocations.rows[0].allocated_sales_qty), 20);

      await query(
        `INSERT INTO dispatch_order_completion_events (
           order_kind, order_ref, dispatch_completed_at, completion_evidence_type,
           completion_evidence_id, actor_type, actor_id, metadata
         ) VALUES ('SO',$1,now(),'reconciliation',$2,'system','','{}'::jsonb)`,
        [`SO-SPECIAL-${suffix}`, `special-test:${suffix}`]
      );
      detail = await getSpecialStockCase(detail.id, { audience: "scm" });
      assert.equal(detail.operationallyComplete, true);
      assert.equal(detail.stage, "operationally_complete");

      await query(
        `UPDATE sales_orders
            SET status = 'G', status_text = 'Closed', fulfillment_status = 'fulfilled', fulfilled_at = now()
          WHERE netsuite_id = $1`,
        [salesOrderId]
      );
      await query(
        `UPDATE purchase_orders
            SET status = 'H', status_text = 'Fully Received', receipt_status = 'received', received_at = now()
          WHERE netsuite_id = $1`,
        [purchaseOrderId]
      );
      detail = await getSpecialStockCase(detail.id, { audience: "scm" });
      assert.equal(detail.remotelyReconciled, true);
      assert.equal(detail.stage, "completed");

      let pickup = await createSpecialStockCase({
        storeLocationId: 15,
        inquiryDate: "2099-08-22",
        customerName: "Special Customer",
        vendorName: "Special Test Vendor",
        lines: [{ productName: "Vendor pickup item", quantity: 2, uom: "PLT", requiredDate: "2099-09-01" }]
      }, { operatorId: salesId, authorizedStoreLocationIds: [15] });
      pickup = await respondSpecialStockLine(pickup.id, pickup.lines[0].id, {
        expectedRevision: pickup.revision,
        ...response()
      }, { operatorId: scmId });
      pickup = await decideSpecialStockLine(pickup.id, pickup.lines[0].id, {
        expectedRevision: pickup.revision,
        ...acceptedDecision()
      }, { operatorId: salesId, authorizedStoreLocationIds: [15] });
      pickup = await saveSpecialSalesOrderDraft(pickup.id, {
        expectedRevision: pickup.revision,
        customerId: 8880001,
        operationalYardLocationId: 15,
        fulfillmentMethod: "vendor_pickup",
        materialLines: [{ caseLineId: pickup.lines[0].id, itemId: 8890001, quantity: 20, uom: "PC", rate: 4.25 }],
        ancillaryLines: []
      }, { operatorId: salesId, authorizedStoreLocationIds: [15] });
      const pickupSalesOrderId = salesOrderId + 100_000_000;
      const pickupPurchaseOrderId = purchaseOrderId + 100_000_000;
      await query(
        `INSERT INTO sales_orders (
           netsuite_id, tranid, trandate, customer_id, customer, status, status_text,
           order_location_id, order_location, netsuite_active, fulfillment_status, dispatch_planned, synced_at
         ) VALUES ($1,$2,current_date,8880001,'Special Customer','B','Pending Fulfillment',15,'12441',true,'not_fulfilled',false,now())`,
        [pickupSalesOrderId, `SO-PICKUP-${suffix}`]
      );
      await query(
        `INSERT INTO sales_order_lines (
           sales_order_id, line_id, item_id, item_name, sku, item_description,
           item_type, quantity, unit, location_id, location, netsuite_active, synced_at
         ) VALUES ($1,9201,8890001,'SPECIAL-TEST','SPECIAL-TEST','Special test item',
                   'InvtPart',20,'PC',15,'12441',true,now())`,
        [pickupSalesOrderId]
      );
      pickup = await linkSpecialSalesOrder(pickup.id, {
        expectedRevision: pickup.revision,
        salesOrderId: pickupSalesOrderId,
        salesOrderRef: `SO-PICKUP-${suffix}`,
        source: "manual_link"
      }, { operatorId: salesId, authorizedStoreLocationIds: [15] });
      pickup = await respondSpecialStockLine(pickup.id, pickup.lines[0].id, {
        expectedRevision: pickup.revision,
        ...response({ itemResolution: itemResolution() })
      }, { operatorId: scmId });
      await query(
        `INSERT INTO purchase_orders (
           netsuite_id, tranid, trandate, vendor_id, vendor, status, status_text,
           destination_location_id, destination_location, receipt_status, netsuite_active, synced_at
         ) VALUES ($1,$2,current_date,8880001,'Special Test Vendor','B','Pending Receipt',15,'12441','not_received',true,now())`,
        [pickupPurchaseOrderId, `PO-PICKUP-${suffix}`]
      );
      await query(
        `INSERT INTO purchase_order_lines (
           purchase_order_id, line_id, item_id, item_name, sku, item_description,
           item_type, quantity, unit, location_id, location, netsuite_active, synced_at
         ) VALUES ($1,9301,8890001,'SPECIAL-TEST','SPECIAL-TEST','Special test item',
                   'InvtPart',20,'PC',15,'12441',true,now())`,
        [pickupPurchaseOrderId]
      );
      pickup = await linkSpecialPurchaseOrder(pickup.id, {
        expectedRevision: pickup.revision,
        purchaseOrderId: pickupPurchaseOrderId,
        purchaseOrderRef: `PO-PICKUP-${suffix}`
      }, { operatorId: scmId });
      assert.equal(pickup.handoff, null);
      assert.equal(pickup.handoffRoute, "none");
      pickup = await completeSpecialVendorPickup(pickup.id, {
        expectedRevision: pickup.revision,
        pickupDate: "2099-09-06",
        pickupReference: "SIGNED-PICKUP-888"
      }, { operatorId: salesId, authorizedStoreLocationIds: [15] });
      assert.equal(pickup.operationallyComplete, true);
      assert.equal(pickup.operationalCompletionSource, "vendor_pickup");
      assert.equal(pickup.vendorPickupDate, "2099-09-06");
      assert.equal(pickup.vendorPickupReference, "SIGNED-PICKUP-888");
      assert.equal(pickup.stage, "operationally_complete");
    });
  } finally {
    await rollback.rollback();
  }
});

test("optimistic revision permits one SCM response and one winner in the close/create race", async () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const salesId = `special-race-sales-${suffix}`;
  const scmId = `special-race-scm-${suffix}`;
  await query(
    `INSERT INTO operators (id, username, display_name, password_hash, password_salt, role, roles, yard_location_ids)
     VALUES
       ($1, $1, 'Race Sales', 'hash', 'salt', 'sales', ARRAY['sales']::text[], ARRAY[15]::integer[]),
       ($2, $2, 'Race SCM', 'hash', 'salt', 'scm', ARRAY['scm']::text[], ARRAY[15]::integer[])`,
    [salesId, scmId]
  );
  await query(
    `INSERT INTO inventory_items (item_id, item_name, display_name, item_description, item_type, stock_unit, raw, synced_at)
     VALUES (8890001, 'SPECIAL-TEST', 'Special Test', 'Special test item', 'InvtPart', 'PC', '{}'::jsonb, now())
     ON CONFLICT (item_id) DO NOTHING`
  );
  await query(
    `INSERT INTO netsuite_customers (
       netsuite_id, entity_number, legal_name, display_name, currency, active,
       source_modified_at, source_version, payload_hash
     ) VALUES (8880002, '8880002', 'Race Customer', 'Race Customer', 'CAD', true,
               now(), 'test', repeat('b', 64))
     ON CONFLICT (netsuite_id) DO NOTHING`
  );
  const detail = await createSpecialStockCase({
    storeLocationId: 15,
    inquiryDate: "2099-08-21",
    customerName: "Race Customer",
    vendorName: "Special Test Vendor",
    lines: [{ productName: "Race A", quantity: 1, uom: "PLT", requiredDate: "2099-09-01" }]
  }, { operatorId: salesId, authorizedStoreLocationIds: [15] });
  const attempts = await Promise.allSettled([
    respondSpecialStockLine(detail.id, detail.lines[0].id, { expectedRevision: detail.revision, ...response() }, { operatorId: scmId }),
    respondSpecialStockLine(detail.id, detail.lines[0].id, { expectedRevision: detail.revision, ...response() }, { operatorId: scmId })
  ]);
  assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
  assert.equal(attempts.filter((attempt) => attempt.status === "rejected" && attempt.reason?.code === "SPECIAL_REVISION_CONFLICT").length, 1);

  let current = await getSpecialStockCase(detail.id, { audience: "scm" });
  current = await decideSpecialStockLine(current.id, current.lines[0].id, {
    expectedRevision: current.revision,
    ...acceptedDecision()
  }, { operatorId: salesId, authorizedStoreLocationIds: [15] });
  current = await saveSpecialSalesOrderDraft(current.id, {
    expectedRevision: current.revision,
    customerId: 8880002,
    operationalYardLocationId: 15,
    fulfillmentMethod: "vendor_pickup",
    materialLines: [{ caseLineId: current.lines[0].id, itemId: 8890001, quantity: 20, uom: "PC", rate: 4.25 }],
    ancillaryLines: []
  }, { operatorId: salesId, authorizedStoreLocationIds: [15] });
  assert.equal(current.salesOrderLines.length, 1);
  current = await respondSpecialStockLine(current.id, current.lines[0].id, {
    expectedRevision: current.revision,
    ...response({ availableDate: "2099-09-06", salesVisibleNote: "The vendor revised its first reply." })
  }, { operatorId: scmId });
  assert.equal(current.lines[0].salesDecision, "pending");
  assert.equal(current.lines[0].itemResolution, null);
  assert.equal(current.salesOrderLines.length, 0);
  current = await decideSpecialStockLine(current.id, current.lines[0].id, {
    expectedRevision: current.revision,
    ...acceptedDecision()
  }, { operatorId: salesId, authorizedStoreLocationIds: [15] });
  current = await saveSpecialSalesOrderDraft(current.id, {
    expectedRevision: current.revision,
    customerId: 8880002,
    operationalYardLocationId: 15,
    fulfillmentMethod: "vendor_pickup",
    materialLines: [{ caseLineId: current.lines[0].id, itemId: 8890001, quantity: 20, uom: "PC", rate: 4.25 }],
    ancillaryLines: []
  }, { operatorId: salesId, authorizedStoreLocationIds: [15] });
  const operationId = crypto.randomUUID();
  const transitionAttempts = await Promise.allSettled([
    claimSpecialOrderOperation(current.id, {
      expectedRevision: current.revision,
      orderKind: "sales_order",
      operationId
    }, { operatorId: salesId }),
    requestSpecialCaseClosure(current.id, {
      expectedRevision: current.revision,
      reason: "Concurrent customer cancellation"
    }, { operatorId: salesId, authorizedStoreLocationIds: [15] })
  ]);
  assert.equal(transitionAttempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
  assert.equal(transitionAttempts.filter((attempt) => attempt.status === "rejected" && attempt.reason?.code === "SPECIAL_REVISION_CONFLICT").length, 1);
  current = await getSpecialStockCase(current.id, { audience: "scm" });
  if (current.salesOrderOperationStatus === "creating") {
    await assert.rejects(
      () => requestSpecialCaseClosure(current.id, {
        expectedRevision: current.revision,
        reason: "Must not close an uncertain remote operation"
      }, { operatorId: salesId, authorizedStoreLocationIds: [15] }),
      (error) => error?.code === "SPECIAL_CLOSURE_OPERATION_UNRESOLVED"
    );
  } else {
    assert.equal(current.closeStatus, "closed");
    await assert.rejects(
      () => claimSpecialOrderOperation(current.id, {
        expectedRevision: current.revision,
        orderKind: "sales_order",
        operationId: crypto.randomUUID()
      }, { operatorId: salesId }),
      (error) => error?.code === "SPECIAL_CASE_CLOSED"
    );
  }

  await query(
    `UPDATE sales_stock_requests SET status = 'submitted' WHERE id = $1`,
    [current.id]
  );
  await query(
    `UPDATE sales_special_stock_cases
        SET close_status = 'active', closure_reason = NULL,
            sales_order_operation_status = 'creating', sales_order_operation_id = $2,
            sales_order_operation_error = NULL
      WHERE request_id = $1`,
    [current.id, crypto.randomUUID()]
  );
  current = await getSpecialStockCase(current.id, { audience: "scm" });
  await assert.rejects(
    () => requestSpecialCaseClosure(current.id, {
      expectedRevision: current.revision,
      reason: "Must wait for deterministic in-flight operation"
    }, { operatorId: salesId, authorizedStoreLocationIds: [15] }),
    (error) => error?.code === "SPECIAL_CLOSURE_OPERATION_UNRESOLVED"
  );
  await query(
    `UPDATE sales_special_stock_cases
        SET close_status = 'closed', sales_order_operation_status = 'idle',
            sales_order_operation_id = NULL
      WHERE request_id = $1`,
    [current.id]
  );
  current = await getSpecialStockCase(current.id, { audience: "scm" });
  await assert.rejects(
    () => claimSpecialOrderOperation(current.id, {
      expectedRevision: current.revision,
      orderKind: "sales_order",
      operationId: crypto.randomUUID()
    }, { operatorId: salesId }),
    (error) => error?.code === "SPECIAL_CASE_CLOSED"
  );
});

test("a PO claim racing the second SCM response can never bypass PO readiness", async () => {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
  const numericSuffix = Number.parseInt(suffix, 16);
  const salesId = `special-po-race-sales-${suffix}`;
  const scmId = `special-po-race-scm-${suffix}`;
  const customerId = 9_100_000_000 + numericSuffix;
  const itemId = 9_200_000_000 + numericSuffix;
  const salesOrderId = 9_300_000_000 + numericSuffix;
  await query(
    `INSERT INTO operators (id, username, display_name, password_hash, password_salt, role, roles, yard_location_ids)
     VALUES
       ($1,$1,'PO Race Sales','hash','salt','sales',ARRAY['sales']::text[],ARRAY[15]::integer[]),
       ($2,$2,'PO Race SCM','hash','salt','scm',ARRAY['scm']::text[],ARRAY[15]::integer[])`,
    [salesId, scmId]
  );
  await query(
    `INSERT INTO netsuite_customers (
       netsuite_id, entity_number, legal_name, display_name, currency, active,
       source_modified_at, source_version, payload_hash
     ) VALUES ($1,$2,'PO Race Customer','PO Race Customer','CAD',true,now(),'test',repeat('c',64))`,
    [customerId, String(customerId)]
  );
  await query(
    `INSERT INTO inventory_items (
       item_id, item_name, display_name, item_description, item_type, stock_unit, raw, synced_at
     ) VALUES ($1,$2,$2,'PO race special item','InvtPart','PC','{}'::jsonb,now())`,
    [itemId, `SPECIAL-PO-RACE-${suffix}`]
  );

  let detail = await createSpecialStockCase({
    storeLocationId: 15,
    inquiryDate: "2099-08-21",
    customerName: "PO Race Customer",
    vendorName: "Special Test Vendor",
    lines: [{ productName: "PO Race Item", quantity: 2, uom: "PLT", requiredDate: "2099-09-01" }]
  }, { operatorId: salesId, authorizedStoreLocationIds: [15] });
  detail = await respondSpecialStockLine(detail.id, detail.lines[0].id, {
    expectedRevision: detail.revision,
    ...response()
  }, { operatorId: scmId });
  detail = await decideSpecialStockLine(detail.id, detail.lines[0].id, {
    expectedRevision: detail.revision,
    decision: "accepted",
    itemResolution: {
      itemId,
      itemName: `SPECIAL-PO-RACE-${suffix}`,
      description: "PO race special item",
      salesUom: "PC",
      salesQuantity: 20,
      palletQuantity: 2
    }
  }, { operatorId: salesId, authorizedStoreLocationIds: [15] });
  detail = await saveSpecialSalesOrderDraft(detail.id, {
    expectedRevision: detail.revision,
    customerId,
    operationalYardLocationId: 15,
    fulfillmentMethod: "vendor_pickup",
    materialLines: [{ caseLineId: detail.lines[0].id, itemId, quantity: 20, uom: "PC", rate: 4.25 }],
    ancillaryLines: []
  }, { operatorId: salesId, authorizedStoreLocationIds: [15] });
  await query(
    `INSERT INTO sales_orders (
       netsuite_id, tranid, trandate, customer_id, customer, status, status_text,
       order_location_id, order_location, netsuite_active, fulfillment_status, dispatch_planned, synced_at
     ) VALUES ($1,$2,current_date,$3,'PO Race Customer','B','Pending Fulfillment',15,'12441',true,'not_fulfilled',false,now())`,
    [salesOrderId, `SO-PO-RACE-${suffix}`, customerId]
  );
  await query(
    `INSERT INTO sales_order_lines (
       sales_order_id, line_id, item_id, item_name, sku, item_description,
       item_type, quantity, unit, location_id, location, netsuite_active, synced_at
     ) VALUES ($1,9401,$2,$3,$3,'PO race special item','InvtPart',20,'PC',15,'12441',true,now())`,
    [salesOrderId, itemId, `SPECIAL-PO-RACE-${suffix}`]
  );
  detail = await linkSpecialSalesOrder(detail.id, {
    expectedRevision: detail.revision,
    salesOrderId,
    salesOrderRef: `SO-PO-RACE-${suffix}`,
    source: "manual_link"
  }, { operatorId: salesId, authorizedStoreLocationIds: [15] });

  const attempts = await Promise.allSettled([
    respondSpecialStockLine(detail.id, detail.lines[0].id, {
      expectedRevision: detail.revision,
      ...response({
        itemResolution: itemResolution({
          itemId,
          itemName: `SPECIAL-PO-RACE-${suffix}`,
          description: "PO race special item"
        })
      })
    }, { operatorId: scmId }),
    claimSpecialOrderOperation(detail.id, {
      expectedRevision: detail.revision,
      orderKind: "purchase_order",
      operationId: crypto.randomUUID()
    }, { operatorId: scmId })
  ]);
  assert.equal(attempts[0].status, "fulfilled");
  assert.equal(attempts[1].status, "rejected");
  assert.ok(["SPECIAL_PO_SECOND_RESPONSE_REQUIRED", "SPECIAL_REVISION_CONFLICT"].includes(attempts[1].reason?.code));
  const afterRace = await getSpecialStockCase(detail.id, { audience: "scm" });
  assert.equal(afterRace.lines[0].poReady, true);
  assert.equal(afterRace.purchaseOrderOperationStatus, "idle");
});
