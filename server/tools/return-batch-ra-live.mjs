// Run via docker exec -i APP node --input-type=module - MODE < this file.
// Imports resolve against /app when this reviewed maintenance script is streamed.
import assert from "node:assert/strict";
import { query, withTransaction, closeDb } from "./src/db.js";
import { writeAudit } from "./src/auth-repository.js";
import { admitExistingReturnBatchAuthorization, syncReturnRecord, getReturnRecordDetail } from "./src/return-repository.js";
import { findReturnTransactionByExternalId } from "./src/return-netsuite.js";
import { verifyReturnBatchSnapshot } from "./src/return-batch-ra-domain.js";

const mode = process.argv[2];
assert.ok(["enable", "recover", "retry-rejected", "verify"].includes(mode));
try {
  if (mode === "enable") {
    const flags = await withTransaction(async () => {
      const before = await query("SELECT flag_key,enabled,revision FROM mbt_feature_flags WHERE flag_key=ANY($1::text[]) ORDER BY flag_key FOR UPDATE",
        [["3445", "2967", "12441", "150"].flatMap(yard => ["stock", "pallet"].map(kind => `operator_netsuite_${kind}_return_ra_${yard}`))]);
      assert.equal(before.rowCount, 8);
      const after = await query(`UPDATE mbt_feature_flags SET enabled=true,revision=revision+1,
        updated_by='system:return-batch-ra-deployment',updated_at=now()
        WHERE flag_key=ANY($1::text[]) AND enabled=false RETURNING flag_key,enabled,revision`, [before.rows.map(row => row.flag_key)]);
      await writeAudit({ actorType: "system", source: "returns", action: "returns.netsuite.ra.automation_enabled",
        details: { reason: "User requested automatic Return Authorizations at the operator receiving yard, with one RA for stock and pallets.",
          before: before.rows, after: after.rows, release: "return-batch-ra-20260918" } });
      return after.rows;
    });
    console.log(JSON.stringify({ enabled: flags }));
  } else if (mode === "recover") {
    const stock = await getReturnRecordDetail(26);
    const pallet = await getReturnRecordDetail(27);
    assert.equal(stock.batchReference, "RB-000004");
    assert.equal(pallet.batchReference, stock.batchReference);
    assert.equal(stock.receivingLocationId, 28);
    assert.equal(pallet.receivingLocationId, 28);
    assert.equal(stock.sourceSalesOrderId, 987342);
    assert.equal(pallet.palletQuantity, 2);
    assert.equal(stock.lines.length, 3);
    assert.ok(Math.abs(stock.lines.reduce((sum, line) => sum + Number(line.returnedSalesQuantity), 0) - 45.45) < 0.000001);
    assert.equal(stock.netSuiteSyncAttempts, 0);
    assert.equal(pallet.netSuiteSyncAttempts, 0);
    for (const externalId of ["MBBS-RB-000004", "MBBS-SR-000004", "MBBS-PR-000001"]) {
      for (const type of ["return_authorization", "credit_memo"]) {
        assert.equal(await findReturnTransactionByExternalId(externalId, type), null, `Existing transaction for ${externalId}`);
      }
    }
    await admitExistingReturnBatchAuthorization({ batchReference: "RB-000004" });
    const result = await syncReturnRecord({ recordId: 26 });
    console.log(JSON.stringify({ batchReference: result.batchReference, status: result.netSuiteSyncStatus,
      transactionId: result.netSuiteTransactionId, reference: result.netSuiteTransactionRef, receivingLocationId: result.receivingLocationId }));
  } else if (mode === "retry-rejected") {
    const stock = await getReturnRecordDetail(26);
    assert.equal(stock.batchReference, "RB-000004");
    for (const externalId of ["MBBS-RB-000004", "MBBS-SR-000004", "MBBS-PR-000001"]) {
      for (const type of ["return_authorization", "credit_memo"]) {
        assert.equal(await findReturnTransactionByExternalId(externalId, type), null);
      }
    }
    await withTransaction(async () => {
      await query("SELECT pg_advisory_xact_lock(hashtext($1))", [`return-batch-ra:${stock.batchId}`]);
      const result = await query("SELECT * FROM return_batch_authorizations WHERE batch_id=$1 FOR UPDATE", [stock.batchId]);
      const batch = result.rows[0];
      assert.equal(batch.netsuite_transaction_id, null);
      assert.equal(Number(batch.sync_attempts), 1);
      // The durable sync event retains the original HTTP response even if the
      // recovery worker has since recorded an uncertain lookup result.
      const rejected = await query(`SELECT 1 FROM return_sync_events WHERE return_record_id=26
        AND error LIKE '%NetSuite REST failed: 400%' AND error LIKE '%DUPLICATE_KEYS%'
        AND error LIKE '%item.items[?(@.orderLine==1)]%'`);
      assert.ok(rejected.rowCount > 0);
      await query("UPDATE return_batch_authorizations SET attempted_at=NULL,sync_status='pending',sync_error=NULL WHERE batch_id=$1", [stock.batchId]);
      await query("UPDATE return_records SET netsuite_sync_status='pending',netsuite_sync_error=NULL WHERE batch_id=$1", [stock.batchId]);
      await writeAudit({ actorType: "system", source: "returns", action: "returns.netsuite.ra.rejected_attempt_released",
        details: { batchReference: "RB-000004", reason: "Confirmed HTTP 400 DUPLICATE_KEYS on item orderLine; all six external-ID lookups empty. Retry same intent with unique REST row keys." } });
    });
    const result = await syncReturnRecord({ recordId: 26 });
    console.log(JSON.stringify({ batchReference: result.batchReference, status: result.netSuiteSyncStatus,
      transactionId: result.netSuiteTransactionId, reference: result.netSuiteTransactionRef, receivingLocationId: result.receivingLocationId }));
  } else {
    const before = await getReturnRecordDetail(27);
    assert.equal(before.netSuiteTransactionId, 997297);
    assert.equal(before.netSuiteSyncStatus, "cancelled");
    const retried = await syncReturnRecord({ recordId: 27 });
    assert.equal(retried.netSuiteSyncStatus, "cancelled");
    assert.equal(retried.netSuiteSyncAttempts, before.netSuiteSyncAttempts);
    const stock = await getReturnRecordDetail(26);
    const pallet = await getReturnRecordDetail(27);
    assert.equal(stock.netSuiteTransactionId, pallet.netSuiteTransactionId);
    const result = await query("SELECT * FROM return_batch_authorizations WHERE batch_id=$1", [stock.batchId]);
    const authority = result.rows[0];
    assert.ok(authority?.netsuite_transaction_id);
    const snapshot = authority.netsuite_snapshot;
    verifyReturnBatchSnapshot({ ...authority.intent_snapshot, netSuiteTransactionId: authority.netsuite_transaction_id }, snapshot, { allowInactive: true });
    // The user confirmed this RA was intentionally cancelled. Verification must
    // preserve that state and its shared identity; it must never reopen it.
    assert.equal(stock.netSuiteTransactionId, 997297);
    assert.equal(stock.netSuiteTransactionRef, "RMAB01506");
    assert.equal(stock.netSuiteSyncStatus, "cancelled");
    assert.equal(pallet.netSuiteSyncStatus, "cancelled");
    assert.match(String(snapshot.status?.refName || snapshot.status), /cancelled/i);
    const duplicates = [];
    for (const externalId of ["MBBS-RB-000004", "MBBS-SR-000004", "MBBS-PR-000001"]) {
      for (const type of ["return_authorization", "credit_memo"]) {
        const found = await findReturnTransactionByExternalId(externalId, type);
        if (found) {duplicates.push({ externalId, type, id: Number(found.id) });}
      }
    }
    assert.deepEqual(duplicates, [{ externalId: "MBBS-RB-000004", type: "return_authorization", id: stock.netSuiteTransactionId }]);
    console.log(JSON.stringify({ batchReference: stock.batchReference, reference: snapshot.tranId || snapshot.tranid,
      transactionId: stock.netSuiteTransactionId, stockStatus: stock.netSuiteSyncStatus, palletStatus: pallet.netSuiteSyncStatus,
      receivingLocationId: snapshot.location?.id, externalId: snapshot.externalId, sourceSalesOrderId: snapshot.createdFrom?.id,
      transactions: duplicates, rows: snapshot.item.items.map(line => ({ itemId: line.item?.id, quantity: line.quantity, rate: line.rate,
        reasonId: line.custcol_atlas_rc_so?.id, locationId: line.location?.id, orderLine: line.orderLine })) }));
  }
} finally { await closeDb(); }
