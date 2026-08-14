// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { closeDb, query } from "../../../src/db.js";
import { manuallyCompleteDispatchOrder } from "../../../src/dispatch-completion-repository.js";

after(closeDb);

test("25 concurrent manual recovery commands converge on one immutable completion event", async () => {
  const suffix = crypto.randomUUID().replaceAll("-", "").toUpperCase();
  const transferOrderId = 9_998_000_000 + Math.floor(Math.random() * 100_000);
  const transferOrderRef = `TO-RACE-${suffix}`;
  await query(
    `INSERT INTO transfer_orders (
       netsuite_id, tranid, from_location_id, from_location,
       to_location_id, to_location, fulfillment_status, netsuite_active, synced_at
     ) VALUES ($1, $2, 28, '2967', 15, '12441', 'not_fulfilled', true, now())`,
    [transferOrderId, transferOrderRef]
  );
  const command = {
    actor: { operatorId: `dispatcher-${suffix}`, roles: ["dispatcher"] },
    orderKind: "TO",
    orderRef: transferOrderRef,
    completedAt: "2040-01-21T18:00:00.000Z",
    reason: "Driver physically completed the transfer but missed the PWA submit action.",
    confirm: true
  };

  const results = await Promise.all(Array.from(
    { length: 25 },
    () => manuallyCompleteDispatchOrder(command)
  ));
  assert.equal(new Set(results.map((result) => result.completionEventId)).size, 1);
  assert.ok(results.every((result) => result.dispatchCompletionStatus === "completed"));
  assert.ok(results.every((result) => result.completionEvidenceType === "manual_dispatch"));

  const events = await query(
    `SELECT id::text, actor_id, reason
       FROM dispatch_order_completion_events
      WHERE order_kind = 'TO'
        AND lower(order_ref) = lower($1)
        AND completion_evidence_type = 'manual_dispatch'`,
    [transferOrderRef]
  );
  assert.equal(events.rowCount, 1);
  assert.equal(events.rows[0].actor_id, command.actor.operatorId);
  assert.equal(events.rows[0].reason, command.reason);

  await assert.rejects(
    query(
      "UPDATE dispatch_order_completion_events SET reason = 'mutated' WHERE id = $1",
      [events.rows[0].id]
    ),
    (error) => error?.code === "55000"
  );
  await assert.rejects(
    query("DELETE FROM dispatch_order_completion_events WHERE id = $1", [events.rows[0].id]),
    (error) => error?.code === "55000"
  );
});
