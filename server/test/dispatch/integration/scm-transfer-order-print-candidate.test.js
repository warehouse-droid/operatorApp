import assert from "node:assert/strict";
import test, { after } from "node:test";

import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import {
  findScmTransferOrderPrintCandidate,
  getScmTransferOrderPrintSnapshot,
  listScmTransferOrderPrintCandidates,
  listScmTransferOrderPrintHistory,
  listScmTransferOrderPrintJobs
} from "../../../src/scm-transfer-order-print-service.js";

after(closeDb);

test("TO print candidate resolves an absent header source from one outbound line yard", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
      const orderId = 8_710_000_000_000 + Number(suffix.slice(-9));
      const orderRef = `TO-PRINT-CANDIDATE-${suffix}`;
      await query(
        `INSERT INTO transfer_orders (
           netsuite_id, tranid, trandate, status, status_text,
           from_location_id, from_location, to_location_id, to_location,
           fulfillment_status, receiving_status, netsuite_active, synced_at
         ) VALUES (
           $1, $2, current_date, 'B', 'Transfer Order : Pending Fulfillment',
           NULL, NULL, 15, '12441', 'not_fulfilled', 'not_received', true, now()
         )`,
        [orderId, orderRef]
      );
      await query(
        `INSERT INTO transfer_order_lines (
           line_stage, transfer_order_id, line_id, item_id, item_name, sku,
           quantity, unit, location_id, location, piece_qty, to_pcs,
           netsuite_active, raw
         ) VALUES (
           'outbound', $1, $2, $3, 'TO Print Candidate Item', $4,
           4, 'EA', 28, '2967', 4, 1, true, '{}'::jsonb
         )`,
        [orderId, orderId + 1, orderId + 2, `TO-PRINT-SKU-${suffix}`]
      );

      const candidate = await findScmTransferOrderPrintCandidate({
        orderRef,
        sourceId: orderId
      });
      assert.deepEqual(candidate, {
        orderId,
        orderRef,
        sourceLocationId: 28,
        sourceLocation: "2967",
        destinationLocationId: 15,
        destinationLocation: "12441",
        status: "B",
        statusText: "Transfer Order : Pending Fulfillment",
        netsuiteActive: true
      });
    });
  } finally {
    await rollback.rollback();
  }
});

test("TO printing history combines manual, stock-request, and legacy Smart SCM jobs", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
      const orderId = 8_720_000_000_000 + Number(suffix.slice(-9));
      const orderRef = `TO-PRINT-HISTORY-${suffix}`;
      await query(
        `INSERT INTO transfer_orders (
           netsuite_id, tranid, trandate, status, status_text,
           from_location_id, from_location, to_location_id, to_location,
           fulfillment_status, receiving_status, netsuite_active, synced_at
         ) VALUES (
           $1, $2, current_date, 'B', 'Transfer Order : Pending Fulfillment',
           28, '2967', 15, '12441', 'not_fulfilled', 'not_received', true, now()
         )`,
        [orderId, orderRef]
      );
      await query(
        `INSERT INTO transfer_order_lines (
           line_stage, transfer_order_id, line_id, item_id, item_name, sku,
           quantity, unit, location_id, location, piece_qty, to_pcs,
           netsuite_active, raw
         ) VALUES (
           'outbound', $1, $2, $3, 'History Item', $4,
           8, 'EA', 28, '2967', 8, 1, true, '{}'::jsonb
         )`,
        [orderId, orderId + 1, orderId + 2, `TO-HISTORY-SKU-${suffix}`]
      );

      const planningRun = await query(
        `INSERT INTO scm_smart_planning_runs (status, trigger_source, revision)
         VALUES ('completed', 'manual', 1)
         RETURNING id`
      );
      const proposal = await query(
        `INSERT INTO scm_smart_proposals (
           run_id, proposal_key, proposal_type, phase, source_kind,
           source_location_id, source_name, destination_location_id, destination_name,
           status, netsuite_transfer_order_id, netsuite_transfer_order_ref
         ) VALUES (
           $1, $2, 'TO', 'internal_transfer', 'yard',
           28, '2967', 15, '12441', 'completed', $3, $4
         ) RETURNING id`,
        [planningRun.rows[0].id, `history-${suffix}`, orderId, orderRef]
      );

      const insertJob = async ({ key, type, proposalId = null, includeIdentity = true, path }) => query(
        `INSERT INTO scm_print_jobs (
           job_key, proposal_id, location_id, document_type, document_name,
           document_path, document_sha256, status, source_order_id, source_order_ref,
           line_location_id, printer_names
         ) VALUES (
           $1, $2, 28, $3, $4, $5, $6, 'printed', $7, $8, 28,
           '["TO Printer A", "TO Printer B"]'::jsonb
         ) RETURNING id`,
        [
          key,
          proposalId,
          type,
          `${orderRef}.pdf`,
          path,
          `sha-${key}`,
          includeIdentity ? orderId : null,
          includeIdentity ? orderRef : null
        ]
      );

      const manual = await insertJob({
        key: `scm-to-printing:${suffix}`,
        type: "picking_ticket",
        path: `/tmp/${orderRef}-manual.pdf`
      });
      await insertJob({
        key: `stock-request:${suffix}`,
        type: "transfer_dependency_picking_ticket",
        path: `/tmp/${orderRef}-stock.pdf`
      });
      await insertJob({
        key: `smart-scm:${suffix}`,
        type: "picking_ticket",
        proposalId: proposal.rows[0].id,
        includeIdentity: false,
        path: `/tmp/${orderRef}-smart.pdf`
      });

      const candidates = await listScmTransferOrderPrintCandidates({ search: orderRef });
      const candidate = candidates.find((entry) => entry.orderId === orderId);
      assert.equal(candidate?.printHistoryCount, 3);
      assert.equal(candidate?.itemLines[0]?.itemName, "History Item");

      const history = await listScmTransferOrderPrintHistory({ orderId, orderRef });
      assert.deepEqual(new Set(history.map((entry) => entry.sourceModule)), new Set([
        "TO Printing",
        "Stock Requests",
        "Smart SCM"
      ]));
      assert.ok(history.every((entry) => entry.orderRef === orderRef));
      assert.ok(history.every((entry) => entry.printerNames.length === 2));

      const recent = await listScmTransferOrderPrintJobs({ limit: 1000 });
      assert.equal(recent.filter((entry) => entry.orderRef === orderRef).length, 3);

      const snapshot = await getScmTransferOrderPrintSnapshot({
        orderId,
        orderRef,
        jobId: manual.rows[0].id
      });
      assert.equal(snapshot.documentPath, `/tmp/${orderRef}-manual.pdf`);
    });
  } finally {
    await rollback.rollback();
  }
});
