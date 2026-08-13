import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before } from "node:test";

import { closeDb, query } from "../../../src/db.js";
import {
  getDeliveryInstruction,
  getDeliveryInstructionsForDriverOrderIds,
  issueDeliveryInstructionMediaUpload,
  listDeliveryInstructionOrders,
  registerDeliveryInstructionMedia,
  removeDeliveryInstructionMedia,
  saveDeliveryInstructionText
} from "../../../src/delivery-instruction-repository.js";

after(closeDb);

const seed = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const baseId = 9_850_000_000_000 + Number(seed.slice(-8)) * 10;
const actor = `delivery-instruction-${seed}`;
const order = {
  id: baseId + 1,
  ref: `SODI-${seed}-A`,
  otherId: baseId + 2,
  otherRef: `SODI-${seed}-B`,
  concurrentId: baseId + 3,
  concurrentRef: `SODI-${seed}-C`,
  defensiveId: baseId + 4,
  defensiveRef: `SODI-${seed}-D`,
  familyId: baseId + 5,
  familyRef: `SODI-${seed}-FAMILY`,
  splitId: -(baseId + 6),
  splitRef: `SODI-${seed}-FAMILY-S1`
};

function mediaPayload(index, expectedRevision, uploadId) {
  const id = uploadId || `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  return {
    uploadId: id,
    objectReference: `r2://sales/sales-delivery-instruction-media/2026/08/11/${id}/proof-${index}.jpg`,
    mimeType: "image/jpeg",
    byteSize: 1024 + index,
    fileName: `proof-${index}.jpg`,
    expectedRevision
  };
}

before(async () => {
  await query(
    `INSERT INTO operators (
       id, username, display_name, password_hash, password_salt, role, roles, active
     ) VALUES ($1,$1,$1,'harness','harness','sales',ARRAY['sales']::text[],true)`,
    [actor]
  );
  await query(
    `INSERT INTO sales_orders (
       netsuite_id, tranid, trandate, customer, status, status_text,
       order_location_id, sales_order_type, memo, netsuite_active, synced_at
     ) VALUES
       ($1,$2,current_date,'Authorized Customer','Pending Fulfillment','Pending Fulfillment',
        1,'Delivery',$3,true,now()),
       ($4,$5,current_date,'Other Yard Customer','Pending Fulfillment','Pending Fulfillment',
        28,'Delivery','Tel: 416-555-9999',true,now())`,
    [
      order.id,
      order.ref,
      "Delivery Address: 1 Planned Road\nDelivery Date: 2026-08-12\nTel: 416-555-1234\nLeave behind the gate.",
      order.otherId,
      order.otherRef
    ]
  );
  await query(
    `INSERT INTO sales_orders (
       netsuite_id, tranid, trandate, customer, status, status_text,
       order_location_id, sales_order_type, memo, netsuite_active, synced_at
     ) VALUES ($1,$2,current_date,'Concurrent Upload Customer','Pending Fulfillment','Pending Fulfillment',
       1,'Delivery','Call 416-555-9876 before delivery.',true,now())`,
    [order.concurrentId, order.concurrentRef]
  );
  await query(
    `INSERT INTO sales_orders (
       netsuite_id, tranid, trandate, customer, status, status_text,
       order_location_id, sales_order_type, memo, netsuite_active, synced_at
     ) VALUES ($1,$2,current_date,'Defensive Upload Customer','Pending Fulfillment','Pending Fulfillment',
       1,'Delivery','Call 416-555-7777 before delivery.',true,now())`,
    [order.defensiveId, order.defensiveRef]
  );
  await query(
    `INSERT INTO sales_orders (
       netsuite_id, tranid, trandate, customer, status, status_text,
       order_location_id, sales_order_type, memo, netsuite_active, synced_at
     ) VALUES
       ($1,$2,current_date,'Split Family Customer','Pending Fulfillment','Pending Fulfillment',
        1,'Delivery','Call before delivering the split family.',true,now()),
       ($3,$4,current_date,'Split Family Customer','Pending Fulfillment','Pending Fulfillment',
        1,'Delivery','Local dispatch split.',true,now())`,
    [order.familyId, order.familyRef, order.splitId, order.splitRef]
  );
  await query(
    `INSERT INTO dispatch_scm_so_splits (
       source_so_id, source_so_ref, split_so_id, split_so_ref, status, created_by, details
     ) VALUES ($1,$2,$3,$4,'active',$5,'{"testFixture":true}'::jsonb)`,
    [order.familyId, order.familyRef, order.splitId, order.splitRef, actor]
  );
  await query(
    `UPDATE sales_orders
        SET dispatch_instruction_parse_version = 2,
            dispatch_instruction_details = $2::jsonb
      WHERE netsuite_id = $1`,
    [order.otherId, JSON.stringify({
      text: "Structured instruction wins.",
      phones: [{ display: "416-555-9999", href: "+14165559999" }, null, { display: "", href: "" }],
      fallbackUsed: true,
      source: "llama-v2"
    })]
  );
});

test("Sales search is yard-scoped, retains completed orders, and derives non-planning memo details", async () => {
  const visible = await listDeliveryInstructionOrders({
    search: order.ref,
    authorizedOrderingLocationIds: [1]
  });
  assert.equal(visible.length, 1);
  assert.equal(visible[0].orderRef, order.ref);
  assert.match(visible[0].automatic.text, /Tel: 416-555-1234/);
  assert.doesNotMatch(visible[0].automatic.text, /Delivery Address|Delivery Date/);
  assert.equal(visible[0].automatic.phones[0].href, "+14165551234");

  const hidden = await listDeliveryInstructionOrders({
    search: order.otherRef,
    authorizedOrderingLocationIds: [1]
  });
  assert.deepEqual(hidden, []);
  await assert.rejects(
    () => getDeliveryInstruction(order.otherId, { authorizedOrderingLocationIds: [1] }),
    (error) => error?.status === 403
  );
  const structured = await getDeliveryInstruction(order.otherId, { authorizedOrderingLocationIds: [28] });
  assert.equal(structured.automatic.text, "Structured instruction wins.");
  assert.deepEqual(structured.automatic.phones, [{ display: "416-555-9999", href: "+14165559999" }]);
  assert.equal(structured.automatic.fallbackUsed, true);
  assert.equal(structured.automatic.source, "llama-v2");
});

test("text saves are revision-safe and a stale editor cannot overwrite newer work", async () => {
  const saved = await saveDeliveryInstructionText(order.id, {
    expectedRevision: 0,
    additionalText: "Use the east entrance."
  }, { operatorId: actor, source: "sales", authorizedOrderingLocationIds: [1] });
  assert.equal(saved.revision, 1);
  assert.equal(saved.additionalText, "Use the east entrance.");

  await assert.rejects(
    () => saveDeliveryInstructionText(order.id, {
      expectedRevision: 0,
      additionalText: "This stale value must never win."
    }, { operatorId: actor, source: "dispatch" }),
    (error) => error?.status === 409 && error?.code === "DELIVERY_INSTRUCTION_REVISION_CONFLICT"
  );
  assert.equal((await getDeliveryInstruction(order.id)).additionalText, "Use the east entrance.");
});

test("split children read and write one canonical original-SO instruction across split timing", async () => {
  const beforeSplit = await saveDeliveryInstructionText(order.familyId, {
    expectedRevision: 0,
    additionalText: "Instruction entered before the dispatch split."
  }, { operatorId: actor, source: "dispatch", authorizedOrderingLocationIds: [1] });
  assert.equal(beforeSplit.orderId, order.familyId);
  assert.equal(beforeSplit.revision, 1);

  const inherited = await getDeliveryInstruction(order.splitRef, { authorizedOrderingLocationIds: [1] });
  assert.equal(inherited.orderId, order.familyId);
  assert.equal(inherited.orderRef, order.familyRef);
  assert.equal(inherited.additionalText, "Instruction entered before the dispatch split.");
  assert.equal((await getDeliveryInstruction(order.splitId)).orderId, order.familyId);

  const afterSplit = await saveDeliveryInstructionText(order.splitRef, {
    expectedRevision: inherited.revision,
    additionalText: "Instruction entered after the dispatch split."
  }, { operatorId: actor, source: "dispatch", authorizedOrderingLocationIds: [1] });
  assert.equal(afterSplit.orderId, order.familyId);
  assert.equal((await getDeliveryInstruction(order.familyRef)).additionalText, "Instruction entered after the dispatch split.");
  assert.equal(Number((await query(
    "SELECT COUNT(*) AS count FROM sales_order_delivery_instructions WHERE sales_order_id = $1",
    [order.splitId]
  )).rows[0].count), 0);

  const driver = await getDeliveryInstructionsForDriverOrderIds([order.familyId, order.splitId]);
  assert.equal(driver[order.familyId].instructionOrderId, order.familyId);
  assert.equal(driver[order.splitId].instructionOrderId, order.familyId);
  assert.equal(driver[order.splitId].instructionOrderRef, order.familyRef);
  assert.equal(driver[order.splitId].orderRef, order.splitRef);
  assert.equal(driver[order.splitId].additionalText, "Instruction entered after the dispatch split.");

  const searchedBySplit = await listDeliveryInstructionOrders({
    search: order.splitRef,
    authorizedOrderingLocationIds: [1]
  });
  assert.deepEqual(searchedBySplit.map((entry) => entry.orderRef), [order.familyRef]);

  const completionJobId = `delivery-instruction-split:${seed}`;
  await query(
    `INSERT INTO driver_job_records (
       job_id, driver_login, stop_type, order_refs, status, completed_at
     ) VALUES ($1,'driver-fixture','dropoff',$2::jsonb,'complete',now())`,
    [completionJobId, JSON.stringify([order.splitRef])]
  );
  const completedFamily = await getDeliveryInstruction(order.familyRef);
  assert.equal(completedFamily.dropoffCompleted, true);
  await assert.rejects(
    () => saveDeliveryInstructionText(order.splitRef, {
      expectedRevision: completedFamily.revision,
      additionalText: "A completed split must keep the family instruction immutable."
    }, { operatorId: actor, source: "dispatch" }),
    (error) => error?.status === 409 && error?.code === "DELIVERY_INSTRUCTION_READ_ONLY"
  );
  await query(
    "UPDATE driver_job_records SET status = 'pending', completed_at = NULL WHERE job_id = $1",
    [completionJobId]
  );
});

test("an issued upload remains additively registrable after a text edit and reserves one of five slots", async () => {
  const context = { operatorId: actor, source: "sales", authorizedOrderingLocationIds: [1] };
  const ticket = await issueDeliveryInstructionMediaUpload(order.concurrentId, {
    expectedRevision: 0,
    mimeType: "image/jpeg",
    byteSize: 1065,
    fileName: "proof-41.jpg"
  }, context);
  const text = await saveDeliveryInstructionText(order.concurrentId, {
    expectedRevision: 0,
    additionalText: "The upload started before this text save."
  }, context);
  assert.equal(text.revision, 1);

  const registered = await registerDeliveryInstructionMedia(
    order.concurrentId,
    mediaPayload(41, 0, ticket.uploadId),
    context
  );
  assert.equal(registered.revision, 2);
  assert.equal(registered.additionalText, "The upload started before this text save.");
  assert.equal(registered.media.length, 1);

  for (let index = 0; index < 4; index += 1) {
    await issueDeliveryInstructionMediaUpload(order.concurrentId, {
      expectedRevision: 2,
      mimeType: "image/jpeg",
      byteSize: 2048 + index,
      fileName: `reserved-${index}.jpg`
    }, context);
  }
  await assert.rejects(
    () => issueDeliveryInstructionMediaUpload(order.concurrentId, {
      expectedRevision: 2,
      mimeType: "image/jpeg",
      byteSize: 4096,
      fileName: "sixth-slot.jpg"
    }, context),
    (error) => error?.status === 409 && error?.code === "DELIVERY_INSTRUCTION_MEDIA_LIMIT"
  );
});

test("upload tickets reject every mismatch and exact registration retries are idempotent", async () => {
  const context = { operatorId: actor, source: "sales", authorizedOrderingLocationIds: [1] };
  await assert.rejects(
    () => issueDeliveryInstructionMediaUpload(order.defensiveId, {
      expectedRevision: 0,
      mimeType: "image/jpeg",
      byteSize: 1095,
      fileName: "proof-71.jpg"
    }, { ...context, source: "driver" }),
    (error) => error?.status === 400
  );

  const expiring = await issueDeliveryInstructionMediaUpload(order.defensiveId, {
    expectedRevision: 0,
    mimeType: "image/jpeg",
    byteSize: 1095,
    fileName: "proof-71.jpg"
  }, context);
  await assert.rejects(
    () => registerDeliveryInstructionMedia(order.defensiveId, {
      ...mediaPayload(71, 0, expiring.uploadId),
      fileName: "wrong-name.jpg"
    }, context),
    (error) => error?.code === "DELIVERY_INSTRUCTION_UPLOAD_MISMATCH"
  );
  await assert.rejects(
    () => registerDeliveryInstructionMedia(order.defensiveId, {
      ...mediaPayload(71, 0, expiring.uploadId),
      objectReference: `r2://sales/sales-delivery-instruction-media/2026/08/11/${crypto.randomUUID()}/proof-71.jpg`
    }, context),
    (error) => error?.code === "DELIVERY_INSTRUCTION_UPLOAD_REFERENCE"
  );
  await query(
    "UPDATE sales_order_delivery_instruction_upload_tickets SET expires_at = now() - interval '1 minute' WHERE id = $1",
    [expiring.uploadId]
  );
  await assert.rejects(
    () => registerDeliveryInstructionMedia(
      order.defensiveId,
      mediaPayload(71, 0, expiring.uploadId),
      context
    ),
    (error) => error?.status === 409 && error?.code === "DELIVERY_INSTRUCTION_UPLOAD_TICKET"
  );

  const valid = await issueDeliveryInstructionMediaUpload(order.defensiveId, {
    expectedRevision: 0,
    mimeType: "image/jpeg",
    byteSize: 1096,
    fileName: "proof-72.jpg"
  }, context);
  const payload = mediaPayload(72, 0, valid.uploadId);
  const registered = await registerDeliveryInstructionMedia(order.defensiveId, payload, context);
  assert.equal(registered.revision, 1);
  const replayed = await registerDeliveryInstructionMedia(order.defensiveId, payload, context);
  assert.equal(replayed.revision, 1);
  assert.equal(replayed.media.length, 1);
  assert.equal(replayed.mediaMutation.type, "replay");
  await assert.rejects(
    () => registerDeliveryInstructionMedia(order.defensiveId, {
      ...payload,
      objectReference: `${payload.objectReference}-changed`
    }, context),
    (error) => error?.status === 409 && error?.code === "DELIVERY_INSTRUCTION_UPLOAD_REPLAY"
  );
});

test("media registration is upload-bound, capped at five, ordered, replaceable in place, and soft-deleted", async () => {
  let revision = 1;
  for (let index = 1; index <= 5; index += 1) {
    const ticket = await issueDeliveryInstructionMediaUpload(order.id, {
      expectedRevision: revision,
      mimeType: "image/jpeg",
      byteSize: 1024 + index,
      fileName: `proof-${index}.jpg`
    }, { operatorId: actor, source: "sales", authorizedOrderingLocationIds: [1] });
    const detail = await registerDeliveryInstructionMedia(
      order.id,
      mediaPayload(index, revision, ticket.uploadId),
      { operatorId: actor, source: "sales", authorizedOrderingLocationIds: [1] }
    );
    revision += 1;
    assert.equal(detail.revision, revision);
    assert.equal(detail.media.length, index);
    assert.deepEqual(detail.media.map((entry) => entry.position), Array.from({ length: index }, (_, offset) => offset + 1));
  }

  const beforeReplacement = await getDeliveryInstruction(order.id);
  const replacedMediaId = beforeReplacement.media[1].id;
  const replacementTicket = await issueDeliveryInstructionMediaUpload(order.id, {
    expectedRevision: revision,
    replaceMediaId: replacedMediaId,
    mimeType: "image/jpeg",
    byteSize: 1105,
    fileName: "proof-81.jpg"
  }, { operatorId: actor, source: "dispatch" });
  const replaced = await registerDeliveryInstructionMedia(
    order.id,
    mediaPayload(81, revision, replacementTicket.uploadId),
    { operatorId: actor, source: "dispatch" }
  );
  revision += 1;
  assert.equal(replaced.revision, revision);
  assert.equal(replaced.media.length, 5);
  assert.deepEqual(replaced.media.map((entry) => entry.position), [1, 2, 3, 4, 5]);
  assert.equal(replaced.media[1].id, replacementTicket.uploadId);
  assert.deepEqual(replaced.mediaMutation, {
    type: "replaced",
    mediaId: replacementTicket.uploadId,
    replacedMediaId
  });
  assert(!replaced.media.some((entry) => entry.id === replacedMediaId));
  const replacedRow = await query(
    "SELECT deleted_at, deleted_source FROM sales_order_delivery_instruction_media WHERE id = $1",
    [replacedMediaId]
  );
  assert.ok(replacedRow.rows[0].deleted_at);
  assert.equal(replacedRow.rows[0].deleted_source, "dispatch");

  await assert.rejects(
    () => issueDeliveryInstructionMediaUpload(order.id, {
      expectedRevision: revision,
      mimeType: "image/jpeg",
      byteSize: 1030,
      fileName: "proof-6.jpg"
    }, { operatorId: actor, source: "sales", authorizedOrderingLocationIds: [1] }),
    (error) => error?.status === 409 && error?.code === "DELIVERY_INSTRUCTION_MEDIA_LIMIT"
  );
  const invalidTicket = await issueDeliveryInstructionMediaUpload(order.id, {
    expectedRevision: revision,
    mimeType: "image/jpeg",
    byteSize: 1033,
    fileName: "invalid-proof.jpg"
  }, { operatorId: actor, source: "sales", authorizedOrderingLocationIds: [1] }).catch((error) => error);
  assert.equal(invalidTicket.code, "DELIVERY_INSTRUCTION_MEDIA_LIMIT");

  await assert.rejects(
    () => registerDeliveryInstructionMedia(order.id, {
      ...mediaPayload(9, revision),
      objectReference: "r2://sales/sales-delivery-instruction-media/2026/08/11/different-upload/file.jpg"
    }, { operatorId: actor, source: "sales", authorizedOrderingLocationIds: [1] }),
    (error) => error?.status === 400
  );

  const thirdMediaId = (await getDeliveryInstruction(order.id)).media[2].id;
  const removed = await removeDeliveryInstructionMedia(order.id, thirdMediaId, {
    expectedRevision: revision
  }, { operatorId: actor, source: "dispatch" });
  assert.equal(removed.revision, revision + 1);
  assert.equal(removed.media.length, 4);
  assert(!removed.media.some((entry) => entry.id === thirdMediaId));
  assert.deepEqual(removed.media.map((entry) => entry.position), [1, 2, 4, 5]);
});

test("Driver completion locks edits, reopening unlocks them, and completed search remains visible", async () => {
  const current = await getDeliveryInstruction(order.id);
  await query(
    `INSERT INTO driver_job_records (
       job_id, driver_login, stop_type, order_refs, status, completed_at
     ) VALUES ($1,'driver-fixture','dropoff',$2::jsonb,'complete',now())`,
    [`delivery-instruction:${seed}`, JSON.stringify([order.ref])]
  );

  const completed = await getDeliveryInstruction(order.id);
  assert.equal(completed.dropoffCompleted, true);
  assert.equal(completed.editable, false);
  await assert.rejects(
    () => saveDeliveryInstructionText(order.id, {
      expectedRevision: current.revision,
      additionalText: "Must remain locked."
    }, { operatorId: actor, source: "dispatch" }),
    (error) => error?.status === 409 && error?.code === "DELIVERY_INSTRUCTION_READ_ONLY"
  );
  const stillVisible = await listDeliveryInstructionOrders({ search: order.ref, authorizedOrderingLocationIds: [1] });
  assert.equal(stillVisible.length, 1);
  assert.equal(stillVisible[0].dropoffCompleted, true);

  await query(
    `UPDATE driver_job_records
        SET status = 'pending', completed_at = NULL
      WHERE job_id = $1`,
    [`delivery-instruction:${seed}`]
  );
  const reopened = await saveDeliveryInstructionText(order.id, {
    expectedRevision: current.revision,
    additionalText: "Editable after an authorized reopen."
  }, { operatorId: actor, source: "dispatch" });
  assert.equal(reopened.editable, true);
  assert.equal(reopened.additionalText, "Editable after an authorized reopen.");
});

test("Driver batch payload exposes only requested Delivery SO instructions", async () => {
  const result = await getDeliveryInstructionsForDriverOrderIds([order.id]);
  assert.deepEqual(Object.keys(result), [String(order.id)]);
  assert.equal(result[order.id].orderRef, order.ref);
  assert.match(result[order.id].automatic.text, /Leave behind the gate/);
  assert.equal(result[order.id].additionalText, "Editable after an authorized reopen.");
  assert.equal(result[order.id].media.length, 4);
});
