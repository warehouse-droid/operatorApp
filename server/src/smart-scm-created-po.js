import { describePurchaseOrderLinePallets } from "./scm-netsuite-po-unit-conversion.js";
import { overlaySmartScmVendorPoFinancials } from "./smart-scm-vendor-po-financials.js";
import { smartScmLineKey, smartScmNetSuiteLineSequence } from "./smart-scm-line-order.js";

function optionalNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function totalWeight(lines) {
  return lines.some((line) => line.lineWeightLbs === null) ? null
    : Number(lines.reduce((total, line) => total + line.lineWeightLbs, 0).toFixed(6));
}

function currentLine(row) {
  const conversion = describePurchaseOrderLinePallets(row);
  const weight = optionalNumber(row.item_weight);
  return {
    id: `netsuite-po-line:${row.line_id}`,
    netsuitePurchaseOrderLineId: Number(row.line_id),
    itemId: Number(row.item_id),
    itemName: row.item_name || "",
    itemDescription: row.item_description || "",
    destinationLocationId: optionalNumber(row.location_id),
    destinationName: row.location || "",
    unit: row.unit || "",
    purchaseUnit: row.unit || "",
    quantity: conversion.nativeQuantity,
    salesQuantity: conversion.nativeQuantity,
    purchaseQuantity: conversion.nativeQuantity,
    proposedPallets: conversion.palletQuantity,
    confirmedPallets: conversion.palletQuantity,
    toPlt: conversion.unitsPerPallet,
    lastPurchasePrice: optionalNumber(row.rate),
    purchaseAmount: optionalNumber(row.amount),
    unitPriceSource: "netsuite_po_rate",
    lastPurchasePriceSyncedAt: row.synced_at || null,
    itemWeightLbs: weight,
    palletWeightLbs: weight === null ? null : weight * Number(conversion.unitsPerPallet || 0),
    lineWeightLbs: weight === null ? null : weight * conversion.nativeQuantity,
    netsuiteClosed: row.netsuite_closed === true,
    receivedQuantity: Number(row.netsuite_received_qty || 0),
    ancillaryPallet: conversion.ancillaryPallet,
    officialLineItem: conversion.ancillaryPallet,
    automaticQuantity: conversion.nativeQuantity,
    currentPurchaseOrder: true
  };
}

// The saved proposal is creation evidence. A created PO is displayed from its
// full canonical line set, including replacements and NetSuite-only additions.
export function projectSmartScmCreatedPo(proposal, current) {
  if (!current?.header) return proposal;
  const { header } = current;
  const originalLines = [...proposal.lines, ...(proposal.physicalPalletLines || [])];
  const evidenceLines = proposal.currentPurchaseOrder ? originalLines : overlaySmartScmVendorPoFinancials({
    lines: originalLines, purchaseOrderLines: current.lines
  });
  const evidence = new Map(evidenceLines.filter((line) => line.netsuitePurchaseOrderLineId)
    .map((line) => [line.netsuitePurchaseOrderLineId, line]));
  const allLines = (current.lines || []).filter((line) => line.netsuite_active !== false)
    .slice().sort((left, right) => (smartScmNetSuiteLineSequence(left) ?? Infinity)
      - (smartScmNetSuiteLineSequence(right) ?? Infinity)).map((row) => {
    const line = currentLine(row);
    const confirmed = evidence.get(line.netsuitePurchaseOrderLineId);
    return {
      ...line,
      vendorReplyConfirmedUnitPrice: confirmed?.vendorReplyConfirmedUnitPrice ?? null,
      vendorReplyConfirmedAmount: confirmed?.vendorReplyConfirmedAmount ?? null,
      priceChangedSinceVendorReply: confirmed?.priceChangedSinceVendorReply ?? false
    };
  });
  const lines = allLines.filter((line) => !line.ancillaryPallet);
  const physicalPalletLines = allLines.filter((line) => line.ancillaryPallet);
  const destinations = [...new Set(allLines.map((line) => line.destinationName).filter(Boolean))];
  const totalWeightLbs = totalWeight(allLines);
  const capacity = optionalNumber(header.truck_capacity_lbs);
  return {
    ...proposal,
    lines,
    physicalPalletLines,
    lineOrder: allLines.map(smartScmLineKey),
    currentPurchaseOrder: true,
    purchaseOrderHistoryId: optionalNumber(header.history_id),
    purchaseOrderSyncedAt: header.last_synced_at || header.synced_at || null,
    purchaseOrderSyncError: header.last_sync_error || "",
    netsuiteStatus: header.status_text || header.status || "",
    vendor: header.vendor || "",
    vendorReference: header.vendor_reference || "",
    vendorReadyDate: header.expected_delivery_date || null,
    memo: header.memo || "",
    destinationName: destinations.join(", "),
    destinationLocationId: destinations.length === 1 ? allLines[0]?.destinationLocationId : null,
    totalPallets: lines.some((line) => line.confirmedPallets === null) ? null
      : Number(lines.reduce((total, line) => total + line.confirmedPallets, 0).toFixed(6)),
    materialWeightLbs: totalWeight(lines),
    physicalPalletWeightLbs: totalWeight(physicalPalletLines),
    totalWeightLbs,
    utilization: capacity > 0 && totalWeightLbs !== null ? totalWeightLbs / capacity : null
  };
}
