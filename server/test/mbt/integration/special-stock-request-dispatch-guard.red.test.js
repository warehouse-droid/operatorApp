import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import {
  createDispatchPlan,
  restoreDispatchPlanSnapshot,
  saveDispatchPlanSnapshot
} from "../../../src/dispatch-plan-repository.js";
import { createSpecialStockCase } from "../../../src/special-stock-request-repository.js";

after(closeDb);

function candidatePlan({ planId, planDate, soRef, driverLogin, truckPlate }) {
  return {
    planDate,
    orders: [{ id: soRef, type: "SO", orderType: "SO", deliveryMethod: "Delivery" }],
    trucks: [{
      id: truckPlate,
      plate: truckPlate,
      driverLogin,
      loads: [{
        id: `special-load-${planId}`,
        name: "Load 1",
        driverLogin,
        stops: [{ id: `special-drop-${planId}`, type: "drop", orderId: soRef }]
      }]
    }],
    summary: {}
  };
}

test("Dispatch save and restore require a route and Via Yard receipt without weakening snapshots", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
      const salesId = `special-plan-sales-${suffix}`;
      const driverLogin = `special-plan-driver-${suffix}`;
      const truckPlate = `SP${suffix.slice(0, 6).toUpperCase()}`;
      await query(
        `INSERT INTO operators (id, username, display_name, password_hash, password_salt, role, roles, yard_location_ids)
         VALUES ($1,$1,'Special Plan Sales','hash','salt','sales',ARRAY['sales']::text[],ARRAY[15]::integer[])`,
        [salesId]
      );
      await query("INSERT INTO dispatch_drivers (name, login, active) VALUES ('Special Plan Driver',$1,true)", [driverLogin]);
      await query("INSERT INTO dispatch_trucks (plate, active) VALUES ($1,true)", [truckPlate]);
      const special = await createSpecialStockCase({
        storeLocationId: 15,
        inquiryDate: "2099-11-01",
        customerName: "Special Plan Customer",
        vendorName: "Special Plan Vendor",
        lines: [{ productName: "Special Plan Item", quantity: 1, uom: "PLT", requiredDate: "2099-11-04" }]
      }, { operatorId: salesId, authorizedStoreLocationIds: [15] });
      const remoteSeed = 700_000_000 + Number.parseInt(suffix.slice(0, 6), 16);
      const salesOrderId = remoteSeed;
      const purchaseOrderId = remoteSeed + 1;
      const soRef = `SO-SPECIAL-PLAN-${suffix}`;
      const poRef = `PO-SPECIAL-PLAN-${suffix}`;
      await query(
        `INSERT INTO purchase_orders (
           netsuite_id, tranid, trandate, vendor_id, vendor, status, status_text,
           destination_location_id, destination_location, receipt_status, netsuite_active, synced_at
         ) VALUES ($1,$2,current_date,8800001,'Special Plan Vendor','B','Pending Receipt',15,'12441','not_received',true,now())`,
        [purchaseOrderId, poRef]
      );
      await query(
        `UPDATE sales_special_stock_cases
            SET fulfillment_method = 'mbt_delivery', operational_yard_location_id = 15,
                delivery_address = '37 Sunmount Rd, Scarborough, ON', delivery_date = '2099-11-02',
                delivery_window_start = '09:00', delivery_window_end = '12:00',
                delivery_instructions = 'Call before unloading',
                sales_order_netsuite_id = $2, sales_order_ref = $3,
                purchase_order_netsuite_id = $4, purchase_order_ref = $5
          WHERE request_id = $1`,
        [special.id, salesOrderId, soRef, purchaseOrderId, poRef]
      );
      await query(
        `INSERT INTO sales_special_stock_handoffs (
           request_id, route, status, sales_order_netsuite_id, purchase_order_netsuite_id,
           pickup_address, destination_address, operational_yard_location_id, line_snapshot
         ) VALUES ($1,NULL,'waiting_route',$2,$3,'Vendor yard','37 Sunmount Rd, Scarborough, ON',15,'[]'::jsonb)`,
        [special.id, salesOrderId, purchaseOrderId]
      );

      const planDate = "2099-11-03";
      const plan = await createDispatchPlan({ planDate });
      const candidate = candidatePlan({ planId: plan.id, planDate, soRef, driverLogin, truckPlate });
      await assert.rejects(
        () => saveDispatchPlanSnapshot(plan.id, { ...candidate, baseRevision: plan.revision }),
        (error) => error?.code === "SPECIAL_PLAN_ROUTE_REQUIRED"
      );
      await query(
        "UPDATE sales_special_stock_handoffs SET route = 'via_yard', status = 'ready' WHERE request_id = $1",
        [special.id]
      );
      await assert.rejects(
        () => saveDispatchPlanSnapshot(plan.id, { ...candidate, baseRevision: plan.revision }),
        (error) => error?.code === "SPECIAL_PLAN_PO_RECEIPT_REQUIRED"
      );
      await query(
        `UPDATE purchase_orders
            SET status = 'H', status_text = 'Fully Received', receipt_status = 'received', received_at = now()
          WHERE netsuite_id = $1`,
        [purchaseOrderId]
      );
      const assigned = await saveDispatchPlanSnapshot(plan.id, { ...candidate, baseRevision: plan.revision });
      assert.equal(assigned.trucks[0].loads[0].stops[0].orderId, soRef);

      const emptied = await saveDispatchPlanSnapshot(plan.id, {
        planDate,
        baseRevision: assigned.revision,
        orders: candidate.orders,
        trucks: [],
        summary: assigned.summary
      });
      assert.equal(emptied.trucks.length, 0);
      const archived = await query(
        `SELECT id FROM dispatch_plan_snapshot_history
          WHERE plan_id = $1 AND jsonb_array_length(trucks) > 0
          ORDER BY id DESC LIMIT 1`,
        [plan.id]
      );
      assert.equal(archived.rowCount, 1);
      const restored = await restoreDispatchPlanSnapshot(archived.rows[0].id, { sessionId: `special-restore-${suffix}` });
      assert.equal(restored.plan.trucks[0].loads[0].stops[0].orderId, soRef);
    });
  } finally {
    await rollback.rollback();
  }
});
