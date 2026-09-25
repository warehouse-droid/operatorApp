import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";
import { query, closeDb } from "../../../src/db.js";
import { createOperator } from "../../../src/auth-repository.js";
import { validateBackgroundPhotoManifest, withOperatorPhotoAction, receiveBackgroundPhoto, claimBackgroundPhoto,
  completeBackgroundPhoto, failBackgroundPhoto, getBackgroundPhoto, getBackgroundPhotoAction } from "../../../src/operator-background-photos.js";
import { describeIsolatedTestDatabase } from "../../support/test-database-isolation.mjs";
describeIsolatedTestDatabase(process.env.DATABASE_URL);
after(closeDb);
const bytes = Buffer.from("photo-one");
function manifest() { return [1, 2].map(() => ({ id: crypto.randomUUID(), sha256: crypto.createHash("sha256").update(bytes).digest("hex"), byteSize: bytes.length, mimeType: "image/jpeg" })); }
async function fixture() {
  const account = await createOperator({ username: `bg-${crypto.randomUUID()}`, password: crypto.randomUUID(), displayName: "Background photo test", role: "operator", yardLocationIds: [1], operatorYardLocationIds: [1] });
  const actor = { ...account, operatorYardLocationIds: [1], yardLocationIds: [1] };
  return { actor, requestId: crypto.randomUUID(), orderId: "GOB-120487-120489", functionKey: "delivery_prep", locationId: 1, backgroundPhotos: manifest(), legacyPhotos: [] };
}
test("confirmation reserves immutable photos atomically and replays without loading twice", async () => {
  const input = await fixture(); let loads = 0;
  const run = async refs => { loads++; assert.equal(refs.length, 2); assert.ok(refs.every(ref => ref.startsWith("operator-photo://"))); return { id: 42, loaded: true }; };
  assert.deepEqual(await withOperatorPhotoAction(input, run), { id: 42, loaded: true });
  assert.deepEqual(await withOperatorPhotoAction(input, run), { id: 42, loaded: true });
  assert.equal(loads, 1);
  assert.equal((await getBackgroundPhotoAction(input.actor, input.requestId)).photos.length, 2);
  await assert.rejects(withOperatorPhotoAction({ ...input, orderId: "other" }, run), { status: 409 });
  await assert.rejects(withOperatorPhotoAction({ ...input, backgroundPhotos: manifest() }, run), { status: 409 });
  const failed = await fixture();
  await assert.rejects(withOperatorPhotoAction(failed, async () => { throw new Error("underpacked"); }), /underpacked/);
  await assert.rejects(getBackgroundPhotoAction(failed.actor, failed.requestId), { status: 404 });
});
test("photo bytes are authorized and verified, acknowledged durably, then retried under a lease", async () => {
  const input = await fixture(); await withOperatorPhotoAction(input, async () => ({ id: 43 }));
  const photo = input.backgroundPhotos[0];
  const other = (await fixture()).actor;
  await assert.rejects(receiveBackgroundPhoto(other, photo.id, bytes), { status: 404 });
  await assert.rejects(receiveBackgroundPhoto({ ...input.actor, operatorYardLocationIds: [28], yardLocationIds: [28] }, photo.id, bytes), { status: 403 });
  await assert.rejects(receiveBackgroundPhoto(input.actor, photo.id, Buffer.from("wrong")), { status: 400 });
  await assert.rejects(receiveBackgroundPhoto(input.actor, photo.id, Buffer.alloc(bytes.length, 1)), { status: 400 });
  assert.equal(await claimBackgroundPhoto({ actionId: input.requestId }), null);
  const receipt = await receiveBackgroundPhoto(input.actor, photo.id, bytes);
  assert.equal(receipt.sha256, photo.sha256);
  assert.deepEqual(await receiveBackgroundPhoto(input.actor, photo.id, bytes), receipt);
  const claims = await Promise.all([claimBackgroundPhoto({ actionId: input.requestId }), claimBackgroundPhoto({ actionId: input.requestId })]);
  assert.equal(claims.filter(Boolean).length, 1);
  const first = claims.find(Boolean);
  assert.equal(first.photoRef, `data:image/jpeg;base64,${bytes.toString("base64")}`);
  await failBackgroundPhoto(first, { code: "PHOTO_UPLOAD_FAILED" });
  assert.equal(await claimBackgroundPhoto({ actionId: input.requestId }), null);
  await query("UPDATE operator_background_photos SET next_attempt_at=now() WHERE id=$1", [photo.id]);
  const second = await claimBackgroundPhoto({ actionId: input.requestId });
  assert.equal(await completeBackgroundPhoto(first, "r2://test/stale.jpg"), false);
  assert.equal(await completeBackgroundPhoto(second, "r2://test/good.jpg"), true);
  const saved = await getBackgroundPhoto(photo.id);
  assert.equal(saved.r2_ref, "r2://test/good.jpg"); assert.equal(saved.bytes, null);
  assert.deepEqual(await receiveBackgroundPhoto(input.actor, photo.id, bytes), receipt);
  assert.equal(await claimBackgroundPhoto({ actionId: input.requestId }), null);
});
test("manifest bounds and identity reject hostile data without relaxing photo counts", () => {
  assert.equal(validateBackgroundPhotoManifest(manifest()).length, 2);
  for (const value of [null, [], [manifest()[0]], [...manifest(), ...Array.from({ length: 19 }, () => manifest()[0])],
    manifest().map(p => ({ ...p, byteSize: 11 * 1024 * 1024 })), manifest().map(p => ({ ...p, mimeType: "text/html" })),
    manifest().map(p => ({ ...p, sha256: "x" })), manifest().map(p => ({ ...p, id: "../other" }))]) {
    assert.throws(() => validateBackgroundPhotoManifest(value), { status: 400 });
  }
  const same = manifest()[0]; assert.throws(() => validateBackgroundPhotoManifest([same, same]), { status: 400 });
});

test("legacy callers remain compatible and invalid IDs cannot create or read reservations", async () => {
  const input = await fixture();
  const refs = ["r2://test/one", "r2://test/two"];
  assert.deepEqual(await withOperatorPhotoAction({ ...input, backgroundPhotos: undefined, legacyPhotos: refs }, async value => value), refs);
  await assert.rejects(getBackgroundPhotoAction(input.actor, input.requestId), { status: 404 });
  await assert.rejects(getBackgroundPhotoAction(input.actor, "not-a-uuid"), { status: 404 });
  await assert.rejects(getBackgroundPhoto("not-a-uuid"), { status: 404 });
  await assert.rejects(getBackgroundPhoto(crypto.randomUUID()), { status: 404 });
  await assert.rejects(withOperatorPhotoAction({ ...input, requestId: "not-a-uuid" }, async () => ({})), { status: 400 });
  assert.deepEqual(validateBackgroundPhotoManifest([], 0), []);
});

test("expired workers recover receiving and consolidated proof with bounded private errors", async () => {
  for (const [functionKey, orderType, transactionType, kind] of [["receiving", "purchase_order", "IR", "receiving"], ["delivery_prep", "consolidation_load", "IF", "delivery_consolidation_load"]]) {
    const input = { ...await fixture(), functionKey, orderType };
    await withOperatorPhotoAction(input, async () => ({ done: true }));
    const id = input.backgroundPhotos[0].id;
    await assert.rejects(receiveBackgroundPhoto(input.actor, id, "not binary"), { status: 400 });
    await receiveBackgroundPhoto(input.actor, id, bytes);
    const first = await claimBackgroundPhoto({ actionId: input.requestId });
    assert.equal(first.functionKey, functionKey); assert.equal(first.transactionType, transactionType); assert.equal(first.operation.kind, kind);
    await query("UPDATE operator_background_photos SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [id]);
    const next = await claimBackgroundPhoto({ actionId: input.requestId });
    assert.notEqual(next.leaseToken, first.leaseToken);
    assert.equal(await completeBackgroundPhoto(first, "r2://test/expired.jpg"), false);
    await assert.rejects(completeBackgroundPhoto(next, "https://untrusted.invalid/photo.jpg"), { status: 400 });
    await failBackgroundPhoto({ ...next, attemptCount: 100 }, { code: "private photo content" });
    const pending = await getBackgroundPhoto(id);
    assert.equal(pending.last_error, "PHOTO_UPLOAD_FAILED"); assert.deepEqual(pending.bytes, bytes);
    assert.ok(new Date(pending.next_attempt_at).getTime() - Date.now() > 3550000);
    await query("UPDATE operator_background_photos SET next_attempt_at=now() WHERE id=$1", [id]);
    const retry = await claimBackgroundPhoto({ actionId: input.requestId });
    assert.equal(await completeBackgroundPhoto(retry, "r2://test/recovered.jpg"), true);
  }
});
