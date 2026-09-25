// Read-only real PO replay: never enters command admission or a transform.
import assert from "node:assert/strict";
import { pool, query, withTransaction } from "/app/src/db.js";
import { buildOperatorNetSuitePostingDraft } from "/app/src/operator-netsuite-posting-domain.js";
import { findOperatorNetSuitePostingTransactionByExternalId } from "/app/src/netsuite.js";

const { resolveOperatorNetSuitePostingTargets } = await import(TARGET_MODULE_URL);
const requestId = "de870108-fe99-4ee0-a19d-bb86b1631863";
const externalId = `MBBS-OP-${requestId}-1`;
pool.options.options = "-c jit=off -c default_transaction_read_only=on -c statement_timeout=30000";
try {
  assert.equal(await findOperatorNetSuitePostingTransactionByExternalId(externalId, "IR", 945685, { direct: true }), null);
  const health = await fetch("http://127.0.0.1:3000/health");
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
  const publicHealth = await fetch("https://test.mbbsoperation.com/health");
  assert.equal(publicHealth.status, 200);
  assert.equal((await publicHealth.json()).ok, true);
  await withTransaction(async () => {
    await query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    const before = (await query("SELECT status,updated_at FROM operator_netsuite_posting_commands WHERE id=$1", [requestId])).rows;
    assert.equal(before[0].status, "failed");
    const resolution = await resolveOperatorNetSuitePostingTargets({ functionKey: "receiving", orderId: 945685,
      orderType: "purchase_order", clientLocationId: 1 });
    const draft = buildOperatorNetSuitePostingDraft({ ...resolution, requestId, actorOperatorId: "read-only-replay", photoRefs: [],
      policy: { gateKey: "operator_netsuite_receiving_ir_3445", revision: 1, effective: true,
        functionKey: "receiving", transactionType: "IR", locationId: 1, yardCode: "3445" } });
    assert.equal(draft.steps.length, 1);
    const step = draft.steps[0];
    assert.equal(draft.inputSnapshot.postingStrategy, "stored_order_line_v1");
    assert.equal(step.sourceNetSuiteId, 945685);
    assert.equal(step.payload.memo, "POB03684");
    assert.equal(step.payload.custbody9, "POB03684");
    assert.equal(step.externalId, externalId);
    assert.deepEqual(step.payload.item.items, [
      { orderLine: 6, location: 1, itemReceive: true, quantity: 108 },
      { orderLine: 29, location: 1, itemReceive: true, quantity: 304 },
      { orderLine: 33, location: 1, itemReceive: false }
    ]);
    assert.deepEqual((await query("SELECT status,updated_at FROM operator_netsuite_posting_commands WHERE id=$1", [requestId])).rows, before);
    console.log(JSON.stringify({ mode: "read-only; no receipt submitted", observedAt: new Date().toISOString(),
      health: health.status, publicHealth: publicHealth.status, failedAttemptHasNoReceipt: true, failedCommandUnchanged: true,
      sourceOrder: "POB03684", sourceId: step.sourceNetSuiteId, rows: step.payload.item.items }, null, 2));
  }, { rollback: true });
} finally { await pool.end(); }
