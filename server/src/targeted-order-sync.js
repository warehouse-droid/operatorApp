const TARGETED_ORDER_TYPES = Object.freeze({
  SO: {
    orderType: "sales_order",
    netSuiteType: "SalesOrd",
    eventNames: ["dispatch.orders.updated", "delivery.order.updated"]
  },
  PO: {
    orderType: "purchase_order",
    netSuiteType: "PurchOrd",
    eventNames: ["dispatch.orders.updated", "receiving.order.updated"]
  },
  TO: {
    orderType: "transfer_order",
    netSuiteType: "TrnfrOrd",
    eventNames: ["dispatch.orders.updated", "delivery.order.updated", "receiving.order.updated"]
  }
});

function targetedSyncError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export function parseTargetedOrderReference(value) {
  const orderRef = String(value || "").trim().toUpperCase();
  if (!orderRef) throw targetedSyncError("Enter a NetSuite SO, PO, or TO order number.");
  if (orderRef.length > 64 || !/^[A-Z0-9_-]+$/.test(orderRef)) {
    throw targetedSyncError("Order number may contain only letters, numbers, hyphens, and underscores.");
  }

  const prefix = ["SO", "PO", "TO"].find((candidate) => orderRef.startsWith(candidate));
  if (!prefix) throw targetedSyncError("Order number must start with SO, PO, or TO.");
  if (prefix === "SO" && orderRef.startsWith("SOT")) {
    throw targetedSyncError("SOT cross-charge orders are excluded from the MBBS dispatch order sync.");
  }
  return { orderRef, prefix, ...TARGETED_ORDER_TYPES[prefix] };
}

function numericNetSuiteId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function statusText(row = {}) {
  return String(row?.statusText ?? row?.status_text ?? "").trim();
}

function missingOrderError(orderRef) {
  return targetedSyncError(`${orderRef} was not found in NetSuite for the inferred order type.`, 404);
}

export async function syncTargetedNetSuiteOrder({ orderRef, actorOperatorId = null } = {}, dependencies = {}) {
  const request = parseTargetedOrderReference(orderRef);
  const local = await dependencies.findLocalOrder(request);
  const identity = local || await dependencies.findNetSuiteOrder(request);
  const orderId = numericNetSuiteId(identity?.id ?? identity?.netsuite_id);
  if (!orderId) throw missingOrderError(request.orderRef);

  let order = null;
  let lineSummary = {};
  if (request.orderType === "sales_order") {
    order = await dependencies.fetchSalesOrder(orderId);
    if (!order) throw missingOrderError(request.orderRef);
    const lines = await dependencies.fetchSalesOrderLines(orderId);
    await dependencies.upsertSalesOrders([order]);
    await dependencies.upsertSalesOrderLines(orderId, lines);
    await dependencies.markMissingOutboundOrderLines(orderId, lines.map((line) => line.line_id));
    lineSummary = { outbound: lines.length };
  } else if (request.orderType === "purchase_order") {
    order = await dependencies.fetchPurchaseOrder(orderId);
    if (!order) throw missingOrderError(request.orderRef);
    const lines = await dependencies.fetchPurchaseOrderLines(orderId);
    await dependencies.upsertPurchaseOrders([order]);
    await dependencies.upsertPurchaseOrderLines(orderId, lines);
    await dependencies.markMissingInboundOrderLines(orderId, lines.map((line) => line.line_id));
    lineSummary = { receiving: lines.length };
  } else {
    order = await dependencies.fetchTransferOrder(orderId);
    if (!order) throw missingOrderError(request.orderRef);
    const sourceLocationId = order.source_location_id || order.outbound_location_id || null;
    const destinationLocationId = order.destination_location_id || order.order_location_id || null;
    const outboundLines = await dependencies.fetchTransferOrderLines(
      orderId,
      sourceLocationId,
      { direction: "source" }
    );
    const receivingLines = await dependencies.fetchTransferOrderLines(
      orderId,
      destinationLocationId,
      { direction: "destination" }
    );
    await dependencies.upsertOutboundTransferOrders([order]);
    await dependencies.upsertInboundTransferOrders([order]);
    await dependencies.upsertOutboundTransferOrderLines(orderId, outboundLines);
    await dependencies.upsertInboundTransferOrderLines(orderId, receivingLines);
    await dependencies.markMissingOutboundOrderLines(orderId, outboundLines.map((line) => line.line_id));
    await dependencies.markMissingInboundOrderLines(orderId, receivingLines.map((line) => line.line_id));
    lineSummary = { outbound: outboundLines.length, receiving: receivingLines.length };
  }

  const previousStatus = statusText(local);
  const currentStatus = statusText(order);
  const result = {
    ok: true,
    orderRef: String(order.tranid || request.orderRef).trim(),
    requestedOrderRef: request.orderRef,
    orderType: request.orderType,
    netSuiteId: orderId,
    foundLocally: Boolean(local),
    previousStatus,
    status: currentStatus,
    statusChanged: Boolean(previousStatus && previousStatus !== currentStatus),
    lines: lineSummary,
    syncedAt: (dependencies.now ? dependencies.now() : new Date()).toISOString()
  };

  await dependencies.writeAudit({
    actorType: actorOperatorId ? "operator" : "system",
    actorOperatorId,
    source: "control",
    action: "netsuite.order.targeted_sync",
    orderId,
    details: result
  });
  for (const eventName of request.eventNames) {
    dependencies.emitEvent(eventName, {
      source: "control_targeted_order_sync",
      orderId,
      tranid: result.orderRef,
      orderType: request.orderType,
      syncedAt: result.syncedAt
    });
  }
  return result;
}
