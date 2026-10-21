import assert from "node:assert/strict";
import test, { after } from "node:test";
import fc from "fast-check";
import { query, closeDb } from "../../../src/db.js";
import { submitReturnBatch, listReturnDrafts, deleteReturnDraft, saveReturnDraft,
  localStockReserved, localPalletReserved, processPendingReturnSyncs } from "../../../src/return-repository.js";
import { fixture, submitInput, actor, reasonPhotos } from "../../support/return-batch-ra-fixture.js";

after(closeDb);
const submit = input => submitReturnBatch({ operatorId: actor, input });
const creates = remote => remote.requests.filter(r => r.method === "POST" && /\/record\/.*returnAuthorization/i.test(r.address));
async function noSubmittedRecords() {
  assert.equal((await query("SELECT count(*) AS n FROM return_records WHERE operator_id=$1", [actor])).rows[0].n, "0");
}

test("F1 NetSuite rejection preserves quantities/photos as a draft with no submitted SR or PR", async t => {
  const remote = await fixture(t);
  const input = await submitInput({ pallet: true, quantity: 2 });
  remote.control.rejectCreate = true;
  remote.control.onCreate = async () => {
    await noSubmittedRecords();
    assert.equal((await listReturnDrafts({ operatorId: actor })).length, 1);
  };
  await assert.rejects(submit(input), e => e.code === "RETURN_SUBMISSION_DRAFT" && Boolean(e.draftId));
  await noSubmittedRecords();
  const drafts = await listReturnDrafts({ operatorId: actor });
  assert.equal(drafts.length, 1);
  assert.deepEqual(drafts[0].lines.map(line => [line.sourceLineId, line.salesQuantity]), input.lines.map(line => [line.sourceLineId, line.salesQuantity]));
  assert.deepEqual(drafts[0].photos, reasonPhotos);
  assert.deepEqual(drafts[0].palletPhotos, reasonPhotos);
  assert.equal(drafts[0].palletQuantity, 2);
  assert.equal((await query("SELECT 1 FROM return_batches WHERE operator_id=$1", [actor])).rowCount, 0);
  assert.equal(await localPalletReserved(99091702), 0);
  remote.control.rejectCreate = false;
  const saved = await submit({ ...input, draftId: drafts[0].id });
  assert.equal(saved.records.length, 2);
  assert.ok(saved.records.every(r => r.netSuiteSyncStatus === "succeeded"));
  assert.equal(creates(remote).length, 2);
  assert.equal(remote.created.size, 1);
  assert.equal((await listReturnDrafts({ operatorId: actor })).length, 0);
});

test("F2 an uncertain response stays a protected draft and recovers one RA by the same external ID", async t => {
  const remote = await fixture(t);
  const input = await submitInput({ pallet: true, quantity: 2 });
  remote.control.failAfterCreate = true;
  remote.control.hideExternalId = true;
  await assert.rejects(submit(input), { code: "RETURN_SUBMISSION_DRAFT" });
  await noSubmittedRecords();
  const [draft] = await listReturnDrafts({ operatorId: actor });
  assert.ok(draft);
  assert.equal(await localPalletReserved(99091702), 2);
  assert.equal((await localStockReserved([99091703])).get("99091703"), 2);
  await assert.rejects(deleteReturnDraft({ draftId: draft.id, operatorId: actor }), /unconfirmed|posting|NetSuite/i);
  await assert.rejects(saveReturnDraft({ operatorId: actor, input: { ...input, draftId: draft.id, palletQuantity: 4 } }), /unconfirmed|posting|NetSuite/i);
  await assert.rejects(submit({ ...input, draftId: draft.id }), { code: "RETURN_SUBMISSION_DRAFT" });
  await assert.rejects(submit({ ...input, draftId: draft.id, orderId: 42 }), { code: "RETURN_SUBMISSION_DRAFT" });
  assert.equal(creates(remote).length, 1);
  remote.control.hideExternalId = false;
  await assert.rejects(submit({ ...input, draftId: draft.id, orderId: 42 }), { code: "RETURN_SUBMISSION_DRAFT" });
  await assert.rejects(submit({ ...input, draftId: draft.id, palletQuantity: 4 }), { code: "RETURN_SUBMISSION_DRAFT" });
  const saved = await submit({ ...input, draftId: draft.id });
  assert.ok(saved.records.every(r => r.netSuiteSyncStatus === "succeeded"));
  assert.equal(creates(remote).length, 1);
  assert.equal(saved.stockReturn.netSuiteTransactionId, Number([...remote.created.values()][0].id));
  assert.equal((await listReturnDrafts({ operatorId: actor })).length, 0);
  const legacyInput = await submitInput({ pallet: true, quantity: 2 });
  delete legacyInput.idempotencyKey;
  remote.control.hideExternalId = true;
  await assert.rejects(submit(legacyInput), { code: "RETURN_SUBMISSION_DRAFT" });
  const [legacyDraft] = await listReturnDrafts({ operatorId: actor });
  remote.control.hideExternalId = false;
  const recovered = await submit({ ...legacyInput, draftId: legacyDraft.id });
  assert.ok(recovered.records.every(r => r.netSuiteSyncStatus === "succeeded"));
  assert.equal(creates(remote).length, 2);
});

test("F3 failed readback keeps a draft and identified RA until exact verification passes", async t => {
  const remote = await fixture(t);
  const input = await submitInput();
  remote.control.alter = snapshot => { snapshot.item.items[0].quantity += 1; };
  await assert.rejects(submit(input), { code: "RETURN_SUBMISSION_DRAFT" });
  await noSubmittedRecords();
  const [draft] = await listReturnDrafts({ operatorId: actor });
  await assert.rejects(submit({ ...input, draftId: draft.id }), { code: "RETURN_SUBMISSION_DRAFT" });
  assert.equal(creates(remote).length, 1);
  remote.created.values().next().value.item.items[0].quantity -= 1;
  const saved = await submit({ ...input, draftId: draft.id });
  assert.equal(saved.stockReturn.netSuiteSyncStatus, "succeeded");
  assert.equal(creates(remote).length, 1);
});

test("F4 concurrent confirmation of the full quantity publishes records only after one verified RA", async t => {
  const remote = await fixture(t);
  const input = await submitInput({ quantity: 10 });
  remote.control.onCreate = noSubmittedRecords;
  const results = await Promise.all(Array.from({ length: 8 }, () => submit(input)));
  assert.equal(creates(remote).length, 1);
  assert.ok(results.every(r => r.stockReturn.netSuiteSyncStatus === "succeeded"));
  assert.equal(new Set(results.map(r => r.stockReturn.id)).size, 1);
  assert.equal((await listReturnDrafts({ operatorId: actor })).length, 0);
});

test("F5 a local finalization failure keeps the identified RA and restores records on retry", async t => {
  const remote = await fixture(t);
  const input = await submitInput();
  await query(`CREATE FUNCTION return_draft_finalize_tripwire() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.operator_id='return-batch-ra-test' AND EXISTS(SELECT 1 FROM return_batch_authorizations a
      WHERE a.batch_id=NEW.batch_id AND a.sync_status='succeeded' AND a.draft_id IS NOT NULL)
    THEN RAISE EXCEPTION 'simulated local finalization failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER return_draft_finalize_tripwire AFTER INSERT ON return_records
    FOR EACH ROW EXECUTE FUNCTION return_draft_finalize_tripwire();`);
  t.after(async () => { await query("DROP TRIGGER IF EXISTS return_draft_finalize_tripwire ON return_records; DROP FUNCTION IF EXISTS return_draft_finalize_tripwire()"); });
  await assert.rejects(submit(input), { code: "RETURN_SUBMISSION_DRAFT" });
  await noSubmittedRecords();
  assert.equal(remote.created.size, 1);
  await query("DROP TRIGGER return_draft_finalize_tripwire ON return_records");
  const saved = await submit(input);
  assert.equal(saved.stockReturn.netSuiteSyncStatus, "succeeded");
  assert.equal(creates(remote).length, 1);
  assert.equal((await listReturnDrafts({ operatorId: actor })).length, 0);
});

test("F6 expired uncertain drafts survive pruning and background recovery publishes one RA", async t => {
  const remote = await fixture(t);
  const input = await submitInput();
  remote.control.failAfterCreate = true;
  await assert.rejects(submit(input), { code: "RETURN_SUBMISSION_DRAFT" });
  await query("UPDATE return_drafts SET expires_at=now()-interval '1 day' WHERE operator_id=$1", [actor]);
  assert.equal((await listReturnDrafts({ operatorId: actor })).length, 1);
  assert.deepEqual(await processPendingReturnSyncs(), { queued: 1, succeeded: 1, failed: 0 });
  assert.equal((await submit(input)).stockReturn.netSuiteSyncStatus, "succeeded");
  assert.equal(creates(remote).length, 1);
});

test("F7 arbitrary rejected quantities and quality evidence survive draft retry exactly", async t => {
  const remote = await fixture(t);
  remote.remoteLines[0].fulfilled_quantity = 1000;
  remote.remoteLines[0].sales_quantity = 1000;
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 10 }), async quantity => {
    const input = await submitInput({ quantity });
    input.stockReturnType = "quality";
    input.lines[0].reasonId = 6;
    input.lines[0].photos = reasonPhotos;
    remote.control.rejectCreate = true;
    await assert.rejects(submit(input), { code: "RETURN_SUBMISSION_DRAFT" });
    const [draft] = await listReturnDrafts({ operatorId: actor });
    assert.equal(draft.lines[0].salesQuantity, quantity);
    assert.deepEqual(draft.lines[0].photos, reasonPhotos);
    remote.control.rejectCreate = false;
    const saved = await submit({ ...input, draftId: draft.id });
    assert.equal(saved.stockReturn.netSuiteSyncStatus, "succeeded");
    const created = [...remote.created.values()].at(-1).item.items[0];
    assert.equal(created.quantity, quantity);
    assert.equal(created.custcol_atlas_rc_so.id, "6");
  }), { seed: 5006642, numRuns: 12 });
});

test("F8 a corrupted staged identity fails before recovery and remains safely retryable", async t => {
  const remote = await fixture(t);
  const input = await submitInput();
  remote.control.failAfterCreate = true;
  await assert.rejects(submit(input), { code: "RETURN_SUBMISSION_DRAFT" });
  const [draft] = await listReturnDrafts({ operatorId: actor });
  const original = (await query("SELECT staged_records FROM return_batch_authorizations WHERE draft_id=$1::uuid", [draft.id])).rows[0].staged_records;
  await query(`UPDATE return_batch_authorizations SET staged_records=jsonb_set(staged_records,'{records,0,id}','-1'::jsonb)
    WHERE draft_id=$1::uuid`, [draft.id]);
  await assert.rejects(submit({ ...input, draftId: draft.id }), error => error.code === "RETURN_SUBMISSION_DRAFT"
    && /staged return does not match/i.test(error.message));
  await noSubmittedRecords();
  assert.equal(creates(remote).length, 1);
  await query("UPDATE return_batch_authorizations SET staged_records=$2::jsonb WHERE draft_id=$1::uuid", [draft.id, JSON.stringify(original)]);
  assert.equal((await submit({ ...input, draftId: draft.id })).stockReturn.netSuiteSyncStatus, "succeeded");
  assert.equal(creates(remote).length, 1);
});
