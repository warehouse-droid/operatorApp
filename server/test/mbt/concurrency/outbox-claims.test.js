import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before } from "node:test";

import { closeDb, query } from "../../../src/db.js";
import {
  claimNextNetSuiteOutbox,
  enqueueNetSuiteOutbox
} from "../../../src/mbt/outbox-repository.js";

const RUN_ID = crypto.randomUUID().replaceAll("-", "");
let sequence = 0;

async function createPending(label) {
  sequence += 1;
  const externalIdempotencyKey = `p1-claim-${label}-${RUN_ID}-${sequence}`;
  const result = await enqueueNetSuiteOutbox({
    externalIdempotencyKey,
    operationType: "create_sales_order",
    targetRecordType: "sales_order",
    payload: { externalId: externalIdempotencyKey }
  });
  return result.outbox;
}

before(async () => {
  await query(
    `UPDATE mbt_netsuite_outbox
        SET state = 'voided',
            lease_token = NULL,
            lease_owner = NULL,
            lease_acquired_at = NULL,
            lease_expires_at = NULL
      WHERE state IN ('pending', 'leased')
        AND (
          external_idempotency_key LIKE 'mbt-p1-%'
          OR external_idempotency_key LIKE 'p1-claim-%'
        )`
  );
});

after(async () => {
  await closeDb();
});

test("F12: twenty-four independent workers claim one eligible outbox event exactly once", async () => {
  const pending = await createPending("single");
  const claims = await Promise.all(
    Array.from({ length: 24 }, (_unused, index) => claimNextNetSuiteOutbox({
      workerId: `p1-race-worker-${RUN_ID}-${index}`,
      leaseSeconds: 30
    }))
  );
  const winners = claims.filter(Boolean);
  assert.equal(winners.length, 1, JSON.stringify(winners));
  assert.equal(winners[0].outboxId, pending.outboxId);
  assert.equal(winners[0].attemptCount, 1);
  assert.equal(winners[0].state, "leased");
  assert.match(winners[0].leaseToken, /^[0-9a-f-]{36}$/i);

  const stored = await query(
    `SELECT state, attempt_count::int AS attempt_count, lease_owner,
            external_idempotency_key
       FROM mbt_netsuite_outbox
      WHERE outbox_id = $1`,
    [pending.outboxId]
  );
  assert.deepEqual(stored.rows[0], {
    state: "leased",
    attempt_count: 1,
    lease_owner: winners[0].leaseOwner,
    external_idempotency_key: pending.externalIdempotencyKey
  });
});

test("F12: two independent workers can claim two separate eligible events", async () => {
  const [left, right] = await Promise.all([
    createPending("pair-left"),
    createPending("pair-right")
  ]);
  const claims = await Promise.all([
    claimNextNetSuiteOutbox({ workerId: `p1-pair-worker-a-${RUN_ID}`, leaseSeconds: 30 }),
    claimNextNetSuiteOutbox({ workerId: `p1-pair-worker-b-${RUN_ID}`, leaseSeconds: 30 })
  ]);
  assert.ok(claims.every(Boolean));
  assert.deepEqual(
    new Set(claims.map(({ outboxId }) => outboxId)),
    new Set([left.outboxId, right.outboxId])
  );
  assert.equal(new Set(claims.map(({ leaseOwner }) => leaseOwner)).size, 2);
  assert.ok(claims.every(({ state, attemptCount }) => state === "leased" && attemptCount === 1));
});
