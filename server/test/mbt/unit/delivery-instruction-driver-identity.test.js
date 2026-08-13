import assert from "node:assert/strict";
import test from "node:test";

import {
  fingerprintDriverOfflineJob,
  fingerprintDriverOfflineJobContent
} from "../../../src/driver-offline-repository.js";

function jobWithInstruction(text) {
  return {
    jobId: "plan:1:load:1:dropoff:1",
    driverLogin: "driver-a",
    stopType: "dropoff",
    stopId: "drop-1",
    loadId: "load-1",
    truckId: "truck-1",
    orderRefs: ["SO100"],
    orderTypes: ["SO"],
    physicalVisitJobIds: ["plan:1:load:1:dropoff:1"],
    physicalVisitStopIds: ["drop-1"],
    dropLocation: "Customer",
    requiredPhotos: 0,
    orders: [{ orderRef: "SO100", orderType: "sales_order", party: "Customer", items: [] }],
    deliveryInstructions: {
      revision: 2,
      orders: [{ orderId: 100, orderRef: "SO100", customer: "Customer", automaticText: text, phones: [], additionalText: "", media: [] }]
    }
  };
}

test("instruction edits change Driver content but never immutable completion identity", () => {
  const before = jobWithInstruction("Call first");
  const after = jobWithInstruction("Use the side gate");
  assert.equal(fingerprintDriverOfflineJob(before), fingerprintDriverOfflineJob(after));
  assert.notEqual(fingerprintDriverOfflineJobContent(before), fingerprintDriverOfflineJobContent(after));
});
