import assert from "node:assert/strict";
import test from "node:test";

import { query, withTransaction } from "../../../src/db.js";
import {
  assertNoDriverPwaCompletedDispatchRefs,
  listDriverPwaCompletedDispatchRefs
} from "../../../src/dispatch-history-mode.js";

async function addPoSplit(parentRef, childRef, { status = "active" } = {}) {
  await query(
    `INSERT INTO dispatch_scm_po_splits (
       source_po_ref, split_po_ref, status, created_by
     ) VALUES ($1, $2, $3, 'driver-completion-split-test')`,
    [parentRef, childRef, status]
  );
}

async function completeDriverRef(orderRef, suffix) {
  await query(
    `INSERT INTO driver_job_records (
       job_id, driver_login, stop_type, order_refs, status, started_at, completed_at
     ) VALUES ($1, 'split-test-driver', 'dropoff', $2::jsonb, 'complete', now(), now())`,
    [`driver-completion-split-${suffix}`, JSON.stringify([orderRef])]
  );
}

async function addScheduleGroup(groupRef, memberRefs, { status = "active" } = {}) {
  const inserted = await query(
    `INSERT INTO scm_schedule_groups (group_ref, status, created_by)
     VALUES ($1, $2, 'driver-completion-split-test')
     RETURNING id`,
    [groupRef, status]
  );
  for (const memberRef of memberRefs) {
    await query(
      `INSERT INTO scm_schedule_group_members (group_id, order_kind, order_ref)
       VALUES ($1, 'PO', $2)`,
      [inserted.rows[0].id, memberRef]
    );
  }
}

test("a completed PO split blocks itself without contaminating sibling splits", async () => {
  await withTransaction(async () => {
    const parent = "POB-SPLIT-ISOLATION";
    const completedChild = "PO# SPLIT-ISOLATION (L3)";
    const openSibling = "PO# SPLIT-ISOLATION (L4)";
    await addPoSplit(parent, completedChild);
    await addPoSplit(parent, openSibling);
    await completeDriverRef(completedChild, "sibling");

    const completed = await listDriverPwaCompletedDispatchRefs({ candidateRefs: [openSibling] });
    assert.equal(completed.has(openSibling.toLowerCase()), false);
    assert.equal(completed.has(parent.toLowerCase()), false);
    await assert.doesNotReject(() => assertNoDriverPwaCompletedDispatchRefs([openSibling], "add these orders to Dispatch"));
    await assert.rejects(
      () => assertNoDriverPwaCompletedDispatchRefs([completedChild], "add these orders to Dispatch"),
      (error) => error?.code === "DISPATCH_ORDER_DRIVER_COMPLETED" && error?.status === 409
    );
  }, { rollback: true });
});

test("a source order completed in Driver PWA still blocks active split descendants", async () => {
  await withTransaction(async () => {
    const source = "POB-SOURCE-COMPLETE";
    const child = "PO# SOURCE-COMPLETE (L1)";
    const grandchild = "PO# SOURCE-COMPLETE (L1-A)";
    await addPoSplit(source, child);
    await addPoSplit(child, grandchild);
    await completeDriverRef(source, "source");

    const completed = await listDriverPwaCompletedDispatchRefs({ candidateRefs: [grandchild] });
    assert.equal(completed.has(grandchild.toLowerCase()), true);
    await assert.rejects(
      () => assertNoDriverPwaCompletedDispatchRefs([grandchild], "add these orders to Dispatch"),
      (error) => error?.code === "DISPATCH_ORDER_DRIVER_COMPLETED"
    );
  }, { rollback: true });
});

test("active schedule groups retain family-level Driver completion protection", async () => {
  await withTransaction(async () => {
    const group = "POGROUP-ACTIVE-COMPLETE";
    const completedMember = "PO# GROUP-ACTIVE (A)";
    const siblingMember = "PO# GROUP-ACTIVE (B)";
    await addScheduleGroup(group, [completedMember, siblingMember]);
    await completeDriverRef(completedMember, "active-group");

    const completed = await listDriverPwaCompletedDispatchRefs({ candidateRefs: [siblingMember] });
    assert.equal(completed.has(siblingMember.toLowerCase()), true);
    await assert.rejects(
      () => assertNoDriverPwaCompletedDispatchRefs([siblingMember], "add these orders to Dispatch"),
      (error) => error?.code === "DISPATCH_ORDER_DRIVER_COMPLETED"
    );
  }, { rollback: true });
});

test("cancelled split and inactive group relations cannot create completion locks", async () => {
  await withTransaction(async () => {
    const splitSource = "POB-CANCELLED-SPLIT";
    const splitChild = "PO# CANCELLED-SPLIT (L1)";
    await addPoSplit(splitSource, splitChild, { status: "cancelled" });
    await completeDriverRef(splitSource, "cancelled-split");

    const inactiveGroup = "POGROUP-INACTIVE-COMPLETE";
    const inactiveMember = "PO# GROUP-INACTIVE (A)";
    await addScheduleGroup(inactiveGroup, [inactiveMember], { status: "cancelled" });
    await completeDriverRef(inactiveGroup, "inactive-group");

    const completed = await listDriverPwaCompletedDispatchRefs({ candidateRefs: [splitChild, inactiveMember] });
    assert.equal(completed.has(splitChild.toLowerCase()), false);
    assert.equal(completed.has(inactiveMember.toLowerCase()), false);
    await assert.doesNotReject(() => assertNoDriverPwaCompletedDispatchRefs(
      [splitChild, inactiveMember],
      "add these orders to Dispatch"
    ));
  }, { rollback: true });
});

test("an exact Driver-completed reference remains blocked without any relation rows", async () => {
  await withTransaction(async () => {
    const orderRef = "PO# EXACT-DRIVER-COMPLETE";
    await completeDriverRef(orderRef, "exact");

    const completed = await listDriverPwaCompletedDispatchRefs({ candidateRefs: [`  ${orderRef.toLowerCase()}  `] });
    assert.equal(completed.has(orderRef.toLowerCase()), true);
    await assert.rejects(
      () => assertNoDriverPwaCompletedDispatchRefs([orderRef], "add these orders to Dispatch"),
      (error) => error?.code === "DISPATCH_ORDER_DRIVER_COMPLETED"
    );
  }, { rollback: true });
});
