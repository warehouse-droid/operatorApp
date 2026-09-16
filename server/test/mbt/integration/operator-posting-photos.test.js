import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { before, after } from "node:test";
import { createOperator } from "../../../src/auth-repository.js";
import { query, withTransaction, closeDb } from "../../../src/db.js";
import { buildOperatorNetSuitePostingDraft } from "../../../src/operator-netsuite-posting-domain.js";
import { createOrReplayOperatorNetSuitePostingCommand, claimOperatorNetSuitePostingCommand, startOperatorNetSuitePostingAttempt, recordOperatorNetSuitePostingStepSuccess, completeOperatorNetSuitePostingCommand } from "../../../src/operator-netsuite-posting-repository.js";
import { enqueuePostingPhotos, claimPostingPhoto, completePostingPhoto, failPostingPhoto } from "../../../src/operator-netsuite-posting-photo-queue.js";

let actor;
const photos = ["first-proof", "second-proof"].map((value) => `data:image/jpeg;base64,${Buffer.from(value).toString("base64")}`);
before(async () => { actor = await createOperator({ username: `photo-${crypto.randomUUID()}`, displayName: "Photo queue test", password: crypto.randomUUID(), role: "operator", operatorYardLocationIds: [1] }); });
after(closeDb);

async function fixture(type = "IF") {
  const id = crypto.randomUUID(), functionKey = type === "IR" ? "receiving" : "delivery_prep";
  const input = { requestId: id, actorOperatorId: actor.id, functionKey, transactionType: type,
    policy: { gateKey: `operator_netsuite_${functionKey}_${type.toLowerCase()}_3445`, revision: 1, effective: true, functionKey, transactionType: type, locationId: 1, yardCode: "3445" },
    photoRefs: photos, localOrderKeys: [id], localOperation: { kind: type === "IR" ? "receiving_receipt" : "delivery_prep_load", orderId: "900001", orderType: type === "IR" ? "purchase_order" : "sales_order" },
    targets: [{ sourceOrderKind: type === "IR" ? "PO" : "SO", sourceNetSuiteId: 900001, sourceOrderRef: "PHOTO-TEST", selectedLines: [{ orderLine: 1, quantity: 2, location: 1, localOrderKey: id, localLineId: "1" }], availableLines: [{ orderLine: 1, location: 1 }] }] };
  const draft = buildOperatorNetSuitePostingDraft(input);
  const created = await createOrReplayOperatorNetSuitePostingCommand(draft);
  const claimed = await claimOperatorNetSuitePostingCommand({ commandId: id, workerId: "test", leaseSeconds: 180 });
  const stepId = created.command.steps[0].id;
  const attempt = await startOperatorNetSuitePostingAttempt({ commandId: id, stepId, leaseToken: claimed.leaseToken });
  await recordOperatorNetSuitePostingStepSuccess({ commandId: id, stepId, leaseToken: claimed.leaseToken, attemptNumber: attempt.attemptNumber, transactionId: 123, transactionRef: `${type}123` });
  return { id, input, draft, leaseToken: claimed.leaseToken };
}

async function finish(f, { load = true, fail = false } = {}) {
  return completeOperatorNetSuitePostingCommand({ commandId: f.id, leaseToken: f.leaseToken, finalize: async () => {
    if (fail) {throw new Error("finalization failed");}
    if (!load) {return {};}
    const record = await query("INSERT INTO operator_load_records(load_type,order_family,operator_id,photo_data_url,photo_data_urls,response) VALUES('sales_order_delivery_load','sales_order',$1,$2,$3,$4) RETURNING id", [actor.id, photos[0], JSON.stringify(photos), JSON.stringify({ operatorNetSuitePosting: { commandId: f.id } })]);
    return { id: record.rows[0].id };
  } });
}

test("IF and IR commit durable photos before posting and enqueue only on successful completion", async () => {
  for (const type of ["IF", "IR"]) {
    const f = await fixture(type);
    assert.deepEqual(f.draft.photoRefs, [...photos].sort());
    assert.ok(f.draft.inputSnapshot.photoRefs.every((ref) => ref.startsWith("sha256:")));
    assert.equal(await claimPostingPhoto({ ownerId: f.id }), null);
    await assert.rejects(finish(f, { fail: true }), /finalization failed/);
    assert.equal(await claimPostingPhoto({ ownerId: f.id }), null);
    await finish(f);
    const job = await claimPostingPhoto({ ownerId: f.id });
    assert.equal(job.commandId, f.id);
    assert.equal(job.transactionType, type);
    assert.ok(photos.includes(job.photoRef));
    assert.equal(job.attemptCount, 1);
    const beforeRow = (await query("SELECT input_hash,input_snapshot FROM operator_netsuite_posting_commands WHERE id=$1", [f.id])).rows[0];
    assert.equal(await completePostingPhoto(job, `r2://operator/${job.id}.jpg`), true);
    const afterRow = (await query("SELECT input_hash,input_snapshot,photo_refs,status FROM operator_netsuite_posting_commands WHERE id=$1", [f.id])).rows[0];
    assert.equal(afterRow.status, "completed");
    assert.equal(afterRow.input_hash, beforeRow.input_hash);
    assert.deepEqual(afterRow.input_snapshot, beforeRow.input_snapshot);
    assert.equal(afterRow.photo_refs[job.photoIndex], `r2://operator/${job.id}.jpg`);
    const replay = await createOrReplayOperatorNetSuitePostingCommand(buildOperatorNetSuitePostingDraft(f.input));
    assert.equal(replay.replayed, true);
  }
});

test("upload retries survive worker restart and cannot alter IF/IR posting state", async () => {
  const f = await fixture(); await finish(f);
  const job = await claimPostingPhoto({ ownerId: f.id });
  await failPostingPhoto(job, Object.assign(new Error("private-image-data"), { code: "PHOTO_UPLOAD_FAILED" }));
  const row = (await query("SELECT * FROM operator_posting_photo_uploads WHERE id=$1", [job.id])).rows[0];
  assert.equal(row.status, "pending");
  assert.equal(row.last_error, "PHOTO_UPLOAD_FAILED");
  assert.ok(new Date(row.next_attempt_at) > new Date());
  await query("UPDATE operator_posting_photo_uploads SET next_attempt_at=now()-interval '1 second' WHERE id=$1", [job.id]);
  const retry = await claimPostingPhoto({ ownerId: f.id });
  assert.equal(retry.id, job.id);
  assert.equal(retry.attemptCount, 2);
  assert.notEqual(retry.leaseToken, job.leaseToken);
  assert.equal(await completePostingPhoto(job, "r2://stale.jpg"), false);
  assert.equal(await completePostingPhoto(retry, "r2://operator/retried.jpg"), true);
  const posting = (await query("SELECT c.status,s.attempt_count FROM operator_netsuite_posting_commands c JOIN operator_netsuite_posting_steps s ON s.command_id=c.id WHERE c.id=$1", [f.id])).rows[0];
  assert.deepEqual(posting, { status: "completed", attempt_count: 1 });
});

test("concurrent workers claim distinct photos and expired leases are recoverable", async () => {
  const f = await fixture(); await finish(f);
  const claims = await Promise.all(Array.from({ length: 6 }, () => claimPostingPhoto({ ownerId: f.id })));
  const active = claims.filter(Boolean);
  assert.equal(active.length, 2);
  assert.equal(new Set(active.map((job) => job.id)).size, 2);
  const old = active[0];
  await query("UPDATE operator_posting_photo_uploads SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [old.id]);
  const recovered = await claimPostingPhoto({ ownerId: f.id });
  assert.equal(recovered.id, old.id);
  assert.equal(await completePostingPhoto(old, "r2://stale.jpg"), false);
  assert.equal(await completePostingPhoto(recovered, "r2://operator/recovered.jpg"), true);
});

test("replacement is atomic, scoped to associated proof, and preserves photo order", async () => {
  const f = await fixture(), other = await fixture(); await finish(f); await finish(other);
  const job = await claimPostingPhoto({ ownerId: f.id });
  await assert.rejects(withTransaction(async () => {
    await completePostingPhoto(job, "r2://operator/new.jpg");
    throw new Error("rollback");
  }), /rollback/);
  const read = async (id) => (await query("SELECT photo_data_url,photo_data_urls FROM operator_load_records WHERE response->'operatorNetSuitePosting'->>'commandId'=$1", [id])).rows[0];
  assert.deepEqual((await read(f.id)).photo_data_urls, photos);
  assert.equal(await completePostingPhoto(job, "r2://operator/new.jpg"), true);
  assert.deepEqual((await read(f.id)).photo_data_urls, photos.map((ref) => ref === job.photoRef ? "r2://operator/new.jpg" : ref));
  assert.deepEqual((await read(other.id)).photo_data_urls, photos);
});

test("queued work cannot run before its owner completes and enqueue is idempotent", async () => {
  const f = await fixture();
  await enqueuePostingPhotos({ commandId: f.id, photos: [...photos].sort() });
  await enqueuePostingPhotos({ commandId: f.id, photos: [...photos].sort() });
  assert.equal(await claimPostingPhoto({ ownerId: f.id }), null);
  await finish(f);
  assert.equal((await query("SELECT count(*)::int AS n FROM operator_posting_photo_uploads WHERE command_id=$1", [f.id])).rows[0].n, 2);
  assert.ok(await claimPostingPhoto({ ownerId: f.id }));
});

test("IR proof and a native consolidated batch keep their associations after background upload", async () => {
  const f = await fixture("IR");
  await query("INSERT INTO purchase_orders(netsuite_id,tranid) VALUES(900001,'PHOTO-TEST') ON CONFLICT DO NOTHING");
  const proof = (await query("INSERT INTO receiving_receipt_records(order_id,operator_id,photo_data_urls,response) VALUES(900001,$1,$2,$3) RETURNING id", [actor.id, JSON.stringify(photos), JSON.stringify({ operatorNetSuitePosting: { commandId: f.id } })])).rows[0];
  await finish(f, { load: false });
  const job = await claimPostingPhoto({ ownerId: f.id });
  await completePostingPhoto(job, "r2://operator/ir.jpg");
  assert.deepEqual((await query("SELECT photo_data_urls FROM receiving_receipt_records WHERE id=$1", [proof.id])).rows[0].photo_data_urls, photos.map((ref) => ref === job.photoRef ? "r2://operator/ir.jpg" : ref));
  const native = await fixture(), batchId = crypto.randomUUID();
  await query("INSERT INTO operator_consolidated_loads(id,operator_id,location_id,snapshot,snapshot_hash,photo_refs,status,command_id) VALUES($1,$2,1,'{}','test',$3,'completed',$4)", [batchId, actor.id, JSON.stringify(photos), native.id]);
  await finish(native);
  const batchJob = await claimPostingPhoto({ ownerId: native.id });
  await completePostingPhoto(batchJob, "r2://operator/native.jpg");
  assert.deepEqual((await query("SELECT photo_refs FROM operator_consolidated_loads WHERE id=$1", [batchId])).rows[0].photo_refs, photos.map((ref) => ref === batchJob.photoRef ? "r2://operator/native.jpg" : ref));
});

test("changed photo identities and expired leases cannot overwrite durable proof", async () => {
  const f = await fixture(); await finish(f);
  const job = await claimPostingPhoto({ ownerId: f.id });
  await assert.rejects(completePostingPhoto(job, "../unsafe"), /valid uploaded photo/);
  await assert.rejects(completePostingPhoto({ ...job, photoIdentity: "wrong" }, "r2://operator/new.jpg"), /identity changed/);
  await assert.rejects(completePostingPhoto({ ...job, photoIndex: 99 }, "r2://operator/new.jpg"), /reference changed/);
  await query("UPDATE operator_posting_photo_uploads SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [job.id]);
  assert.equal(await completePostingPhoto(job, "r2://operator/new.jpg"), false);
  const row = (await query("SELECT photo_refs FROM operator_netsuite_posting_commands WHERE id=$1", [f.id])).rows[0];
  assert.deepEqual(row.photo_refs, [...photos].sort());
});
