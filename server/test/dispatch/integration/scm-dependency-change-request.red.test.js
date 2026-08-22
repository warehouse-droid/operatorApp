import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import {
  acknowledgeScmDependencyChangeRequest,
  completeScmDependencyActionReceipt,
  createScmDependencyChangeRequest,
  getScmDependencyChangeRequest,
  listRouteBearingDevicePresence,
  recordDriverRoutePresence,
  reserveScmDependencyActionReceipt
} from "../../../src/scm-dependency-management-repository.js";

after(closeDb);

function sha(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

test("dependency request waits for every route-bearing Driver device and never auto-applies", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const suffix = crypto.randomUUID();
      const requestId = crypto.randomUUID();
      const manifestA = crypto.randomUUID();
      const manifestB = crypto.randomUUID();
      const planDate = "2026-08-19";
      for (const [deviceId, manifestId] of [[`phone-a-${suffix}`, manifestA], [`phone-b-${suffix}`, manifestB]]) {
        const presence = await recordDriverRoutePresence({
          driverLogin: `cheng-${suffix}`,
          deviceId,
          visible: true,
          online: true,
          manifestId,
          planDate,
          planRevision: 8,
          syncState: "clean",
          pendingEventCount: 0,
          pendingPhotoCount: 0,
          activeJobId: ""
        });
        assert.equal(presence.deviceId, deviceId);
      }

      const created = await createScmDependencyChangeRequest({
        requestId,
        payloadHash: sha("request-a"),
        action: "link_to",
        payload: { transferOrderRef: "TOB00937" },
        targetRef: "SOB118191",
        targetSignature: sha("target"),
        planDate,
        expectedPlanRevision: 8,
        expectedPlanDigest: sha("plan"),
        requestedBy: "scm-user",
        devices: [
          { driverLogin: `cheng-${suffix}`, deviceId: `phone-a-${suffix}`, manifestId: manifestA },
          { driverLogin: `cheng-${suffix}`, deviceId: `phone-b-${suffix}`, manifestId: manifestB }
        ]
      });
      assert.equal(created.status, "waiting_driver");
      assert.deepEqual(created.devices.map((device) => device.state), ["waiting", "waiting"]);

      const firstReady = await acknowledgeScmDependencyChangeRequest({
        requestId,
        driverLogin: `cheng-${suffix}`,
        deviceId: `phone-a-${suffix}`,
        manifestId: manifestA,
        readinessTokenHash: sha("token-a"),
        readyExpiresAt: "2026-08-19T12:02:00.000Z"
      });
      assert.equal(firstReady.status, "waiting_driver");
      assert.equal(firstReady.devices.filter((device) => device.state === "ready").length, 1);

      const allReady = await acknowledgeScmDependencyChangeRequest({
        requestId,
        driverLogin: `cheng-${suffix}`,
        deviceId: `phone-b-${suffix}`,
        manifestId: manifestB,
        readinessTokenHash: sha("token-b"),
        readyExpiresAt: "2026-08-19T12:02:00.000Z"
      });
      assert.equal(allReady.status, "driver_ready");
      assert.equal(allReady.appliedAt, null, "readiness must not apply the relationship");
    });
  } finally {
    await rollback.rollback();
  }
});

test("a route-bearing device without a heartbeat remains an explicit offline blocker", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const plan = await query(
        `INSERT INTO dispatch_plans (plan_date, status, revision)
         VALUES ('2026-08-19', 'confirmed', 12) RETURNING id`
      );
      const manifestId = crypto.randomUUID();
      await query(
        `INSERT INTO driver_offline_manifests (
           manifest_id, driver_login, device_id, plan_id, plan_date,
           plan_revision, generated_at, expires_at
         ) VALUES ($1, 'cheng-offline', 'iphone-offline', $2, '2026-08-19', 12,
                   now(), now() + interval '1 day')`,
        [manifestId, plan.rows[0].id]
      );
      const devices = await listRouteBearingDevicePresence({
        planId: plan.rows[0].id,
        planDate: "2026-08-19",
        driverLogins: ["cheng-offline"]
      });
      assert.equal(devices.length, 1);
      assert.equal(devices[0].manifestId, manifestId);
      assert.equal(devices[0].visible, false);
      assert.equal(devices[0].online, false);
      assert.equal(devices[0].heartbeatAt, null);
    });
  } finally {
    await rollback.rollback();
  }
});

test("committed action receipts are idempotent and reject request-id payload drift", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const requestId = crypto.randomUUID();
      const payloadHash = sha("same-payload");
      const first = await reserveScmDependencyActionReceipt({
        requestId,
        payloadHash,
        action: "unlink_to",
        actorId: "scm-user",
        surface: "scm"
      });
      assert.equal(first.created, true);
      await completeScmDependencyActionReceipt(requestId, { ok: true, dependencyId: 41 });

      const retry = await reserveScmDependencyActionReceipt({
        requestId,
        payloadHash,
        action: "unlink_to",
        actorId: "scm-user",
        surface: "dispatch"
      });
      assert.equal(retry.created, false);
      assert.equal(retry.receipt.status, "succeeded");
      assert.deepEqual(retry.receipt.result, { ok: true, dependencyId: 41 });

      await assert.rejects(
        reserveScmDependencyActionReceipt({
          requestId,
          payloadHash: sha("different-payload"),
          action: "unlink_to",
          actorId: "scm-user"
        }),
        (error) => error?.status === 409 && error?.code === "DEPENDENCY_REQUEST_ID_REUSED"
      );
      assert.equal((await getScmDependencyChangeRequest(requestId)), null);
    });
  } finally {
    await rollback.rollback();
  }
});
