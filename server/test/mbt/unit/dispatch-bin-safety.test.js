import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";

import {
  assertBinDispatchCapability,
  assertNoDriverBinMaterialization,
  binDispatchOrders,
  isBinDispatchOrder,
  serializeBinDispatchSnapshot
} from "../../../src/mbt/dispatch-bin-safety.js";
import { planJobsForDrivers } from "../../../src/driver-repository.js";

const BIN_ORDER = Object.freeze({
  id: "00000000-0000-4000-8000-000000000101",
  type: "BIN",
  customer: "Phase 1 customer snapshot",
  serviceAction: "deliver_empty",
  stops: [
    {
      id: "00000000-0000-4000-8000-000000000102",
      type: "drop",
      serviceAction: "deliver_empty",
      location: "100 Test Road"
    }
  ],
  mbt: {
    contractId: "00000000-0000-4000-8000-000000000103",
    visitId: "00000000-0000-4000-8000-000000000104",
    templateVersionId: "00000000-0000-4000-8000-000000000105",
    reservation: {
      assetId: "00000000-0000-4000-8000-000000000106",
      reservationSlot: 1
    },
    evidenceRequirements: ["bin_scan", "placement_photo"]
  }
});

test("F14: BIN identity is explicit and cannot be hidden by changing only its type", () => {
  assert.equal(isBinDispatchOrder(BIN_ORDER), true);
  assert.equal(isBinDispatchOrder({ ...BIN_ORDER, type: "SO" }), true, "an MBT identity remains BIN");
  assert.equal(isBinDispatchOrder({ id: "SO-1", type: "SO", items: [] }), false);
  assert.deepEqual(binDispatchOrders({
    orders: [{ id: "SO-1", type: "SO" }, BIN_ORDER],
    trucks: []
  }), [BIN_ORDER]);
});

test("F14: the reserved BIN snapshot round-trips without losing stable stop or evidence identity", () => {
  const before = structuredClone(BIN_ORDER);
  const serialized = serializeBinDispatchSnapshot(BIN_ORDER);
  assert.equal(typeof serialized, "string");
  assert.deepEqual(JSON.parse(serialized), before);
  assert.deepEqual(BIN_ORDER, before, "snapshot serialization must not mutate dispatch state");
});

test("F01/F14: disabled BIN save, restore, and confirmation fail with one stable error", () => {
  for (const operation of ["save", "restore", "confirm"]) {
    assert.throws(
      () => assertBinDispatchCapability({ orders: [BIN_ORDER] }, {
        operation,
        environmentEnabled: true,
        databaseEnabled: false
      }),
      (error) => error.status === 409
        && error.code === "MBT_CAPABILITY_DISABLED"
        && error.message === "BIN dispatch is disabled."
        && error.details?.capability === "bin_dispatch"
        && error.details?.operation === operation
    );
  }
});

test("F14/F15: a BIN order is never eligible for Driver materialization in Phase 1", () => {
  assert.throws(
    () => assertNoDriverBinMaterialization({ orders: [BIN_ORDER] }),
    (error) => error.status === 409
      && error.code === "MBT_DRIVER_BIN_DISABLED"
      && error.message === "Driver BIN execution is disabled in Phase 1."
  );
  assert.equal(assertNoDriverBinMaterialization({ orders: [{ id: "SO-1", type: "SO" }] }), true);
});

test("F14/F15: an empty multi-driver projection cannot bypass the Driver BIN guard", () => {
  assert.throws(
    () => planJobsForDrivers({ orders: [BIN_ORDER] }, []),
    (error) => error.status === 409
      && error.code === "MBT_DRIVER_BIN_DISABLED"
      && error.message === "Driver BIN execution is disabled in Phase 1."
  );
});

test("F14/F15: a nested truck stop cannot hide BIN identity from save or Driver guards", () => {
  for (const stop of [
    { id: "STOP-TYPE-BIN", type: "BIN" },
    { id: "STOP-MBT-IDENTITY", type: "drop", mbt: { visitId: "VISIT-STOP" } }
  ]) {
    const plan = {
      orders: [],
      trucks: [{
        id: "TRUCK-1",
        loads: [{ id: "LOAD-1", stops: [{ id: "ORDINARY" }, stop] }]
      }]
    };

    assert.deepEqual(binDispatchOrders(plan), [stop]);
    assert.throws(
      () => assertBinDispatchCapability(plan, {
        operation: "save",
        environmentEnabled: false,
        databaseEnabled: false
      }),
      (error) => error.code === "MBT_CAPABILITY_DISABLED"
    );
    assert.throws(
      () => assertNoDriverBinMaterialization(plan),
      (error) => error.code === "MBT_DRIVER_BIN_DISABLED"
    );
  }
});

test("F14 hardening: nested, duplicate, cyclic, and malformed order shapes cannot hide BIN identity", () => {
  const nestedBin = {
    id: "NESTED-BIN",
    type: "so",
    mbt: { visitId: "VISIT-NESTED" },
    childOrderDetails: "not-an-array"
  };
  const parent = {
    id: "PARENT-SO",
    type: "SO",
    childOrderDetails: [null, "bad-child", nestedBin]
  };
  parent.childOrderDetails.push(parent, nestedBin);

  assert.equal(isBinDispatchOrder(null), false);
  assert.equal(isBinDispatchOrder([]), false);
  assert.equal(isBinDispatchOrder({ type: "  bin  " }), true);
  assert.equal(isBinDispatchOrder({ type: "SO", mbt: {} }), true);
  assert.equal(isBinDispatchOrder({ type: "SO", mbt: [] }), false);
  assert.equal(isBinDispatchOrder({ type: "SO", mbt: null }), false);
  assert.deepEqual(binDispatchOrders({
    orders: [undefined, parent, nestedBin, parent]
  }), [nestedBin], "a shared nested BIN object is reported exactly once");
  const stopOnlyBin = { id: "STOP-ONLY-BIN", type: "drop", mbt: { visitId: "VISIT-STOP-ONLY" } };
  assert.deepEqual(binDispatchOrders({
    orders: [stopOnlyBin],
    trucks: [
      null,
      { loads: "not-an-array" },
      {
        loads: [
          null,
          { stops: "not-an-array" },
          { stops: [undefined, stopOnlyBin, stopOnlyBin] }
        ]
      }
    ]
  }), [stopOnlyBin], "malformed route containers and shared stop identities remain safe and deduplicated");
  assert.deepEqual(binDispatchOrders(null), []);
  assert.deepEqual(binDispatchOrders({ orders: "not-an-array" }), []);
});

test("F14 hardening: snapshot and capability boundaries fail closed without blocking ordinary plans", () => {
  assert.throws(
    () => serializeBinDispatchSnapshot({ id: "SO-ONLY", type: "SO" }),
    (error) => error instanceof TypeError
      && error.message === "A BIN dispatch order snapshot is required."
  );
  assert.equal(assertBinDispatchCapability(null), true);
  assert.equal(assertBinDispatchCapability({ orders: [{ type: "SO" }] }), true);
  assert.equal(assertBinDispatchCapability({ orders: [BIN_ORDER] }, {
    environmentEnabled: true,
    databaseEnabled: true
  }), true);
  for (const options of [
    undefined,
    { environmentEnabled: false, databaseEnabled: false },
    { environmentEnabled: false, databaseEnabled: true }
  ]) {
    assert.throws(
      () => assertBinDispatchCapability({ orders: [BIN_ORDER] }, options),
      (error) => error.code === "MBT_CAPABILITY_DISABLED"
        && error.details?.operation === "save"
    );
  }
  assert.equal(assertNoDriverBinMaterialization(null), true);
  assert.equal(assertNoDriverBinMaterialization({ orders: [] }), true);
});

test("F14 non-regression: deeply nested ordinary plans are scanned without call-stack failure", () => {
  const root = { id: "DEEP-ROOT", type: "SO", childOrderDetails: [] };
  let current = root;
  for (let index = 0; index < 20_000; index += 1) {
    const child = {
      id: `DEEP-${index}`,
      type: "SO",
      childOrderDetails: []
    };
    current.childOrderDetails.push(child);
    current = child;
  }
  current.type = "BIN";

  assert.deepEqual(binDispatchOrders({ orders: [root] }), [current]);
});

test("F14 non-regression: a representative large ordinary plan scan stays bounded", () => {
  const orders = Array.from({ length: 10_000 }, (_, index) => ({
    id: `SO-LARGE-${index}`,
    type: "SO",
    childOrderDetails: []
  }));
  const startedAt = performance.now();
  assert.deepEqual(binDispatchOrders({ orders }), []);
  const elapsedMilliseconds = performance.now() - startedAt;
  assert.ok(
    elapsedMilliseconds < 1_000,
    `A 10,000-order non-BIN scan took ${elapsedMilliseconds.toFixed(1)}ms.`
  );
});
