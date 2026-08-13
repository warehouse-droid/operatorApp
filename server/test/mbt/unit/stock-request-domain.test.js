import assert from "node:assert/strict";
import test from "node:test";

import {
  STOCK_REQUEST_MAX_QUANTITY,
  STOCK_REQUEST_YARDS,
  assertStockRequestDestinationAccess,
  groupStockRequestLinesForTransfer,
  normalizeStockRequestListLimit,
  normalizeStockRequestQuantity,
  selectStockRequestMarkerTransferOrder,
  stockRequestAvailableQuantity,
  stockRequestBackorder,
  stockRequestBucket,
  stockRequestMemoMarker,
  stockRequestPalletQuantity,
  stockTransferQuantityRevisionBlock
} from "../../../src/stock-request-domain.js";

test("supported stock-request yards retain the four canonical NetSuite/local mappings", () => {
  assert.deepEqual(STOCK_REQUEST_YARDS, [
    { yardCode: "3445", locationId: 1 },
    { yardCode: "2967", locationId: 28 },
    { yardCode: "12441", locationId: 15 },
    { yardCode: "150", locationId: 26 }
  ]);
});

test("single and multi-yard Sales destinations are restricted to explicit account access", () => {
  assert.equal(assertStockRequestDestinationAccess(1, [1]), 1);
  assert.equal(assertStockRequestDestinationAccess(28, [1, 28]), 28);
  assert.throws(
    () => assertStockRequestDestinationAccess(15, [1, 28]),
    (error) => error?.status === 403 && /yard access/i.test(error.message)
  );
  assert.throws(
    () => assertStockRequestDestinationAccess("bad", [1]),
    (error) => error?.status === 400
  );
});

test("conversion quantities normalize to sales quantity without mixing input modes", () => {
  const item = { stockUnit: "EA", toPlt: 100, toLyr: 20, toSec: 5, toPcs: 1 };
  assert.deepEqual(
    normalizeStockRequestQuantity({ pallets: 1, layers: 2, sections: 3, pieces: 4 }, item),
    {
      pallets: 1,
      layers: 2,
      sections: 3,
      pieces: 4,
      salesQty: 159,
      salesUom: "EA",
      mode: "conversion"
    }
  );
  assert.throws(
    () => normalizeStockRequestQuantity({ pallets: 1, salesQty: 100 }, item),
    /either conversion fields or Sales quantity/i
  );
});

test("items without conversion require sales quantity and retain their Sales UOM", () => {
  assert.deepEqual(
    normalizeStockRequestQuantity(
      { salesQty: 12.5 },
      { stockUnit: "SQ FT", toPlt: null, toLyr: null, toSec: null, toPcs: null }
    ),
    {
      pallets: null,
      layers: null,
      sections: null,
      pieces: null,
      salesQty: 12.5,
      salesUom: "SQ FT",
      mode: "sales"
    }
  );
});

test("invalid quantities and a fractional layer are rejected", () => {
  const converted = { stockUnit: "EA", toPlt: 100, toLyr: 20, toSec: 5, toPcs: 1 };
  for (const salesQty of [0, -1, "not-a-number", Infinity, STOCK_REQUEST_MAX_QUANTITY + 1]) {
    assert.throws(
      () => normalizeStockRequestQuantity({ salesQty }, { stockUnit: "EA" }),
      /quantity/i
    );
  }
  assert.throws(
    () => normalizeStockRequestQuantity({ layers: 1.5 }, converted),
    /whole number/i
  );
});

test("requestable availability deducts active local reservations and never becomes negative", () => {
  assert.equal(stockRequestAvailableQuantity({ liveAvailable: 40, activeReserved: 13.5 }), 26.5);
  assert.equal(stockRequestAvailableQuantity({ liveAvailable: 4, activeReserved: 9 }), 0);
  assert.equal(stockRequestAvailableQuantity({ liveAvailable: "bad", activeReserved: 1 }), 0);
});

test("manual SCM demand reports the shortage as backorder without hiding physical availability", () => {
  assert.deepEqual(stockRequestBackorder({
    requestedQuantity: 10,
    liveAvailable: 1,
    activeReserved: 0
  }), {
    requestedQuantity: 10,
    requestableAvailable: 1,
    backorderQuantity: 9
  });
  assert.deepEqual(stockRequestBackorder({
    requestedQuantity: 10,
    liveAvailable: 1,
    activeReserved: 10,
    ownReserved: 10
  }), {
    requestedQuantity: 10,
    requestableAvailable: 1,
    backorderQuantity: 9
  });
});

test("converted lines group deterministically by independent source and destination pairs", () => {
  const groups = groupStockRequestLinesForTransfer([
    { id: 4, sourceLocationId: 28, destinationLocationId: 1 },
    { id: 2, sourceLocationId: 15, destinationLocationId: 1 },
    { id: 3, sourceLocationId: 28, destinationLocationId: 1 },
    { id: 9, sourceLocationId: 28, destinationLocationId: 26 }
  ]);
  assert.deepEqual(groups.map((group) => ({
    key: group.key,
    lineIds: group.lines.map((line) => line.id)
  })), [
    { key: "15:1", lineIds: [2] },
    { key: "28:1", lineIds: [3, 4] },
    { key: "28:26", lineIds: [9] }
  ]);
});

test("PALLET quantity is one per full pallet plus one per SKU loose remainder", () => {
  assert.deepEqual(stockRequestPalletQuantity([
    { itemId: 10, salesQty: 250, toPlt: 100 },
    { itemId: 11, salesQty: 40, toPlt: 40 },
    { itemId: 10, salesQty: 25, toPlt: 100 }
  ]), { automaticQuantity: 4, requiresManualQuantity: false });
  assert.deepEqual(stockRequestPalletQuantity([
    { itemId: 10, salesQty: 100, toPlt: 100 },
    { itemId: 12, salesQty: 7, toPlt: null }
  ]), { automaticQuantity: 1, requiresManualQuantity: true });
});

test("Sales buckets keep driver completion accepted until NetSuite receipt is terminal", () => {
  assert.equal(stockRequestBucket({ lines: [{ status: "submitted" }] }), "pending");
  assert.equal(stockRequestBucket({ lines: [{ status: "converted", driverCompleted: true }] }), "accepted");
  assert.equal(stockRequestBucket({ lines: [{ status: "received" }, { status: "rejected" }] }), "completed");
  assert.equal(stockRequestBucket({ lines: [{ status: "cancelled" }] }), "completed");
  assert.equal(stockRequestBucket({ lines: [{ status: "closed" }] }), "completed");
});

test("unsafe NetSuite lifecycle states block TO quantity revision", () => {
  assert.equal(stockTransferQuantityRevisionBlock({ status: "pendingFulfillment" }), null);
  for (const status of ["partiallyFulfilled", "pendingReceipt", "received", "closed", "cancelled"]) {
    assert.match(stockTransferQuantityRevisionBlock({ status }), /cannot be revised/i);
  }
  assert.match(stockTransferQuantityRevisionBlock({ status: "pendingFulfillment", fulfilledQty: 1 }), /fulfilled/i);
});

test("stable memo markers recover one matching NetSuite TO and reject duplicates or wrong routes", () => {
  assert.equal(stockRequestMemoMarker(42), "MBBS-STOCK-REQUEST-TO:42");
  assert.deepEqual(selectStockRequestMarkerTransferOrder([
    { id: "910", tranid: "TO910", source_location_id: 28, destination_location_id: 1 }
  ], { transferId: 42, sourceLocationId: 28, destinationLocationId: 1 }), {
    id: 910,
    tranid: "TO910",
    source_location_id: 28,
    destination_location_id: 1
  });
  assert.throws(
    () => selectStockRequestMarkerTransferOrder([{ id: 1 }, { id: 2 }], { transferId: 42 }),
    /more than one/i
  );
  assert.throws(
    () => selectStockRequestMarkerTransferOrder([
      { id: 910, source_location_id: 15, destination_location_id: 1 }
    ], { transferId: 42, sourceLocationId: 28, destinationLocationId: 1 }),
    /different.*source/i
  );
});

test("search and list limits are bounded", () => {
  assert.equal(normalizeStockRequestListLimit(undefined), 40);
  assert.equal(normalizeStockRequestListLimit(0), 1);
  assert.equal(normalizeStockRequestListLimit(5000), 100);
  assert.equal(normalizeStockRequestListLimit(25), 25);
});
