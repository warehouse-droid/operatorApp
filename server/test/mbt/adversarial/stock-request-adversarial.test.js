import assert from "node:assert/strict";
import test from "node:test";

import {
  groupStockRequestLinesForTransfer,
  normalizeStockRequestQuantity,
  selectStockRequestMarkerTransferOrder,
  stockRequestMemoMarker,
  stockRequestPalletQuantity
} from "../../../src/stock-request-domain.js";
import {
  buildStockRequestTransferPayload,
  canonicalStockRequestInventoryRows,
  confirmStockTransferWorkflow
} from "../../../src/stock-request-service.js";

const yards = [
  { netsuiteLocationId: 2001, localLocationId: 1, localLocationCode: "3445" },
  { netsuiteLocationId: 2028, localLocationId: 28, localLocationCode: "2967" },
  { netsuiteLocationId: 2015, localLocationId: 15, localLocationCode: "12441" },
  { netsuiteLocationId: 2026, localLocationId: 26, localLocationCode: "150" }
];

function transfer(overrides = {}) {
  return {
    id: 42,
    transferRef: "STTO-000042",
    sourceLocationId: 28,
    sourceName: "2967",
    destinationLocationId: 1,
    destinationName: "3445",
    palletItemId: 999,
    palletQuantity: 0,
    lines: [{ itemId: 10, salesQty: 1, pieces: 1 }],
    ...overrides
  };
}

test("hostile and incomplete quantity inputs fail closed with no implicit zero request", () => {
  assert.throws(
    () => normalizeStockRequestQuantity({}, { stockUnit: "EA", toPlt: 10 }),
    /positive quantity using/i
  );
  assert.throws(
    () => normalizeStockRequestQuantity({}, { stockUnit: "EA" }),
    /positive Sales quantity/i
  );
  assert.throws(
    () => normalizeStockRequestQuantity({ pieces: 1 }, { stockUnit: "EA", toPlt: 10 }),
    /PIECES is not available/i
  );
  assert.throws(
    () => normalizeStockRequestQuantity({ pallets: 1_000_000_000 }, { stockUnit: "EA", toPlt: 2 }),
    /converted Sales quantity/i
  );
});

test("hostile route, conversion-snapshot, and marker identities are rejected", () => {
  assert.throws(
    () => groupStockRequestLinesForTransfer([{ id: 1, sourceLocationId: 28, destinationLocationId: 28 }]),
    /different supported source and destination/i
  );
  assert.throws(
    () => stockRequestPalletQuantity([
      { itemId: 10, salesQty: 10, toPlt: 10 },
      { itemId: 10, salesQty: 10, toPlt: 20 }
    ]),
    (error) => error?.status === 409 && error?.code === "STOCK_REQUEST_CONVERSION_CONFLICT"
  );
  assert.throws(() => stockRequestMemoMarker(0), /valid local stock transfer ID/i);
  assert.throws(
    () => selectStockRequestMarkerTransferOrder([{ id: "bad" }], { transferId: 42 }),
    (error) => error?.status === 502 && error?.stockRequestAttention === true
  );
  assert.throws(
    () => selectStockRequestMarkerTransferOrder([
      { id: 910, source_location_id: 28, destination_location_id: 15 }
    ], { transferId: 42, sourceLocationId: 28, destinationLocationId: 1 }),
    /different.*destination/i
  );
});

test("malformed inventory and TO payload boundaries fail before any external write", () => {
  assert.throws(
    () => canonicalStockRequestInventoryRows([], yards.slice(0, 3), 10),
    /all four supported yards/i
  );
  assert.throws(
    () => canonicalStockRequestInventoryRows([], yards, 10),
    /no supported-yard inventory/i
  );
  assert.throws(() => buildStockRequestTransferPayload({ transfer: null, locations: null }), /required/i);
  assert.throws(
    () => buildStockRequestTransferPayload({ transfer: transfer({ lines: [] }), locations: { source: {}, destination: {} } }),
    /at least one material item/i
  );
  assert.throws(
    () => buildStockRequestTransferPayload({
      transfer: transfer({ palletItemId: null, palletQuantity: 1 }),
      locations: { source: { netsuiteLocationId: 2028, subsidiaryId: 2 }, destination: { netsuiteLocationId: 2001 } }
    }),
    /official PALLET item/i
  );
});

test("remote TO states that never reach Pending Fulfillment are recorded as attention", async () => {
  const failures = [];
  await assert.rejects(
    () => confirmStockTransferWorkflow({
      transfer: transfer({ netsuiteTransferOrderId: 920, netsuiteTransferOrderRef: "TO920" }),
      requestId: "adversarial-confirm",
      operatorId: "scm-user"
    }, {
      ensurePrinter: async () => {},
      resolveLocations: async () => ({
        source: { netsuiteLocationId: 2028, subsidiaryId: 2 },
        destination: { netsuiteLocationId: 2001, subsidiaryId: 2 },
        intercompany: false
      }),
      findRemoteByMarker: async () => [],
      createRemote: async () => assert.fail("existing remote ID must be reused"),
      recordRemote: async () => {},
      approveRemote: async () => {},
      hydrateRemote: async () => ({ id: 920, tranid: "TO920", pendingFulfillment: false }),
      recordApproved: async () => assert.fail("unsafe remote status must not be recorded as approved"),
      fetchTicket: async () => assert.fail("unsafe remote status must not print"),
      claimPrint: async () => assert.fail("unsafe remote status must not print"),
      queuePrint: async () => assert.fail("unsafe remote status must not print"),
      complete: async () => assert.fail("unsafe remote status must not complete"),
      fail: async (_id, failure) => failures.push(failure)
    }),
    /did not reach Pending Fulfillment/i
  );
  assert.equal(failures.length, 1);
  assert.equal(failures[0].remoteId, 920);
});
