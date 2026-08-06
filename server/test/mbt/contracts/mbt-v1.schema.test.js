import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

const schemaUrl = new URL("../../../contracts/mbt-v1.schema.json", import.meta.url);

const VALID_BIN_ORDER = {
  id: "BIN-contract-0042-V0007",
  type: "BIN",
  serviceAction: "customer_exchange",
  stops: [
    {
      id: "BIN-contract-0042-V0007-S0001",
      serviceAction: "customer_exchange",
      mbt: {
        visitId: "62b00c42-b697-4e62-aa83-54f3f866ab7e",
        visitRevision: 3,
        stepId: "c6af3e66-cc44-4f11-a937-99443c0c99be",
        evidenceRequirements: [
          { code: "pickup_before", kind: "photo", minimumCount: 1 },
          { code: "delivery_after", kind: "photo", minimumCount: 1 }
        ]
      }
    }
  ],
  mbt: {
    contractId: "5a2efc3a-e366-40d9-a68d-19f965ecf421",
    visitId: "62b00c42-b697-4e62-aa83-54f3f866ab7e",
    visitRevision: 3,
    templateVersionId: "93d4f115-1b91-4e49-b807-8f4e16f67d25",
    stepId: "c6af3e66-cc44-4f11-a937-99443c0c99be",
    reservationSnapshot: {
      revision: 2,
      capturedAt: "2026-08-03T14:30:00.000Z"
    },
    expectedAssets: [
      {
        reservationSlot: "collect",
        assetId: "e1ae8c32-76cc-4cec-a9ca-18eb22c58c45",
        assetCode: "BIN-20-0012",
        binTypeId: "0c51ed71-43ec-4610-b009-88ed05675172"
      },
      {
        reservationSlot: "deliver",
        assetId: "d5b2f360-c384-4220-bde6-8d2d5eeb2d20",
        assetCode: "BIN-20-0031",
        binTypeId: "0c51ed71-43ec-4610-b009-88ed05675172"
      }
    ],
    materialCode: "MIXED-C-D",
    dumpSiteId: "79f41bb1-fd08-4681-b80c-157d94556b99",
    evidenceRequirements: [
      { code: "pickup_before", kind: "photo", minimumCount: 1 },
      { code: "delivery_after", kind: "photo", minimumCount: 1 }
    ]
  }
};

async function loadContract() {
  return JSON.parse(await readFile(schemaUrl, "utf8"));
}

test("F14 MBT v1 schema compiles strictly and accepts the reserved BIN dispatch snapshot", async () => {
  const schema = await loadContract();
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addSchema(schema);
  const validateDispatchOrder = ajv.compile({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $ref: `${schema.$id}#/$defs/dispatchOrder`
  });

  assert.equal(validateDispatchOrder(VALID_BIN_ORDER), true, JSON.stringify(validateDispatchOrder.errors));
});

test("F14 MBT v1 schema rejects incomplete, malformed, and extra BIN identity data", async () => {
  const schema = await loadContract();
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addSchema(schema);
  const validateDispatchOrder = ajv.getSchema(`${schema.$id}#/$defs/dispatchOrder`);

  assert.equal(typeof validateDispatchOrder, "function");

  const missingFingerprint = structuredClone(VALID_BIN_ORDER);
  delete missingFingerprint.mbt.visitRevision;
  assert.equal(validateDispatchOrder(missingFingerprint), false);

  const wrongType = structuredClone(VALID_BIN_ORDER);
  wrongType.type = "SO";
  assert.equal(validateDispatchOrder(wrongType), false);

  const malformedUuid = structuredClone(VALID_BIN_ORDER);
  malformedUuid.mbt.visitId = "visit-7";
  assert.equal(validateDispatchOrder(malformedUuid), false);

  const unstableAction = structuredClone(VALID_BIN_ORDER);
  unstableAction.serviceAction = "Customer Exchange";
  assert.equal(validateDispatchOrder(unstableAction), false);

  const extraIdentity = structuredClone(VALID_BIN_ORDER);
  extraIdentity.mbt.netsuiteRawPayload = { secret: true };
  assert.equal(validateDispatchOrder(extraIdentity), false);
});

test("F14 MBT v1 schema requires stable, self-describing BIN stops", async () => {
  const schema = await loadContract();
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addSchema(schema);
  const validateDispatchOrder = ajv.getSchema(`${schema.$id}#/$defs/dispatchOrder`);

  assert.equal(typeof validateDispatchOrder, "function");

  const missingStops = structuredClone(VALID_BIN_ORDER);
  delete missingStops.stops;
  assert.equal(validateDispatchOrder(missingStops), false, "a BIN order without stable stops must fail");

  assert.equal(
    validateDispatchOrder({ ...structuredClone(VALID_BIN_ORDER), stops: [] }),
    false,
    "a BIN order must reserve at least one stop"
  );

  const missingStopId = structuredClone(VALID_BIN_ORDER);
  delete missingStopId.stops[0].id;
  assert.equal(validateDispatchOrder(missingStopId), false);

  const unstableStopId = structuredClone(VALID_BIN_ORDER);
  unstableStopId.stops[0].id = "temporary stop 1";
  assert.equal(validateDispatchOrder(unstableStopId), false);

  const missingStopAction = structuredClone(VALID_BIN_ORDER);
  delete missingStopAction.stops[0].serviceAction;
  assert.equal(validateDispatchOrder(missingStopAction), false);

  const malformedStopAction = structuredClone(VALID_BIN_ORDER);
  malformedStopAction.stops[0].serviceAction = "Customer Exchange";
  assert.equal(validateDispatchOrder(malformedStopAction), false);

  const missingStopSnapshot = structuredClone(VALID_BIN_ORDER);
  delete missingStopSnapshot.stops[0].mbt;
  assert.equal(validateDispatchOrder(missingStopSnapshot), false);

  const incompleteStopSnapshot = structuredClone(VALID_BIN_ORDER);
  delete incompleteStopSnapshot.stops[0].mbt.evidenceRequirements;
  assert.equal(validateDispatchOrder(incompleteStopSnapshot), false);

  const leakedStopData = structuredClone(VALID_BIN_ORDER);
  leakedStopData.stops[0].mbt.rawNetSuitePayload = { secret: true };
  assert.equal(validateDispatchOrder(leakedStopData), false);

  const leakedReservationData = structuredClone(VALID_BIN_ORDER);
  leakedReservationData.mbt.reservationSnapshot.internalQuery = "private";
  assert.equal(validateDispatchOrder(leakedReservationData), false);

  const duplicateStops = structuredClone(VALID_BIN_ORDER);
  duplicateStops.stops.push(structuredClone(duplicateStops.stops[0]));
  assert.equal(validateDispatchOrder(duplicateStops), false);
});

test("F03/F04 public error schema requires the stable error envelope", async () => {
  const schema = await loadContract();
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addSchema(schema);
  const validateError = ajv.getSchema(`${schema.$id}#/$defs/errorEnvelope`);

  const valid = {
    error: "This record changed. Reload and try again.",
    code: "MBT_STALE_REVISION",
    details: { expectedRevision: 4, actualRevision: 5 },
    correlationId: "corr-p1-0001"
  };
  assert.equal(typeof validateError, "function");
  assert.equal(validateError(valid), true, JSON.stringify(validateError?.errors));
  assert.equal(validateError({ ...valid, code: "" }), false);
  assert.equal(validateError({ ...valid, debugStack: "secret" }), false);
});
