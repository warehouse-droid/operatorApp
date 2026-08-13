import assert from "node:assert/strict";
import test from "node:test";

import { overlaySmartScmVendorPoFinancials } from "../../../src/smart-scm-vendor-po-financials.js";

const reviewLine = {
  id: 107560,
  itemId: 1259,
  itemName: "BWS-DC-CHAR",
  destinationLocationId: 1,
  purchaseUnit: "PC",
  purchaseQuantity: 200,
  lastPurchasePrice: 10.66625,
  purchaseAmount: 2133.25,
  unitPriceSource: "saved_load",
  lastPurchasePriceSyncedAt: "2026-08-11T13:06:50.051Z"
};

test("a linked NetSuite PO rate becomes the displayed Vendor Reply rate without erasing confirmation evidence", () => {
  const [displayed] = overlaySmartScmVendorPoFinancials({
    lines: [reviewLine],
    purchaseOrderLines: [{
      lineId: 4766206,
      itemId: 1259,
      locationId: 1,
      unit: "PC",
      quantity: 200,
      rate: 12.6,
      amount: 2520,
      netsuiteActive: true,
      syncedAt: "2026-08-12T01:02:03.000Z"
    }]
  });

  assert.equal(displayed.lastPurchasePrice, 12.6);
  assert.equal(displayed.purchaseAmount, 2520);
  assert.equal(displayed.unitPriceSource, "netsuite_po_rate");
  assert.equal(displayed.lastPurchasePriceSyncedAt, "2026-08-12T01:02:03.000Z");
  assert.equal(displayed.vendorReplyConfirmedUnitPrice, 10.66625);
  assert.equal(displayed.vendorReplyConfirmedAmount, 2133.25);
  assert.equal(displayed.netsuitePurchaseOrderLineId, 4766206);
  assert.equal(displayed.priceChangedSinceVendorReply, true);
  assert.equal(reviewLine.lastPurchasePrice, 10.66625, "the saved review object remains immutable");
});

test("a later NetSuite edit replaces the previously displayed linked-PO price", () => {
  const current = overlaySmartScmVendorPoFinancials({
    lines: [reviewLine],
    purchaseOrderLines: [{
      lineId: 4766206,
      itemId: 1259,
      locationId: 1,
      unit: "PC",
      quantity: 200,
      rate: 13.25,
      amount: 2650,
      syncedAt: "2026-08-12T02:00:00.000Z"
    }]
  });

  assert.equal(current[0].lastPurchasePrice, 13.25);
  assert.equal(current[0].purchaseAmount, 2650);
  assert.equal(current[0].priceChangedSinceVendorReply, true);
});

test("financial matching requires exact NetSuite item and yard identity, never item name alone", () => {
  const invalidIdentityLines = [{
      lineId: 99,
      itemId: 9999,
      itemName: "BWS-DC-CHAR",
      locationId: 1,
      unit: "PC",
      quantity: 200,
      rate: 99,
      amount: 19800,
      syncedAt: "2026-08-12T02:00:00.000Z"
    }, {
      lineId: 100,
      itemId: 1259,
      itemName: "BWS-DC-CHAR",
      locationId: 15,
      unit: "PC",
      quantity: 200,
      rate: 88,
      amount: 17600,
      syncedAt: "2026-08-12T02:00:00.000Z"
    }];

  for (const purchaseOrderLine of invalidIdentityLines) {
    const [unchanged] = overlaySmartScmVendorPoFinancials({
      lines: [reviewLine],
      purchaseOrderLines: [purchaseOrderLine]
    });
    assert.deepEqual(unchanged, reviewLine);
  }
});

test("blank, inactive, unit-mismatched, or ambiguous PO rates cannot overwrite audit pricing", () => {
  for (const purchaseOrderLines of [
    [{ itemId: 1259, locationId: 1, unit: "PC", rate: null }],
    [{ itemId: 1259, locationId: 1, unit: "PC", rate: "not-a-rate" }],
    [{ itemId: 1259, locationId: 1, unit: "PC", rate: 12.6, netsuiteActive: false }],
    [{ itemId: 1259, locationId: 1, unit: "CASE", rate: 12.6 }],
    [
      { lineId: 1, itemId: 1259, locationId: 1, unit: "PC", quantity: 200, rate: 12.6 },
      { lineId: 2, itemId: 1259, locationId: 1, unit: "PC", quantity: 200, rate: 13.25 }
    ]
  ]) {
    assert.deepEqual(overlaySmartScmVendorPoFinancials({ lines: [reviewLine], purchaseOrderLines })[0], reviewLine);
  }
});

test("a unique quantity match disambiguates duplicate item-yard PO lines and amount falls back safely", () => {
  const [displayed] = overlaySmartScmVendorPoFinancials({
    lines: [reviewLine],
    purchaseOrderLines: [
      { lineId: 1, itemId: 1259, locationId: 1, unit: "PC", quantity: 5, rate: 99, amount: 495 },
      { lineId: 2, itemId: 1259, locationId: 1, unit: "PC", quantity: 200, rate: 12.6, amount: null }
    ]
  });

  assert.equal(displayed.lastPurchasePrice, 12.6);
  assert.equal(displayed.purchaseAmount, 2520);
  assert.equal(displayed.netsuitePurchaseOrderLineId, 2);
});

test("defensive empty input returns an empty line collection", () => {
  assert.deepEqual(overlaySmartScmVendorPoFinancials(), []);
  assert.deepEqual(overlaySmartScmVendorPoFinancials({ lines: null, purchaseOrderLines: null }), []);
});

test("all persisted identity aliases and unit spellings match without inventing audit values", () => {
  const cases = [
    {
      line: {
        item_id: 1259,
        destination_location_id: 1,
        purchase_unit: "EA",
        purchase_quantity: 4,
        last_purchase_price: 12.6,
        purchase_amount: 50.4
      },
      po: {
        line_id: 41,
        item_id: 1259,
        location_id: 1,
        unit: "each",
        quantity: 4,
        rate: -12.6,
        amount: -50.4,
        netsuite_active: true,
        synced_at: "2026-08-12T03:00:00.000Z"
      },
      expectedId: 41,
      expectedQuantity: 4,
      expectedAmount: 50.4,
      changed: false
    },
    {
      line: {
        item_id: 1259,
        locationId: 1,
        unit: "square feet",
        salesQuantity: 2
      },
      po: {
        id: 42,
        item_id: 1259,
        location_id: 1,
        unit: "SQFT",
        quantity: null,
        rate: 3.333,
        amount: null
      },
      expectedId: 42,
      expectedQuantity: null,
      expectedAmount: 6.67,
      changed: true
    },
    {
      line: {
        itemId: 1259,
        location_id: 1,
        sales_quantity: 3
      },
      po: {
        lineId: 43,
        itemId: 1259,
        locationId: 1,
        quantity: null,
        rate: 2,
        amount: null
      },
      expectedId: 43,
      expectedQuantity: null,
      expectedAmount: 6,
      changed: true
    },
    {
      line: { itemId: 1259, destinationLocationId: 1 },
      po: { lineId: 44, itemId: 1259, locationId: 1, unit: "PC", rate: 2, amount: null },
      expectedId: 44,
      expectedQuantity: null,
      expectedAmount: 0,
      changed: true
    }
  ];

  for (const entry of cases) {
    const [displayed] = overlaySmartScmVendorPoFinancials({ lines: [entry.line], purchaseOrderLines: [entry.po] });
    assert.equal(displayed.netsuitePurchaseOrderLineId, entry.expectedId);
    assert.equal(displayed.netsuitePurchaseQuantity, entry.expectedQuantity);
    assert.equal(displayed.purchaseAmount, entry.expectedAmount);
    assert.equal(displayed.priceChangedSinceVendorReply, entry.changed);
  }
});

test("invalid identities, candidates, rates, and missing duplicate quantities fail closed", () => {
  const lines = [
    { itemId: 0, destinationLocationId: 1, purchaseUnit: "PC", purchaseQuantity: 2 },
    { itemId: 1259, destinationLocationId: -1, purchaseUnit: "PC", purchaseQuantity: 2 }
  ];
  const invalidCandidates = [
    null,
    "not-a-line",
    { itemId: 1259, locationId: 1, unit: "PC", rate: "not-a-number" },
    { itemId: 1259, locationId: 1, unit: "PC", rate: 12.6, netsuite_active: false }
  ];
  assert.deepEqual(
    overlaySmartScmVendorPoFinancials({ lines, purchaseOrderLines: invalidCandidates }),
    lines
  );

  const noQuantity = { itemId: 1259, destinationLocationId: 1, purchaseUnit: "PCS" };
  assert.deepEqual(overlaySmartScmVendorPoFinancials({
    lines: [noQuantity],
    purchaseOrderLines: [
      { lineId: 1, itemId: 1259, locationId: 1, unit: "PIECE", quantity: 1, rate: 1 },
      { lineId: 2, itemId: 1259, locationId: 1, unit: "PIECES", quantity: 2, rate: 2 }
    ]
  })[0], noQuantity);
});
