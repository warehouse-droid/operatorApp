import assert from "node:assert/strict";
import test, { after } from "node:test";
import { closeDb, query, withTransaction } from "../../../src/db.js";
import { submitReturnBatch, syncReturnRecord, getReturnRecordDetail, localPalletReserved, localStockReserved,
  voidReturnRecord, reconcileReturnRecords, processPendingReturnSyncs, linkReturnNetSuiteTransaction, admitExistingReturnBatchAuthorization } from "../../../src/return-repository.js";
import { listOperatorHistory } from "../../../src/history-repository.js";
import { fixture, submitInput, actor, reasonPhotos } from "../../support/return-batch-ra-fixture.js";

after(closeDb);
const submit = input => submitReturnBatch({ operatorId: actor, input });
const creates = remote => remote.requests.filter(r => r.method === "POST" && /\/record\/.*(?:returnAuthorization|creditMemo)/i.test(r.address));

test("B1/B3 mixed stock and PALLET confirmation creates one Return Authorization with a shared RMA number", async t => {
  const remote = await fixture(t);
  const input = await submitInput({ pallet: true });
  input.stockReturnType = "quality";
  input.lines = [6, 7, 8].map((reasonId, i) => ({ sourceLineId: 99091703, salesQuantity: i + 1, reasonId, photos: reasonPhotos }));
  const result = await submit(input);
  assert.equal(creates(remote).length, 1);
  assert.equal(remote.created.size, 1);
  assert.equal(result.records.length, 2);
  const [ra] = remote.created.values();
  assert.equal(ra.item.items.length, 4);
  assert.deepEqual(ra.item.items.map(line => line.custcol_atlas_rc_so.id), ["6", "7", "8", "10"]);
  assert.equal(ra.item.items[3].rate, 40);
  assert.equal(ra.item.items[3].quantity, 1);
  assert.ok(result.records.every(record => record.netSuiteSyncStatus === "succeeded"));
  assert.ok(result.records.every(record => record.netSuiteTransactionRef === ra.tranId));
  assert.equal(result.stockReturn.netSuiteTransactionId, result.palletReturn.netSuiteTransactionId);
  assert.ok(result.records.every(record => record.workflowVersion === 3));
  assert.equal((await submit(input)).idempotentReplay, true);
  await syncReturnRecord({ recordId: result.palletReturn.id });
  assert.equal(creates(remote).length, 1);
});

test("D1 twelve simultaneous stock/pallet retries share one RA without exhausting the connection pool", async t => {
  const remote = await fixture(t);
  const result = await submitReturnBatch({ operatorId: actor, input: await submitInput({ pallet: true }), autoSync: false });
  const replies = await Promise.all(Array.from({ length: 12 }, (_, i) => syncReturnRecord({ recordId: result.records[i % 2].id })));
  assert.equal(creates(remote).length, 1);
  assert.equal(new Set(replies.map(record => record.netSuiteTransactionId)).size, 1);
  assert.ok(replies.every(record => record.netSuiteSyncStatus === "succeeded"));
});

test("D1 a lost creation response recovers the same RA from the other member record", async t => {
  const remote = await fixture(t);
  remote.control.failAfterCreate = true;
  const result = await submit(await submitInput({ pallet: true }));
  assert.ok(result.records.every(record => record.netSuiteSyncStatus === "failed"));
  assert.equal(creates(remote).length, 1);
  const recovered = await syncReturnRecord({ recordId: result.palletReturn.id });
  assert.equal(recovered.netSuiteSyncStatus, "succeeded");
  assert.equal(creates(remote).length, 1);
  assert.equal((await getReturnRecordDetail(result.stockReturn.id)).netSuiteTransactionRef, recovered.netSuiteTransactionRef);
});

test("D1 an unfindable uncertain RA never creates a replacement and cannot be voided", async t => {
  const remote = await fixture(t);
  remote.control.failAfterCreate = true;
  remote.control.hideExternalId = true;
  const result = await submit(await submitInput({ pallet: true }));
  await assert.rejects(syncReturnRecord({ recordId: result.palletReturn.id }), { code: "RETURN_RA_CREATION_UNCERTAIN" });
  await assert.rejects(voidReturnRecord({ recordId: result.stockReturn.id, actorOperatorId: actor, reason: "Do not lose uncertain RA" }), /unconfirmed|uncertain/i);
  assert.equal(creates(remote).length, 1);
});

test("D2 a bad PALLET readback fails the whole batch and retains its ID for recovery", async t => {
  const remote = await fixture(t);
  remote.control.alter = snapshot => { snapshot.item.items.at(-1).quantity += 1; };
  const result = await submit(await submitInput({ pallet: true }));
  assert.ok(result.records.every(record => record.netSuiteSyncStatus === "failed"));
  assert.ok(result.records.every(record => record.netSuiteTransactionId > 0));
  await assert.rejects(syncReturnRecord({ recordId: result.palletReturn.id }), { code: "RETURN_RA_VERIFICATION_FAILED" });
  assert.equal(creates(remote).length, 1);
  remote.created.values().next().value.item.items.at(-1).quantity -= 1;
  assert.equal((await syncReturnRecord({ recordId: result.stockReturn.id })).netSuiteSyncStatus, "succeeded");
  assert.equal(creates(remote).length, 1);
});

test("D1 durable RA identity survives an outer local transaction rollback", async t => {
  const remote = await fixture(t);
  const result = await submitReturnBatch({ operatorId: actor, input: await submitInput({ pallet: true }), autoSync: false });
  await assert.rejects(withTransaction(async () => {
    await syncReturnRecord({ recordId: result.stockReturn.id });
    throw new Error("outer transaction failed");
  }), /outer transaction failed/);
  const recovered = await syncReturnRecord({ recordId: result.palletReturn.id });
  assert.equal(recovered.netSuiteSyncStatus, "succeeded");
  assert.equal(creates(remote).length, 1);
});

test("G1 disabling either component saves the entire mixed batch locally without creating a partial RA", async t => {
  const remote = await fixture(t);
  await query("UPDATE mbt_feature_flags SET enabled=false WHERE flag_key='operator_netsuite_pallet_return_ra_3445'");
  const result = await submit(await submitInput({ pallet: true }));
  assert.ok(result.records.every(record => record.netSuiteSyncStatus === "disabled"));
  assert.equal(creates(remote).length, 0);
  await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key='operator_netsuite_pallet_return_ra_3445'");
  await assert.rejects(syncReturnRecord({ recordId: result.stockReturn.id, force: true }), /locally|admitted/i);
  assert.equal(creates(remote).length, 0);
});

test("Q1 a shared RA reserves PALLET quantity until observed PALLET credits arrive", async t => {
  const remote = await fixture(t);
  const result = await submit(await submitInput({ pallet: true, quantity: 5 }));
  const id = result.palletReturn.netSuiteTransactionId;
  assert.equal(await localPalletReserved(99091702, [], [id]), 5);
  const credits = [{ returnAuthorizationId: id, transactionId: 8101, quantity: 2 }];
  assert.equal(await localPalletReserved(99091702, [], [8101], credits), 3);
  assert.equal(await localPalletReserved(99091702, [], [], credits), 5);
  await reconcileReturnRecords();
  assert.equal((await getReturnRecordDetail(result.palletReturn.id)).netSuiteTransactionRef, result.stockReturn.netSuiteTransactionRef);
  assert.equal(creates(remote).length, 1);
});


test("D1 pending recovery visits a mixed batch once and recovers an uncertain creation", async t => {
  const remote = await fixture(t);
  const result = await submitReturnBatch({ operatorId: actor, input: await submitInput({ pallet: true }), autoSync: false });
  remote.control.failAfterCreate = true;
  assert.deepEqual(await processPendingReturnSyncs(), { queued: 1, succeeded: 0, failed: 1 });
  assert.deepEqual(await processPendingReturnSyncs(), { queued: 1, succeeded: 1, failed: 0 });
  assert.equal((await getReturnRecordDetail(result.palletReturn.id)).netSuiteSyncStatus, "succeeded");
  assert.equal(creates(remote).length, 1);
});

test("Q1 reconciliation checks one shared RA, and cancellation permits local void without more RAs", async t => {
  const remote = await fixture(t);
  const result = await submit(await submitInput({ pallet: true }));
  await assert.rejects(voidReturnRecord({ recordId: result.palletReturn.id, actorOperatorId: actor, reason: "test" }), /Cancel or void/);
  remote.created.values().next().value.status = { refName: "Cancelled" };
  assert.deepEqual(await reconcileReturnRecords(), { checked: 1, updated: 1, failed: 0, skipped: 0 });
  assert.ok((await getReturnRecordDetail(result.stockReturn.id)).netSuiteSyncStatus === "cancelled");
  assert.equal((await syncReturnRecord({ recordId: result.palletReturn.id })).netSuiteSyncStatus, "cancelled");
  await voidReturnRecord({ recordId: result.palletReturn.id, actorOperatorId: actor, reason: "cancelled remotely" });
  assert.equal(creates(remote).length, 1);
});

test("D2 a rejected manual link leaves the original batch recoverable", async t => {
  const remote = await fixture(t);
  const result = await submitReturnBatch({ operatorId: actor, input: await submitInput({ pallet: true }), autoSync: false });
  remote.created.set("555", { id: "555", externalId: "wrong", tranId: "RMA555", item: { items: [] } });
  await assert.rejects(linkReturnNetSuiteTransaction({ recordId: result.palletReturn.id, transactionType: "return_authorization", netsuiteId: 555, actorOperatorId: actor }));
  assert.equal((await getReturnRecordDetail(result.palletReturn.id)).netSuiteTransactionId, null);
  const recovered = await syncReturnRecord({ recordId: result.stockReturn.id });
  assert.equal(recovered.netSuiteSyncStatus, "succeeded");
  assert.equal(creates(remote).length, 1);
});


test("B1 standalone PALLET and definite rejection retry use one RA and no Credit Memo", async t => {
  const remote = await fixture(t);
  remote.control.rejectCreate = true;
  const result = await submit(await submitInput({ stock: false, pallet: true }));
  assert.equal(result.palletReturn.netSuiteSyncStatus, "failed");
  assert.equal(result.palletReturn.netSuiteRaAttemptedAt, null);
  remote.control.rejectCreate = false;
  const recovered = await syncReturnRecord({ recordId: result.palletReturn.id });
  assert.equal(recovered.netSuiteSyncStatus, "succeeded");
  assert.equal(remote.created.size, 1);
  assert.ok(creates(remote).every(request => /returnAuthorization/.test(request.address)));
});

test("R1 explicit recovery admits only the named untouched legacy batch and preserves transaction ownership", async t => {
  const remote = await fixture(t);
  const result = await submitReturnBatch({ operatorId: actor, input: await submitInput({ pallet: true }), autoSync: false });
  await query("DELETE FROM return_batch_authorizations WHERE batch_id=$1", [result.stockReturn.batchId]);
  await query("UPDATE return_records SET workflow_version=1,netsuite_sync_status='disabled' WHERE batch_id=$1", [result.stockReturn.batchId]);
  const admitted = await admitExistingReturnBatchAuthorization({ batchReference: result.batchReference, actorOperatorId: actor });
  assert.equal(admitted.sync_status, "pending");
  await assert.rejects(admitExistingReturnBatchAuthorization({ batchReference: result.batchReference }), /already/);
  const recovered = await syncReturnRecord({ recordId: result.stockReturn.id });
  assert.equal(recovered.netSuiteSyncStatus, "succeeded");
  assert.equal(creates(remote).length, 1);
  await assert.rejects(query("UPDATE return_records SET netsuite_transaction_id=$2 WHERE id=$1", [result.palletReturn.id, recovered.netSuiteTransactionId]), { code: "23505" });
  await assert.rejects(query("UPDATE return_batch_authorizations SET external_id='CHANGED' WHERE batch_id=$1", [result.stockReturn.batchId]), { code: "23514" });
});


test("B3 personal history exposes the same verified RMA on stock and PALLET records", async t => {
  await fixture(t);
  const result = await submit(await submitInput({ pallet: true }));
  const history = (await listOperatorHistory({ operatorId: actor, yardLocationIds: [1] }))
    .filter(record => ["stock_return", "pallet_return"].includes(record.type));
  assert.equal(history.length, 2);
  assert.ok(history.every(record => record.details.netSuiteTransactionRef === result.stockReturn.netSuiteTransactionRef));
  assert.ok(history.every(record => record.details.workflowVersion === 3));
  assert.equal((await listOperatorHistory({ operatorId: actor, yardLocationIds: [28] })).length, 0);
});


test("Q1 split stock rows retain unobserved quota when only the first row has a native SO link", async t => {
  const remote = await fixture(t);
  const input = await submitInput({ pallet: true });
  input.stockReturnType = "quality";
  input.lines = [6, 7, 8].map(reasonId => ({ sourceLineId: 99091703, salesQuantity: 2, reasonId, photos: reasonPhotos }));
  const result = await submit(input);
  assert.equal(result.stockReturn.netSuiteSyncStatus, "succeeded");
  assert.equal(remote.created.size, 1);
  const id = result.stockReturn.netSuiteTransactionId;
  const observed = new Map([["99091703", { transactions: [{ id, countedQuantity: 2 }] }]]);
  assert.equal((await localStockReserved([99091703], [], [id], observed)).get("99091703"), 4);
  observed.get("99091703").transactions[0].countedQuantity = 6;
  assert.equal((await localStockReserved([99091703], [], [id], observed)).get("99091703"), 0);
});


test("D2 real REST shape omits orderLine; native SO links verify the same RA and source units", async t => {
  const remote = await fixture(t);
  remote.control.sourceLinks = [{ return_line_id: "1", source_line_id: "99091703", source_order_line: "2", source_units_id: "3" }];
  remote.control.alter = snapshot => { for (const line of snapshot.item.items) {delete line.orderLine;} };
  const result = await submit(await submitInput({ pallet: true }));
  assert.equal(result.stockReturn.netSuiteSyncStatus, "succeeded");
  assert.equal(creates(remote).length, 1);
  remote.control.sourceLinks[0].source_units_id = "99";
  assert.equal((await reconcileReturnRecords()).failed, 1);
  assert.equal((await getReturnRecordDetail(result.stockReturn.id)).netSuiteSyncStatus, "failed");
  remote.control.sourceLinks[0].source_units_id = "3";
  remote.control.sourceLinks[0].source_line_id = "555";
  await assert.rejects(syncReturnRecord({ recordId: result.stockReturn.id }), { code: "RETURN_RA_VERIFICATION_FAILED" });
  assert.equal(creates(remote).length, 1);
});
