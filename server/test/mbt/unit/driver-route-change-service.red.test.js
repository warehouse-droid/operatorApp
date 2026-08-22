import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  acknowledgeDriverRouteChange,
  assertDriverRouteDeviceReady,
  DRIVER_ROUTE_READINESS_TTL_MS
} from "../../../src/driver-route-change-service.js";

const now = new Date("2026-08-19T12:00:00.000Z");
const manifestId = crypto.randomUUID();

function expectedDevice(overrides = {}) {
  return {
    driverLogin: "cheng",
    deviceId: "iphone-1",
    manifestId,
    ...overrides
  };
}

function readyPresence(overrides = {}) {
  return {
    ...expectedDevice(),
    visible: true,
    online: true,
    heartbeatAt: new Date(now.getTime() - 1_000).toISOString(),
    syncState: "clean",
    pendingEventCount: 0,
    pendingPhotoCount: 0,
    activeJobId: "",
    ...overrides
  };
}

test("a clean visible device receives a short readiness window without applying a route", async () => {
  let acknowledgement = null;
  const result = await acknowledgeDriverRouteChange({
    requestId: crypto.randomUUID(),
    driverLogin: "cheng",
    deviceId: "iphone-1",
    now
  }, {
    getRequest: async (requestId) => ({
      requestId,
      status: "waiting_driver",
      expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
      planId: 91,
      planDate: "2026-08-19",
      devices: [expectedDevice()]
    }),
    listPresence: async () => [readyPresence()],
    randomBytes: () => Buffer.alloc(32, 7),
    acknowledge: async (input) => {
      acknowledgement = input;
      return { requestId: input.requestId, status: "driver_ready", devices: [] };
    }
  });
  assert.equal(result.routeChanged, false);
  assert.equal(result.readyExpiresAt, new Date(now.getTime() + DRIVER_ROUTE_READINESS_TTL_MS).toISOString());
  assert.match(acknowledgement.readinessTokenHash, /^[0-9a-f]{64}$/u);
  assert.equal(acknowledgement.manifestId, manifestId);
});

test("readiness rejects hidden, stale, dirty, active, and mismatched devices", () => {
  const cases = [
    [readyPresence({ visible: false }), "DRIVER_ROUTE_DEVICE_NOT_VISIBLE"],
    [readyPresence({ heartbeatAt: new Date(now.getTime() - 16_000).toISOString() }), "DRIVER_ROUTE_DEVICE_NOT_VISIBLE"],
    [readyPresence({ syncState: "pending", pendingEventCount: 1 }), "DRIVER_ROUTE_SYNC_NOT_CLEAN"],
    [readyPresence({ pendingPhotoCount: 1 }), "DRIVER_ROUTE_SYNC_NOT_CLEAN"],
    [readyPresence({ activeJobId: "STOP-1" }), "DRIVER_ROUTE_ACTIVITY_ACTIVE"],
    [readyPresence({ manifestId: crypto.randomUUID() }), "DRIVER_ROUTE_MANIFEST_MISMATCH"]
  ];
  for (const [presence, code] of cases) {
    assert.throws(
      () => assertDriverRouteDeviceReady(presence, expectedDevice(), now),
      (error) => error?.status === 409 && error?.code === code,
      code
    );
  }
});

test("an unrelated device cannot acknowledge another Driver route", async () => {
  await assert.rejects(
    acknowledgeDriverRouteChange({
      requestId: crypto.randomUUID(),
      driverLogin: "other-driver",
      deviceId: "other-phone",
      now
    }, {
      getRequest: async (requestId) => ({
        requestId,
        status: "waiting_driver",
        expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
        devices: [expectedDevice()]
      })
    }),
    (error) => error?.status === 403 && error?.code === "DRIVER_ROUTE_DEVICE_MISMATCH"
  );
});
