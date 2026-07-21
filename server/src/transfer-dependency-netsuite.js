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
