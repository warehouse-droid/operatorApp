import { closeDb, query, withTransaction } from "./db.js";
import {
  upsertInboundTransferOrderLines,
  upsertInboundTransferOrders,
  upsertOutboundTransferOrderLines,
  upsertOutboundTransferOrders,
  upsertPurchaseOrderLines,
  upsertPurchaseOrders,
  upsertSalesOrderLines,
  upsertSalesOrders
} from "./order-sync-repository.js";
import { processNetSuiteOrderWebhook } from "./server.js";

const runId = Date.now();
const ids = {
  sales: 9810000000 + Number(String(runId).slice(-6)),
  purchase: 9820000000 + Number(String(runId).slice(-6)),
  transfer: 9830000000 + Number(String(runId).slice(-6)),
  webhookSales: 9840000000 + Number(String(runId).slice(-6)),
  webhookPurchase: 9850000000 + Number(String(runId).slice(-6)),
  webhookTransfer: 9860000000 + Number(String(runId).slice(-6))
};

function check(condition, message, details = {}) {
  if (!condition) {
    const error = new Error(message);
    error.details = details;
    throw error;
  }
}

function number(value) {
  return Number(value ?? 0);
}

function dateOnly(value) {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

async function one(sql, params = []) {
  const result = await query(sql, params);
  return result.rows[0] || null;
}

async function all(sql, params = []) {
  const result = await query(sql, params);
  return result.rows;
}

async function assertSalesOrder(orderId, expected) {
  const order = await one("SELECT * FROM sales_orders WHERE netsuite_id = $1", [orderId]);
  check(order, "Sales order was not visible through sales_orders.", { orderId });
  check(order.sales_order_type === expected.sales_order_type, "Sales order type mapped incorrectly.", { order });
  check(String(order.outbound_location_id) === String(expected.outbound_location_id), "Sales outbound location mapped incorrectly.", { order });
  check(dateOnly(order.expected_delivery_date) === expected.expected_delivery_date, "Sales expected date mapped incorrectly.", { order });
  check(order.memo === expected.memo, "Sales memo/note mapped incorrectly.", { order });

  const line = await one("SELECT * FROM sales_order_lines WHERE sales_order_id = $1 AND line_id = $2", [orderId, expected.line_id]);
  check(line, "Sales line was not visible through sales_order_lines.", { orderId, expected });
  check(line.item_name === expected.item_name, "Sales line item name mapped incorrectly.", { line });
  check(line.item_description === expected.item_description, "Sales line description mapped incorrectly.", { line });
  check(number(line.pallet_qty) === expected.pallet_qty, "Sales line PLT mapped incorrectly.", { line });
  check(number(line.layer_qty) === expected.layer_qty, "Sales line LYR mapped incorrectly.", { line });
  check(number(line.section_qty) === expected.section_qty, "Sales line SEC mapped incorrectly.", { line });
  check(number(line.piece_qty) === expected.piece_qty, "Sales line PCS mapped incorrectly.", { line });
  check(number(line.to_plt) === expected.to_plt, "Sales line to_plt mapped incorrectly.", { line });
  check(number(line.to_lyr) === expected.to_lyr, "Sales line to_lyr mapped incorrectly.", { line });
  check(number(line.to_sec) === expected.to_sec, "Sales line to_sec mapped incorrectly.", { line });
  check(number(line.to_pcs) === expected.to_pcs, "Sales line to_pcs mapped incorrectly.", { line });
  check(number(line.item_weight) === expected.item_weight, "Sales line item weight mapped incorrectly.", { line });
}

async function assertPurchaseOrder(orderId, expected) {
  const order = await one("SELECT * FROM purchase_orders WHERE netsuite_id = $1", [orderId]);
  check(order, "Purchase order was not visible through purchase_orders.", { orderId });
  check(order.vendor === expected.vendor, "Purchase vendor mapped incorrectly.", { order });
  check(String(order.destination_location_id) === String(expected.destination_location_id), "Purchase destination location mapped incorrectly.", { order });
  check(order.memo === expected.memo, "Purchase memo mapped incorrectly.", { order });

  const line = await one("SELECT * FROM purchase_order_lines WHERE purchase_order_id = $1 AND line_id = $2", [orderId, expected.line_id]);
  check(line, "Purchase line was not visible through purchase_order_lines.", { orderId, expected });
  check(line.item_name === expected.item_name, "Purchase line item name mapped incorrectly.", { line });
  check(number(line.pallet_qty) === expected.pallet_qty, "Purchase line PLT mapped incorrectly.", { line });
  check(number(line.layer_qty) === expected.layer_qty, "Purchase line LYR mapped incorrectly.", { line });
  check(number(line.section_qty) === expected.section_qty, "Purchase line SEC mapped incorrectly.", { line });
  check(number(line.piece_qty) === expected.piece_qty, "Purchase line PCS mapped incorrectly.", { line });
  check(number(line.netsuite_received_qty) === expected.netsuite_received_qty, "Purchase received sales quantity mapped incorrectly.", { line });
  if (expected.netsuite_received_baseline_qty !== undefined) {
    check(number(line.netsuite_received_baseline_qty) === expected.netsuite_received_baseline_qty, "Purchase received baseline quantity mapped incorrectly.", { line });
  }
  check(number(line.item_weight) === expected.item_weight, "Purchase line item weight mapped incorrectly.", { line });
}

async function assertTransferOrder(orderId, expected) {
  const order = await one("SELECT * FROM transfer_orders WHERE netsuite_id = $1", [orderId]);
  check(order, "Transfer order was not visible through transfer_orders.", { orderId });
  check(String(order.from_location_id) === String(expected.from_location_id), "Transfer from location mapped incorrectly.", { order });
  check(String(order.to_location_id) === String(expected.to_location_id), "Transfer to location mapped incorrectly.", { order });

  const lines = await all(
    "SELECT * FROM transfer_order_lines WHERE transfer_order_id = $1 AND line_id = $2 ORDER BY line_stage",
    [orderId, expected.line_id]
  );
  check(lines.length === 2, "Transfer order should expose outbound and receiving line stages.", { lines });
  const outbound = lines.find((line) => line.line_stage === "outbound");
  const receiving = lines.find((line) => line.line_stage === "receiving");
  check(outbound && receiving, "Transfer stage labels are missing.", { lines });
  check(number(outbound.pallet_qty) === expected.outbound_pallet_qty, "Transfer outbound PLT mapped incorrectly.", { outbound });
  check(number(outbound.layer_qty) === expected.outbound_layer_qty, "Transfer outbound LYR mapped incorrectly.", { outbound });
  check(number(outbound.to_plt) === expected.to_plt, "Transfer outbound to_plt mapped incorrectly.", { outbound });
  check(number(outbound.item_weight) === expected.item_weight, "Transfer outbound item weight mapped incorrectly.", { outbound });
  check(number(receiving.pallet_qty) === expected.receiving_pallet_qty, "Transfer receiving PLT mapped incorrectly.", { receiving });
  check(number(receiving.netsuite_received_qty) === expected.netsuite_received_qty, "Transfer received sales quantity mapped incorrectly.", { receiving });
  check(number(receiving.item_weight) === expected.item_weight, "Transfer receiving item weight mapped incorrectly.", { receiving });
}

async function assertDispatchWeight(orderRef, expectedWeight) {
  const row = await one("SELECT * FROM sales_orders WHERE tranid = $1", [orderRef]);
  check(row, "Dispatch weight source order was not stored.", { orderRef });
  const dispatch = await import("./dispatch-repository.js");
  const orders = await dispatch.listDispatchOrders();
  const order = orders.find((item) => item.id === orderRef);
  check(order, "Dispatch order was not visible for weight assertion.", { orderRef, orders: orders.slice(0, 5) });
  check(number(order.weight) === expectedWeight, "Dispatch order weight did not use sales quantity times item weight.", { order });
}

async function runRepositorySimulation(checks) {
  await upsertSalesOrders([{
    id: ids.sales,
    tranid: `SIM-SO-${runId}`,
    trandate: "2026-06-29",
    customer_id: 7001,
    customer: "Sync Shape Customer",
    status: "B",
    status_text: "Pending Fulfillment",
    memo: "Add: 92 Chaplin Crescent, Toronto, ON M5P 1A5",
    expected_delivery_date: "2026-07-01",
    foreigntotal: "123.45",
    order_location_id: 1,
    order_location: "3445",
    outbound_location_id: 1,
    outbound_location: "3445",
    delivery_method_id: 2,
    delivery_method: "Delivery"
  }]);
  await upsertSalesOrderLines(ids.sales, [{
    line_id: 11,
    item_id: 8001,
    item_name: "BWS-HUNT-SM",
    item_type: "InvtPart",
    item_type_text: "Inventory Item",
    item_description: "Repository simulated sales line",
    quantity: 112,
    unit: "EA",
    item_weight: 2.5,
    location_id: 1,
    location: "3445",
    pallet_qty: 1,
    layer_qty: 1,
    section_qty: 2,
    piece_qty: 3,
    to_plt: 100,
    to_lyr: 10,
    to_sec: 1,
    to_pcs: 1
  }]);
  await assertSalesOrder(ids.sales, {
    sales_order_type: "Delivery",
    outbound_location_id: 1,
    expected_delivery_date: "2026-07-01",
    memo: "Add: 92 Chaplin Crescent, Toronto, ON M5P 1A5",
    line_id: 11,
    item_name: "BWS-HUNT-SM",
    item_description: "Repository simulated sales line",
    pallet_qty: 1,
    layer_qty: 1,
    section_qty: 2,
    piece_qty: 3,
    to_plt: 100,
    to_lyr: 10,
    to_sec: 1,
    to_pcs: 1,
    item_weight: 2.5
  });
  await assertDispatchWeight(`SIM-SO-${runId}`, 280);
  const specialSalesLines = [
    {
      line_id: 12,
      item_id: 2055,
      item_name: "MBBS-Special",
      item_description: "Custom coping - charcoal",
      quantity: 1,
      unit: "PC",
      location_id: 1,
      location: "3445",
      pallet_qty: 1,
      layer_qty: 0,
      section_qty: 0,
      piece_qty: 0
    },
    {
      line_id: 13,
      item_id: 2055,
      item_name: "MBBS-Special",
      item_description: "Custom coping - limestone",
      quantity: 2,
      unit: "PC",
      location_id: 1,
      location: "3445",
      pallet_qty: 0,
      layer_qty: 2,
      section_qty: 0,
      piece_qty: 0
    },
    {
      line_id: 14,
      item_id: 2055,
      item_name: "MBBS-Special",
      item_description: "Custom coping - ivory",
      quantity: 3,
      unit: "PC",
      location_id: 1,
      location: "3445",
      pallet_qty: 0,
      layer_qty: 0,
      section_qty: 1,
      piece_qty: 4
    }
  ];
  await upsertSalesOrderLines(ids.sales, specialSalesLines);
  await upsertSalesOrderLines(ids.sales, [...specialSalesLines].reverse());
  const storedSpecialSalesLines = await all(
    "SELECT line_id, item_description, pallet_qty, layer_qty, section_qty, piece_qty, pack_quantity_source "
      + "FROM sales_order_lines WHERE sales_order_id = $1 AND item_id = 2055 AND netsuite_active = true ORDER BY line_id",
    [ids.sales]
  );
  check(storedSpecialSalesLines.length === 3, "Repeated MBBS-Special sales lines collapsed during sync.", { storedSpecialSalesLines });
  check(storedSpecialSalesLines.map((line) => number(line.line_id)).join(",") === "12,13,14",
    "MBBS-Special sales lines did not retain their NetSuite unique keys.", { storedSpecialSalesLines });
  check(storedSpecialSalesLines.every((line) => line.pack_quantity_source === "netsuite_manual"),
    "Manual MBBS-Special sales quantities did not retain their source.", { storedSpecialSalesLines });
  check(storedSpecialSalesLines.map((line) => line.item_description).join("|")
      === "Custom coping - charcoal|Custom coping - limestone|Custom coping - ivory",
    "MBBS-Special sales descriptions were not retained line by line.", { storedSpecialSalesLines });
  const deliveryRepository = await import("./delivery-repository.js");
  const testOperator = await one("SELECT id FROM operators WHERE active = true ORDER BY created_at LIMIT 1");
  check(testOperator, "An active operator is required for MBBS-Special delivery regression coverage.");
  const manualDeliveryLine = await one(
    "SELECT id FROM sales_order_lines WHERE sales_order_id = $1 AND line_id = 13",
    [ids.sales]
  );
  await deliveryRepository.confirmDeliveryLine(ids.sales, manualDeliveryLine.id, { layers: 1 }, testOperator.id);
  let manualDeliveryProgress = await one(
    "SELECT packed_layer_qty, packed_sales_qty FROM sales_order_lines WHERE id = $1",
    [manualDeliveryLine.id]
  );
  check(number(manualDeliveryProgress.packed_layer_qty) === 0 && number(manualDeliveryProgress.packed_sales_qty) === 1,
    "No-conversion MBBS-Special packing did not use packed_sales_qty exclusively.", { manualDeliveryProgress });
  await deliveryRepository.setDeliveryLinePackedQuantity(ids.sales, manualDeliveryLine.id, { layers: 2 }, testOperator.id);
  manualDeliveryProgress = await one(
    "SELECT packed_layer_qty, packed_sales_qty FROM sales_order_lines WHERE id = $1",
    [manualDeliveryLine.id]
  );
  check(number(manualDeliveryProgress.packed_layer_qty) === 0 && number(manualDeliveryProgress.packed_sales_qty) === 2,
    "No-conversion MBBS-Special packed sales quantity was not editable in its sales UOM.", { manualDeliveryProgress });
  checks.push("repository sales order -> sales_orders/sales_order_lines");

  await upsertPurchaseOrders([{
    id: ids.purchase,
    tranid: `SIM-PO-${runId}`,
    trandate: "2026-06-29",
    vendor_id: 7101,
    vendor: "UNILOCK Ayr",
    status: "B",
    status_text: "Pending Receipt",
    memo: "Ayr Yard - Unilock",
    foreigntotal: "456.78",
    destination_location_id: 15,
    destination_location: "12441"
  }]);
  await upsertPurchaseOrderLines(ids.purchase, [{
    line_id: 21,
    item_id: 8101,
    item_name: "UNI-ARTLINE-XL",
    item_type: "InvtPart",
    item_type_text: "Inventory Item",
    item_description: "Repository simulated PO line",
    quantity: 240,
    netsuite_received_qty: 40,
    unit: "EA",
    item_weight: 3.25,
    location_id: 15,
    location: "12441",
    pallet_qty: 2,
    layer_qty: 4,
    section_qty: 0,
    piece_qty: 0,
    to_plt: 100,
    to_lyr: 10
  }]);
  await assertPurchaseOrder(ids.purchase, {
    vendor: "UNILOCK Ayr",
    destination_location_id: 15,
    memo: "Ayr Yard - Unilock",
    line_id: 21,
    item_name: "UNI-ARTLINE-XL",
    pallet_qty: 2,
    layer_qty: 4,
    section_qty: 0,
    piece_qty: 0,
    netsuite_received_qty: 40,
    netsuite_received_baseline_qty: 40,
    item_weight: 3.25
  });
  await upsertPurchaseOrderLines(ids.purchase, [{
    line_id: 21,
    item_id: 8101,
    item_name: "UNI-ARTLINE-XL",
    item_type: "InvtPart",
    item_type_text: "Inventory Item",
    item_description: "Repository simulated PO line",
    quantity: 240,
    netsuite_received_qty: 60,
    unit: "EA",
    item_weight: 3.25,
    location_id: 15,
    location: "12441",
    pallet_qty: 2,
    layer_qty: 4,
    section_qty: 0,
    piece_qty: 0,
    to_plt: 100,
    to_lyr: 10
  }]);
  await assertPurchaseOrder(ids.purchase, {
    vendor: "UNILOCK Ayr",
    destination_location_id: 15,
    memo: "Ayr Yard - Unilock",
    line_id: 21,
    item_name: "UNI-ARTLINE-XL",
    pallet_qty: 2,
    layer_qty: 4,
    section_qty: 0,
    piece_qty: 0,
    netsuite_received_qty: 60,
    netsuite_received_baseline_qty: 40,
    item_weight: 3.25
  });
  const amendedPurchaseLine = await one(
    "SELECT quantity, netsuite_received_qty, netsuite_received_baseline_qty FROM purchase_order_lines WHERE purchase_order_id = $1 AND line_id = 21",
    [ids.purchase]
  );
  check(
    number(amendedPurchaseLine.quantity) - number(amendedPurchaseLine.netsuite_received_baseline_qty) === 200,
    "Later NetSuite receipts changed local PO operational quantity.",
    { amendedPurchaseLine }
  );
  await upsertPurchaseOrderLines(ids.purchase, [{
    line_id: 21,
    item_id: 8101,
    item_name: "UNI-ARTLINE-XL",
    item_type: "InvtPart",
    item_type_text: "Inventory Item",
    item_description: "Repository simulated PO line",
    quantity: 260,
    netsuite_received_qty: 60,
    unit: "EA",
    item_weight: 3.25,
    location_id: 15,
    location: "12441",
    pallet_qty: 2,
    layer_qty: 6,
    section_qty: 0,
    piece_qty: 0,
    to_plt: 100,
    to_lyr: 10
  }]);
  const quantityAmendedLine = await one(
    "SELECT quantity, netsuite_received_qty, netsuite_received_baseline_qty FROM purchase_order_lines WHERE purchase_order_id = $1 AND line_id = 21",
    [ids.purchase]
  );
  check(
    number(quantityAmendedLine.quantity) - number(quantityAmendedLine.netsuite_received_baseline_qty) === 220,
    "A NetSuite PO quantity amendment did not update local operational quantity.",
    { quantityAmendedLine }
  );
  const dispatchRepository = await import("./dispatch-repository.js");
  const perTypeCappedOrders = await dispatchRepository.listDispatchOrders({
    includeHiddenScm: true,
    perTypeLimit: 1
  });
  const cappedTypeCounts = perTypeCappedOrders.reduce((counts, order) => {
    counts.set(order.type, Number(counts.get(order.type) || 0) + 1);
    return counts;
  }, new Map());
  check(cappedTypeCounts.size >= 2 && [...cappedTypeCounts.values()].every((count) => count === 1),
    "Dispatch pool limits must be applied independently per order type.",
    { cappedTypeCounts: Object.fromEntries(cappedTypeCounts) });
  const searchedDispatchOrders = await dispatchRepository.listDispatchOrders({
    includeHiddenScm: true,
    perTypeLimit: 1,
    search: `SIM-SO-${runId}`
  });
  check(searchedDispatchOrders.some((order) => order.id === `SIM-SO-${runId}`),
    "Backend dispatch search must return a valid order even when it falls outside the normal pool cap.",
    { searchedDispatchOrders: searchedDispatchOrders.map((order) => order.id) });
  checks.push("dispatch per-type pool limit + backend search bypass");
  const dispatchOrders = await dispatchRepository.listDispatchOrders({ includeHiddenScm: true });
  const dispatchPurchase = dispatchOrders.find((order) => order.id === `SIM-PO-${runId}`);
  check(number(dispatchPurchase?.salesQty) === 220, "Dispatch did not use the fixed PO receipt baseline.", { dispatchPurchase });
  const receivingRepository = await import("./receiving-repository.js");
  const receivingPurchase = await receivingRepository.getReceivingOrder(ids.purchase);
  const receivingLine = receivingPurchase?.lines?.find((line) => number(line.line_id) === 21);
  check(number(receivingLine?.quantity) === 220, "Receiving did not use the fixed PO receipt baseline.", { receivingLine });

  const sourceLine = await one(
    "SELECT id FROM purchase_order_lines WHERE purchase_order_id = $1 AND line_id = 21",
    [ids.purchase]
  );
  const splitOrderId = -(ids.purchase * 10 + 1);
  const splitLineRowId = -(ids.purchase * 10 + 2);
  const splitRef = `SIM-PO-SPLIT-${runId}`;
  await query(
    `INSERT INTO purchase_orders (netsuite_id, tranid, status, status_text, destination_location_id, destination_location, netsuite_active, synced_at)
     VALUES ($1, $2, 'B', 'Pending Receipt', 15, '12441', true, now())`,
    [splitOrderId, splitRef]
  );
  await query(
    `INSERT INTO purchase_order_lines (
       id, purchase_order_id, line_id, item_id, item_name, sku, quantity, unit,
       pallet_qty, layer_qty, section_qty, piece_qty, to_plt, to_lyr,
       netsuite_received_qty, netsuite_received_baseline_qty, netsuite_active, synced_at, raw
     ) VALUES (
       $1, $2, 21, 8101, 'UNI-ARTLINE-XL', 'UNI-ARTLINE-XL', 100, 'EA',
       1, 0, 0, 0, 100, 10,
       0, 0, true, now(), '{"scmSplit":true}'::jsonb
     )`,
    [splitLineRowId, splitOrderId]
  );
  const splitHeader = await one(
    `INSERT INTO dispatch_scm_po_splits (source_po_id, source_po_ref, split_po_id, split_po_ref, status)
     VALUES ($1, $2, $3, $4, 'active')
     RETURNING id`,
    [ids.purchase, `SIM-PO-${runId}`, splitOrderId, splitRef]
  );
  const splitLedger = await one(
    `INSERT INTO dispatch_scm_po_split_lines (
       split_id, source_line_id, split_line_id, item_id, sku, item_name,
       pallet_qty, layer_qty, section_qty, piece_qty, sales_qty, unit,
       requested_pallet_qty, requested_layer_qty, requested_section_qty,
       requested_piece_qty, requested_sales_qty
     ) VALUES ($1, $2, $3, 8101, 'UNI-ARTLINE-XL', 'UNI-ARTLINE-XL', 1, 0, 0, 0, 100, 'EA', 1, 0, 0, 0, 100)
     RETURNING id`,
    [splitHeader.id, sourceLine.id, splitLineRowId]
  );
  const amendedPurchasePayload = {
    line_id: 21,
    item_id: 8101,
    item_name: "UNI-ARTLINE-XL",
    item_type: "InvtPart",
    item_type_text: "Inventory Item",
    item_description: "Repository simulated PO line",
    netsuite_received_qty: 80,
    unit: "EA",
    item_weight: 3.25,
    location_id: 15,
    location: "12441",
    pallet_qty: 0,
    layer_qty: 0,
    section_qty: 0,
    piece_qty: 0,
    to_plt: 100,
    to_lyr: 10
  };
  await upsertPurchaseOrderLines(ids.purchase, [{ ...amendedPurchasePayload, quantity: 40 }]);
  const completedSplit = await one(
    `SELECT line.quantity, line.netsuite_active AS line_active, po.netsuite_active AS order_active,
            ledger.sales_qty, ledger.requested_sales_qty
       FROM dispatch_scm_po_split_lines ledger
       JOIN purchase_order_lines line ON line.id = ledger.split_line_id
       JOIN purchase_orders po ON po.netsuite_id = line.purchase_order_id
      WHERE ledger.id = $1`,
    [splitLedger.id]
  );
  check(number(completedSplit.quantity) === 0 && !completedSplit.line_active && !completedSplit.order_active,
    "A downward PO quantity amendment left an obsolete split quantity active.", { completedSplit });
  check(number(completedSplit.requested_sales_qty) === 100,
    "A downward PO quantity amendment erased the original split request.", { completedSplit });

  await upsertPurchaseOrderLines(ids.purchase, [{ ...amendedPurchasePayload, quantity: 160 }]);
  const restoredSplit = await one(
    `SELECT line.quantity, line.netsuite_active AS line_active, po.netsuite_active AS order_active,
            ledger.sales_qty, ledger.requested_sales_qty
       FROM dispatch_scm_po_split_lines ledger
       JOIN purchase_order_lines line ON line.id = ledger.split_line_id
       JOIN purchase_orders po ON po.netsuite_id = line.purchase_order_id
      WHERE ledger.id = $1`,
    [splitLedger.id]
  );
  check(number(restoredSplit.quantity) === 100 && restoredSplit.line_active && restoredSplit.order_active,
    "A later PO quantity increase did not restore the requested split quantity.", { restoredSplit });
  const specialPurchaseLines = [
    {
      line_id: 22,
      item_id: 2055,
      item_name: "MBBS-Special",
      item_description: "Custom coping - charcoal",
      quantity: 1,
      unit: "PC",
      location_id: 15,
      location: "12441",
      pallet_qty: 1,
      layer_qty: 0,
      section_qty: 0,
      piece_qty: 0
    },
    {
      line_id: 23,
      item_id: 2055,
      item_name: "MBBS-Special",
      item_description: "Custom coping - limestone",
      quantity: 2,
      unit: "PC",
      location_id: 15,
      location: "12441",
      pallet_qty: 0,
      layer_qty: 2,
      section_qty: 0,
      piece_qty: 0
    },
    {
      line_id: 24,
      item_id: 2055,
      item_name: "MBBS-Special",
      item_description: "Custom coping - ivory",
      quantity: 3,
      unit: "PC",
      location_id: 15,
      location: "12441",
      pallet_qty: 0,
      layer_qty: 0,
      section_qty: 1,
      piece_qty: 4
    }
  ];
  await upsertPurchaseOrderLines(ids.purchase, specialPurchaseLines);
  await upsertPurchaseOrderLines(ids.purchase, [...specialPurchaseLines].reverse());
  const storedSpecialPurchaseLines = await all(
    "SELECT line_id, item_description, pallet_qty, layer_qty, section_qty, piece_qty, pack_quantity_source "
      + "FROM purchase_order_lines WHERE purchase_order_id = $1 AND item_id = 2055 AND netsuite_active = true ORDER BY line_id",
    [ids.purchase]
  );
  check(storedSpecialPurchaseLines.length === 3, "Repeated MBBS-Special PO lines collapsed during sync.", { storedSpecialPurchaseLines });
  check(storedSpecialPurchaseLines.map((line) => number(line.line_id)).join(",") === "22,23,24",
    "MBBS-Special PO lines did not retain their NetSuite unique keys.", { storedSpecialPurchaseLines });
  check(storedSpecialPurchaseLines.every((line) => line.pack_quantity_source === "netsuite_manual"),
    "Manual MBBS-Special PO quantities did not retain their source.", { storedSpecialPurchaseLines });
  check(storedSpecialPurchaseLines.map((line) => line.item_description).join("|")
      === "Custom coping - charcoal|Custom coping - limestone|Custom coping - ivory",
    "MBBS-Special PO descriptions were not retained line by line.", { storedSpecialPurchaseLines });
  const manualReceivingLine = await one(
    "SELECT id FROM purchase_order_lines WHERE purchase_order_id = $1 AND line_id = 23",
    [ids.purchase]
  );
  await receivingRepository.confirmReceivingLine(ids.purchase, manualReceivingLine.id, { layers: 1 }, testOperator.id);
  let manualReceivingProgress = await one(
    "SELECT received_layer_qty, received_sales_qty FROM purchase_order_lines WHERE id = $1",
    [manualReceivingLine.id]
  );
  check(number(manualReceivingProgress.received_layer_qty) === 0 && number(manualReceivingProgress.received_sales_qty) === 1,
    "No-conversion MBBS-Special receiving did not use received_sales_qty exclusively.", { manualReceivingProgress });
  await receivingRepository.confirmReceivingLine(ids.purchase, manualReceivingLine.id, { layers: 2 }, testOperator.id);
  manualReceivingProgress = await one(
    "SELECT received_layer_qty, received_sales_qty FROM purchase_order_lines WHERE id = $1",
    [manualReceivingLine.id]
  );
  check(number(manualReceivingProgress.received_layer_qty) === 0 && number(manualReceivingProgress.received_sales_qty) === 2,
    "No-conversion MBBS-Special received sales quantity was not editable in its sales UOM.", { manualReceivingProgress });
  checks.push("repository purchase order -> purchase_orders/purchase_order_lines");

  const transferOrder = {
    id: ids.transfer,
    tranid: `SIM-TO-${runId}`,
    trandate: "2026-06-29",
    status: "B",
    status_text: "Pending Fulfillment",
    memo: "Transfer 3445 to 12441",
    source_location_id: 1,
    source_location: "3445",
    destination_location_id: 15,
    destination_location: "12441",
    outbound_location_id: 1,
    outbound_location: "3445"
  };
  const transferLine = {
    line_id: 31,
    item_id: 8201,
    item_name: "PER-LAFITT-60",
    item_type: "InvtPart",
    item_type_text: "Inventory Item",
    item_description: "Repository simulated TO line",
    quantity: 150,
    unit: "EA",
    item_weight: 4,
    location_id: 1,
    location: "3445",
    pallet_qty: 1,
    layer_qty: 5,
    section_qty: 0,
    piece_qty: 0,
    to_plt: 100,
    to_lyr: 10
  };
  const noConversionTransferLine = {
    ...transferLine,
    line_id: 32,
    item_id: 2055,
    item_name: "MBBS-Special",
    item_description: "No-conversion TO sales-UOM line",
    quantity: 3,
    unit: "PC",
    pallet_qty: 0,
    layer_qty: 2,
    section_qty: 0,
    piece_qty: 0,
    to_plt: 0,
    to_lyr: 0,
    to_sec: 0,
    to_pcs: 0
  };
  await upsertOutboundTransferOrders([transferOrder]);
  await upsertOutboundTransferOrderLines(ids.transfer, [transferLine, noConversionTransferLine]);
  await upsertInboundTransferOrders([{
    ...transferOrder,
    status_text: "Pending Receipt",
    destination_location_id: 15,
    destination_location: "12441"
  }]);
  await upsertInboundTransferOrderLines(ids.transfer, [{
    ...transferLine,
    location_id: 15,
    location: "12441",
    netsuite_received_qty: 50
  }, {
    ...noConversionTransferLine,
    location_id: 15,
    location: "12441",
    netsuite_received_qty: 0
  }]);
  await assertTransferOrder(ids.transfer, {
    from_location_id: 1,
    to_location_id: 15,
    line_id: 31,
    outbound_pallet_qty: 1,
    outbound_layer_qty: 5,
    receiving_pallet_qty: 1,
    netsuite_received_qty: 50,
    to_plt: 100,
    item_weight: 4
  });
  await query(
    `UPDATE sales_orders
        SET operator_status = 'packed', preparing_operator_id = null, preparing_started_at = null
      WHERE netsuite_id = $1`,
    [ids.sales]
  );
  const outboundNoConversionTransfer = await one(
    "SELECT id FROM transfer_order_lines WHERE transfer_order_id = $1 AND line_stage = 'outbound' AND line_id = 32",
    [ids.transfer]
  );
  await deliveryRepository.confirmDeliveryLine(ids.transfer, outboundNoConversionTransfer.id, { layers: 2 }, testOperator.id);
  const outboundTransferProgress = await one(
    "SELECT packed_layer_qty, packed_sales_qty FROM transfer_order_lines WHERE id = $1",
    [outboundNoConversionTransfer.id]
  );
  check(number(outboundTransferProgress.packed_layer_qty) === 0 && number(outboundTransferProgress.packed_sales_qty) === 2,
    "No-conversion TO packing did not use packed_sales_qty exclusively.", { outboundTransferProgress });
  const inboundNoConversionTransfer = await one(
    "SELECT id FROM transfer_order_lines WHERE transfer_order_id = $1 AND line_stage = 'receiving' AND line_id = 32",
    [ids.transfer]
  );
  await receivingRepository.confirmReceivingLine(ids.transfer, inboundNoConversionTransfer.id, { layers: 2 }, testOperator.id);
  const inboundTransferProgress = await one(
    "SELECT received_layer_qty, received_sales_qty FROM transfer_order_lines WHERE id = $1",
    [inboundNoConversionTransfer.id]
  );
  check(number(inboundTransferProgress.received_layer_qty) === 0 && number(inboundTransferProgress.received_sales_qty) === 2,
    "No-conversion TO receiving did not use received_sales_qty exclusively.", { inboundTransferProgress });
  checks.push("repository transfer order -> transfer_orders/transfer_order_lines both stages");
}

async function runWebhookSimulation(checks) {
  await processNetSuiteOrderWebhook({
    recordType: "salesorder",
    id: ids.webhookSales,
    tranid: `WH-SO-${runId}`,
    trandate: "2026-06-29",
    entityId: 7201,
    entityText: "Webhook Customer",
    status: "B",
    statusText: "Pending Fulfillment",
    custbody7: "送货地址：18 Stanwood Crescent, North York, ON M9M 1Z9",
    custbody4: "2026-07-02",
    foreignTotal: "321.00",
    locationId: 1,
    locationText: "3445",
    deliveryMethodId: 2,
    deliveryMethodText: "Delivery",
    lines: [{
      lineId: 41,
      itemId: 8301,
      itemName: "BC-SMOOTH-GR",
      itemType: "InvtPart",
      itemTypeText: "Inventory Item",
      itemDescription: "Webhook simulated SO line",
      quantity: 112,
      quantityFulfilled: 0,
      unitText: "EA",
      itemWeight: 2.75,
      locationId: 1,
      locationText: "3445",
      custcol_plt: 1,
      custcol_lyr: 1,
      custcol_sec: 2,
      custcol_pcs: 3,
      toPlt: 100,
      toLyr: 10,
      toSec: 1,
      toPcs: 1
    }]
  }, { scheduleDelayedStatus: false });
  await assertSalesOrder(ids.webhookSales, {
    sales_order_type: "Delivery",
    outbound_location_id: 1,
    expected_delivery_date: "2026-07-02",
    memo: "送货地址：18 Stanwood Crescent, North York, ON M9M 1Z9",
    line_id: 41,
    item_name: "BC-SMOOTH-GR",
    item_description: "Webhook simulated SO line",
    pallet_qty: 1,
    layer_qty: 1,
    section_qty: 2,
    piece_qty: 3,
    to_plt: 100,
    to_lyr: 10,
    to_sec: 1,
    to_pcs: 1,
    item_weight: 2.75
  });
  await assertDispatchWeight(`WH-SO-${runId}`, 308);
  checks.push("webhook salesorder custbody/custcol payload -> canonical sales views");

  await processNetSuiteOrderWebhook({
    recordType: "purchaseorder",
    id: ids.webhookPurchase,
    tranid: `WH-PO-${runId}`,
    trandate: "2026-06-29",
    entityId: 7301,
    entityText: "BWS Uxbridge",
    status: "B",
    statusText: "Pending Receipt",
    memo: "Uxbridge yard - BWS",
    foreignTotal: "654.00",
    locationId: 28,
    locationText: "2967",
    lines: [{
      lineId: 51,
      itemId: 8401,
      itemName: "BWS-AR-COP-UB",
      itemType: "InvtPart",
      itemTypeText: "Inventory Item",
      itemDescription: "Webhook simulated PO line",
      quantity: 210,
      quantityReceived: 10,
      unitText: "EA",
      itemWeight: 1.5,
      locationId: 28,
      locationText: "2967",
      custcol_plt: 2,
      custcol_lyr: 1,
      toPlt: 100,
      toLyr: 10
    }]
  }, { scheduleDelayedStatus: false });
  await assertPurchaseOrder(ids.webhookPurchase, {
    vendor: "BWS Uxbridge",
    destination_location_id: 28,
    memo: "Uxbridge yard - BWS",
    line_id: 51,
    item_name: "BWS-AR-COP-UB",
    pallet_qty: 2,
    layer_qty: 1,
    section_qty: 0,
    piece_qty: 0,
    netsuite_received_qty: 10,
    item_weight: 1.5
  });
  checks.push("webhook purchaseorder payload -> canonical purchase views");

  await processNetSuiteOrderWebhook({
    recordType: "transferorder",
    id: ids.webhookTransfer,
    tranid: `WH-TO-${runId}`,
    trandate: "2026-06-29",
    status: "B",
    statusText: "Pending Fulfillment",
    custbody7: "Transfer stock for receiving test",
    sourceLocationId: 1,
    sourceLocationText: "3445",
    transferLocationId: 15,
    transferLocationText: "12441",
    lines: [{
      lineId: 61,
      itemId: 8501,
      itemName: "OAK-MIST-24",
      itemType: "InvtPart",
      itemTypeText: "Inventory Item",
      itemDescription: "Webhook simulated TO line",
      quantity: 120,
      quantityFulfilled: 20,
      quantityReceived: 10,
      unitText: "EA",
      itemWeight: 5,
      custcol_plt: 1,
      custcol_lyr: 2,
      toPlt: 100,
      toLyr: 10
    }]
  }, { scheduleDelayedStatus: false });
  await assertTransferOrder(ids.webhookTransfer, {
    from_location_id: 1,
    to_location_id: 15,
    line_id: 61,
    outbound_pallet_qty: 1,
    outbound_layer_qty: 2,
    receiving_pallet_qty: 1,
    netsuite_received_qty: 10,
    to_plt: 100,
    item_weight: 5
  });
  checks.push("webhook transferorder payload -> canonical transfer outbound and receiving views");
}

async function main() {
  const checks = [];
  try {
    const result = await withTransaction(async () => {
      await runRepositorySimulation(checks);
      await runWebhookSimulation(checks);
      return {
        ok: true,
        rollback: true,
        syntheticIds: ids,
        checks
      };
    }, { rollback: true });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      message: error.message,
      details: error.details || null,
      checks
    }, null, 2));
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}

await main();
