import assert from "node:assert/strict";
import { closeDb } from "./db.js";
import { buildSmartScmPurchaseOrderRestPayload, smartScmPurchaseOrderMemoMarker } from "./smart-scm-purchase-netsuite.js";
import {
  selectSmartScmMarkerPurchaseOrder,
  smartScmNetSuiteCreateFailureIsAmbiguous
} from "./smart-scm-purchase-service.js";
import { normalizeSmartScmVendorDecision } from "./smart-scm-vendor-repository.js";
import { selectSmartScmMarkerTransferOrder, smartScmTransferOrderMemoMarker } from "./transfer-dependency-netsuite.js";

try {
  const sourceLine = { id: 71, proposedPallets: 6 };
  assert.deepEqual(normalizeSmartScmVendorDecision(sourceLine, { decision: "confirm" }), {
    decision: "confirm",
    proposalLineId: 71,
    requestedPallets: 6,
    decisionPallets: 6,
    heldPallets: 0,
    remainderPallets: 0,
    responseStatus: "confirmed",
    confirmedPallets: 6,
    unavailablePallets: 0
  });
  const defaultHold = normalizeSmartScmVendorDecision(sourceLine, { decision: "hold" });
  assert.equal(defaultHold.responseStatus, "awaiting");
  assert.equal(defaultHold.confirmedPallets, 0);
  assert.equal(defaultHold.heldPallets, 6);
  assert.equal(defaultHold.decisionPallets, 6);
  const partialHold = normalizeSmartScmVendorDecision(sourceLine, { decision: "hold", decisionPallets: 2.5 });
  assert.equal(partialHold.heldPallets, 2.5);
  assert.equal(partialHold.remainderPallets, 3.5);
  assert.throws(
    () => normalizeSmartScmVendorDecision(sourceLine, { decision: "hold", decisionPallets: 0 }),
    /greater than zero/
  );
  assert.throws(
    () => normalizeSmartScmVendorDecision(sourceLine, { decision: "hold", decisionPallets: 7 }),
    /cannot exceed/
  );
  assert.equal(normalizeSmartScmVendorDecision(sourceLine, { decision: "hold", decisionPallets: 6.0000005 }).decisionPallets, 6);
  assert.equal(normalizeSmartScmVendorDecision({ ...sourceLine, residualPallets: 4 }, { decision: "hold" }).decisionPallets, 4);
  assert.equal(normalizeSmartScmVendorDecision(sourceLine, { decision: "cancel" }).responseStatus, "cancelled");
  assert.equal(normalizeSmartScmVendorDecision(sourceLine, { decision: "cancel" }).confirmedPallets, 0);
  assert.equal(normalizeSmartScmVendorDecision(sourceLine, { decision: "confirm", confirmedPallets: 2 }).responseStatus, "partial");

  assert.equal(selectSmartScmMarkerPurchaseOrder([], { proposalId: 501 }), null);
  assert.equal(selectSmartScmMarkerPurchaseOrder([{ id: "901", tranid: "PO901", vendor_id: "77" }], {
    proposalId: 501,
    vendorId: 77
  }).id, 901);
  assert.throws(
    () => selectSmartScmMarkerPurchaseOrder([{ id: 901 }, { id: 902 }], { proposalId: 501 }),
    (error) => error.smartScmAttention === true
  );
  assert.throws(
    () => selectSmartScmMarkerPurchaseOrder([{ id: 901, vendor_id: 88 }], { proposalId: 501, vendorId: 77 }),
    /different NetSuite vendor/
  );
  assert.equal(smartScmNetSuiteCreateFailureIsAmbiguous(new Error("network timeout")), true);
  assert.equal(smartScmNetSuiteCreateFailureIsAmbiguous(Object.assign(new Error("upstream failed"), { status: 503 })), true);
  assert.equal(smartScmNetSuiteCreateFailureIsAmbiguous(Object.assign(new Error("request rejected"), { status: 400 })), false);
  assert.equal(smartScmTransferOrderMemoMarker(601), "MBBS-SCM:601");
  assert.equal(selectSmartScmMarkerTransferOrder([], { proposalId: 601 }), null);
  assert.equal(selectSmartScmMarkerTransferOrder([{
    id: "9901",
    tranid: "TOB09901",
    source_location_id: "101",
    destination_location_id: "128"
  }], {
    proposalId: 601,
    sourceLocationId: 101,
    destinationLocationId: 128
  }).id, 9901);
  assert.throws(
    () => selectSmartScmMarkerTransferOrder([{ id: 9901 }, { id: 9902 }], { proposalId: 601 }),
    (error) => error.smartScmAttention === true
  );
  assert.throws(
    () => selectSmartScmMarkerTransferOrder([{
      id: 9901,
      source_location_id: 102,
      destination_location_id: 128
    }], {
      proposalId: 601,
      sourceLocationId: 101,
      destinationLocationId: 128
    }),
    /different NetSuite source location/
  );

  const proposal = {
    id: 501,
    parentProposalId: 401,
    vendorId: 77,
    destinationLocationId: 15,
    destinationName: "12441",
    readyDate: "2026-08-15",
    memo: "Harness staged PO",
    vendorReference: "V-501",
    palletItem: {
      id: 999,
      itemName: "PALLET",
      unit: "Each",
      purchaseUnit: "Each",
      lastPurchasePrice: 4.25
    },
    lines: [
      { itemId: 601, itemName: "A", unit: "Each", purchaseUnit: "Each", lastPurchasePrice: 11.5, destinationLocationId: 15, destinationName: "12441", salesQuantity: 40, confirmedPallets: 1, palletQty: 1, layerQty: null, sectionQty: undefined, pieceQty: "" },
      { itemId: 602, itemName: "B", unit: "Each", purchaseUnit: "Each", lastPurchasePrice: 3.75, destinationLocationId: 15, destinationName: "12441", salesQuantity: 80, confirmedPallets: 2, palletQty: 2 },
      { itemId: 603, itemName: "C", unit: "Each", purchaseUnit: "Each", lastPurchasePrice: 9, destinationLocationId: 26, destinationName: "150", salesQuantity: 12, confirmedPallets: 0.5, palletQty: 0.5 },
      { itemId: 999, itemName: "PALLET", unit: "Each", purchaseUnit: "Each", lastPurchasePrice: 4.25, destinationLocationId: 15, salesQuantity: 3.5, confirmedPallets: 3.5, ancillaryPallet: true }
    ]
  };
  const locations = [
    { locationId: 15, netsuiteLocationId: 115, subsidiaryId: 2 },
    { locationId: 26, netsuiteLocationId: 126, subsidiaryId: 2 }
  ];
  const payload = buildSmartScmPurchaseOrderRestPayload({ proposal, locations });
  assert.equal(smartScmPurchaseOrderMemoMarker(501), "MBBS-SCM-PO:501");
  assert.match(payload.memo, /MBBS-SCM-PO:501/);
  assert.match(payload.memo, /Date: 2026-08-15/);
  assert.match(payload.memo, /Yard: 12441, 150/);
  assert.match(payload.memo, /Load #401/);
  assert.equal(payload.item.items.length, 5);
  assert.deepEqual(payload.item.items.slice(0, 3).map((line) => line.rate), [11.5, 3.75, 9]);
  for (const materialLine of payload.item.items.slice(0, 3)) {
    assert.equal(Object.hasOwn(materialLine, "custcol_lyr"), false,
      "An empty LYR value must be omitted from the NetSuite request, not converted to 0.");
    assert.equal(Object.hasOwn(materialLine, "custcol_sec"), false,
      "An empty SEC value must be omitted from the NetSuite request, not converted to 0.");
    assert.equal(Object.hasOwn(materialLine, "custcol_pcs"), false,
      "An empty PCS value must be omitted from the NetSuite request, not converted to 0.");
  }
  const palletLines = payload.item.items.filter((line) => line.item.id === "999");
  assert.equal(palletLines.length, 2);
  assert.deepEqual(palletLines.map((line) => [line.location.id, line.quantity, line.custcol_pcs, line.rate]), [
    ["115", 3, 3, 4.25],
    ["126", 0.5, 0.5, 4.25]
  ]);
  assert(palletLines.every((line) => !Object.hasOwn(line, "custcol_plt")
    && !Object.hasOwn(line, "custcol_lyr")
    && !Object.hasOwn(line, "custcol_sec")),
  "Official PALLET rows must leave unrelated PLT/LYR/SEC fields blank while retaining their meaningful PCS quantity.");

  const overridden = structuredClone(proposal);
  overridden.palletLines = [
    { itemId: 999, itemName: "PALLET", destinationLocationId: 15, purchaseQuantity: 1.25, ancillaryPallet: true },
    { itemId: 999, itemName: "PALLET", destinationLocationId: 26, purchaseQuantity: 0, ancillaryPallet: true }
  ];
  const overriddenPayload = buildSmartScmPurchaseOrderRestPayload({ proposal: overridden, locations });
  assert.deepEqual(
    overriddenPayload.item.items.filter((line) => line.item.id === "999").map((line) => [line.location.id, line.quantity]),
    [["115", 1.25]],
    "A saved manual PALLET override must replace automatic regeneration, while explicit zero omits that destination."
  );
  assert.equal(overriddenPayload.item.items.length, 4, "Visible PALLET material rows must still be filtered from the final payload.");

  const zeroOverride = structuredClone(proposal);
  zeroOverride.palletLines = [
    { itemId: 999, itemName: "PALLET", destinationLocationId: 15, purchaseQuantity: 0, ancillaryPallet: true },
    { itemId: 999, itemName: "PALLET", destinationLocationId: 26, purchaseQuantity: 0, ancillaryPallet: true }
  ];
  zeroOverride.palletItem = { id: null, itemName: "PALLET", unit: null, purchaseUnit: null, lastPurchasePrice: null };
  const zeroPayload = buildSmartScmPurchaseOrderRestPayload({ proposal: zeroOverride, locations });
  assert.equal(zeroPayload.item.items.length, 3);
  assert.equal(zeroPayload.item.items.filter((line) => line.item.id === "999").length, 0);

  const directOverride = structuredClone(proposal);
  directOverride.palletQuantityOverrides = { 15: 2.75, 26: 0 };
  const directOverridePayload = buildSmartScmPurchaseOrderRestPayload({ proposal: directOverride, locations });
  assert.deepEqual(
    directOverridePayload.item.items.filter((line) => line.item.id === "999").map((line) => [line.location.id, line.quantity]),
    [["115", 2.75]],
    "A persisted override map must also be honored when a caller has not projected palletLines."
  );

  const missingPrice = structuredClone(proposal);
  missingPrice.lines[0].lastPurchasePrice = null;
  assert.throws(() => buildSmartScmPurchaseOrderRestPayload({ proposal: missingPrice, locations }), /positive Last Purchase Price/);
  const mismatchedUnit = structuredClone(proposal);
  assert.equal(payload.item.items.filter((line) => line.item.id === "999").length, 2, "Visible Official PALLET rows must not duplicate the one derived payload line per destination.");
  mismatchedUnit.lines[0].purchaseUnit = "Case";
  assert.throws(() => buildSmartScmPurchaseOrderRestPayload({ proposal: mismatchedUnit, locations }), /does not match purchase unit/);

  console.log(JSON.stringify({ ok: true, materialLines: 3, automaticPalletLines: 2, manualOverride: 1.25, zeroOverride: true, exactlyOnce: true, poMarkerRecoveryCovered: true, toMarkerRecoveryCovered: true }));
} finally {
  await closeDb();
}
