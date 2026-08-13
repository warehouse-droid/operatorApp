import assert from "node:assert/strict";
import test from "node:test";

import {
  buildStockRequestTransferPayload,
  canonicalStockRequestInventoryRows,
  confirmAndPrintStockTransfer,
  confirmStockTransferWorkflow,
  convertStockRequestLines,
  hydrateStockRequestTransfer,
  queueStockRequestTicket,
  refreshStockRequestItemAvailability,
  refreshStockRequestItemsAvailability,
  reprintStockTransfer,
  requireStockRequestPrinter,
  reviseStockTransfer,
  stockRequestPrintJobKey,
  stockRequestTransferLocationInput
} from "../../../src/stock-request-service.js";

function transferFixture(overrides = {}) {
  return {
    id: 42,
    transferRef: "STTO-000042",
    sourceLocationId: 28,
    sourceName: "2967",
    destinationLocationId: 1,
    destinationName: "3445",
    palletItemId: 999,
    palletItemName: "PALLET",
    palletQuantity: 3,
    lines: [
      { itemId: 10, itemName: "A", salesQty: 120, pallets: 1, layers: 1, sections: 0, pieces: 0 },
      { itemId: 10, itemName: "A", salesQty: 5, pallets: 0, layers: 0, sections: 1, pieces: 0 },
      { itemId: 11, itemName: "B", salesQty: 8, pallets: null, layers: null, sections: null, pieces: null }
    ],
    ...overrides
  };
}

const locations = {
  source: { netsuiteLocationId: 2028, subsidiaryId: 2 },
  destination: { netsuiteLocationId: 2001, subsidiaryId: 2 },
  intercompany: false
};

const yards = [
  { netsuiteLocationId: 2001, localLocationId: 1, localLocationCode: "3445" },
  { netsuiteLocationId: 2028, localLocationId: 28, localLocationCode: "2967" },
  { netsuiteLocationId: 2015, localLocationId: 15, localLocationCode: "12441" },
  { netsuiteLocationId: 2026, localLocationId: 26, localLocationCode: "150" }
];

test("NetSuite TO payload aggregates duplicate item lines and adds the official PALLET item", () => {
  const payload = buildStockRequestTransferPayload({ transfer: transferFixture(), locations });
  assert.equal(payload.location.id, "2028");
  assert.equal(payload.transferLocation.id, "2001");
  assert.match(payload.memo, /MBBS-STOCK-REQUEST-TO:42/);
  assert.deepEqual(payload.item.items, [
    { item: { id: "10" }, quantity: 125, custcol_plt: 1, custcol_lyr: 1, custcol_sec: 1, custcol_pcs: 0 },
    { item: { id: "11" }, quantity: 8, custcol_plt: 0, custcol_lyr: 0, custcol_sec: 0, custcol_pcs: 0 },
    { item: { id: "999" }, quantity: 3, custcol_plt: 0, custcol_lyr: 0, custcol_sec: 0, custcol_pcs: 3 }
  ]);
});

test("live inventory rows map NetSuite IDs to all four local yards and fill omitted zero balances", () => {
  const rows = canonicalStockRequestInventoryRows([
    {
      item_id: "10",
      item_name: "A",
      stock_unit: "EA",
      location_id: "2001",
      quantity_on_hand: "9",
      quantity_available: "8"
    },
    {
      item_id: "10",
      item_name: "A",
      stock_unit: "EA",
      location_id: "2028",
      quantity_on_hand: "7",
      quantity_available: "6"
    }
  ], [
    { netsuiteLocationId: 2001, localLocationId: 1, localLocationCode: "3445" },
    { netsuiteLocationId: 2028, localLocationId: 28, localLocationCode: "2967" },
    { netsuiteLocationId: 2015, localLocationId: 15, localLocationCode: "12441" },
    { netsuiteLocationId: 2026, localLocationId: 26, localLocationCode: "150" }
  ], 10);
  assert.deepEqual(rows.map((row) => ({
    locationId: row.location_id,
    location: row.location,
    available: Number(row.quantity_available)
  })), [
    { locationId: 1, location: "3445", available: 8 },
    { locationId: 28, location: "2967", available: 6 },
    { locationId: 15, location: "12441", available: 0 },
    { locationId: 26, location: "150", available: 0 }
  ]);
});

test("confirm and print recovers an existing marker and never creates a duplicate TO", async () => {
  const calls = [];
  const completed = await confirmStockTransferWorkflow({
    transfer: transferFixture(),
    requestId: "confirm-42",
    operatorId: "scm-user"
  }, {
    ensurePrinter: async () => calls.push("printer"),
    resolveLocations: async () => locations,
    findRemoteByMarker: async () => [{
      id: 910,
      tranid: "TO910",
      source_location_id: 2028,
      destination_location_id: 2001
    }],
    createRemote: async () => assert.fail("Remote create must not run after marker recovery."),
    recordRemote: async (_id, remote) => calls.push(`record:${remote.id}`),
    approveRemote: async () => calls.push("approve"),
    hydrateRemote: async () => ({ id: 910, tranid: "TO910", pendingFulfillment: true }),
    recordApproved: async () => calls.push("hydrated"),
    fetchTicket: async () => ({ filename: "TO910.pdf", buffer: Buffer.from("pdf") }),
    claimPrint: async () => ({ generation: 1 }),
    queuePrint: async () => ({ id: 77, status: "queued" }),
    complete: async () => calls.push("complete"),
    fail: async () => assert.fail("Failure path must not run.")
  });
  assert.equal(completed.recovered, true);
  assert.equal(completed.remoteId, 910);
  assert.equal(completed.printJob.id, 77);
  assert.deepEqual(calls, ["printer", "record:910", "approve", "hydrated", "complete"]);
});

test("a completed stable confirmation request replays its result without printing twice", async () => {
  const result = await confirmStockTransferWorkflow({
    transfer: transferFixture({
      confirmationStatus: "complete",
      confirmationRequestId: "confirm-complete-42",
      netsuiteTransferOrderId: 913,
      netsuiteTransferOrderRef: "TO913",
      printJobId: 79,
      printStatus: "printed"
    }),
    requestId: "confirm-complete-42",
    operatorId: "scm-user"
  }, new Proxy({}, {
    get() {
      return async () => assert.fail("A completed idempotent replay must not repeat external work.");
    }
  }));
  assert.deepEqual(result, {
    transferId: 42,
    remoteId: 913,
    remoteRef: "TO913",
    printJob: { id: 79, status: "printed" },
    recovered: true,
    idempotentReplay: true
  });
});

test("a timeout after remote creation recovers by marker before retrying downstream steps", async () => {
  let markerLookups = 0;
  let creates = 0;
  const failedRecords = [];
  const result = await confirmStockTransferWorkflow({
    transfer: transferFixture(),
    requestId: "confirm-timeout",
    operatorId: "scm-user"
  }, {
    ensurePrinter: async () => {},
    resolveLocations: async () => locations,
    findRemoteByMarker: async () => {
      markerLookups += 1;
      return markerLookups < 3 ? [] : [{ id: 911, tranid: "TO911", source_location_id: 2028, destination_location_id: 2001 }];
    },
    createRemote: async () => {
      creates += 1;
      throw new Error("socket timed out after write");
    },
    recordRemote: async () => {},
    approveRemote: async () => {},
    hydrateRemote: async () => ({ id: 911, tranid: "TO911", pendingFulfillment: true }),
    recordApproved: async () => {},
    fetchTicket: async () => ({ filename: "TO911.pdf", buffer: Buffer.from("pdf") }),
    claimPrint: async () => ({ generation: 1 }),
    queuePrint: async () => ({ id: 78, status: "queued" }),
    complete: async () => {},
    fail: async (...args) => failedRecords.push(args),
    recoveryAttempts: 3,
    recoveryDelayMs: 1
  });
  assert.equal(creates, 1);
  assert.equal(markerLookups, 3);
  assert.equal(result.remoteId, 911);
  assert.equal(result.recovered, true);
  assert.equal(failedRecords.length, 0);
});

test("a downstream print failure records the known remote TO for safe recovery", async () => {
  const failures = [];
  await assert.rejects(
    () => confirmStockTransferWorkflow({
      transfer: transferFixture(),
      requestId: "confirm-print-failure",
      operatorId: "scm-user"
    }, {
      ensurePrinter: async () => {},
      resolveLocations: async () => locations,
      findRemoteByMarker: async () => [],
      createRemote: async () => ({ id: 912 }),
      recordRemote: async () => {},
      approveRemote: async () => {},
      hydrateRemote: async () => ({ id: 912, tranid: "TO912", pendingFulfillment: true }),
      recordApproved: async () => {},
      fetchTicket: async () => ({ filename: "TO912.pdf", buffer: Buffer.from("pdf") }),
      claimPrint: async () => ({ generation: 1 }),
      queuePrint: async () => { throw new Error("printer queue unavailable"); },
      complete: async () => {},
      fail: async (_id, failure) => failures.push(failure),
      recoveryAttempts: 1,
      recoveryDelayMs: 0
    }),
    /printer queue unavailable/
  );
  assert.equal(failures.length, 1);
  assert.equal(failures[0].remoteId, 912);
  assert.equal(failures[0].remoteRef, "TO912");
});

test("OAuth inventory refresh de-duplicates items, fills every yard, persists once, and returns the selected item", async () => {
  const saved = [];
  const dependencies = {
    resolveYards: async (requested) => {
      assert.deepEqual(requested.map((yard) => yard.locationId), [1, 28, 15, 26]);
      return yards;
    },
    fetchBalances: async (itemIds, locationIds) => {
      assert.deepEqual(itemIds, [10, 11]);
      assert.deepEqual(locationIds, [2001, 2028, 2015, 2026]);
      return [
        { item_id: 10, item_name: "A", location_id: 2001, quantity_available: 8, quantity_on_hand: 9 },
        { item_id: 11, item_name: "B", location_id: 2028, quantity_available: 6, quantity_on_hand: 7 }
      ];
    },
    upsertBalances: async (rows) => saved.push(...rows),
    getAvailability: async (itemId) => ({ itemId, refreshed: true })
  };
  assert.deepEqual(await refreshStockRequestItemsAvailability([], dependencies), []);
  const canonical = await refreshStockRequestItemsAvailability([10, "10", 11, 0, "bad"], dependencies);
  assert.equal(canonical.length, 8);
  assert.equal(saved.length, 8);
  const one = await refreshStockRequestItemAvailability(10, {
    ...dependencies,
    fetchBalances: async () => [{
      item_id: 10,
      item_name: "A",
      location_id: 2001,
      quantity_available: 8,
      quantity_on_hand: 9
    }]
  });
  assert.deepEqual(one, { itemId: 10, refreshed: true });
});

test("SCM conversion refreshes only selected item IDs before the atomic repository conversion", async () => {
  const calls = [];
  const result = await convertStockRequestLines(7, { lineIds: [2] }, { id: "scm-user" }, {
    getRequest: async () => ({ lines: [{ id: 1, itemId: 10 }, { id: 2, itemId: 11 }] }),
    refreshAvailability: async (ids) => calls.push(["refresh", ids]),
    convertLines: async (...args) => {
      calls.push(["convert", ...args]);
      return { converted: true };
    }
  });
  assert.deepEqual(result, { converted: true });
  assert.deepEqual(calls, [
    ["refresh", [11]],
    ["convert", 7, { lineIds: [2] }, { operatorId: "scm-user" }]
  ]);
});

test("dual-printer readiness is mandatory and a configured source yard passes through", async () => {
  const ready = { locationId: 28, transferOrderReady: true };
  assert.equal(await requireStockRequestPrinter(28, { listPrinters: async () => [ready] }), ready);
  await assert.rejects(
    () => requireStockRequestPrinter(28, { listPrinters: async () => [{ locationId: 28, transferOrderReady: false }] }),
    (error) => error?.status === 409 && /two different TO printers/i.test(error.message)
  );
});

test("NetSuite hydration writes outbound and inbound canonical projections using local yard IDs", async () => {
  const writes = [];
  const hydrated = await hydrateStockRequestTransfer(914, transferFixture(), {
    fetchOrder: async () => ({
      id: 914,
      tranid: "TO914",
      status: "B",
      status_text: "Pending Fulfillment",
      source_location_id: 2028,
      destination_location_id: 2001
    }),
    fetchDetails: async (_id, locationId, options) => [{ line_id: options.direction === "source" ? 1 : 2, location_id: locationId }],
    saveOutboundOrders: async (orders) => writes.push(["outbound-order", orders]),
    saveOutboundLines: async (id, lines) => writes.push(["outbound-lines", id, lines]),
    saveInboundOrders: async (orders) => writes.push(["inbound-order", orders]),
    saveInboundLines: async (id, lines) => writes.push(["inbound-lines", id, lines])
  });
  assert.equal(hydrated.pendingFulfillment, true);
  assert.equal(hydrated.tranid, "TO914");
  assert.equal(writes[0][1][0].source_location_id, 28);
  assert.equal(writes[1][2][0].location_id, 28);
  assert.equal(writes[3][2][0].location_id, 1);
  await assert.rejects(
    () => hydrateStockRequestTransfer(999, transferFixture(), { fetchOrder: async () => null }),
    /was not found/i
  );
});

test("immutable print keys and queued ticket metadata bind a snapshot to one transfer generation", async () => {
  assert.equal(
    stockRequestPrintJobKey({ transferId: 42, remoteRef: "TO914", generation: 2 }),
    "stock-request:42:picking-ticket:TO914:2"
  );
  let queued = null;
  const printJob = await queueStockRequestTicket({
    transfer: transferFixture(),
    remoteId: 914,
    remoteRef: "TO914",
    document: { filename: "TO914.pdf", buffer: Buffer.from("pdf") },
    generation: 2,
    operatorId: "scm-user"
  }, {
    queuePrintJob: async (payload, operatorId) => {
      queued = { payload, operatorId };
      return { id: 80, status: "queued" };
    }
  });
  assert.equal(printJob.id, 80);
  assert.equal(queued.operatorId, "scm-user");
  assert.equal(queued.payload.locationId, 28);
  assert.equal(queued.payload.jobKey, "stock-request:42:picking-ticket:TO914:2");
  assert.deepEqual(stockRequestTransferLocationInput(transferFixture()), {
    sourceLocationId: 28,
    sourceLocation: "2967",
    destinationLocationId: 1,
    destinationLocation: "3445"
  });
});

test("confirm wrapper enforces the live-write gate and replays a completed claim without external work", async () => {
  await assert.rejects(
    () => confirmAndPrintStockTransfer(42, {}, { id: "scm-user" }, { liveExecutionEnabled: false }),
    (error) => error?.status === 409 && /disabled/i.test(error.message)
  );
  const result = await confirmAndPrintStockTransfer(42, { requestId: "wrapper-replay" }, { id: "scm-user" }, {
    liveExecutionEnabled: true,
    claimConfirmation: async () => transferFixture({
      confirmationStatus: "complete",
      confirmationRequestId: "wrapper-replay",
      netsuiteTransferOrderId: 915,
      netsuiteTransferOrderRef: "TO915",
      printJobId: 81,
      printStatus: "printed"
    })
  });
  assert.equal(result.idempotentReplay, true);
  assert.equal(result.remoteId, 915);
});

test("re-print validates revision and real TO identity, then queues and records a new snapshot", async () => {
  const real = transferFixture({
    revision: 3,
    netsuiteTransferOrderId: 916,
    netsuiteTransferOrderRef: "TO916"
  });
  await assert.rejects(
    () => reprintStockTransfer(42, { expectedRevision: 2 }, { id: "scm-user" }, { getTransfer: async () => real }),
    (error) => error?.status === 409 && /changed after/i.test(error.message)
  );
  await assert.rejects(
    () => reprintStockTransfer(42, { expectedRevision: 3 }, { id: "scm-user" }, {
      getTransfer: async () => ({ ...real, netsuiteTransferOrderId: null, netsuiteTransferOrderRef: null })
    }),
    (error) => error?.status === 409 && /no real NetSuite/i.test(error.message)
  );
  const calls = [];
  const result = await reprintStockTransfer(42, { expectedRevision: 3 }, { id: "scm-user" }, {
    getTransfer: async () => real,
    ensurePrinter: async (locationId) => calls.push(["printer", locationId]),
    resolveLocations: async () => locations,
    fetchTicket: async (remoteId, options) => {
      calls.push(["ticket", remoteId, options]);
      return { filename: "TO916.pdf", buffer: Buffer.from("pdf") };
    },
    claimPrint: async () => ({ generation: 4 }),
    queueTicket: async (payload) => {
      calls.push(["queue", payload.generation]);
      return { id: 82, status: "queued" };
    },
    completePrint: async (_id, payload) => ({ ...real, printJobId: payload.printJobId })
  });
  assert.equal(result.transfer.printJobId, 82);
  assert.deepEqual(calls.map((call) => call[0]), ["printer", "ticket", "queue"]);
});

test("TO revision refreshes live stock, blocks executing orders, and records remote success or failure", async () => {
  const local = transferFixture({ revision: 1, netsuiteTransferOrderId: null, netsuiteTransferOrderRef: null });
  const refreshed = [];
  const localResult = await reviseStockTransfer(42, { expectedRevision: 1 }, { id: "scm-user" }, {
    getTransfer: async () => local,
    refreshAvailability: async (ids) => refreshed.push(ids),
    reviseQuantities: async () => ({ ...local, revision: 2 })
  });
  assert.equal(localResult.synced, false);
  assert.deepEqual(refreshed, [[10, 10, 11]]);

  const real = transferFixture({ revision: 2, netsuiteTransferOrderId: 917, netsuiteTransferOrderRef: "TO917" });
  await assert.rejects(
    () => reviseStockTransfer(42, { expectedRevision: 2 }, { id: "scm-user" }, {
      getTransfer: async () => real,
      refreshAvailability: async () => {},
      fetchRemote: async () => ({ status_text: "Pending Receipt" })
    }),
    (error) => error?.code === "STOCK_TRANSFER_REVISION_BLOCKED"
  );
  await assert.rejects(
    () => reviseStockTransfer(42, { expectedRevision: 2 }, { id: "scm-user" }, {
      getTransfer: async () => real,
      refreshAvailability: async () => {},
      fetchRemote: async () => null
    }),
    /linked NetSuite Transfer Order was not found/i
  );

  const revisionResults = [];
  const success = await reviseStockTransfer(42, { expectedRevision: 2 }, { id: "scm-user" }, {
    getTransfer: async () => real,
    refreshAvailability: async () => {},
    fetchRemote: async () => ({ status: "B", status_text: "Pending Fulfillment" }),
    resolveLocations: async () => locations,
    reviseQuantities: async () => ({ ...real, revision: 3 }),
    updateRemote: async (id, payload) => {
      assert.equal(id, 917);
      assert(payload.item.items.length >= 2);
    },
    hydrateRemote: async () => ({ status: "B", statusText: "Pending Fulfillment" }),
    recordRevisionResult: async (_id, result) => {
      revisionResults.push(result);
      return { ...real, revision: 3, revisionError: null };
    }
  });
  assert.equal(success.synced, true);
  assert.equal(revisionResults[0].succeeded, true);

  const failureResults = [];
  await assert.rejects(
    () => reviseStockTransfer(42, { expectedRevision: 2 }, { id: "scm-user" }, {
      getTransfer: async () => real,
      refreshAvailability: async () => {},
      fetchRemote: async () => ({ status: "B", status_text: "Pending Fulfillment" }),
      resolveLocations: async () => locations,
      reviseQuantities: async () => ({ ...real, revision: 3 }),
      updateRemote: async () => { throw new Error("remote update failed"); },
      recordRevisionResult: async (_id, result) => failureResults.push(result)
    }),
    /remote update failed/
  );
  assert.equal(failureResults[0].succeeded, false);
});
