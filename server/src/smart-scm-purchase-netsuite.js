import { config } from "./config.js";

function quantity(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function buildSmartScmPurchaseOrderRestPayload({ proposal, locations = [] }) {
  const locationById = new Map(locations.map((location) => [Number(location.localLocationId ?? location.locationId), location]));
  const defaultLocation = locationById.get(Number(proposal.destinationLocationId)) || locations[0];
  if (!defaultLocation?.netsuiteLocationId) throw new Error("The Smart SCM PO destination could not be resolved to NetSuite.");
  const lines = (proposal.lines || [])
    .filter((line) => quantity(line.salesQuantity) > 0 && quantity(line.confirmedPallets) > 0)
    .map((line) => {
      const lineLocation = locationById.get(Number(line.destinationLocationId)) || defaultLocation;
      return {
        item: { id: String(line.itemId) },
        quantity: quantity(line.salesQuantity),
        location: { id: String(lineLocation.netsuiteLocationId) },
        custcol_plt: quantity(line.palletQty),
        custcol_lyr: quantity(line.layerQty),
        custcol_sec: quantity(line.sectionQty),
        custcol_pcs: quantity(line.pieceQty)
      };
    });
  if (!lines.length) throw new Error("The Smart SCM PO has no confirmed line quantity.");
  const payload = {
    entity: { id: String(proposal.vendorId) },
    location: { id: String(defaultLocation.netsuiteLocationId) },
    memo: `${proposal.memo || "Smart SCM replenishment"} | MBBS-SCM-PO:${proposal.id}${proposal.vendorReference ? ` | Vendor ref: ${proposal.vendorReference}` : ""}`,
    item: { items: lines }
  };
  if (defaultLocation.subsidiaryId) payload.subsidiary = { id: String(defaultLocation.subsidiaryId) };
  const employeeId = String(config.transferDependency.employeeId || "").trim();
  const deliveryMethodId = String(config.transferDependency.deliveryMethodId || "").trim();
  if (employeeId) payload.employee = { id: employeeId };
  if (deliveryMethodId) payload.custbody3 = { id: deliveryMethodId };
  return payload;
}
