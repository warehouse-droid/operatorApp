import assert from "node:assert/strict";
import { beginRollbackContext, closeDb, query } from "./db.js";
import {
  repairScmPoScheduleGroupRollup,
  resolveScmReconciliationReview
} from "./scm-reconciliation-repository.js";

const rollback = await beginRollbackContext();

function canonical(value) {
  return JSON.parse(JSON.stringify(value));
}

try {
  await rollback.run(async () => {
    const seed = 9_946_000_000 + Math.floor(Math.random() * 100_000);
    const sourceIds = [seed + 1, seed + 2];
    const memberRefs = [`TST-PGOB-MEMBER-${seed + 1}`, `TST-PGOB-MEMBER-${seed + 2}`];
    const groupRef = `PGOB-${memberRefs.join("-")}`;
    const actor = "scm-po-group-rollup-recovery-harness";

    for (let index = 0; index < sourceIds.length; index += 1) {
      await query(
        `INSERT INTO purchase_orders (
           netsuite_id, tranid, trandate, status, status_text, vendor_id, vendor,
           destination_location_id, destination_location, receipt_status,
           netsuite_active, synced_at
         ) VALUES (
           $1, $2, DATE '2099-12-01', 'G', 'Purchase Order : Fully Billed',
           994601, 'PO Group Recovery Vendor', 28, '2967', 'received', true, now()
         )`,
        [sourceIds[index], memberRefs[index]]
      );
    }

    const quantitySummary = {
      family: {
        orderRef: memberRefs[0],
        ordered: 10,
        fulfilled: 0,
        received: 10,
        abandoned: 0,
        remaining: 0,
        destinationRemaining: 0
      },
      targets: {
        [memberRefs[0]]: {
          orderRef: memberRefs[0],
          orderId: sourceIds[0],
          targetKind: "source_residual",
          ordered: 10,
          fulfilled: 0,
          received: 10,
          abandoned: 0,
          remaining: 0,
          destinationRemaining: 0,
          applicationStatus: "Reconcile Review",
          reconciliationStatus: "review",
          exactAllocation: false,
          allocationMethods: ["inferred"],
          hidden: false,
          hasActivePlan: false
        }
      }
    };
    const stateResult = await query(
      `INSERT INTO scm_reconciliation_order_state (
         order_kind, source_order_netsuite_id, source_order_ref,
         netsuite_status_code, netsuite_status_text, netsuite_terminal_state,
         application_status, reconciliation_status, reconciliation_reason,
         reconciliation_source, ordered_qty, fulfilled_qty, received_qty,
         abandoned_qty, remaining_qty, destination_remaining_qty,
         exact_allocation, quantity_summary, proposed_state, reconciled_at
       ) VALUES (
         'PO', $1, $2, 'G', 'Purchase Order : Fully Billed', 'open',
         'Reconcile Review', 'review', 'Legacy grouped review is stale.',
         'manual', 10, 0, 10, 0, 0, 0, false, $3::jsonb, $4::jsonb, now()
       ) RETURNING id`,
      [
        sourceIds[0],
        memberRefs[0],
        JSON.stringify(quantitySummary),
        JSON.stringify({
          applicationStatus: "Reconcile Review",
          reconciliationStatus: "review",
          targets: quantitySummary.targets
        })
      ]
    );
    const stateId = Number(stateResult.rows[0].id);
    const lineResult = await query(
      `INSERT INTO scm_reconciliation_order_line_state (
         order_state_id, netsuite_line_key, item_id, item_name, sku, unit,
         current_ordered_qty, fulfilled_qty, received_qty, abandoned_qty,
         remaining_qty, line_status, identity_status, allocation_quality,
         netsuite_active
       ) VALUES (
         $1, $2, 9946001, 'PO Group Recovery Item', 'PGROUP-ITEM', 'EA',
         10, 0, 10, 0, 0, 'completed', 'exact', 'inferred', true
       ) RETURNING id`,
      [stateId, String(seed + 101)]
    );
    await query(
      `INSERT INTO scm_reconciliation_allocations (
         allocation_key, order_line_state_id, progress_kind, target_kind,
         target_order_ref, target_line_ref, quantity, allocation_method, active
       ) VALUES ($1, $2, 'received', 'source_residual', $3, $4, 10, 'inferred', true)`,
      [
        `po-group-recovery:${seed}`,
        Number(lineResult.rows[0].id),
        memberRefs[0],
        String(seed + 101)
      ]
    );
    const reviewResult = await query(
      `INSERT INTO scm_reconciliation_review_cases (
         case_key, order_state_id, review_code, severity, dismissible,
         status, reason, details
       ) VALUES (
         $1, $2, 'reconciliation_conflict', 'blocking', false,
         'open', 'Legacy grouped review is stale.', '{}'::jsonb
       ) RETURNING id`,
      [`po-group-recovery:${seed}`, stateId]
    );

    const groupResult = await query(
      `INSERT INTO scm_schedule_groups (group_ref, status, created_by)
       VALUES ($1, 'active', $2) RETURNING id`,
      [groupRef, actor]
    );
    await query(
      `INSERT INTO scm_transport_schedule (
         order_kind, order_ref, group_ref, status,
         reconciliation_order_state_id, reconciliation_blocked,
         last_reconciled_at, created_by, updated_by
       ) VALUES
         ('PO', $1, $3, 'Reconcile Review', $4, true, now(), $5, $5),
         ('PO', $2, $3, 'Completed', NULL, false, now(), $5, $5),
         ('PO', $3, $3, 'Reconcile Review', NULL, true, now(), $5, $5)`,
      [memberRefs[0], memberRefs[1], groupRef, stateId, actor]
    );
    for (const memberRef of memberRefs) {
      await query(
        `INSERT INTO scm_schedule_group_members (group_id, order_kind, order_ref)
         VALUES ($1, 'PO', $2)`,
        [Number(groupResult.rows[0].id), memberRef]
      );
    }

    const immutableBefore = canonical((await query(
      `SELECT line.current_ordered_qty, line.received_qty, line.remaining_qty,
              allocation.quantity, allocation.allocation_method,
              allocation.target_order_ref
         FROM scm_reconciliation_order_line_state line
         JOIN scm_reconciliation_allocations allocation
           ON allocation.order_line_state_id = line.id
        WHERE line.order_state_id = $1`,
      [stateId]
    )).rows);

    const resolution = await resolveScmReconciliationReview({
      kind: "PO",
      orderRef: memberRefs[0],
      resolution: "accept_current",
      note: "Regression harness accepts the already-complete member evidence.",
      actor,
      actorRole: "admin"
    });
    assert.equal(resolution.remainingOpenCases, 0);

    let parent = (await query(
      `SELECT status, reconciliation_blocked, updated_by, last_reconciled_at
         FROM scm_transport_schedule
        WHERE order_kind = 'PO' AND order_ref = $1`,
      [groupRef]
    )).rows[0];
    assert.equal(parent.status, "Completed",
      "Resolving the final member review must recover a stale group status.");
    assert.equal(parent.reconciliation_blocked, false);
    assert.equal(parent.updated_by, actor);
    assert.ok(parent.last_reconciled_at);

    const review = (await query(
      `SELECT status, resolution_action
         FROM scm_reconciliation_review_cases
        WHERE id = $1`,
      [Number(reviewResult.rows[0].id)]
    )).rows[0];
    assert.equal(review.status, "resolved");
    assert.equal(review.resolution_action, "accept");

    const immutableAfter = canonical((await query(
      `SELECT line.current_ordered_qty, line.received_qty, line.remaining_qty,
              allocation.quantity, allocation.allocation_method,
              allocation.target_order_ref
         FROM scm_reconciliation_order_line_state line
         JOIN scm_reconciliation_allocations allocation
           ON allocation.order_line_state_id = line.id
        WHERE line.order_state_id = $1`,
      [stateId]
    )).rows);
    assert.deepEqual(immutableAfter, immutableBefore,
      "Group recovery must not rewrite line quantities or allocations.");

    await query(
      `UPDATE scm_transport_schedule
          SET status = 'Reconcile Review', reconciliation_blocked = true,
              updated_by = 'legacy-test-state', updated_at = now()
        WHERE order_kind = 'PO' AND order_ref = $1`,
      [groupRef]
    );
    await assert.rejects(
      repairScmPoScheduleGroupRollup({
        groupRef,
        expectedMemberRefs: [memberRefs[0], "WRONG-MEMBER"],
        actor
      }),
      /member set changed/i
    );
    parent = (await query(
      `SELECT status, reconciliation_blocked
         FROM scm_transport_schedule
        WHERE order_kind = 'PO' AND order_ref = $1`,
      [groupRef]
    )).rows[0];
    assert.equal(parent.status, "Reconcile Review");
    assert.equal(parent.reconciliation_blocked, true);

    const repaired = await repairScmPoScheduleGroupRollup({
      groupRef,
      expectedMemberRefs: memberRefs,
      actor
    });
    assert.equal(repaired.changed, true);
    assert.equal(repaired.after.status, "Completed");
    assert.equal(repaired.after.reconciliationBlocked, false);
    assert.ok(repaired.auditEventId > 0);

    const auditCount = Number((await query(
      `SELECT COUNT(*)::int AS count
         FROM scm_reconciliation_audit_events
        WHERE event_type = 'schedule_group.rollup_repaired'
          AND parent_order_ref = $1`,
      [groupRef]
    )).rows[0].count);
    const retry = await repairScmPoScheduleGroupRollup({
      groupRef,
      expectedMemberRefs: [...memberRefs].reverse(),
      actor
    });
    assert.equal(retry.changed, false);
    assert.equal(retry.auditEventId, null);
    assert.equal(Number((await query(
      `SELECT COUNT(*)::int AS count
         FROM scm_reconciliation_audit_events
        WHERE event_type = 'schedule_group.rollup_repaired'
          AND parent_order_ref = $1`,
      [groupRef]
    )).rows[0].count), auditCount,
    "An idempotent retry must not append a duplicate repair audit event.");
  });
  console.log("SCM PO group rollup recovery harness passed.");
} finally {
  await rollback.rollback();
  await closeDb();
}
