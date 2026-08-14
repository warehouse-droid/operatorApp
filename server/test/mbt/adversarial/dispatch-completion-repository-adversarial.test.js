// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import {
  listDispatchOrderCompletionStatuses,
  manuallyCompleteDispatchOrder
} from "../../../src/dispatch-completion-repository.js";

after(closeDb);

async function inRollback(operation) {
  const rollback = await beginRollbackContext();
  try {
    return await rollback.run(operation);
  } finally {
    await rollback.rollback();
  }
}

test("manual completion normalizes every supported order family and rejects hostile input", async () => {
  await inRollback(async () => {
    const suffix = crypto.randomUUID().replaceAll("-", "").toUpperCase();
    const base = 9_994_000_000 + Math.floor(Math.random() * 100_000);
    const refs = {
      SO: `SO-ADV-${suffix}`,
      TO: `TO-ADV-${suffix}`,
      PO: `PO-ADV-${suffix}`,
      VRMA: `VRMA-ADV-${suffix}`,
      CUSTOM: `CUSTOM-ADV-${suffix}`
    };
    await query(
      `INSERT INTO sales_orders (
         netsuite_id, tranid, fulfillment_status, outbound_location,
         sales_order_type, dispatch_address, netsuite_active, synced_at
       ) VALUES ($1, $2, 'not_fulfilled', '2967', 'Delivery', 'Adversarial SO address', true, now())`,
      [base + 1, refs.SO]
    );
    await query(
      `INSERT INTO transfer_orders (
         netsuite_id, tranid, from_location_id, from_location,
         to_location_id, to_location, fulfillment_status, netsuite_active, synced_at
       ) VALUES ($1, $2, 28, '2967', 15, '12441', 'not_fulfilled', true, now())`,
      [base + 2, refs.TO]
    );
    await query(
      `INSERT INTO purchase_orders (
         netsuite_id, tranid, vendor, destination_location_id, destination_location,
         receipt_status, netsuite_active, synced_at
       ) VALUES ($1, $2, 'Adversarial vendor', 15, '12441', 'pending', true, now())`,
      [base + 3, refs.PO]
    );
    await query(
      `INSERT INTO scm_vrma_orders (
         vrma_ref, vendor, pickup_location, dropoff_location,
         status, method, created_by, updated_by
       ) VALUES ($1, 'Adversarial vendor', '3445', 'Vendor yard', 'Queued', 'MBT', 'adv', 'adv')`,
      [refs.VRMA]
    );
    await query(
      `INSERT INTO dispatch_custom_orders (
         ref_number, pickup_location, dropoff_location, order_details,
         weight_lbs, status, created_by, updated_by
       ) VALUES ($1, 'Custom pickup', 'Custom drop', 'Adversarial custom order', 1, 'open', 'adv', 'adv')`,
      [refs.CUSTOM]
    );

    const actor = { id: `admin-${suffix}`, role: "Admin" };
    const aliases = [
      ["sales order", refs.SO, "SO"],
      ["transfer-order", refs.TO, "TO"],
      ["purchase order", refs.PO, "PO"],
      ["vendor return authorization", refs.VRMA, "VRMA"],
      ["custom order", refs.CUSTOM, "CUSTOM"]
    ];
    for (const [index, [orderKind, orderRef, canonicalKind]] of aliases.entries()) {
      const completion = await manuallyCompleteDispatchOrder({
        actor,
        orderKind,
        orderRef,
        completedAt: index === 0 ? undefined : `2025-01-0${index + 1}T12:00:00.000Z`,
        reason: `Adversarial retained completion ${index}`,
        confirm: true
      });
      assert.equal(completion.orderKind, canonicalKind);
      assert.equal(completion.actorId, actor.id);
    }

    assert.deepEqual(await listDispatchOrderCompletionStatuses(null), []);
    assert.deepEqual(await listDispatchOrderCompletionStatuses([
      { orderKind: "unsupported", orderRef: "HELPER" },
      { orderKind: "SO", orderRef: "" }
    ]), []);
    const statuses = await listDispatchOrderCompletionStatuses([
      ...aliases.map(([, orderRef, orderKind]) => ({ orderKind, orderRef })),
      { orderKind: "sales order", orderRef: refs.SO.toLowerCase() }
    ]);
    assert.equal(statuses.length, aliases.length);

    const baseCommand = {
      actor: { operatorId: actor.id, roles: ["dispatcher"] },
      orderKind: "SO",
      orderRef: refs.SO,
      completedAt: "2025-01-01T12:00:00.000Z",
      reason: "Valid retained reason",
      confirm: true
    };
    const invalidCases = [
      [{ ...baseCommand, orderKind: "CO" }, "DISPATCH_COMPLETION_ORDER_KIND_INVALID"],
      [{ ...baseCommand, orderRef: "" }, "DISPATCH_COMPLETION_ORDER_REF_INVALID"],
      [{ ...baseCommand, orderRef: "X".repeat(201) }, "DISPATCH_COMPLETION_ORDER_REF_INVALID"],
      [{ ...baseCommand, reason: "R".repeat(1001) }, "DISPATCH_COMPLETION_REASON_INVALID"],
      [{ ...baseCommand, completedAt: "not-a-date" }, "DISPATCH_COMPLETION_TIME_INVALID"],
      [{ ...baseCommand, actor: { roles: ["dispatcher"] } }, "DISPATCH_COMPLETION_FORBIDDEN"]
    ];
    for (const [command, code] of invalidCases) {
      await assert.rejects(
        manuallyCompleteDispatchOrder(command),
        (error) => error?.code === code
      );
    }
    await assert.rejects(
      manuallyCompleteDispatchOrder(null),
      (error) => error?.code === "DISPATCH_COMPLETION_FORBIDDEN"
    );

    const cancelledVrma = `VRMA-CANCELLED-${suffix}`;
    const cancelledCustom = `CUSTOM-CANCELLED-${suffix}`;
    await query(
      `INSERT INTO scm_vrma_orders (
         vrma_ref, vendor, status, method, created_by, updated_by
       ) VALUES ($1, 'Cancelled vendor', 'cancelled', 'MBT', 'adv', 'adv')`,
      [cancelledVrma]
    );
    await query(
      `INSERT INTO dispatch_custom_orders (
         ref_number, pickup_location, dropoff_location, order_details,
         weight_lbs, status, created_by, updated_by
       ) VALUES ($1, 'Pickup', 'Drop', 'Cancelled custom', 1, 'cancelled', 'adv', 'adv')`,
      [cancelledCustom]
    );
    for (const [orderKind, orderRef] of [["VRMA", cancelledVrma], ["CUSTOM", cancelledCustom]]) {
      await assert.rejects(
        manuallyCompleteDispatchOrder({ ...baseCommand, orderKind, orderRef }),
        (error) => error?.code === "DISPATCH_COMPLETION_ORDER_CANCELLED"
      );
    }
  });
});
