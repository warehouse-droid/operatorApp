// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSalesOrderReattemptPreview,
  buildSalesOrderReattemptTargets
} from "../../../src/sales-order-reload.js";

function som05681Preview() {
  return buildSalesOrderReattemptPreview({
    sourceLoadRecordId: 836,
    historicalLines: [{
      lineId: "4760329",
      itemId: "3631",
      itemName: "UNI-WIN70T-RDM-CG",
      description: "Windermere Cliffside Grey",
      quantity: 1470.08,
      unit: "SQFT",
      loadedQty: 1470.08,
      loadedUom: "SQFT",
      packedPallets: 0,
      packedLayers: 0,
      packedSections: 0,
      packedPieces: 0
    }, {
      lineId: "4760330",
      itemId: "8472",
      itemName: "UNI-WIN70S-0714-DC-2026",
      description: "Windermere Dark Charcoal",
      quantity: 294,
      unit: "SQFT",
      loadedQty: 294,
      loadedUom: "SQFT",
      packedPallets: 0,
      packedLayers: 0,
      packedSections: 0,
      packedPieces: 0
    }],
    currentLines: [{
      id: 168936,
      line_id: 4760329,
      item_id: 3632,
      item_name: "UNI-WIN70T-RDM-GN",
      sku: "UNI-WIN70T-RDM-GN",
      item_description: "Windermere Granite Blend",
      quantity: 1470.08,
      unit: "SQFT",
      pallet_qty: 16,
      to_plt: 91.88,
      to_lyr: 10.21,
      item_weight: 32.02,
      netsuite_active: true
    }, {
      id: 168937,
      line_id: 4760330,
      item_id: 8472,
      item_name: "UNI-WIN70S-0714-DC-2026",
      sku: "UNI-WIN70S-0714-DC-2026",
      item_description: "Windermere Dark Charcoal",
      quantity: 294,
      unit: "SQFT",
      pallet_qty: 3,
      to_plt: 98,
      to_lyr: 12.25,
      item_weight: 32.00208,
      netsuite_active: true
    }],
    itemCatalog: [{
      item_id: 3631,
      item_name: "UNI-WIN70T-RDM-CG",
      item_description: "Windermere Cliffside Grey",
      stock_unit: "SQFT",
      to_plt: 91.88,
      to_lyr: 10.21,
      to_sec: 0,
      to_pcs: 0,
      item_weight: 32.02
    }, {
      item_id: 8472,
      item_name: "UNI-WIN70S-0714-DC-2026",
      item_description: "Windermere Dark Charcoal",
      stock_unit: "SQFT",
      to_plt: 98,
      to_lyr: 12.25,
      to_sec: 0,
      to_pcs: 0,
      item_weight: 32.00208
    }]
  });
}

test("Preview compares immutable historical and refreshed current lines", () => {
  const preview = som05681Preview();
  assert.equal(preview.sourceLoadRecordId, 836);
  assert.equal(preview.lines.length, 2);

  const changed = preview.lines[0];
  assert.equal(changed.historicalSku, "UNI-WIN70T-RDM-CG");
  assert.equal(changed.currentSku, "UNI-WIN70T-RDM-GN");
  assert.equal(changed.historicalLoadedSalesQty, 1470.08);
  assert.equal(changed.historicalPalletQty, 16);
  assert.equal(changed.currentSalesOrderLineId, 168936);
  assert.equal(changed.skuMismatch, true);
  assert.equal(changed.itemMismatch, true);
  assert.equal(changed.selectable, true);

  const unchanged = preview.lines[1];
  assert.equal(unchanged.historicalPalletQty, 3);
  assert.equal(unchanged.skuMismatch, false);
  assert.equal(unchanged.itemMismatch, false);
});

test("Selected 16-pallet line conserves selected and already-delivered quantities", () => {
  const preview = som05681Preview();
  const targets = buildSalesOrderReattemptTargets({
    preview,
    selections: [{
      lineKey: preview.lines[0].lineKey,
      palletQty: 16,
      reason: "Wrong colour must be delivered again"
    }, {
      lineKey: preview.lines[1].lineKey,
      palletQty: 0,
      reason: ""
    }]
  });

  assert.equal(targets.length, 2, "Unselected evidence must be retained for the delivered remainder.");
  assert.equal(targets[0].selectedForReattempt, true);
  assert.equal(targets[0].sku, "UNI-WIN70T-RDM-CG", "The child must retain the historical freight identity.");
  assert.equal(targets[0].targetPalletQty, 16);
  assert.equal(targets[0].targetSalesQty, 1470.08);
  assert.equal(targets[0].alreadyDeliveredPalletQty, 0);
  assert.equal(targets[0].alreadyDeliveredSalesQty, 0);
  assert.equal(targets[0].selectionReason, "Wrong colour must be delivered again");
  assert.equal(targets[0].itemWeight, 32.02);

  assert.equal(targets[1].selectedForReattempt, false);
  assert.equal(targets[1].targetPalletQty, 0);
  assert.equal(targets[1].targetSalesQty, 0);
  assert.equal(targets[1].alreadyDeliveredPalletQty, 3);
  assert.equal(targets[1].alreadyDeliveredSalesQty, 294);
});

test("Selected-line reason is mandatory and invalid quantities cannot create targets", () => {
  const preview = som05681Preview();
  const changed = preview.lines[0];

  assert.throws(
    () => buildSalesOrderReattemptTargets({
      preview,
      selections: [{ lineKey: changed.lineKey, palletQty: 1, reason: "   " }]
    }),
    (error) => error?.code === "REATTEMPT_LINE_REASON_REQUIRED"
  );
  for (const palletQty of [-1, Number.NaN, Number.POSITIVE_INFINITY, 16.00001]) {
    assert.throws(
      () => buildSalesOrderReattemptTargets({
        preview,
        selections: [{ lineKey: changed.lineKey, palletQty, reason: "Retry" }]
      }),
      (error) => error?.code === "REATTEMPT_QUANTITY_INVALID"
        || error?.code === "REATTEMPT_QUANTITY_EXCEEDED"
    );
  }
  assert.throws(
    () => buildSalesOrderReattemptTargets({
      preview,
      selections: preview.lines.map((line) => ({ lineKey: line.lineKey, palletQty: 0, reason: "" }))
    }),
    (error) => error?.code === "REATTEMPT_SELECTION_REQUIRED"
  );
  assert.throws(
    () => buildSalesOrderReattemptTargets({
      preview,
      selections: [{ lineKey: "another-order:0", palletQty: 1, reason: "Cross-order tamper" }]
    }),
    (error) => error?.code === "REATTEMPT_EVIDENCE_STALE"
  );
});

test("A historical line without an authoritative current mapping is visible but not selectable", () => {
  const preview = buildSalesOrderReattemptPreview({
    sourceLoadRecordId: 900,
    historicalLines: [{
      lineId: "111",
      itemId: "222",
      itemName: "HISTORICAL-SKU",
      loadedQty: 10,
      loadedUom: "EA"
    }],
    currentLines: [],
    itemCatalog: [{ item_id: 222, item_name: "HISTORICAL-SKU", stock_unit: "EA", to_pcs: 1 }]
  });
  assert.equal(preview.lines.length, 1);
  assert.equal(preview.lines[0].historicalSku, "HISTORICAL-SKU");
  assert.equal(preview.lines[0].currentSku, "");
  assert.equal(preview.lines[0].selectable, false);
  assert.throws(
    () => buildSalesOrderReattemptTargets({
      preview,
      selections: [{ lineKey: preview.lines[0].lineKey, pieceQty: 1, reason: "Retry" }]
    }),
    (error) => error?.code === "REATTEMPT_LINE_UNMAPPED"
  );
});

test("A legacy load without a line ID may map only to one unambiguous current item", () => {
  const historicalLine = {
    itemId: "222",
    itemName: "LEGACY-SKU",
    loadedQty: 10,
    loadedUom: "EA"
  };
  const currentLine = {
    id: 333,
    item_id: 222,
    item_name: "LEGACY-SKU",
    quantity: 10,
    unit: "EA",
    netsuite_active: true
  };
  const catalog = [{ item_id: 222, item_name: "LEGACY-SKU", stock_unit: "EA", to_pcs: 1 }];
  const preview = buildSalesOrderReattemptPreview({
    sourceLoadRecordId: 901,
    historicalLines: [historicalLine],
    currentLines: [currentLine],
    itemCatalog: catalog
  });
  assert.equal(preview.lines[0].currentSalesOrderLineId, 333);
  assert.equal(preview.lines[0].selectable, true);

  const [target] = buildSalesOrderReattemptTargets({
    preview,
    selections: [{ lineKey: preview.lines[0].lineKey, salesQty: 4, reason: "Legacy retry" }]
  });
  assert.equal(target.targetSalesQty, 4);
  assert.equal(target.alreadyDeliveredSalesQty, 6);

  assert.throws(
    () => buildSalesOrderReattemptTargets({
      preview,
      selections: [{ lineKey: preview.lines[0].lineKey, salesQty: 11, reason: "Too much" }]
    }),
    (error) => error?.code === "REATTEMPT_QUANTITY_EXCEEDED"
  );

  const ambiguous = buildSalesOrderReattemptPreview({
    sourceLoadRecordId: 902,
    historicalLines: [historicalLine],
    currentLines: [currentLine, { ...currentLine, id: 334 }],
    itemCatalog: catalog
  });
  assert.equal(ambiguous.lines[0].selectable, false);
});
