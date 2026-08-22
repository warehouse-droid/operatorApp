import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { writeAudit } from "../../../src/auth-repository.js";
import { closeDb, query, withTransaction } from "../../../src/db.js";
import { updatePurchaseOrderNetSuiteStatus } from "../../../src/order-sync-repository.js";
import { processNetSuiteOrderWebhook } from "../../../src/server.js";
import {
  claimDueDelayedStatusRefreshJobs,
  enqueueDelayedStatusRefresh,
  finishDelayedStatusRefreshAttempt,
  lockDelayedStatusRefreshLease,
  renewDelayedStatusRefreshLease
} from "../../../src/netsuite-delayed-status-refresh-repository.js";
import { createDelayedStatusRefreshWorker } from "../../../src/netsuite-delayed-status-refresh-service.js";

after(closeDb);

function identity(offset = 0) {
  const suffix = Number.parseInt(crypto.randomBytes(4).toString("hex"), 16) % 500_000;
  return 9_980_000_000 + suffix + offset;
}

async function cleanup(ids) {
  await query(
    "DELETE FROM netsuite_delayed_status_refresh_jobs WHERE netsuite_order_id = ANY($1::bigint[])",
    [ids]
  );
}

test("DSR-R1: enqueue commits atomically, coalesces an active duplicate, and rolls back with its caller", async () => {
  const committedId = identity(1);
  const rolledBackId = identity(2);
  try {
    const first = await withTransaction(() => enqueueDelayedStatusRefresh({
      orderType: "purchase_order",
      netsuiteOrderId: committedId,
      tranid: "DSR-PO-COMMIT",
      availableAt: new Date("2026-08-19T12:00:10.000Z")
    }));
    const duplicate = await withTransaction(() => enqueueDelayedStatusRefresh({
      orderType: "purchase_order",
      netsuiteOrderId: committedId,
      tranid: "DSR-PO-COMMIT",
      availableAt: new Date("2026-08-19T12:00:20.000Z")
    }));
    assert.equal(duplicate.jobId, first.jobId);
    assert.equal(duplicate.created, false);

    await assert.rejects(
      () => withTransaction(async () => {
        await enqueueDelayedStatusRefresh({
          orderType: "purchase_order",
          netsuiteOrderId: rolledBackId,
          tranid: "DSR-PO-ROLLBACK",
          availableAt: new Date("2026-08-19T12:00:10.000Z")
        });
        throw new Error("force webhook rollback");
      }),
      /force webhook rollback/
    );
    const rows = await query(
      `SELECT netsuite_order_id::text AS id
         FROM netsuite_delayed_status_refresh_jobs
        WHERE netsuite_order_id = ANY($1::bigint[])
        ORDER BY netsuite_order_id`,
      [[committedId, rolledBackId]]
    );
    assert.deepEqual(rows.rows.map((row) => row.id), [String(committedId)]);
  } finally {
    await cleanup([committedId, rolledBackId]);
  }
});

test("DSR-R2: concurrent SKIP LOCKED claimers receive a due job exactly once", async () => {
  const orderId = identity(10);
  try {
    await enqueueDelayedStatusRefresh({
      orderType: "sales_order",
      netsuiteOrderId: orderId,
      tranid: "DSR-SO-CLAIM",
      availableAt: new Date("2026-08-19T11:59:00.000Z")
    });
    const now = new Date("2026-08-19T12:00:00.000Z");
    const [left, right] = await Promise.all([
      claimDueDelayedStatusRefreshJobs({ workerId: "worker-left", limit: 10, leaseMs: 120_000, now }),
      claimDueDelayedStatusRefreshJobs({ workerId: "worker-right", limit: 10, leaseMs: 120_000, now })
    ]);
    assert.equal(left.length + right.length, 1);
    const claimed = [...left, ...right][0];
    assert.equal(claimed.netsuiteOrderId, orderId);
    assert.equal(claimed.attemptNumber, 1);
    const attempts = await query(
      `SELECT outcome, attempt_number
         FROM netsuite_delayed_status_refresh_attempts
        WHERE job_id = $1`,
      [claimed.jobId]
    );
    assert.deepEqual(attempts.rows, [{ outcome: "running", attempt_number: 1 }]);
  } finally {
    await cleanup([orderId]);
  }
});

test("DSR-R3: expired leases are evidenced, reclaimed, and stale tokens cannot finish", async () => {
  const orderId = identity(20);
  try {
    await enqueueDelayedStatusRefresh({
      orderType: "purchase_order",
      netsuiteOrderId: orderId,
      tranid: "DSR-PO-LEASE",
      availableAt: new Date("2026-08-19T11:59:00.000Z")
    });
    const [first] = await claimDueDelayedStatusRefreshJobs({
      workerId: "worker-before-restart",
      limit: 1,
      leaseMs: 1_000,
      now: new Date("2026-08-19T12:00:00.000Z")
    });
    const [reclaimed] = await claimDueDelayedStatusRefreshJobs({
      workerId: "worker-after-restart",
      limit: 1,
      leaseMs: 120_000,
      now: new Date("2026-08-19T12:00:02.000Z")
    });
    assert.equal(reclaimed.jobId, first.jobId);
    assert.equal(reclaimed.attemptNumber, 2);
    assert.notEqual(reclaimed.leaseToken, first.leaseToken);
    assert.equal(await lockDelayedStatusRefreshLease({ jobId: first.jobId, leaseToken: first.leaseToken }), false);
    assert.equal(await finishDelayedStatusRefreshAttempt({
      jobId: first.jobId,
      leaseToken: first.leaseToken,
      outcome: "succeeded",
      details: { stale: true }
    }), false);
    assert.equal(await lockDelayedStatusRefreshLease({ jobId: reclaimed.jobId, leaseToken: reclaimed.leaseToken }), true);
    assert.equal(await finishDelayedStatusRefreshAttempt({
      jobId: reclaimed.jobId,
      leaseToken: reclaimed.leaseToken,
      outcome: "succeeded",
      details: { refreshed: true }
    }), true);
    const attempts = await query(
      `SELECT attempt_number, outcome
         FROM netsuite_delayed_status_refresh_attempts
        WHERE job_id = $1
        ORDER BY attempt_number`,
      [first.jobId]
    );
    assert.deepEqual(attempts.rows, [
      { attempt_number: 1, outcome: "lease_expired" },
      { attempt_number: 2, outcome: "succeeded" }
    ]);
  } finally {
    await cleanup([orderId]);
  }
});

test("DSR-R4: a current token can renew before expiry but cannot resurrect an expired lease", async () => {
  const orderId = identity(30);
  try {
    await enqueueDelayedStatusRefresh({
      orderType: "purchase_order",
      netsuiteOrderId: orderId,
      tranid: "DSR-PO-RENEW",
      availableAt: new Date("2026-08-19T11:59:00.000Z")
    });
    const [claimed] = await claimDueDelayedStatusRefreshJobs({
      workerId: "worker-renew",
      limit: 1,
      leaseMs: 1_000,
      now: new Date("2026-08-19T12:00:00.000Z")
    });
    assert.equal(await renewDelayedStatusRefreshLease({
      jobId: claimed.jobId,
      leaseToken: claimed.leaseToken,
      leaseMs: 1_000,
      now: new Date("2026-08-19T12:00:00.500Z")
    }), true);
    assert.equal((await claimDueDelayedStatusRefreshJobs({
      workerId: "worker-too-early",
      limit: 1,
      leaseMs: 1_000,
      now: new Date("2026-08-19T12:00:01.200Z")
    })).length, 0);
    assert.equal(await renewDelayedStatusRefreshLease({
      jobId: claimed.jobId,
      leaseToken: claimed.leaseToken,
      leaseMs: 1_000,
      now: new Date("2026-08-19T12:00:01.600Z")
    }), false);
    const [reclaimed] = await claimDueDelayedStatusRefreshJobs({
      workerId: "worker-after-expiry",
      limit: 1,
      leaseMs: 1_000,
      now: new Date("2026-08-19T12:00:01.600Z")
    });
    assert.equal(reclaimed.jobId, claimed.jobId);
    assert.equal(reclaimed.attemptNumber, 2);
  } finally {
    await cleanup([orderId]);
  }
});

test("DSR-R5: the production repository/worker sequence moves a pending PO to Pending Receipt", async () => {
  const orderId = identity(40);
  const events = [];
  try {
    await query(
      `INSERT INTO purchase_orders (
         netsuite_id, tranid, status, status_text, netsuite_active, synced_at
       ) VALUES ($1, 'DSR-PO-END-TO-END', 'A', 'Purchase Order : Pending Supervisor Approval', false, now())`,
      [orderId]
    );
    await enqueueDelayedStatusRefresh({
      orderType: "purchase_order",
      netsuiteOrderId: orderId,
      tranid: "DSR-PO-END-TO-END",
      availableAt: new Date("2026-08-19T11:59:00.000Z")
    });
    const worker = createDelayedStatusRefreshWorker({
      claimJobs: claimDueDelayedStatusRefreshJobs,
      lockLease: lockDelayedStatusRefreshLease,
      renewLease: renewDelayedStatusRefreshLease,
      finishAttempt: finishDelayedStatusRefreshAttempt,
      fetchTransactionStatus: async () => ({
        tranid: "DSR-PO-END-TO-END",
        status: "B",
        status_text: "Purchase Order : Pending Receipt"
      }),
      fetchSalesOrderLines: async () => [],
      applyStatus: ({ netsuiteOrderId, status, statusText }) => (
        updatePurchaseOrderNetSuiteStatus(netsuiteOrderId, { status, statusText })
      ),
      applySalesOrderLines: async () => {},
      withTransaction,
      writeAudit,
      emitEvents: (entry) => events.push(entry),
      now: () => new Date("2026-08-19T12:00:00.000Z"),
      logger: { error() {} }
    });
    assert.deepEqual(await worker.runOnce({
      workerId: "end-to-end-worker",
      now: new Date("2026-08-19T12:00:00.000Z")
    }), {
      skipped: false,
      claimed: 1,
      succeeded: 1,
      retried: 0,
      failed: 0,
      stale: 0
    });
    const local = await query(
      "SELECT status, status_text FROM purchase_orders WHERE netsuite_id = $1",
      [orderId]
    );
    assert.deepEqual(local.rows[0], {
      status: "B",
      status_text: "Purchase Order : Pending Receipt"
    });
    const attempt = await query(
      `SELECT job.status AS job_status, attempt.outcome
         FROM netsuite_delayed_status_refresh_jobs job
         JOIN netsuite_delayed_status_refresh_attempts attempt ON attempt.job_id = job.id
        WHERE job.netsuite_order_id = $1`,
      [orderId]
    );
    assert.deepEqual(attempt.rows, [{ job_status: "succeeded", outcome: "succeeded" }]);
    const audit = await query(
      `SELECT action, details
         FROM delivery_audit_log
        WHERE action = 'netsuite.webhook.delayed_status_refresh'
          AND details->>'netsuiteOrderId' = $1
        ORDER BY id DESC
        LIMIT 1`,
      [String(orderId)]
    );
    assert.equal(audit.rows[0].details.jobId > 0, true);
    assert.equal(audit.rows[0].details.attemptNumber, 1);
    assert.deepEqual(events, [{
      orderType: "purchase_order",
      netsuiteOrderId: orderId,
      tranid: "DSR-PO-END-TO-END"
    }]);
  } finally {
    await cleanup([orderId]);
    await query(
      "DELETE FROM delivery_audit_log WHERE details->>'netsuiteOrderId' = $1",
      [String(orderId)]
    );
    await query("DELETE FROM purchase_orders WHERE netsuite_id = $1", [orderId]);
  }
});

test("DSR-R6: the real webhook writes its delayed job inside the caller transaction", async () => {
  const orderId = identity(50);
  await withTransaction(async () => {
    const result = await processNetSuiteOrderWebhook({
      recordType: "purchaseorder",
      eventType: "edit",
      id: orderId,
      tranid: "DSR-PO-WEBHOOK-TX",
      trandate: "2026-08-19",
      entityId: 700001,
      entityText: "Durable Refresh Test Vendor",
      status: "A",
      statusText: "Purchase Order : Pending Supervisor Approval",
      locationId: 1,
      locationText: "3445",
      lines: []
    });
    assert.equal(result.ok, true);
    const inside = await query(
      `SELECT status, tranid
         FROM netsuite_delayed_status_refresh_jobs
        WHERE order_type = 'purchase_order'
          AND netsuite_order_id = $1`,
      [orderId]
    );
    assert.deepEqual(inside.rows, [{ status: "pending", tranid: "DSR-PO-WEBHOOK-TX" }]);
  }, { rollback: true });

  const afterRollback = await query(
    `SELECT count(*)::integer AS count
       FROM netsuite_delayed_status_refresh_jobs
      WHERE netsuite_order_id = $1`,
    [orderId]
  );
  assert.equal(afterRollback.rows[0].count, 0);
  assert.equal((await query(
    "SELECT count(*)::integer AS count FROM purchase_orders WHERE netsuite_id = $1",
    [orderId]
  )).rows[0].count, 0);
});

test("DSR-R7: repeated worker crashes terminate after the eighth durable attempt", async () => {
  const orderId = identity(60);
  try {
    await enqueueDelayedStatusRefresh({
      orderType: "purchase_order",
      netsuiteOrderId: orderId,
      tranid: "DSR-PO-CRASH-BOUND",
      availableAt: new Date("2026-08-19T11:59:00.000Z")
    });
    let claimAt = new Date("2026-08-19T12:00:00.000Z");
    for (let attemptNumber = 1; attemptNumber <= 8; attemptNumber += 1) {
      const [claimed] = await claimDueDelayedStatusRefreshJobs({
        workerId: `crashing-worker-${attemptNumber}`,
        limit: 1,
        leaseMs: 1_000,
        now: claimAt
      });
      assert.equal(claimed.attemptNumber, attemptNumber);
      claimAt = new Date(claimAt.getTime() + 2_000);
    }
    assert.equal((await claimDueDelayedStatusRefreshJobs({
      workerId: "ninth-worker-must-not-claim",
      limit: 1,
      leaseMs: 1_000,
      now: claimAt
    })).length, 0);
    const jobState = await query(
      `SELECT status, attempt_count
         FROM netsuite_delayed_status_refresh_jobs
        WHERE netsuite_order_id = $1`,
      [orderId]
    );
    assert.deepEqual(jobState.rows, [{ status: "failed", attempt_count: 8 }]);
    const evidence = await query(
      `SELECT count(*)::integer AS count
         FROM netsuite_delayed_status_refresh_attempts attempt
         JOIN netsuite_delayed_status_refresh_jobs job ON job.id = attempt.job_id
        WHERE job.netsuite_order_id = $1
          AND attempt.outcome = 'lease_expired'`,
      [orderId]
    );
    assert.equal(evidence.rows[0].count, 8);
  } finally {
    await cleanup([orderId]);
  }
});

test("DSR-R8: a PostgreSQL audit error rolls back to its savepoint without erasing success evidence", async () => {
  const orderId = identity(70);
  try {
    await enqueueDelayedStatusRefresh({
      orderType: "purchase_order",
      netsuiteOrderId: orderId,
      tranid: "DSR-PO-AUDIT-SAVEPOINT",
      availableAt: new Date("2026-08-19T11:59:00.000Z")
    });
    const worker = createDelayedStatusRefreshWorker({
      claimJobs: claimDueDelayedStatusRefreshJobs,
      lockLease: lockDelayedStatusRefreshLease,
      renewLease: renewDelayedStatusRefreshLease,
      finishAttempt: finishDelayedStatusRefreshAttempt,
      fetchTransactionStatus: async () => ({ status: "B", status_text: "Pending Receipt" }),
      fetchSalesOrderLines: async () => [],
      applyStatus: async () => ({ updated: true }),
      applySalesOrderLines: async () => {},
      withTransaction,
      writeAudit: async () => query("INSERT INTO table_that_must_not_exist_for_dsr_test VALUES (1)"),
      emitEvents: () => {},
      now: () => new Date("2026-08-19T12:00:00.000Z"),
      logger: { error() {} }
    });
    assert.equal((await worker.runOnce({
      workerId: "audit-savepoint-worker",
      now: new Date("2026-08-19T12:00:00.000Z")
    })).succeeded, 1);
    const evidence = await query(
      `SELECT job.status, attempt.outcome
         FROM netsuite_delayed_status_refresh_jobs job
         JOIN netsuite_delayed_status_refresh_attempts attempt ON attempt.job_id = job.id
        WHERE job.netsuite_order_id = $1`,
      [orderId]
    );
    assert.deepEqual(evidence.rows, [{ status: "succeeded", outcome: "succeeded" }]);
  } finally {
    await cleanup([orderId]);
  }
});
