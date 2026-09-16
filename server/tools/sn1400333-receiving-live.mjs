import assert from "node:assert/strict";
import { query, withTransaction, pool } from "../src/db.js";
import { buildOperatorNetSuitePostingDraft } from "../src/operator-netsuite-posting-domain.js";
import { resolveOperatorNetSuitePostingTargets } from "../src/operator-netsuite-posting-targets.js";
import { findOperatorNetSuitePostingTransactionByExternalId } from "../src/netsuite.js";

// This executable never calls the posting service, adapter transform or finalizer.
try {
  await withTransaction(async () => {
    await query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    const stored = (await query(`SELECT request_id, input_snapshot, status
      FROM operator_netsuite_posting_commands WHERE id=$1`,
    ["f9f45e36-c256-4d33-b4e0-9c97c97a4b82"])).rows[0];
    assert.ok(stored);
    const snapshot = stored.input_snapshot;
    const resolution = await resolveOperatorNetSuitePostingTargets({
      functionKey: "receiving", orderId: snapshot.localOperation.orderId,
      orderType: "purchase_order", clientLocationId: snapshot.policy.locationId
    });
    const draft = buildOperatorNetSuitePostingDraft({ ...snapshot, ...resolution });
    assert.equal(draft.steps.length, 1);
    const step = draft.steps[0];
    assert.equal(step.sourceNetSuiteId, 936958);
    assert.equal(step.sourceOrderRef, "POB03658");
    assert.equal(step.payload.memo, "SN1400333");
    const old = snapshot.steps[0].payload.item.items;
    const selected = items => items.filter(line => line.itemReceive).map(line => ({
      orderLine: line.orderLine, quantity: line.quantity, location: line.location
    }));
    assert.deepEqual(selected(step.payload.item.items), selected(old));
    const retained = new Set(step.payload.item.items.map(line => line.orderLine));
    const omitted = old.filter(line => !retained.has(line.orderLine)).map(line => line.orderLine);
    assert.deepEqual(omitted, [9, 16, 20, 29, 37]);
    const existing = await findOperatorNetSuitePostingTransactionByExternalId(step.externalId, "IR", 936958);
    assert.equal(existing, null);
    console.log(JSON.stringify({ readAt: new Date().toISOString(), mode: "read-only; no transaction submitted",
      storedCommandStatus: stored.status, sourceOrderRef: step.sourceOrderRef,
      sourceNetSuiteId: step.sourceNetSuiteId, memo: step.payload.memo,
      previousLineCount: old.length, correctedLineCount: step.payload.item.items.length,
      omittedCompletedLines: omitted, selected: selected(step.payload.item.items),
      existingReceiptForFailedRequest: existing, payload: step.payload }, null, 2));
  });
} finally {
  await pool.end();
}
