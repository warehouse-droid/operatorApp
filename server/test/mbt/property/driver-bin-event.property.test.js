// @ts-check

import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";

const contractModule = /** @type {Record<string, Function>} */ (await import(
  "../../../src/mbt/driver-bin-contract.js"
).catch((error) => {
  if (error?.code !== "ERR_MODULE_NOT_FOUND") {
    throw error;
  }
  return {};
}));

/** @param {string} name */
function requiredOperation(name) {
  const operation = contractModule[name];
  assert.equal(typeof operation, "function", `P3.9 requires driver-bin-contract.${name}.`);
  return operation;
}

test("P3-F18/P3-F22 property: 1,000 scan permutations canonicalize without crossing outgoing/incoming identities", () => {
  const normalizeMbtDriverEventDetails = requiredOperation("normalizeMbtDriverEventDetails");
  fc.assert(fc.property(
    fc.uuid({ version: 4 }),
    fc.uuid({ version: 4 }),
    fc.stringMatching(/^[A-Z0-9-]{1,24}$/u),
    fc.stringMatching(/^[A-Z0-9-]{1,24}$/u),
    (outgoingAssetId, incomingAssetId, outgoingCode, incomingCode) => {
      fc.pre(outgoingAssetId !== incomingAssetId);
      const scans = [
        {
          evidenceCode: "outgoing_bin_scan",
          assetRole: "outgoing",
          assetId: outgoingAssetId,
          scannedValue: outgoingCode
        },
        {
          evidenceCode: "incoming_bin_scan",
          assetRole: "incoming",
          assetId: incomingAssetId,
          scannedValue: incomingCode
        }
      ];
      const before = structuredClone(scans);
      const forward = normalizeMbtDriverEventDetails({
        schemaVersion: "mbt-driver-bin-event-v1",
        actionCode: "exchange_bin",
        scans
      });
      const reverse = normalizeMbtDriverEventDetails({
        schemaVersion: "mbt-driver-bin-event-v1",
        actionCode: "exchange_bin",
        scans: [...scans].reverse()
      });
      assert.deepEqual(reverse, forward);
      assert.deepEqual(scans, before);
      assert.notEqual(forward.scans[0].assetId, forward.scans[1].assetId);
      assert.deepEqual(new Set(forward.scans.map(({ assetRole }) => assetRole)), new Set(["incoming", "outgoing"]));
    }
  ), { numRuns: 1_000 });
});

test("P3-F21 property: 1,000 complete dump receipts retain exact integer cents and quantity evidence", () => {
  const normalizeMbtDriverEventDetails = requiredOperation("normalizeMbtDriverEventDetails");
  fc.assert(fc.property(
    fc.integer({ min: 0, max: 100_000_000 }),
    fc.integer({ min: 0, max: 100_000_000 }),
    fc.integer({ min: 1, max: 1_000_000 }),
    (subtotalMinor, taxMinor, weightThousandths) => {
      const totalMinor = subtotalMinor + taxMinor;
      const normalized = normalizeMbtDriverEventDetails({
        schemaVersion: "mbt-driver-bin-event-v1",
        actionCode: "dump_bin",
        scans: [],
        receipt: {
          dumpSiteId: "00000000-0000-4000-8000-000000000101",
          materialId: "00000000-0000-4000-8000-000000000102",
          ticketNumber: "SYNTH-TICKET",
          weight: String(weightThousandths / 1000),
          quantity: "1",
          unitOfMeasure: "TONNE",
          subtotalMinor,
          taxMinor,
          totalMinor,
          currency: "CAD",
          receiptPhotoOrdinal: 0
        }
      });
      assert.equal(normalized.receipt.subtotalMinor, subtotalMinor);
      assert.equal(normalized.receipt.taxMinor, taxMinor);
      assert.equal(normalized.receipt.totalMinor, totalMinor);
      assert.equal(normalized.receipt.currency, "CAD");
      assert.equal(normalized.receipt.weight, String(weightThousandths / 1000));
    }
  ), { numRuns: 1_000 });
});

test("P3-F18/P3-F21: malformed, duplicate, permissively coerced, or unbalanced evidence fails closed", () => {
  const normalizeMbtDriverEventDetails = requiredOperation("normalizeMbtDriverEventDetails");
  const scan = {
    evidenceCode: "outgoing_bin_scan",
    assetRole: "outgoing",
    assetId: "00000000-0000-4000-8000-000000000201",
    scannedValue: "BIN-201"
  };
  for (const value of [
    { actionCode: "deliver_bin", scans: [scan, scan] },
    { actionCode: "deliver_bin", scans: [{ ...scan, unknown: true }] },
    { actionCode: "dump_bin", scans: [], receipt: { subtotalMinor: "12", taxMinor: 1, totalMinor: 13 } },
    {
      actionCode: "dump_bin",
      scans: [],
      receipt: {
        dumpSiteId: "00000000-0000-4000-8000-000000000101",
        materialId: "00000000-0000-4000-8000-000000000102",
        ticketNumber: "SYNTH-TICKET",
        quantity: "1",
        unitOfMeasure: "TONNE",
        subtotalMinor: 12,
        taxMinor: 1,
        totalMinor: 99,
        currency: "CAD",
        receiptPhotoOrdinal: 0
      }
    }
  ]) {
    assert.throws(() => normalizeMbtDriverEventDetails(value), (error) => error?.code === "MBT_DRIVER_BIN_EVENT_INVALID");
  }
});
