import { config } from "./config.js";

function quantity(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function transferUnitFields(line = {}) {
  return {
    custcol_plt: quantity(line.palletQty),
    custcol_lyr: quantity(line.layerQty),
    custcol_sec: quantity(line.sectionQty),
    custcol_pcs: quantity(line.pieceQty)
  };
}

export function transferDependencyMemoMarker(batchId, proposalId) {
  const batch = String(batchId ?? "").trim();
  const proposal = String(proposalId ?? "").trim();
  if (!batch || !proposal) return "";
  return `MBBS dependency batch ${batch} proposal ${proposal}`;
}

export function transferDependencySalesOrderMemo(salesOrderRef) {
  const orderRef = String(salesOrderRef ?? "").trim();
  return orderRef ? `for ${orderRef}` : "";
}

export function smartScmTransferOrderMemoMarker(proposalId) {
  const proposal = Number(proposalId);
  if (!Number.isInteger(proposal) || proposal <= 0) return "";
  return `MBBS-SCM:${proposal}`;
}

export function selectSmartScmMarkerTransferOrder(rows = [], {
  proposalId,
  sourceLocationId = null,
  destinationLocationId = null
} = {}) {
  const matches = Array.isArray(rows) ? rows : [];
  if (matches.length > 1) {
    const error = Object.assign(
      new Error(`More than one NetSuite Transfer Order uses Smart SCM marker ${smartScmTransferOrderMemoMarker(proposalId)}. Reconcile the duplicates before retrying.`),
      { smartScmAttention: true }
    );
    error.markerMatches = matches.map((row) => ({
      id: Number(row.id) || null,
      tranid: row.tranid || null
    }));
    throw error;
  }
  if (!matches.length) return null;
  const match = matches[0];
  const id = Number(match.id);
  if (!Number.isInteger(id) || id <= 0) {
    throw Object.assign(
      new Error(`NetSuite returned an invalid TO ID for Smart SCM marker ${smartScmTransferOrderMemoMarker(proposalId)}.`),
      { smartScmAttention: true }
    );
  }
  const expectedSource = Number(sourceLocationId);
  const actualSource = Number(match.source_location_id ?? match.sourceLocationId);
  const expectedDestination = Number(destinationLocationId);
  const actualDestination = Number(match.destination_location_id ?? match.destinationLocationId);
  if (Number.isInteger(expectedSource) && expectedSource > 0
      && Number.isInteger(actualSource) && actualSource > 0
      && actualSource !== expectedSource) {
    throw Object.assign(new Error("The Smart SCM TO marker exists under a different NetSuite source location."), {
      smartScmAttention: true
    });
  }
  if (Number.isInteger(expectedDestination) && expectedDestination > 0
      && Number.isInteger(actualDestination) && actualDestination > 0
      && actualDestination !== expectedDestination) {
    throw Object.assign(new Error("The Smart SCM TO marker exists under a different NetSuite destination location."), {
      smartScmAttention: true
    });
  }
  return { ...match, id };
}

export function buildTransferDependencyRestPayload({
  proposal,
  batch,
  locations,
  memoOverride = ""
}) {
  const palletItemId = Number(proposal.palletItemId);
  const materialItems = (proposal.lines || [])
    .filter((line) => String(line.itemId) !== String(palletItemId)
      && String(line.sku || line.itemName || "").trim().toUpperCase() !== "PALLET")
    .map((line) => ({
      item: { id: String(line.itemId) },
      quantity: quantity(line.proposedQuantity),
      ...transferUnitFields(line)
    }));
  const palletQuantity = quantity(proposal.palletTransferQuantity);
  const employeeId = String(config.transferDependency.employeeId || "").trim();
  const deliveryMethodId = String(config.transferDependency.deliveryMethodId || "").trim();
  const memoMarker = transferDependencyMemoMarker(batch.id, proposal.id);
  const memo = String(memoOverride || "").trim()
    || transferDependencySalesOrderMemo(batch.salesOrderRef)
    || memoMarker
    || `MBBS dependency batch ${batch.id}`;
  const payload = {
    location: { id: String(locations.source.netsuiteLocationId) },
    transferLocation: { id: String(locations.destination.netsuiteLocationId) },
    memo,
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
  if (employeeId) payload.employee = { id: employeeId };
  if (deliveryMethodId) payload.custbody3 = { id: deliveryMethodId };
  if (locations.intercompany) {
    payload.toSubsidiary = { id: String(locations.destination.subsidiaryId) };
  }
  return payload;
}

export function buildTransferDependencyUpdateRequest({
  transferOrderId,
  intercompany = false,
  payload
} = {}) {
  const id = Number(transferOrderId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("A valid numeric NetSuite transfer order ID is required.");
  }
  if (!payload?.item || !Array.isArray(payload.item.items) || !payload.item.items.length) {
    throw new Error("A Transfer Order quantity update requires at least one item line.");
  }
  const recordType = intercompany ? "intercompanyTransferOrder" : "transferOrder";
  return {
    path: `/record/v1/${recordType}/${id}?replace=item`,
    method: "PATCH",
    payload
  };
}

export function transferOrderQuantityRevisionStatusBlock(order = {}) {
  const status = String(order.status || "").trim().toUpperCase();
  const statusText = String(order.status_text ?? order.statusText ?? "").trim();
  if (/partially fulfilled|pending receipt|partially received|received|closed|cancel(?:led)?/i.test(statusText)) {
    return `NetSuite Transfer Order execution has started (${statusText || status}); its quantities can no longer be changed.`;
  }
  if (["A", "B"].includes(status) || /pending approval|pending fulfillment/i.test(statusText)) return null;
  return `NetSuite Transfer Order status ${statusText || status || "unknown"} is not safe for a quantity change.`;
}

export function transferDependencyPickingTicketJobKey({
  proposalId,
  transferOrderRef,
  generation
} = {}) {
  const proposal = Number(proposalId);
  const printGeneration = Number(generation);
  const orderRef = String(transferOrderRef || "").trim();
  if (!Number.isInteger(proposal) || proposal <= 0 || !orderRef
      || !Number.isInteger(printGeneration) || printGeneration <= 0) {
    throw new Error("Proposal, Transfer Order reference, and positive print generation are required.");
  }
  return `transfer-dependency:${proposal}:picking-ticket:${orderRef}:${printGeneration}`;
}
