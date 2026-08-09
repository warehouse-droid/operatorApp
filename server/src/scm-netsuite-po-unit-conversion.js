const QUANTITY_PRECISION = 6;

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function positive(value) {
  return Math.max(0, number(value));
}

function roundQuantity(value) {
  return Number(number(value).toFixed(QUANTITY_PRECISION));
}

function lineValue(line, camel, snake) {
  return line?.[camel] ?? line?.[snake];
}

function ancillaryPalletLine(line = {}) {
  return line.ancillaryPallet === true
    || String(lineValue(line, "itemName", "item_name") || "").trim().toUpperCase() === "PALLET";
}

export function describePurchaseOrderLinePallets(line = {}) {
  const nativeQuantity = roundQuantity(positive(line.quantity));
  const nativeUnit = String(line.unit || "").trim() || "UNIT";
  if (ancillaryPalletLine(line)) {
    return {
      ancillaryPallet: true,
      palletEditable: true,
      palletQuantity: nativeQuantity,
      nativeQuantity,
      nativeUnit,
      unitsPerPallet: 1,
      conversionSource: "pallet_item",
      updatePalletColumn: false
    };
  }

  const reportedPallets = positive(lineValue(line, "palletQuantity", "pallet_qty"));
  const configuredUnits = positive(lineValue(line, "toPlt", "to_plt"));
  const ratioUnits = reportedPallets > 0 && nativeQuantity > 0
    ? nativeQuantity / reportedPallets
    : 0;
  const unitsPerPallet = configuredUnits > 0 ? configuredUnits : ratioUnits;
  const palletQuantity = reportedPallets > 0
    ? reportedPallets
    : unitsPerPallet > 0 && nativeQuantity > 0
      ? nativeQuantity / unitsPerPallet
      : null;
  return {
    ancillaryPallet: false,
    palletEditable: unitsPerPallet > 0 && palletQuantity !== null,
    palletQuantity: palletQuantity === null ? null : roundQuantity(palletQuantity),
    nativeQuantity,
    nativeUnit,
    unitsPerPallet: unitsPerPallet > 0 ? roundQuantity(unitsPerPallet) : null,
    conversionSource: configuredUnits > 0 ? "item_conversion" : ratioUnits > 0 ? "line_ratio" : "unavailable",
    updatePalletColumn: true
  };
}

export function convertPurchaseOrderPalletQuantity(line = {}, value) {
  const palletQuantity = number(value);
  if (!Number.isFinite(palletQuantity) || palletQuantity <= 0) {
    throw Object.assign(new Error("PLT quantity must be a positive number."), { status: 400 });
  }
  const conversion = describePurchaseOrderLinePallets(line);
  if (!conversion.palletEditable || !conversion.unitsPerPallet) {
    throw Object.assign(new Error("This purchase-order line has no reliable PLT conversion."), { status: 409 });
  }
  const nativeQuantity = roundQuantity(palletQuantity * conversion.unitsPerPallet);
  if (!Number.isFinite(nativeQuantity) || nativeQuantity <= 0) {
    throw Object.assign(new Error("The calculated native purchase quantity is invalid."), { status: 400 });
  }
  return {
    palletQuantity: roundQuantity(palletQuantity),
    nativeQuantity,
    updatePalletColumn: conversion.updatePalletColumn
  };
}
