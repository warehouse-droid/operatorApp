// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before } from "node:test";

import { createOperator } from "../../../src/auth-repository.js";
import { closeDb, query } from "../../../src/db.js";
import { buildOperatorNetSuitePostingDraft } from "../../../src/operator-netsuite-posting-domain.js";
import {
  assertNoActiveOperatorNetSuitePostingClaims,
  claimOperatorNetSuitePostingCommand,
  completeOperatorNetSuitePostingCommand,
  createOrReplayOperatorNetSuitePostingCommand,
  failOperatorNetSuitePostingCommand,
  getOperatorNetSuitePostingCommand,
  listOperatorNetSuitePostingAttentionCommands,
  markOperatorNetSuitePostingCommandAttention,
  recordOperatorNetSuitePostingStepFailure,
  recordOperatorNetSuitePostingStepSuccess,
  renewOperatorNetSuitePostingLease,
  resumeOperatorNetSuitePostingCommand,
  startOperatorNetSuitePostingAttempt
} from "../../../src/operator-netsuite-posting-repository.js";

const RUN_ID = crypto.randomUUID().replaceAll("-", "");
let operatorId = "";

function draft({ requestId = crypto.randomUUID(), localOrderKey = `SO:${RUN_ID}`, photo = "r2://operator/a.jpg" } = {}) {
  return buildOperatorNetSuitePostingDraft({
    requestId,
    actorOperatorId: operatorId,
    functionKey: "delivery_prep",
    transactionType: "IF",
    policy: {
      gateKey: "operator_netsuite_delivery_prep_if_12441",
      revision: 1,
      effective: true,
      functionKey: "delivery_prep",
      transactionType: "IF",
      locationId: 15,
      yardCode: "12441"
    },
    photoRefs: [photo],
    localOrderKeys: [localOrderKey],
    localOperation: {
      kind: "delivery_prep_load",
      orderId: localOrderKey,
      orderType: "sales_order"
    },
    targets: [{
      sourceOrderKind: "SO",
      sourceNetSuiteId: 9_000_000 + Number.parseInt(RUN_ID.slice(0, 5), 16),
      sourceOrderRef: `SO-${RUN_ID.slice(0, 8)}`,
      selectedLines: [{
        orderLine: 1,
        quantity: 2,
        location: 15,
        localOrderKey,
        localLineId: "line-1"
      }],
      availableLines: [
        { orderLine: 1, location: 15 },
        { orderLine: 2, location: 15 }
      ]
    }]
  });
}

before(async () => {
  const operator = await createOperator({
    username: `operator-posting-${RUN_ID}`,
    displayName: `Operator Posting ${RUN_ID}`,
    password: "operator-posting-test",
    role: "operator",
    roles: ["operator"],
    yardLocationIds: [15]
  });
  operatorId = operator.id;
});

after(async () => {
  await closeDb();
});

test("P5 create/replay is durable, payload-bound, and owns one active order claim", async () => {
  const commandDraft = draft();
  const first = await createOrReplayOperatorNetSuitePostingCommand(commandDraft);
  assert.equal(first.replayed, false);
  assert.equal(first.command.id, commandDraft.requestId);
  assert.equal(first.command.status, "queued");
  assert.equal(first.command.steps.length, 1);
  assert.equal(first.command.steps[0].status, "pending");
  assert.deepEqual(first.command.activeClaims, commandDraft.claims);
  await assert.rejects(
    assertNoActiveOperatorNetSuitePostingClaims({
      functionKey: commandDraft.functionKey,
      localOrderKeys: commandDraft.claims
    }),
    (error) => error?.code === "OPERATOR_NETSUITE_POSTING_IN_PROGRESS"
  );
  await assert.doesNotReject(assertNoActiveOperatorNetSuitePostingClaims({
    functionKey: commandDraft.functionKey,
    localOrderKeys: commandDraft.claims.map((claim) => `${claim}-near-collision`)
  }));

  const replay = await createOrReplayOperatorNetSuitePostingCommand(commandDraft);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.command, first.command);

  await assert.rejects(
    createOrReplayOperatorNetSuitePostingCommand(draft({
      requestId: commandDraft.requestId,
      localOrderKey: commandDraft.claims[0],
      photo: "r2://operator/different.jpg"
    })),
    (error) => error?.status === 409 && error?.code === "OPERATOR_NETSUITE_POSTING_IDEMPOTENCY_CONFLICT"
  );

  await assert.rejects(
    createOrReplayOperatorNetSuitePostingCommand(draft({ localOrderKey: commandDraft.claims[0] })),
    (error) => error?.status === 409 && error?.code === "OPERATOR_NETSUITE_POSTING_ORDER_CLAIMED"
  );

  const counts = await query(
    `SELECT
       (SELECT count(*)::int FROM operator_netsuite_posting_commands WHERE id = $1) AS commands,
       (SELECT count(*)::int FROM operator_netsuite_posting_steps WHERE command_id = $1) AS steps,
       (SELECT count(*)::int FROM operator_netsuite_posting_order_claims WHERE command_id = $1 AND active) AS claims`,
    [commandDraft.requestId]
  );
  assert.deepEqual(counts.rows[0], { commands: 1, steps: 1, claims: 1 });
});

test("P5/P6 one worker owns a lease, records immutable attempts, and completes once", async () => {
  const commandDraft = draft({ localOrderKey: `SO:${RUN_ID}:lease` });
  await createOrReplayOperatorNetSuitePostingCommand(commandDraft);
  const [left, right] = await Promise.all([
    claimOperatorNetSuitePostingCommand({ commandId: commandDraft.requestId, workerId: "worker-left", leaseSeconds: 30 }),
    claimOperatorNetSuitePostingCommand({ commandId: commandDraft.requestId, workerId: "worker-right", leaseSeconds: 30 })
  ]);
  const claimed = left || right;
  assert.ok(claimed);
  assert.equal(Boolean(left) + Boolean(right), 1);
  assert.equal(claimed.status, "posting");
  assert.match(claimed.leaseToken, /^[0-9a-f-]{36}$/u);

  const originalLeaseExpiry = new Date(claimed.leaseExpiresAt).getTime();
  const renewed = await renewOperatorNetSuitePostingLease({
    commandId: claimed.id,
    leaseToken: claimed.leaseToken,
    leaseSeconds: 180
  });
  assert.ok(new Date(renewed.leaseExpiresAt).getTime() > originalLeaseExpiry);
  await assert.rejects(
    renewOperatorNetSuitePostingLease({
      commandId: claimed.id,
      leaseToken: crypto.randomUUID(),
      leaseSeconds: 180
    }),
    (error) => error?.code === "OPERATOR_NETSUITE_POSTING_LEASE_LOST"
  );

  const step = claimed.steps[0];
  const attempt = await startOperatorNetSuitePostingAttempt({
    commandId: claimed.id,
    stepId: step.id,
    leaseToken: claimed.leaseToken
  });
  assert.equal(attempt.attemptNumber, 1);
  assert.equal(attempt.step.status, "posting");

  const posted = await recordOperatorNetSuitePostingStepSuccess({
    commandId: claimed.id,
    stepId: step.id,
    leaseToken: claimed.leaseToken,
    attemptNumber: attempt.attemptNumber,
    transactionId: 778899,
    transactionRef: "IF778899",
    response: { recoveredBy: "external_id" },
    recovered: true
  });
  assert.equal(posted.status, "posted");
  assert.equal(posted.netSuiteTransactionId, 778899);
  assert.equal(posted.netSuiteTransactionRef, "IF778899");

  await assert.rejects(
    startOperatorNetSuitePostingAttempt({
      commandId: claimed.id,
      stepId: step.id,
      leaseToken: claimed.leaseToken
    }),
    (error) => error?.status === 409 && error?.code === "OPERATOR_NETSUITE_POSTING_STEP_ALREADY_POSTED"
  );

  await assert.rejects(
    completeOperatorNetSuitePostingCommand({
      commandId: claimed.id,
      leaseToken: claimed.leaseToken,
      result: { ok: true },
      finalize: async () => {
        throw new Error("synthetic local finalization failure");
      }
    }),
    /synthetic local finalization failure/u
  );
  const afterRollback = await getOperatorNetSuitePostingCommand(claimed.id);
  assert.equal(afterRollback.status, "posting");
  assert.deepEqual(afterRollback.activeClaims, commandDraft.claims);

  const completed = await completeOperatorNetSuitePostingCommand({
    commandId: claimed.id,
    leaseToken: claimed.leaseToken,
    result: { ok: true, itemFulfillmentTranid: "IF778899" },
    finalize: async () => ({ locallyFinalized: true })
  });
  assert.equal(completed.status, "completed");
  assert.equal(completed.result.itemFulfillmentTranid, "IF778899");
  assert.deepEqual(completed.result.localFinalization, { locallyFinalized: true });
  assert.deepEqual(completed.activeClaims, []);

  const replay = await completeOperatorNetSuitePostingCommand({
    commandId: claimed.id,
    leaseToken: claimed.leaseToken,
    result: { ignored: true },
    finalize: async () => {
      throw new Error("completed replay must not finalize again");
    }
  });
  assert.deepEqual(replay, completed);

  const replacement = await createOrReplayOperatorNetSuitePostingCommand(draft({
    localOrderKey: commandDraft.claims[0]
  }));
  assert.equal(replacement.replayed, false, "Completion must release the durable active claim.");
});

test("P6/P8 an expired lease is recoverable and an uncertain step moves to attention", async () => {
  const commandDraft = draft({ localOrderKey: `SO:${RUN_ID}:recovery` });
  await createOrReplayOperatorNetSuitePostingCommand(commandDraft);
  const first = await claimOperatorNetSuitePostingCommand({
    commandId: commandDraft.requestId,
    workerId: "worker-before-crash",
    leaseSeconds: 30
  });
  assert.ok(first);
  await query(
    `UPDATE operator_netsuite_posting_commands
        SET lease_expires_at = now() - interval '1 second'
      WHERE id = $1`,
    [first.id]
  );
  const recovered = await claimOperatorNetSuitePostingCommand({
    commandId: commandDraft.requestId,
    workerId: "worker-after-crash",
    leaseSeconds: 45
  });
  assert.ok(recovered);
  assert.notEqual(recovered.leaseToken, first.leaseToken);
  assert.equal(recovered.leaseOwner, "worker-after-crash");

  const attempt = await startOperatorNetSuitePostingAttempt({
    commandId: recovered.id,
    stepId: recovered.steps[0].id,
    leaseToken: recovered.leaseToken
  });
  const uncertain = await recordOperatorNetSuitePostingStepFailure({
    commandId: recovered.id,
    stepId: recovered.steps[0].id,
    leaseToken: recovered.leaseToken,
    attemptNumber: attempt.attemptNumber,
    error: new Error("response lost after transform"),
    uncertain: true
  });
  assert.equal(uncertain.status, "uncertain");

  const attention = await markOperatorNetSuitePostingCommandAttention({
    commandId: recovered.id,
    leaseToken: recovered.leaseToken,
    error: "NetSuite result needs external-ID verification"
  });
  assert.equal(attention.status, "attention");
  assert.equal(attention.leaseToken, null);
  assert.deepEqual(attention.activeClaims, commandDraft.claims);

  const automatic = await claimOperatorNetSuitePostingCommand({
    commandId: recovered.id,
    workerId: "automatic-worker",
    leaseSeconds: 30
  });
  assert.equal(automatic, null, "Attention commands require an explicit resume.");

  const attentionList = await listOperatorNetSuitePostingAttentionCommands({ limit: 20 });
  assert.ok(attentionList.some((command) => command.id === recovered.id));
  const resumed = await resumeOperatorNetSuitePostingCommand(recovered.id);
  assert.equal(resumed.status, "queued");
  assert.deepEqual(resumed.activeClaims, commandDraft.claims);
  const explicitlyClaimed = await claimOperatorNetSuitePostingCommand({
    commandId: recovered.id,
    workerId: "explicit-worker",
    leaseSeconds: 30
  });
  assert.ok(explicitlyClaimed);
});

test("P7 a definitive pre-write failure releases claims, but posted work cannot be failed", async () => {
  const commandDraft = draft({ localOrderKey: `SO:${RUN_ID}:definitive` });
  await createOrReplayOperatorNetSuitePostingCommand(commandDraft);
  const claimed = await claimOperatorNetSuitePostingCommand({
    commandId: commandDraft.requestId,
    workerId: "definitive-worker",
    leaseSeconds: 30
  });
  const attempt = await startOperatorNetSuitePostingAttempt({
    commandId: claimed.id,
    stepId: claimed.steps[0].id,
    leaseToken: claimed.leaseToken
  });
  await recordOperatorNetSuitePostingStepFailure({
    commandId: claimed.id,
    stepId: claimed.steps[0].id,
    leaseToken: claimed.leaseToken,
    attemptNumber: attempt.attemptNumber,
    error: new Error("definitive validation failure"),
    uncertain: false
  });
  const failed = await failOperatorNetSuitePostingCommand({
    commandId: claimed.id,
    leaseToken: claimed.leaseToken,
    error: "definitive validation failure"
  });
  assert.equal(failed.status, "failed");
  assert.deepEqual(failed.activeClaims, []);

  const postedDraft = draft({ localOrderKey: `SO:${RUN_ID}:posted-cannot-fail` });
  await createOrReplayOperatorNetSuitePostingCommand(postedDraft);
  const postedClaim = await claimOperatorNetSuitePostingCommand({
    commandId: postedDraft.requestId,
    workerId: "posted-worker",
    leaseSeconds: 30
  });
  const postedAttempt = await startOperatorNetSuitePostingAttempt({
    commandId: postedClaim.id,
    stepId: postedClaim.steps[0].id,
    leaseToken: postedClaim.leaseToken
  });
  await recordOperatorNetSuitePostingStepSuccess({
    commandId: postedClaim.id,
    stepId: postedClaim.steps[0].id,
    leaseToken: postedClaim.leaseToken,
    attemptNumber: postedAttempt.attemptNumber,
    transactionId: 991122,
    transactionRef: "IF991122"
  });
  await assert.rejects(
    failOperatorNetSuitePostingCommand({
      commandId: postedClaim.id,
      leaseToken: postedClaim.leaseToken,
      error: "must not release"
    }),
    (error) => error?.status === 409 && error?.code === "OPERATOR_NETSUITE_POSTING_REMOTE_WORK_EXISTS"
  );
});
