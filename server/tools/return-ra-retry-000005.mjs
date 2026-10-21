// One authorized recovery of SR-000005. Stream into the running app with Node.
import assert from "node:assert/strict";
import { query, closeDb } from "./src/db.js";
import { syncReturnRecord } from "./src/return-repository.js";
import { findReturnTransactionByExternalId } from "./src/return-netsuite.js";

const transport = globalThis.fetch;
let creates = 0;
try {
  const result = await query(`SELECT r.id,r.operator_id,a.* FROM return_records r
    JOIN return_batch_authorizations a ON a.batch_id=r.batch_id
    WHERE r.record_reference='SR-000005' AND r.source_sales_order_id=1006905`);
  assert.equal(result.rowCount, 1);
  const batch = result.rows[0];
  assert.equal(Number(batch.batch_id), 20);
  assert.equal(batch.external_id, "MBBS-RB-000006");
  assert.equal(batch.sync_status, "failed");
  assert.equal(batch.netsuite_transaction_id, null);
  assert.equal(batch.attempted_at, null);
  assert.equal(await findReturnTransactionByExternalId(batch.external_id, "return_authorization"), null);
  const expected = [[1, "3026", 71.47, 3.98, "483", "6"], [2, "5020", 30.63, 4.28, "486", "6"]];
  globalThis.fetch = async (url, options = {}) => {
    const address = String(url?.url || url);
    if (/\/record\/v1\//.test(address) && ["POST", "PATCH", "DELETE"].includes(options.method)) {
      assert.equal(options.method, "POST");
      assert.match(address, /\/salesOrder\/1006905\/!transform\/returnAuthorization\?replace=item$/);
      const body = JSON.parse(options.body);
      assert.equal(body.externalId, batch.external_id);
      assert.equal(body.location.id, "26");
      assert.deepEqual(body.item.items.map(row => [row.orderLine, row.item.id, row.quantity, row.rate,
        String(row.units?.id ?? row.units), row.custcol_atlas_rc_so.id]), expected);
      assert.equal(++creates, 1);
      // The tested scalar serialization fix, scoped to this single recovery process.
      body.item.items = body.item.items.map(row => ({ ...row, units: String(row.units?.id ?? row.units) }));
      return transport(url, { ...options, body: JSON.stringify(body) });
    }
    return transport(url, options);
  };
  const saved = await syncReturnRecord({ recordId: Number(batch.id), actorOperatorId: batch.operator_id });
  assert.equal(saved.netSuiteSyncStatus, "succeeded");
  assert.ok(saved.netSuiteTransactionId);
  console.log(JSON.stringify({ succeeded: true, record: saved.recordReference,
    batchId: saved.batchId, transactionId: saved.netSuiteTransactionId,
    transactionRef: saved.netSuiteTransactionRef, creates, verifiedQuantities: expected.map(row => row[2]) }));
} catch (problem) {
  console.log(JSON.stringify({ succeeded: false, creates, code: problem.code, error: problem.message }));
  process.exitCode = 1;
} finally {
  globalThis.fetch = transport;
  await closeDb();
}
