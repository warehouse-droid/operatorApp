import { config } from "./config.js";
import { upsertInventoryBalances } from "./inventory-repository.js";
import {
  createTransferOrderInNetSuite,
  fetchInventoryBalancesForItemsFromNetSuite,
  fetchPickingTicketFromNetSuite,
  fetchTransferOrderByIdFromNetSuite,
  fetchTransferOrderDetailsFromNetSuite,
  findTransferOrdersByStockRequestMarkerFromNetSuite,
  resolveNetSuiteTransferLocations,
  resolveNetSuiteYardLocations,
  updateTransferOrderInNetSuite,
  updateTransferOrderStatusInNetSuite
} from "./netsuite.js";
import {
  upsertInboundTransferOrderLines,
  upsertInboundTransferOrders,
  upsertOutboundTransferOrderLines,
  upsertOutboundTransferOrders
} from "./order-sync-repository.js";
import { listYardPrinters, queueSmartScmPrintJob } from "./smart-scm-print-repository.js";
import {
  claimStockTransferConfirmation,
  claimStockTransferPrint,
  completeStockTransferPrint,
  convertSalesStockRequestLines,
  failStockTransferConfirmation,
  getScmStockRequest,
  getStockRequestItemAvailability,
  getStockTransfer,
  recordStockTransferApproved,
  recordStockTransferRemote,
  recordStockTransferRevisionResult,
  reviseStockTransferQuantities
} from "./stock-request-repository.js";
import {
  STOCK_REQUEST_YARDS,
  selectStockRequestMarkerTransferOrder,
  stockRequestMemoMarker,
  stockTransferQuantityRevisionBlock
} from "./stock-request-domain.js";

function quantity(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function positiveId(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`A valid ${label} ID is required.`);
  return parsed;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function canonicalStockRequestInventoryRows(rows = [], resolvedYards = [], itemId) {
  const id = positiveId(itemId, "inventory item");
  const yards = Array.isArray(resolvedYards) ? resolvedYards : [];
  if (yards.length !== STOCK_REQUEST_YARDS.length) {
    throw new Error("All four supported yards must be resolved before refreshing stock-request availability.");
  }
  const localByRemote = new Map(yards.map((yard) => [String(yard.netsuiteLocationId), yard]));
  const matching = (rows || []).filter((row) => Number(row.item_id) === id && localByRemote.has(String(row.location_id)));
  if (!matching.length) throw new Error(`NetSuite returned no supported-yard inventory for item ${id}.`);
  const base = matching[0];
  const byLocal = new Map(matching.map((row) => {
    const yard = localByRemote.get(String(row.location_id));
    return [Number(yard.localLocationId), {
      ...row,
      item_id: id,
      location_id: Number(yard.localLocationId),
      location: yard.localLocationCode
    }];
  }));
  return yards.map((yard) => byLocal.get(Number(yard.localLocationId)) || {
    ...base,
    item_id: id,
    location_id: Number(yard.localLocationId),
    location: yard.localLocationCode,
    quantity_on_hand: 0,
    quantity_available: 0,
    quantity_on_order: 0,
    quantity_backordered: 0
  });
}

export function buildStockRequestTransferPayload({ transfer, locations }) {
  if (!transfer || !locations?.source || !locations?.destination) {
    throw new Error("A local stock transfer and resolved NetSuite locations are required.");
  }
  const materialByItem = new Map();
  for (const line of transfer.lines || []) {
    const itemId = positiveId(line.itemId ?? line.item_id, "inventory item");
    if (itemId === Number(transfer.palletItemId)) continue;
    const current = materialByItem.get(itemId) || {
      itemId,
      quantity: 0,
      pallets: 0,
      layers: 0,
      sections: 0,
      pieces: 0
    };
    current.quantity += quantity(line.salesQty ?? line.sales_qty);
    current.pallets += quantity(line.pallets ?? line.pallet_qty);
    current.layers += quantity(line.layers ?? line.layer_qty);
    current.sections += quantity(line.sections ?? line.section_qty);
    current.pieces += quantity(line.pieces ?? line.piece_qty);
    materialByItem.set(itemId, current);
  }
  const materialItems = [...materialByItem.values()]
    .sort((left, right) => left.itemId - right.itemId)
    .map((line) => ({
      item: { id: String(line.itemId) },
      quantity: line.quantity,
      custcol_plt: line.pallets,
      custcol_lyr: line.layers,
      custcol_sec: line.sections,
      custcol_pcs: line.pieces
    }));
  if (!materialItems.length) throw new Error("A stock-request TO requires at least one material item.");
  const palletQuantity = quantity(transfer.palletQuantity);
  const palletItemId = Number(transfer.palletItemId);
  if (palletQuantity > 0 && (!Number.isInteger(palletItemId) || palletItemId <= 0)) {
    throw new Error("The official PALLET item is required for this Transfer Order.");
  }
  const payload = {
    location: { id: String(locations.source.netsuiteLocationId) },
    transferLocation: { id: String(locations.destination.netsuiteLocationId) },
    memo: `Sales stock request ${transfer.transferRef || transfer.id} | ${stockRequestMemoMarker(transfer.id)}`,
    item: {
      items: [
        ...materialItems,
        ...(palletQuantity > 0 ? [{
          item: { id: String(palletItemId) },
          quantity: palletQuantity,
          custcol_plt: 0,
          custcol_lyr: 0,
          custcol_sec: 0,
          custcol_pcs: palletQuantity
        }] : [])
      ]
    },
    subsidiary: { id: String(locations.source.subsidiaryId) }
  };
  const employeeId = String(config.transferDependency.employeeId || "").trim();
  const deliveryMethodId = String(config.transferDependency.deliveryMethodId || "").trim();
  if (employeeId) payload.employee = { id: employeeId };
  if (deliveryMethodId) payload.custbody3 = { id: deliveryMethodId };
  if (locations.intercompany) payload.toSubsidiary = { id: String(locations.destination.subsidiaryId) };
  return payload;
}

async function recoverRemoteTransfer(transfer, locations, findRemoteByMarker, {
  attempts = 1,
  delayMs = 0
} = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const rows = await findRemoteByMarker({
      transferId: transfer.id,
      sourceLocationId: locations.source.netsuiteLocationId,
      destinationLocationId: locations.destination.netsuiteLocationId
    });
    const match = selectStockRequestMarkerTransferOrder(rows, {
      transferId: transfer.id,
      sourceLocationId: locations.source.netsuiteLocationId,
      destinationLocationId: locations.destination.netsuiteLocationId
    });
    if (match) return match;
    if (attempt < attempts && delayMs > 0) await sleep(delayMs * attempt);
  }
  return null;
}

export async function confirmStockTransferWorkflow({
  transfer,
  requestId,
  operatorId = null
} = {}, dependencies = {}) {
  const {
    ensurePrinter,
    resolveLocations,
    findRemoteByMarker,
    createRemote,
    recordRemote,
    approveRemote,
    hydrateRemote,
    recordApproved,
    fetchTicket,
    claimPrint,
    queuePrint,
    complete,
    fail,
    recoveryAttempts = 4,
    recoveryDelayMs = 650
  } = dependencies;
  if (transfer?.confirmationStatus === "complete"
      && transfer?.confirmationRequestId === requestId
      && transfer?.netsuiteTransferOrderId
      && transfer?.printJobId) {
    return {
      transferId: transfer.id,
      remoteId: Number(transfer.netsuiteTransferOrderId),
      remoteRef: transfer.netsuiteTransferOrderRef || null,
      printJob: { id: Number(transfer.printJobId), status: transfer.printStatus || "queued" },
      recovered: true,
      idempotentReplay: true
    };
  }
  let remoteId = Number(transfer?.netsuiteTransferOrderId) || null;
  let remoteRef = transfer?.netsuiteTransferOrderRef || null;
  let recovered = false;
  try {
    await ensurePrinter(transfer.sourceLocationId);
    const locations = await resolveLocations(transfer);
    let remote = null;
    if (remoteId) {
      remote = { id: remoteId, tranid: remoteRef };
      recovered = true;
    } else {
      remote = await recoverRemoteTransfer(transfer, locations, findRemoteByMarker, { attempts: 1 });
      if (remote) {
        recovered = true;
      } else {
        let createError = null;
        try {
          remote = await createRemote(buildStockRequestTransferPayload({ transfer, locations }), {
            intercompany: locations.intercompany
          });
        } catch (error) {
          createError = error;
        }
        const createdId = Number(remote?.id);
        if (!Number.isInteger(createdId) || createdId <= 0) {
          remote = await recoverRemoteTransfer(transfer, locations, findRemoteByMarker, {
            attempts: recoveryAttempts,
            delayMs: recoveryDelayMs
          });
          if (!remote) throw createError || new Error("NetSuite did not return a TO ID and marker recovery found no matching transaction.");
          recovered = true;
        }
      }
    }
    remoteId = positiveId(remote.id, "NetSuite Transfer Order");
    remoteRef = remote.tranid || remoteRef || null;
    await recordRemote(transfer.id, { ...remote, id: remoteId, recovered }, { operatorId, requestId });
    await approveRemote(remoteId, { intercompany: locations.intercompany, statusId: "B" });
    const hydrated = await hydrateRemote(remoteId, transfer, locations);
    remoteRef = hydrated.tranid || remoteRef || `TO-${remoteId}`;
    if (!hydrated.pendingFulfillment) {
      throw new Error(`${remoteRef} exists but did not reach Pending Fulfillment.`);
    }
    await recordApproved(transfer.id, hydrated, { operatorId, requestId });
    const document = await fetchTicket(remoteId, {
      locationId: locations.source.netsuiteLocationId,
      filenamePrefix: remoteRef
    });
    const printClaim = await claimPrint(transfer.id, { operatorId, requestId });
    const printJob = await queuePrint({
      transfer,
      remoteId,
      remoteRef,
      document,
      generation: printClaim.generation,
      operatorId
    });
    await complete(transfer.id, { printJobId: printJob.id, operatorId, requestId });
    return { transferId: transfer.id, remoteId, remoteRef, printJob, recovered };
  } catch (error) {
    await fail(transfer.id, { error, remoteId, remoteRef, requestId }, { operatorId }).catch(() => null);
    throw error;
  }
}

async function resolvedStockRequestYards({ resolveYards = resolveNetSuiteYardLocations } = {}) {
  return resolveYards(STOCK_REQUEST_YARDS.map((yard) => ({
    locationId: yard.locationId,
    code: yard.yardCode
  })));
}

export async function refreshStockRequestItemAvailability(itemId, dependencies = {}) {
  const id = positiveId(itemId, "inventory item");
  await refreshStockRequestItemsAvailability([id], dependencies);
  const getAvailability = dependencies.getAvailability || getStockRequestItemAvailability;
  return getAvailability(id);
}

export async function refreshStockRequestItemsAvailability(itemIds = [], dependencies = {}) {
  const ids = [...new Set((itemIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) return [];
  const yards = await resolvedStockRequestYards({
    resolveYards: dependencies.resolveYards || resolveNetSuiteYardLocations
  });
  const fetchBalances = dependencies.fetchBalances || fetchInventoryBalancesForItemsFromNetSuite;
  const saveBalances = dependencies.upsertBalances || upsertInventoryBalances;
  const rows = await fetchBalances(
    ids,
    yards.map((yard) => yard.netsuiteLocationId)
  );
  const canonical = ids.flatMap((id) => canonicalStockRequestInventoryRows(rows, yards, id));
  await saveBalances(canonical);
  return canonical;
}

export async function convertStockRequestLines(requestId, input = {}, operator = {}, dependencies = {}) {
  const getRequest = dependencies.getRequest || getScmStockRequest;
  const refreshAvailability = dependencies.refreshAvailability || refreshStockRequestItemsAvailability;
  const convertLines = dependencies.convertLines || convertSalesStockRequestLines;
  const request = await getRequest(requestId);
  const selected = new Set((input.lineIds || []).map(Number));
  const itemIds = request.lines.filter((line) => selected.has(line.id)).map((line) => line.itemId);
  if (itemIds.length) await refreshAvailability(itemIds);
  return convertLines(requestId, input, { operatorId: operator.id });
}

export async function requireStockRequestPrinter(locationId, dependencies = {}) {
  const listPrinters = dependencies.listPrinters || listYardPrinters;
  const printer = (await listPrinters()).find((row) => Number(row.locationId) === Number(locationId));
  if (!printer?.transferOrderReady) {
    const yard = STOCK_REQUEST_YARDS.find((candidate) => candidate.locationId === Number(locationId));
    throw Object.assign(
      new Error(`${yard?.yardCode || locationId} requires two different TO printers, an enabled yard queue, and an agent token before confirming this TO.`),
      { status: 409 }
    );
  }
  return printer;
}

export async function hydrateStockRequestTransfer(remoteId, transfer, dependencies = {}) {
  const fetchOrder = dependencies.fetchOrder || fetchTransferOrderByIdFromNetSuite;
  const fetchDetails = dependencies.fetchDetails || fetchTransferOrderDetailsFromNetSuite;
  const saveOutboundOrders = dependencies.saveOutboundOrders || upsertOutboundTransferOrders;
  const saveOutboundLines = dependencies.saveOutboundLines || upsertOutboundTransferOrderLines;
  const saveInboundOrders = dependencies.saveInboundOrders || upsertInboundTransferOrders;
  const saveInboundLines = dependencies.saveInboundLines || upsertInboundTransferOrderLines;
  const order = await fetchOrder(remoteId);
  if (!order) throw new Error("Created NetSuite Transfer Order was not found.");
  const remoteSourceId = Number(order.source_location_id || transfer.sourceLocationId);
  const remoteDestinationId = Number(order.destination_location_id || transfer.destinationLocationId);
  const outboundLines = await fetchDetails(remoteId, remoteSourceId, { direction: "source" });
  const receivingLines = await fetchDetails(remoteId, remoteDestinationId, { direction: "destination" });
  const canonicalOrder = {
    ...order,
    source_location_id: transfer.sourceLocationId,
    source_location: transfer.sourceName,
    outbound_location_id: transfer.sourceLocationId,
    outbound_location: transfer.sourceName,
    destination_location_id: transfer.destinationLocationId,
    destination_location: transfer.destinationName,
    order_location_id: transfer.destinationLocationId,
    order_location: transfer.destinationName,
    customer_id: transfer.destinationLocationId,
    customer: `Transfer to ${transfer.destinationName}`
  };
  await saveOutboundOrders([canonicalOrder]);
  await saveOutboundLines(remoteId, outboundLines.map((line) => ({
    ...line,
    location_id: transfer.sourceLocationId,
    location: transfer.sourceName
  })));
  await saveInboundOrders([canonicalOrder]);
  await saveInboundLines(remoteId, receivingLines.map((line) => ({
    ...line,
    location_id: transfer.destinationLocationId,
    location: transfer.destinationName
  })));
  const status = String(order.status || "").trim();
  const statusText = String(order.status_text || "").trim();
  return {
    id: Number(order.id),
    tranid: order.tranid,
    status,
    statusText,
    pendingFulfillment: status.toUpperCase() === "B" || /pending fulfillment/i.test(statusText)
  };
}

export function stockRequestPrintJobKey({ transferId, remoteRef, generation }) {
  return `stock-request:${positiveId(transferId, "stock transfer")}:picking-ticket:${String(remoteRef || "").trim()}:${positiveId(generation, "print generation")}`;
}

export function stockRequestTransferLocationInput(transfer = {}) {
  return {
    sourceLocationId: transfer.sourceLocationId,
    sourceLocation: transfer.sourceName,
    destinationLocationId: transfer.destinationLocationId,
    destinationLocation: transfer.destinationName
  };
}

export async function queueStockRequestTicket({ transfer, remoteId, remoteRef, document, generation, operatorId }, dependencies = {}) {
  const queuePrintJob = dependencies.queuePrintJob || queueSmartScmPrintJob;
  return queuePrintJob({
    proposalId: null,
    locationId: transfer.sourceLocationId,
    documentType: "transfer_dependency_picking_ticket",
    documentName: document.filename,
    documentBuffer: document.buffer,
    jobKey: stockRequestPrintJobKey({ transferId: transfer.id, remoteRef, generation }),
    sourceOrderId: remoteId,
    sourceOrderRef: remoteRef,
    lineLocationId: transfer.sourceLocationId
  }, operatorId);
}

export async function confirmAndPrintStockTransfer(transferId, input = {}, operator = {}, dependencies = {}) {
  const liveExecutionEnabled = dependencies.liveExecutionEnabled ?? config.smartScm.liveExecutionEnabled;
  if (!liveExecutionEnabled) {
    throw Object.assign(new Error("Live Transfer Order creation is disabled by SMART_SCM_LIVE_EXECUTION_ENABLED=false."), { status: 409 });
  }
  const claimConfirmation = dependencies.claimConfirmation || claimStockTransferConfirmation;
  const transfer = await claimConfirmation(transferId, input, { operatorId: operator.id });
  return confirmStockTransferWorkflow({
    transfer,
    requestId: input.requestId,
    operatorId: operator.id
  }, {
    ensurePrinter: dependencies.ensurePrinter || requireStockRequestPrinter,
    resolveLocations: dependencies.resolveLocations
      || ((candidate) => resolveNetSuiteTransferLocations(stockRequestTransferLocationInput(candidate))),
    findRemoteByMarker: dependencies.findRemoteByMarker || findTransferOrdersByStockRequestMarkerFromNetSuite,
    createRemote: dependencies.createRemote || createTransferOrderInNetSuite,
    recordRemote: dependencies.recordRemote || recordStockTransferRemote,
    approveRemote: dependencies.approveRemote || updateTransferOrderStatusInNetSuite,
    hydrateRemote: dependencies.hydrateRemote || hydrateStockRequestTransfer,
    recordApproved: dependencies.recordApproved || recordStockTransferApproved,
    fetchTicket: dependencies.fetchTicket || fetchPickingTicketFromNetSuite,
    claimPrint: dependencies.claimPrint || claimStockTransferPrint,
    queuePrint: dependencies.queuePrint || queueStockRequestTicket,
    complete: dependencies.complete || completeStockTransferPrint,
    fail: dependencies.fail || failStockTransferConfirmation,
    recoveryAttempts: dependencies.recoveryAttempts,
    recoveryDelayMs: dependencies.recoveryDelayMs
  });
}

export async function reprintStockTransfer(transferId, input = {}, operator = {}, dependencies = {}) {
  const loadTransfer = dependencies.getTransfer || getStockTransfer;
  const ensurePrinter = dependencies.ensurePrinter || requireStockRequestPrinter;
  const resolveLocations = dependencies.resolveLocations || resolveNetSuiteTransferLocations;
  const fetchTicket = dependencies.fetchTicket || fetchPickingTicketFromNetSuite;
  const claimPrint = dependencies.claimPrint || claimStockTransferPrint;
  const queueTicket = dependencies.queueTicket || queueStockRequestTicket;
  const completePrint = dependencies.completePrint || completeStockTransferPrint;
  const transfer = await loadTransfer(transferId);
  const expected = Number(input.expectedRevision);
  if (!Number.isInteger(expected) || transfer.revision !== expected) {
    throw Object.assign(new Error("This pending Transfer Order changed after the screen loaded. Reload and try again."), { status: 409 });
  }
  if (!transfer.netsuiteTransferOrderId || !transfer.netsuiteTransferOrderRef) {
    throw Object.assign(new Error("This pending TO has no real NetSuite picking ticket to re-print."), { status: 409 });
  }
  await ensurePrinter(transfer.sourceLocationId);
  const locations = await resolveLocations(stockRequestTransferLocationInput(transfer));
  const document = await fetchTicket(transfer.netsuiteTransferOrderId, {
    locationId: locations.source.netsuiteLocationId,
    filenamePrefix: transfer.netsuiteTransferOrderRef
  });
  const claim = await claimPrint(transfer.id, { operatorId: operator.id });
  const printJob = await queueTicket({
    transfer,
    remoteId: transfer.netsuiteTransferOrderId,
    remoteRef: transfer.netsuiteTransferOrderRef,
    document,
    generation: claim.generation,
    operatorId: operator.id
  });
  const updated = await completePrint(transfer.id, { printJobId: printJob.id, operatorId: operator.id });
  return { transfer: updated, printJob };
}

export async function reviseStockTransfer(transferId, input = {}, operator = {}, dependencies = {}) {
  const loadTransfer = dependencies.getTransfer || getStockTransfer;
  const refreshAvailability = dependencies.refreshAvailability || refreshStockRequestItemsAvailability;
  const fetchRemote = dependencies.fetchRemote || fetchTransferOrderByIdFromNetSuite;
  const resolveLocations = dependencies.resolveLocations || resolveNetSuiteTransferLocations;
  const reviseQuantities = dependencies.reviseQuantities || reviseStockTransferQuantities;
  const updateRemote = dependencies.updateRemote || updateTransferOrderInNetSuite;
  const hydrateRemote = dependencies.hydrateRemote || hydrateStockRequestTransfer;
  const recordRevisionResult = dependencies.recordRevisionResult || recordStockTransferRevisionResult;
  const current = await loadTransfer(transferId);
  await refreshAvailability(current.lines.map((line) => line.itemId));
  let locations = null;
  if (current.netsuiteTransferOrderId) {
    const remote = await fetchRemote(current.netsuiteTransferOrderId);
    if (!remote) throw Object.assign(new Error("The linked NetSuite Transfer Order was not found."), { status: 409 });
    const block = stockTransferQuantityRevisionBlock(remote);
    if (block) throw Object.assign(new Error(block), { status: 409, code: "STOCK_TRANSFER_REVISION_BLOCKED" });
    locations = await resolveLocations(stockRequestTransferLocationInput(current));
  }
  const revised = await reviseQuantities(transferId, input, { operatorId: operator.id });
  if (!revised.netsuiteTransferOrderId) return { transfer: revised, synced: false };
  try {
    const payload = buildStockRequestTransferPayload({ transfer: revised, locations });
    await updateRemote(
      revised.netsuiteTransferOrderId,
      { item: payload.item },
      { intercompany: locations.intercompany }
    );
    const hydrated = await hydrateRemote(revised.netsuiteTransferOrderId, revised);
    const transfer = await recordRevisionResult(revised.id, {
      succeeded: true,
      remote: hydrated,
      operatorId: operator.id
    });
    return { transfer, synced: true };
  } catch (error) {
    await recordRevisionResult(revised.id, {
      succeeded: false,
      error,
      operatorId: operator.id
    });
    throw error;
  }
}
