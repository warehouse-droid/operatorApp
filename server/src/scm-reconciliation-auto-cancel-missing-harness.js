import assert from "node:assert/strict";
import { closeDb, query, withTransaction } from "./db.js";
import {
  autoCancelConfirmedMissingScmOrder,
  listLocalScmReconciliationSources,
  recordScmReconciliationMissingLookup
} from "./scm-reconciliation-repository.js";

const seed = Date.now() % 100000000;
const baseId = 880000000000 + (seed * 10);

async function seedOrder(kind, id, ref) {
  if (kind === "SO") {
    await query(
      `INSERT INTO sales_orders (
         netsuite_id, tranid, trandate, status, status_text, customer,
         sales_order_type, netsuite_active, synced_at
       ) VALUES ($1,$2,current_date,'B','Sales Order : Pending Fulfillment','Harness','delivery',true,now())`,
      [id, ref]
    );
    await query(
      `INSERT INTO sales_order_lines (
         sales_order_id, line_id, item_id, item_name, sku, quantity, unit,
         netsuite_active, synced_at
       ) VALUES ($1,1,$2,'Harness item','HARNESS',10,'EA',true,now())`,
      [id, id + 1]
    );
    return;
  }
  if (kind === "PO") {
    await query(
      `INSERT INTO purchase_orders (
         netsuite_id, tranid, trandate, status, status_text, receipt_status,
         netsuite_active, synced_at
       ) VALUES ($1,$2,current_date,'B','Purchase Order : Pending Receipt','not_received',true,now())`,
      [id, ref]
    );
    await query(
      `INSERT INTO purchase_order_lines (
         purchase_order_id, line_id, item_id, item_name, sku, quantity, unit,
         netsuite_received_qty, netsuite_active, synced_at
       ) VALUES ($1,1,$2,'Harness item','HARNESS',10,'EA',0,true,now())`,
      [id, id + 1]
    );
    return;
  }
  await query(
    `INSERT INTO transfer_orders (
       netsuite_id, tranid, trandate, status, status_text, fulfillment_status,
       receiving_status, netsuite_active, synced_at
     ) VALUES ($1,$2,current_date,'B','Transfer Order : Pending Fulfillment','pending','not_received',true,now())`,
    [id, ref]
  );
  await query(
    `INSERT INTO transfer_order_lines (
       line_stage, transfer_order_id, line_id, item_id, item_name, sku,
       quantity, unit, netsuite_active, synced_at
     ) VALUES ('outbound',$1,1,$2,'Harness item','HARNESS',10,'EA',true,now())`,
    [id, id + 1]
  );
}

try {
  await withTransaction(async () => {
    for (const [offset, kind] of ["SO", "PO", "TO"].entries()) {
      const id = baseId + (offset * 2);
      const ref = `${kind}-AUTO-MISSING-${seed}`;
      await seedOrder(kind, id, ref);
      await recordScmReconciliationMissingLookup({ kind, id, tranid: ref }, {
        sourceName: "manual"
      });
      const confirmed = await recordScmReconciliationMissingLookup({ kind, id, tranid: ref }, {
        sourceName: "manual"
      });
      assert.equal(confirmed.missing_success_count, 2);
      await assert.rejects(
        autoCancelConfirmedMissingScmOrder({
          kind,
          id,
          tranid: ref,
          successfulLookups: confirmed.missing_success_count,
          sourceName: "manual"
        }),
        (error) => error?.code === "SCM_RECONCILIATION_NETSUITE_VERIFICATION_REQUIRED"
      );
      const cancelled = await autoCancelConfirmedMissingScmOrder({
        kind,
        id,
        tranid: ref,
        successfulLookups: confirmed.missing_success_count,
        sourceName: "manual",
        verification: {
          verifiedAt: new Date().toISOString(),
          orderKind: kind,
          sourceOrderId: id,
          sourceOrderRef: ref,
          lineQueryFound: false,
          headerQueryFound: false,
          referenceQueryFound: false
        }
      });
      assert.equal(cancelled.applicationStatus, "Cancelled");
      assert.equal(cancelled.netsuiteTerminalState, "deleted");
      const state = await query(
        `SELECT application_status, reconciliation_status, netsuite_terminal_state
           FROM scm_reconciliation_order_state
          WHERE order_kind = $1 AND source_order_netsuite_id = $2`,
        [kind, id]
      );
      assert.deepEqual({
        applicationStatus: state.rows[0].application_status,
        reconciliationStatus: state.rows[0].reconciliation_status,
        terminal: state.rows[0].netsuite_terminal_state
      }, {
        applicationStatus: "Cancelled",
        reconciliationStatus: "current",
        terminal: "deleted"
      });
      const table = kind === "SO" ? "sales_orders" : kind === "PO" ? "purchase_orders" : "transfer_orders";
      const local = await query(`SELECT netsuite_active, netsuite_missing_at${kind === "SO" ? ", operator_status, local_yard_order_status" : ""} FROM ${table} WHERE netsuite_id = $1`, [id]);
      assert.equal(local.rows[0].netsuite_active, false);
      assert.ok(local.rows[0].netsuite_missing_at);
      if (kind === "SO") {
        assert.equal(local.rows[0].operator_status, "cancelled");
        assert.equal(local.rows[0].local_yard_order_status, "Cancelled");
      } else {
        const schedule = await query(
          `SELECT status, reconciliation_blocked
             FROM scm_transport_schedule
            WHERE order_kind = $1 AND lower(order_ref) = lower($2)`,
          [kind, ref]
        );
        assert.equal(schedule.rows[0].status, "Cancelled");
        assert.equal(schedule.rows[0].reconciliation_blocked, false);
      }
      const broad = await listLocalScmReconciliationSources({ kind });
      assert.equal(broad.some((source) => source.id === id), false,
        `${kind} confirmed deletions must not reopen on every broad reconciliation run.`);
    }
  }, { rollback: true });
  console.log("SCM confirmed-missing PO/SO/TO auto-cancellation harness passed.");
} finally {
  await closeDb();
}
