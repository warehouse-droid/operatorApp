import { config } from "./config.js";

function quantity(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function optionalQuantity(value) {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizedUnit(value) {
  return String(value || "").trim().toUpperCase().replace(/\s+/g, " ");
}

function assertPurchaseUnit(itemName, stockUnit, purchaseUnit) {
  if (normalizedUnit(stockUnit) === "" || normalizedUnit(purchaseUnit) === "") {
    throw new Error(itemName + " needs both a stock-unit and purchase-unit snapshot before PO payload creation.");
  }
  if (normalizedUnit(stockUnit) !== normalizedUnit(purchaseUnit)) {
    throw new Error(itemName + " stock unit " + stockUnit + " does not match purchase unit " + purchaseUnit + ".");
  }
}

export function smartScmPurchaseOrderMemoMarker(proposalId) {
  const id = Number(proposalId);
  if (!Number.isInteger(id) || id <= 0) return "";
  return `MBBS-SCM-PO:${id}`;
}

function isPalletLine(line = {}, palletItemId = null) {
  return String(line.itemId) === String(palletItemId)
    || String(line.itemName || line.sku || "").trim().toUpperCase() === "PALLET";
}

export function smartScmPurchaseOrderMemo({ proposal = {}, materialLines = [], locations = [] } = {}) {
  const locationById = new Map(locations.map((location) => [
    Number(location.localLocationId ?? location.locationId),
    location
  ]));
  const yards = [...new Set((materialLines.length ? materialLines : proposal.lines || [])
    .filter((line) => !isPalletLine(line, proposal.palletItemId ?? proposal.palletItem?.itemId))
    .map((line) => {
      const location = locationById.get(Number(line.destinationLocationId));
      return String(
        line.destinationName
        || location?.yardCode
        || location?.locationName
        || location?.name
        || (Number(line.destinationLocationId) === Number(proposal.destinationLocationId) ? proposal.destinationName : "")
        || line.destinationLocationId
        || ""
      ).trim();
    })
    .filter(Boolean))];
  if (!yards.length && proposal.destinationName) yards.push(String(proposal.destinationName).trim());
  const rawDate = String(
    proposal.readyDate
    || proposal.vendorReadyDate
    || proposal.expectedDeliveryDate
    || proposal.transactionDate
    || "Not set"
  ).trim();
  const memoDate = /^\d{4}-\d{2}-\d{2}/.test(rawDate) ? rawDate.slice(0, 10) : rawDate;
  const marker = smartScmPurchaseOrderMemoMarker(proposal.id);
  const loadNumber = [proposal.sourceProposalId, proposal.parentProposalId, proposal.id]
    .map(Number)
    .find((value) => Number.isInteger(value) && value > 0);
  return [
    `Date: ${memoDate}`,
    `Yard: ${yards.join(", ") || "Not set"}`,
    `Load #${loadNumber || "Not set"}`,
    proposal.memo || "Smart SCM replenishment",
    marker,
    proposal.vendorReference ? `Vendor ref: ${proposal.vendorReference}` : ""
  ].filter(Boolean).join(" | ");
}

export function buildSmartScmPurchaseOrderRestPayload({ proposal, locations = [], palletItem = null }) {
  const locationById = new Map(locations.map((location) => [Number(location.localLocationId ?? location.locationId), location]));
  const defaultLocation = locationById.get(Number(proposal.destinationLocationId)) || locations[0];
  if (!defaultLocation?.netsuiteLocationId) throw new Error("The Smart SCM PO destination could not be resolved to NetSuite.");
  const resolvedPalletItem = palletItem || proposal.palletItem || {
    id: proposal.palletItemId,
    itemId: proposal.palletItemId,
    itemName: proposal.palletItemName,
    unit: proposal.palletUnit,
    purchaseUnit: proposal.palletPurchaseUnit,
    lastPurchasePrice: proposal.palletLastPurchasePrice
  };
  const palletItemId = Number(resolvedPalletItem?.id ?? resolvedPalletItem?.itemId);
  const materialLines = (proposal.lines || [])
    .filter((line) => quantity(line.salesQuantity) > 0
      && quantity(line.confirmedPallets) > 0
      && !isPalletLine(line, palletItemId));
  const lines = materialLines
    .map((line) => {
      const lineLocation = locationById.get(Number(line.destinationLocationId)) || defaultLocation;
      const rate = quantity(line.lastPurchasePrice);
      if (rate <= 0) throw new Error((line.itemName || line.itemId) + " needs a positive Last Purchase Price before PO payload creation.");
      assertPurchaseUnit(line.itemName || line.itemId, line.unit, line.purchaseUnit);
      const payloadLine = {
        item: { id: String(line.itemId) },
        quantity: quantity(line.salesQuantity),
        location: { id: String(lineLocation.netsuiteLocationId) },
        rate,
        custcol_plt: quantity(line.palletQty)
      };
      const layerQty = optionalQuantity(line.layerQty);
      const sectionQty = optionalQuantity(line.sectionQty);
      const pieceQty = optionalQuantity(line.pieceQty);
      if (layerQty !== undefined) payloadLine.custcol_lyr = layerQty;
      if (sectionQty !== undefined) payloadLine.custcol_sec = sectionQty;
      if (pieceQty !== undefined) payloadLine.custcol_pcs = pieceQty;
      return payloadLine;
    });
  const palletsByDestination = new Map();
  for (const line of materialLines) {
    const destinationLocationId = Number(line.destinationLocationId || proposal.destinationLocationId);
    palletsByDestination.set(
      destinationLocationId,
      quantity(palletsByDestination.get(destinationLocationId)) + quantity(line.confirmedPallets)
    );
  }
  const explicitPalletLines = Array.isArray(proposal.palletLines) ? proposal.palletLines : null;
  if (explicitPalletLines) {
    palletsByDestination.clear();
    for (const line of explicitPalletLines) {
      const destinationLocationId = Number(line.destinationLocationId || proposal.destinationLocationId);
      if (!Number.isInteger(destinationLocationId) || destinationLocationId <= 0) {
        throw new Error("Every Official PALLET line needs a valid destination before PO payload creation.");
      }
      palletsByDestination.set(destinationLocationId, quantity(
        line.purchaseQuantity ?? line.salesQuantity ?? line.confirmedPallets ?? line.quantity
      ));
    }
  } else if (proposal.palletQuantityOverrides && typeof proposal.palletQuantityOverrides === "object") {
    for (const [rawDestinationLocationId, rawQuantity] of Object.entries(proposal.palletQuantityOverrides)) {
      const destinationLocationId = Number(rawDestinationLocationId);
      if (palletsByDestination.has(destinationLocationId)) {
        palletsByDestination.set(destinationLocationId, quantity(rawQuantity));
      }
    }
  }
  const palletRate = quantity(resolvedPalletItem?.lastPurchasePrice ?? proposal.palletLastPurchasePrice);
  const needsPalletItem = [...palletsByDestination.values()].some((value) => value > 0);
  if (needsPalletItem && (Number.isInteger(palletItemId) === false || palletItemId <= 0)) throw new Error("The active NetSuite PALLET item is required before PO payload creation.");
  if (needsPalletItem && palletRate <= 0) throw new Error("PALLET needs a positive Last Purchase Price before PO payload creation.");
  if (needsPalletItem) assertPurchaseUnit(resolvedPalletItem?.itemName || "PALLET", resolvedPalletItem?.unit, resolvedPalletItem?.purchaseUnit);
  for (const [destinationLocationId, palletQuantity] of palletsByDestination) {
    if (palletQuantity <= 0) continue;
    const lineLocation = locationById.get(destinationLocationId) || defaultLocation;
    lines.push({
      item: { id: String(palletItemId) },
      quantity: palletQuantity,
      location: { id: String(lineLocation.netsuiteLocationId) },
      rate: palletRate,
      custcol_pcs: palletQuantity
    });
  }
  if (!lines.length) throw new Error("The Smart SCM PO has no confirmed line quantity.");
  const payload = {
    entity: { id: String(proposal.vendorId) },
    location: { id: String(defaultLocation.netsuiteLocationId) },
    memo: smartScmPurchaseOrderMemo({ proposal, materialLines, locations }),
    item: { items: lines }
  };
  if (defaultLocation.subsidiaryId) payload.subsidiary = { id: String(defaultLocation.subsidiaryId) };
  const employeeId = String(config.transferDependency.employeeId || "").trim();
  const deliveryMethodId = String(config.transferDependency.deliveryMethodId || "").trim();
  if (employeeId) payload.employee = { id: employeeId };
  if (deliveryMethodId) payload.custbody3 = { id: deliveryMethodId };
  return payload;
}
