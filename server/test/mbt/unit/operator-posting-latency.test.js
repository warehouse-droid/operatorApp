import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { createOperatorPostingTelemetry } from "../../../src/operator-netsuite-posting-telemetry.js";
import { parsePostingPhoto, postingPhotoIdentity, replacePostingPhoto, uploadPostingPhoto, validatePostingPhotos } from "../../../src/operator-netsuite-posting-photos.js";
import { createPostingPhotoWorker, postingPhotoWorker, startPostingPhotoWorker } from "../../../src/operator-netsuite-posting-photo-worker.js";

const photo = (body = "photo-one") => `data:image/jpeg;base64,${Buffer.from(body).toString("base64")}`;

test("timings include response bodies, HTTP failures, and safe correlation fields", async () => {
  const events = [];
  let clock = 10;
  const telemetry = createOperatorPostingTelemetry({ now: () => clock, log: (entry) => events.push(entry) });
  const value = await telemetry.context({ commandId: "command-one", transactionType: "IR", token: "secret-token" }, () =>
    telemetry.time({ operation: "netsuite.http", method: "POST", path: "/record/v1/purchaseorder/9/!transform/itemreceipt?token=secret", attempt: 1 }, async () => {
      clock += 15;
      return { response: { status: 204 }, text: "private-body" };
    }));
  assert.equal(value.text, "private-body");
  assert.equal(events[0].durationMs, 15);
  assert.equal(events[0].status, 204);
  assert.equal(events[0].commandId, "command-one");
  assert.equal(events[0].transactionType, "IR");
  assert.equal(events[0].path, "/record/v1/purchaseorder/9/!transform/itemreceipt");
  const failure = Object.assign(new Error("private body and secret-token"), { code: "ECONNRESET" });
  await assert.rejects(telemetry.context({ commandId: "command-two", transactionType: "IF" }, () =>
    telemetry.time({ operation: "netsuite.http" }, async () => { clock += 7; throw failure; })), (error) => error === failure);
  assert.equal(events[1].durationMs, 7);
  assert.equal(events[1].outcome, "error");
  assert.equal(events[1].errorCode, "ECONNRESET");
  assert.doesNotMatch(JSON.stringify(events), /secret|private/);
});

test("concurrent IF/IR stages retain their own context and logging cannot fail posting", async () => {
  const events = [];
  const telemetry = createOperatorPostingTelemetry({ log: (entry) => events.push(entry) });
  await Promise.all(["IF", "IR"].map((transactionType) => telemetry.context({ commandId: transactionType, transactionType }, async () => {
    await new Promise((resolve) => setImmediate(resolve));
    await telemetry.context({ stage: "verify" }, () => telemetry.time({ operation: "netsuite.http" }, async () => ({ response: { status: 400 } })));
  })));
  assert.equal(events.length, 2);
  for (const entry of events) {
    assert.equal(entry.commandId, entry.transactionType);
    assert.equal(entry.stage, "verify");
    assert.equal(entry.outcome, "error");
    assert.equal(entry.status, 400);
  }
  const brokenLog = createOperatorPostingTelemetry({ log: () => { throw new Error("logging failed"); } });
  assert.equal(await brokenLog.context({ commandId: "one" }, () => brokenLog.time({ operation: "post" }, async () => 123)), 123);
  await telemetry.time({ operation: "outside-context" }, async () => null);
  assert.equal(events.length, 2);
});

test("photo data is bounded and invalid images are rejected without echoing data", () => {
  const parsed = parsePostingPhoto(photo());
  assert.equal(parsed.mimeType, "image/jpeg");
  assert.equal(parsed.bytes.toString(), "photo-one");
  assert.equal(parsed.sha256.length, 64);
  for (const value of ["data:image/svg+xml;base64,PHN2Zz4=", "data:image/jpeg;base64,@@private@@", "data:image/jpeg;base64,", "data:image/jpeg,private"]) {
    assert.throws(() => parsePostingPhoto(value), (error) => error.code === "OPERATOR_PHOTO_INVALID" && !error.message.includes("private"));
  }
  assert.throws(() => parsePostingPhoto(photo(), { maxBytes: 2 }), /too large/i);
  assert.throws(() => parsePostingPhoto("data:image/jpeg;base64,YQ"), /base64 data is invalid/);
  assert.throws(() => validatePostingPhotos(Array(21).fill("r2://operator/existing.jpg")), /too large/i);
  const large = `data:image/jpeg;base64,${Buffer.alloc(9 * 1024 * 1024).toString("base64")}`;
  assert.throws(() => validatePostingPhotos([large, large]), /too large/i);
  assert.equal(parsePostingPhoto("r2://operator/existing.jpg"), null);
});

test("photo identity is stable, content sensitive, and does not retain image bodies", () => {
  assert.match(postingPhotoIdentity(photo()), /^sha256:[a-f0-9]{64}$/);
  assert.equal(postingPhotoIdentity(photo()), postingPhotoIdentity(photo()));
  assert.notEqual(postingPhotoIdentity(photo()), postingPhotoIdentity(photo("photo-two")));
  assert.equal(postingPhotoIdentity("r2://operator/existing.jpg"), "r2://operator/existing.jpg");
});

test("photo replacement preserves order and unrelated values across generated cases", () => {
  fc.assert(fc.property(fc.uint8Array({ minLength: 1, maxLength: 2048 }), (bytes) => {
    const ref = `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
    assert.deepEqual(parsePostingPhoto(ref).bytes, Buffer.from(bytes));
    const original = ["r2://a", ref, "r2://b", ref];
    assert.deepEqual(replacePostingPhoto(original, ref, "r2://new"), ["r2://a", "r2://new", "r2://b", "r2://new"]);
    assert.equal(original[1], ref);
    assert.equal(postingPhotoIdentity(ref), postingPhotoIdentity(ref));
  }), { seed: 16092026, numRuns: 160 });
});

test("R2 upload verifies response, uses fresh credentials, and omits remote bodies from errors", async () => {
  const calls = [];
  const job = { id: "1", commandId: "command", actorOperatorId: "operator", functionKey: "receiving", photoRef: photo(), attemptCount: 1, operation: { orderId: "9", orderType: "purchase_order" } };
  const dependencies = {
    ticket: (input) => { calls.push(input); return { uploadUrl: "https://upload.invalid/upload", token: "secret" }; },
    fetch: async (url, options) => { assert.equal(url, "https://upload.invalid/upload"); assert.equal(options.headers.Authorization, "Bearer secret"); assert.equal(options.body.get("file").size, 9); return new Response(JSON.stringify({ key: "operator/receipt.jpg" }), { status: 200 }); }
  };
  assert.equal(await uploadPostingPhoto(job, dependencies), "r2://operator/receipt.jpg");
  assert.equal(calls[0].recordType, "operator-receiving-photo");
  await assert.rejects(uploadPostingPhoto(job, { ...dependencies, fetch: async () => new Response("private-image-token", { status: 503 }) }), (error) => error.status === 503 && !error.message.includes("private"));
  await assert.rejects(uploadPostingPhoto(job, { ...dependencies, fetch: async () => new Response(JSON.stringify({ key: "../foreign" }), { status: 200 }) }), /key/i);
  await assert.rejects(uploadPostingPhoto(job, { ...dependencies, fetch: async () => new Response("invalid JSON", { status: 200 }) }), /key/i);
  await assert.rejects(uploadPostingPhoto(job, { ...dependencies,
    ticket: () => ({ token: "secret", metadata: { keyPrefix: "operator/owned" } }),
    fetch: async () => new Response(JSON.stringify({ key: "operator/foreign.jpg" }), { status: 200 }) }), /key/i);
  assert.equal(await uploadPostingPhoto({ photoRef: "r2://existing.jpg" }, { ticket: () => { throw new Error("Existing upload needs no ticket"); } }), "r2://existing.jpg");
});

test("background worker does not overlap ticks and persists upload failures for retry", async () => {
  let release, claims = 0, completed = 0, failed = 0;
  const barrier = new Promise((resolve) => { release = resolve; });
  const worker = createPostingPhotoWorker({
    claim: async () => ++claims === 1 ? { id: "1" } : null,
    upload: async () => { await barrier; return "r2://done.jpg"; },
    complete: async () => { completed += 1; return true; }, fail: async () => { failed += 1; }
  });
  const first = worker.tick();
  await new Promise((resolve) => setImmediate(resolve));
  await worker.tick();
  assert.equal(claims, 1);
  release(); await first;
  assert.equal(completed, 1); assert.equal(failed, 0);
  let pending = true;
  const failing = createPostingPhotoWorker({
    claim: async () => { if (!pending) {return null;} pending = false; return { id: "2" }; },
    upload: async () => { throw new Error("R2 unavailable"); },
    complete: async () => { throw new Error("Must not complete failed upload"); },
    fail: async (_job, error) => { assert.equal(error.message, "R2 unavailable"); failed += 1; }
  });
  await failing.tick(); assert.equal(failed, 1);
});

test("photo worker reports a lost lease and resumes polling once after startup", async (t) => {
  const errors = [];
  let available = true;
  const worker = createPostingPhotoWorker({
    claim: async () => { if (!available) {return null;} available = false; return { id: "lost" }; },
    upload: async () => "r2://uploaded.jpg", complete: async () => false,
    fail: async (_job, error) => errors.push(error.code)
  });
  await worker.tick();
  assert.deepEqual(errors, ["PHOTO_LEASE_LOST"]);
  let scheduled, polls = 0, unref = 0;
  const log = [];
  t.mock.method(globalThis, "setInterval", (callback, delay) => {
    assert.equal(delay, 5000); assert.equal(scheduled, undefined); scheduled = callback;
    return { unref: () => { unref += 1; } };
  });
  t.mock.method(postingPhotoWorker, "tick", async () => { polls += 1; throw new Error("private database details"); });
  t.mock.method(console, "error", (entry) => log.push(JSON.parse(entry)));
  startPostingPhotoWorker(); startPostingPhotoWorker();
  await new Promise((resolve) => setImmediate(resolve));
  scheduled();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(polls, 2); assert.equal(unref, 1);
  assert.deepEqual(log, Array(2).fill({ event: "operator_photo_worker_error", errorCode: "PHOTO_WORKER_FAILED" }));
});
