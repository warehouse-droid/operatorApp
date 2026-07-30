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

export function buildTransferDependencyRestPayload({ proposal, batch, locations }) {
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
  const payload = {
    location: { id: String(locations.source.netsuiteLocationId) },
    transferLocation: { id: String(locations.destination.netsuiteLocationId) },
    memo: `${proposal.memo || `Inventory dependency for ${batch.salesOrderRef}`} | ${memoMarker || `MBBS dependency batch ${batch.id}`}`,
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
