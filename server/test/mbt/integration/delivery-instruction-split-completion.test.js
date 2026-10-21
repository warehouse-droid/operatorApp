import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import test, { after } from "node:test";

import { closeDb, query } from "../../../src/db.js";
import {
  getDeliveryInstruction,
  getDeliveryInstructionNetSuite,
  issueDeliveryInstructionMediaUpload,
  listDeliveryInstructionOrders,
  registerDeliveryInstructionMedia,
  removeDeliveryInstructionMedia,
  saveDeliveryInstructionNetSuite,
  saveDeliveryInstructionText
} from "../../../src/delivery-instruction-repository.js";

after(closeDb);
const context = { source: "sales", authorizedOrderingLocationIds: [1] };
const readOnly = error => error?.status === 409 && error?.code === "DELIVERY_INSTRUCTION_READ_ONLY";

async function fixture(splitCount = 2) {
  const id = 9_780_000_000 + randomInt(100_000_000);
  const ref = `DI-SPLIT-${randomUUID().slice(0, 12)}`;
  const refs = Array.from({ length: splitCount }, (_, index) => `${ref}-S${index + 1}`);
  for (const [index, orderRef] of [ref, ...refs].entries()) {
    await query(`INSERT INTO sales_orders
      (netsuite_id,tranid,trandate,status,status_text,order_location_id,sales_order_type,netsuite_active)
      VALUES ($1,$2,current_date,'B','Pending Fulfillment',1,'Delivery',true)`,
    [index ? -(id + index) : id, orderRef]);
    if (index) {
      await query(`INSERT INTO dispatch_scm_so_splits
        (source_so_id,source_so_ref,split_so_id,split_so_ref) VALUES ($1,$2,$3,$4)`,
      [id, ref, -(id + index), orderRef]);
    }
  }
  return { id, ref, refs };
}

async function job(refs, status = "complete", stopType = "dropoff") {
  const id = `di-split-${randomUUID()}`;
  await query(`INSERT INTO driver_job_records
    (job_id,driver_login,stop_type,order_refs,status,completed_at)
    VALUES ($1,'di-split-driver',$2,$3::jsonb,$4,CASE WHEN $4='complete' THEN now() END)`,
  [id, stopType, JSON.stringify(refs), status]);
  return id;
}

async function assertState(f, completed) {
  for (const identifier of [f.id, f.ref, ...f.refs]) {
    const detail = await getDeliveryInstruction(identifier, context);
    assert.equal(detail.orderId, f.id);
    assert.equal(detail.dropoffCompleted, completed, identifier);
    assert.equal(detail.editable, !completed, identifier);
  }
  const list = await listDeliveryInstructionOrders({ search: f.ref, authorizedOrderingLocationIds: [1] });
  assert.equal(list.length, 1);
  assert.equal(list[0].dropoffCompleted, completed);
  assert.equal(list[0].editable, !completed);
}

test("every split must be delivered, regardless of which split finishes first", async () => {
  for (const first of [0, 1]) {
    const f = await fixture();
    await assertState(f, false);
    await job([f.refs[first]]);
    await assertState(f, false);
    await job([f.refs[1 - first]], "complete", "pickup");
    await assertState(f, false);
    await job([f.refs[1 - first]], "in_progress");
    await assertState(f, false);
    await job([f.refs[1 - first]]);
    await assertState(f, true);
  }
});

test("historical parent delivery cannot complete an outstanding split", async () => {
  const f = await fixture();
  await job([f.ref]);
  await assertState(f, false);
  await job([f.refs[0]]);
  await assertState(f, false);
  await job([f.refs[1]]);
  await assertState(f, true);
});

test("cancelled or replaced splits do not block the remaining active deliveries", async () => {
  const f = await fixture(3);
  await query(`UPDATE dispatch_scm_so_splits SET status='cancelled',cancelled_at=now()
    WHERE split_so_ref=$1`, [f.refs[1]]);
  await job([f.refs[0]]);
  await assertState(f, false);
  await job([f.refs[2]]);
  await assertState(f, true);
});

test("unsplit orders use the parent delivery and ignore cancelled child completions", async () => {
  for (const splitCount of [0, 2]) {
    const f = await fixture(splitCount);
    await query(`UPDATE dispatch_scm_so_splits SET status='cancelled',cancelled_at=now()
      WHERE source_so_id=$1`, [f.id]);
    if (f.refs.length) { await job(f.refs); }
    await assertState(f, false);
    await job([f.ref]);
    await assertState(f, true);
  }
});

test("grouped deliveries match each split and reopening one split unlocks the family", async () => {
  const f = await fixture();
  await job(["UNRELATED-SO", ` ${f.refs[0].toLowerCase()} `]);
  const lastJob = await job([f.refs[1], "ANOTHER-SO"]);
  await assertState(f, true);
  await query("UPDATE driver_job_records SET status='pending',completed_at=NULL WHERE job_id=$1", [lastJob]);
  await assertState(f, false);
  const saved = await saveDeliveryInstructionText(f.refs[1], {
    expectedRevision: 0, additionalText: "Use the updated entrance for the reopened delivery."
  }, context);
  assert.equal(saved.revision, 1);
  await query("UPDATE driver_job_records SET status='complete',completed_at=now() WHERE job_id=$1", [lastJob]);
  await assertState(f, true);
});

test("partial deliveries allow shared text and media changes; final delivery blocks every mutation", async () => {
  const f = await fixture();
  await job([f.refs[0]]);
  const saved = await saveDeliveryInstructionText(f.refs[1], {
    expectedRevision: 0, additionalText: "Call ahead for the remaining delivery."
  }, context);
  assert.equal(saved.orderId, f.id);
  assert.equal(saved.revision, 1);
  const mediaInput = { expectedRevision: 1, mimeType: "image/jpeg", byteSize: 128, fileName: "gate.jpg" };
  const ticket = await issueDeliveryInstructionMediaUpload(f.ref, mediaInput, context);
  const mediaPayload = {
    ...mediaInput, uploadId: ticket.uploadId,
    objectReference: `r2://sales/sales-delivery-instruction-media/2026/10/19/${ticket.uploadId}/gate.jpg`
  };
  const registered = await registerDeliveryInstructionMedia(f.refs[0], mediaPayload, context);
  assert.equal(registered.media.length, 1);
  assert.equal(registered.additionalText, saved.additionalText);
  const removed = await removeDeliveryInstructionMedia(f.ref, ticket.uploadId, { expectedRevision: 2 }, context);
  assert.equal(removed.media.length, 0);
  const pending = await issueDeliveryInstructionMediaUpload(f.ref, { ...mediaInput, expectedRevision: 3 }, context);
  const currentMedia = await registerDeliveryInstructionMedia(f.ref, {
    ...mediaPayload, expectedRevision: 3, uploadId: pending.uploadId,
    objectReference: `r2://sales/sales-delivery-instruction-media/2026/10/19/${pending.uploadId}/gate.jpg`
  }, context);
  const finalTicket = await issueDeliveryInstructionMediaUpload(f.ref, { ...mediaInput, expectedRevision: 4 }, context);
  await job([f.refs[1]]);
  await assert.rejects(() => saveDeliveryInstructionText(f.ref, {
    expectedRevision: 4, additionalText: "Must stay locked."
  }, context), readOnly);
  await assert.rejects(() => issueDeliveryInstructionMediaUpload(f.ref, { ...mediaInput, expectedRevision: 4 }, context), readOnly);
  await assert.rejects(() => registerDeliveryInstructionMedia(f.ref, {
    ...mediaPayload, expectedRevision: 4, uploadId: finalTicket.uploadId,
    objectReference: `r2://sales/sales-delivery-instruction-media/2026/10/19/${finalTicket.uploadId}/gate.jpg`
  }, context), readOnly);
  await assert.rejects(() => removeDeliveryInstructionMedia(f.ref, pending.uploadId, { expectedRevision: 4 }, context), readOnly);
  const locked = await getDeliveryInstruction(f.ref, context);
  assert.equal(locked.revision, currentMedia.revision);
  assert.deepEqual(locked.media, currentMedia.media);
  assert.equal(locked.additionalText, saved.additionalText);
});

test("NetSuite instruction saves remain available until the last split is delivered", async () => {
  const f = await fixture();
  const netSuite = {
    identity: { orderId: f.id, orderRef: f.ref, locationId: 1 },
    values: { memo: "Original instructions", shipDate: "2026-10-19", deliverByDate: "2026-10-20" },
    editable: true
  };
  let writes = 0;
  const remote = {
    read: async () => structuredClone(netSuite),
    update: async ({ values }) => { writes += 1; return { ...netSuite, values }; }
  };
  await job([f.refs[0]]);
  const loaded = await getDeliveryInstructionNetSuite(f.ref, context, remote);
  assert.equal(loaded.editable, true);
  const input = {
    expectedRevision: 0, expected: loaded.netSuite,
    values: { ...netSuite.values, memo: "Call before delivering the remaining split." }
  };
  const saved = await saveDeliveryInstructionNetSuite(f.refs[1], input, context, remote);
  assert.equal(saved.revision, 1);
  assert.equal(writes, 1);
  await job([f.refs[1]]);
  await assert.rejects(() => saveDeliveryInstructionNetSuite(f.ref, {
    ...input, expectedRevision: 1
  }, context, remote), readOnly);
  assert.equal(writes, 1);
});
