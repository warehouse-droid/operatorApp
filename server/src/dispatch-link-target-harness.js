import { beginRollbackContext, closeDb, query } from "./db.js";
import {
  createSalesOrderPoAllocations,
  getSalesOrderPoAllocationOptions
} from "./dispatch-repository.js";
import { resolveDispatchSalesTarget } from "./dispatch-order-target-repository.js";
import {
  createOrderDependency,
  getOrderDependencyOptions,
  listOrderDependencies
} from "./order-dependency-repository.js";
import {
  upsertInboundTransferOrderLines,
  upsertInboundTransferOrders,
  upsertOutboundTransferOrderLines,
  upsertOutboundTransferOrders
} from "./order-sync-repository.js";

const suffix = Number(String(Date.now()).slice(-6));
const base = 9880000000 + suffix;
const itemId = base + 20;
const orderRefs = [`LINK-SO-A-${suffix}`, `LINK-SO-B-${suffix}`, `LINK-SO-C-${suffix}`];
const orderIds = [base + 1, base + 2, base + 3];
const groupRef = `GOA-LINK-${suffix}`;
const splitRefs = [`${orderRefs[2]}-S1`, `${orderRefs[2]}-S2`];
const transferId = base + 10;
const transferRef = `LINK-TO-${suffix}`;
const poId = base + 11;
const poRef = `LINK-PO-${suffix}`;
const planDate = "2097-07-14";

function assert(condition, message, details = {}) {
  if (condition) return;
  const error = new Error(message);
  error.details = details;
  throw error;
}

async function insertSalesOrder(orderId, orderRef, quantity, lineId) {
  await query(
    `INSERT INTO sales_orders (
       netsuite_id, tranid, trandate, customer, status, status_text,
       outbound_location_id, outbound_location, sales_order_type,
       fulfillment_status, operator_status, local_yard_order_status,
       dispatch_address, netsuite_active
     ) VALUES ($1, $2, $3::date, 'Link Target Harness', 'B', 'Pending Fulfillment',
       15, '12441', 'Delivery', 'open', 'open', 'Open',
       '100 Test Street, Toronto, ON', true)`,
    [orderId, orderRef, planDate]
  );
  return (await query(
    `INSERT INTO sales_order_lines (
       sales_order_id, line_id, item_id, item_name, sku, item_type, item_type_text,
       quantity, unit, netsuite_committed_qty, netsuite_backordered_qty,
       netsuite_active, location_id, location, to_pcs
     ) VALUES ($1, $2, $3, 'Link Target Item', 'LINK-TARGET-SKU', 'InvtPart',
       'Inventory Item', $4, 'EA', 0, $4, true, 15, '12441', 1)
     RETURNING *`,
    [orderId, lineId, itemId, quantity]
  )).rows[0];
}

function snapshotItem(line, quantity) {
  return {
    lineRowId: line.id,
    lineId: line.line_id,
    itemId: line.item_id,
    itemName: line.item_name,
    sku: line.sku,
    quantity,
    salesQty: quantity,
    unit: line.unit
  };
}

const rollback = await beginRollbackContext();
try {
  await rollback.run(async () => {
    await query(
      `INSERT INTO inventory_items (
         item_id, item_name, item_type, item_type_text, stock_unit, item_weight
       ) VALUES ($1, 'Link Target Item', 'InvtPart', 'Inventory Item', 'EA', 10)`,
      [itemId]
    );
    const firstLine = await insertSalesOrder(orderIds[0], orderRefs[0], 4, base + 101);
    const secondLine = await insertSalesOrder(orderIds[1], orderRefs[1], 6, base + 102);
    const splitParentLine = await insertSalesOrder(orderIds[2], orderRefs[2], 10, base + 103);

    const groupOrder = {
      id: groupRef,
      type: "SO",
      customer: "Grouped Link Harness",
      childOrders: orderRefs.slice(0, 2),
      childOrderDetails: [
        { id: orderRefs[0], type: "SO", items: [snapshotItem(firstLine, 4)] },
        { id: orderRefs[1], type: "SO", items: [snapshotItem(secondLine, 6)] }
      ],
      items: [snapshotItem(firstLine, 4), snapshotItem(secondLine, 6)]
    };
    const splitOrders = [
      { id: splitRefs[0], type: "SO", originalOrderId: orderRefs[2], items: [snapshotItem(splitParentLine, 3)] },
      { id: splitRefs[1], type: "SO", originalOrderId: orderRefs[2], items: [snapshotItem(splitParentLine, 7)] }
    ];
    const plan = await query(
      `INSERT INTO dispatch_plans (plan_date, status, note)
       VALUES ($1::date, 'draft', 'dispatch link target harness')
       RETURNING id`,
      [planDate]
    );
    await query(
      `INSERT INTO dispatch_plan_snapshots (plan_id, orders, trucks, summary)
       VALUES ($1, $2::jsonb, '[]'::jsonb, '{}'::jsonb)`,
      [plan.rows[0].id, JSON.stringify([groupOrder, ...splitOrders])]
    );

    const transfer = {
      id: transferId,
      tranid: transferRef,
      trandate: planDate,
      status: "B",
      status_text: "Transfer Order : Pending Fulfillment",
      source_location_id: 1,
      source_location: "3445",
      destination_location_id: 15,
      destination_location: "12441"
    };
    const transferLine = {
      line_id: base + 201,
      item_id: itemId,
      item_name: "Link Target Item",
      sku: "LINK-TARGET-SKU",
      item_type: "InvtPart",
      item_type_text: "Inventory Item",
      quantity: 8,
      unit: "EA",
      netsuite_received_qty: 0,
      location_id: 1,
      location: "3445"
    };
    await upsertOutboundTransferOrders([transfer]);
    await upsertOutboundTransferOrderLines(transferId, [transferLine]);
    await upsertInboundTransferOrders([transfer]);
    await upsertInboundTransferOrderLines(transferId, [{ ...transferLine, location_id: 15, location: "12441" }]);

    const groupTarget = await resolveDispatchSalesTarget({ dispatchTargetRef: groupRef, planDate });
    assert(groupTarget.target.kind === "group" && groupTarget.lines.length === 2,
      "Grouped target must resolve both canonical child lines.", { groupTarget });
    assert(new Set(groupTarget.lines.map((line) => line.sourceOrderRef)).size === 2,
      "Duplicate grouped SKUs must retain separate source-order identities.", { lines: groupTarget.lines });

    const dependencyOptions = await getOrderDependencyOptions({
      dispatchTargetRef: groupRef,
      transferOrderRef: transferRef,
      planDate
    });
    assert(dependencyOptions.matchingLines.length === 2,
      "One TO must match several grouped target lines.", { dependencyOptions });
    assert(dependencyOptions.matchingLines.reduce((sum, line) => sum + line.suggestedQuantity, 0) === 8,
      "Suggested quantities must not exceed the aggregate TO quantity.", { matchingLines: dependencyOptions.matchingLines });
    assert(dependencyOptions.matchingLines.every((line) => line.suggestedQuantities.pieces === line.suggestedQuantity),
      "Link TO options must expose converted unit quantities.", { matchingLines: dependencyOptions.matchingLines });

    const missingTransferOptions = await getOrderDependencyOptions({
      dispatchTargetRef: groupRef,
      transferOrderRef: "LINK-TO-NOT-FOUND",
      planDate
    });
    assert(missingTransferOptions.matchingLines.length === 0 && /not found/i.test(missingTransferOptions.matchError),
      "Link TO must return a detailed no-match error.", { missingTransferOptions });

    const dependency = await createOrderDependency({
      dispatchTargetRef: groupRef,
      transferOrderRef: transferRef,
      planDate,
      targetSignature: dependencyOptions.targetSignature,
      mode: "direct_to_customer",
      allocations: dependencyOptions.matchingLines.map((line) => ({
        targetLineKey: line.targetLineKey,
        quantities: line.suggestedQuantities
      })),
      operatorId: "dispatch-link-harness"
    });
    assert(dependency.dispatchTargetRef === groupRef && dependency.dispatchTargetKind === "group",
      "Created dependency must retain the visible grouped target.", { dependency });
    assert(dependency.lines.length === 2 && dependency.lines.every((line) => line.targetLineKey),
      "Grouped dependency lines must persist stable target keys.", { dependency });
    assert((await listOrderDependencies({ salesOrderRef: groupRef })).length === 1,
      "Grouped dependency must be retrievable by its visible reference.");

    await query(
      `INSERT INTO purchase_orders (
         netsuite_id, tranid, trandate, vendor_id, vendor, status, status_text,
         destination_location_id, destination_location, receipt_status,
         dispatch_vendor_yard, dispatch_address, netsuite_active
       ) VALUES ($1, $2, $3::date, $4, 'Link Target Vendor', 'pendingReceipt',
         'Pending Receipt', 15, '12441', 'open', 'Link Target Yard',
         '200 Vendor Street, Toronto, ON', true)`,
      [poId, poRef, planDate, base + 12]
    );
    await query(
      `INSERT INTO purchase_order_lines (
         purchase_order_id, line_id, item_id, item_name, sku, item_type, item_type_text,
         quantity, unit, netsuite_received_qty, netsuite_active, location_id, location
       ) VALUES ($1, $2, $3, 'Link Target Item', 'LINK-TARGET-SKU', 'InvtPart',
         'Inventory Item', 10, 'EA', 0, true, 15, '12441')`,
      [poId, base + 301, itemId]
    );
    const poOptions = await getSalesOrderPoAllocationOptions(groupRef, { planDate });
    assert(poOptions.salesLines.length === 2 && poOptions.order.kind === "group",
      "Link PO must use the same grouped target resolver.", { poOptions });
    assert(poOptions.salesLines.every((line) => line.conversions.pieces === 1 && line.available.pieces > 0),
      "Link PO must expose the same converted unit controls as Link TO.", { poOptions });
    const poAllocations = await createSalesOrderPoAllocations({
      dispatchTargetRef: groupRef,
      poRef,
      planDate,
      targetSignature: poOptions.order.targetSignature,
      lines: poOptions.salesLines.map((line) => ({
        targetLineKey: line.targetLineKey,
        quantities: { pieces: line.available.pieces }
      })),
      createdBy: "dispatch-link-harness"
    });
    assert(poAllocations.length === 2 && poAllocations.every((allocation) => allocation.dispatchTargetRef === groupRef),
      "Grouped PO allocations must persist under the visible target.", { poAllocations });

    const firstSplit = await resolveDispatchSalesTarget({ dispatchTargetRef: splitRefs[0], planDate });
    const secondSplit = await resolveDispatchSalesTarget({ dispatchTargetRef: splitRefs[1], planDate });
    assert(firstSplit.target.kind === "split" && secondSplit.target.kind === "split",
      "Unmaterialized split targets must resolve as split orders.");
    assert(firstSplit.lines[0].quantity === 3 && secondSplit.lines[0].quantity === 7,
      "Split targets must retain their exact snapshot quantities.", { firstSplit, secondSplit });
    assert(firstSplit.lines[0].targetLineKey !== secondSplit.lines[0].targetLineKey,
      "Sibling split target keys must never share an allocation identity.");
  });
  console.log("Dispatch link target rollback harness passed.");
} catch (error) {
  console.error(error.message);
  if (error.details) console.error(JSON.stringify(error.details, null, 2));
  process.exitCode = 1;
} finally {
  await rollback.rollback();
  await closeDb();
}
