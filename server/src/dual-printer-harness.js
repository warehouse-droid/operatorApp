import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { closeDb, query, withTransaction } from "./db.js";
import {
  createSimplePdf,
  leaseYardPrintJob,
  queueSmartScmPrintJob,
  queueYardPrinterTest,
  retrySmartScmPrintJob,
  rotateYardPrinterToken,
  updateLeasedPrintJob,
  updateYardPrinter
} from "./smart-scm-print-repository.js";

const printPaths = [];

async function rememberPrintPath(jobId) {
  const result = await query("SELECT document_path FROM scm_print_jobs WHERE id = $1", [Number(jobId)]);
  assert.equal(result.rowCount, 1);
  printPaths.push(result.rows[0].document_path);
}

try {
  await withTransaction(async () => {
    await query(
      "UPDATE scm_yard_printers SET agent_token_hash = NULL WHERE location_id = $1",
      [15]
    );
    const configured = await updateYardPrinter(15, {
      enabled: true,
      printers: [
        { slot: 1, printerName: "Harness 12441 Printer 1", printTransferOrders: true, printSalesOrders: true },
        { slot: 2, printerName: "Harness 12441 Printer 2", printTransferOrders: true, printSalesOrders: false }
      ]
    });
    assert.equal(configured.transferOrderReady, false);
    assert.equal(configured.salesOrderReady, false);

    const credentials = await rotateYardPrinterToken(15);
    assert.equal(credentials.printer.transferOrderReady, true);
    assert.equal(credentials.printer.salesOrderReady, true);

    const testJob = await queueYardPrinterTest(15, null, 2);
    await rememberPrintPath(testJob.id);
    assert.deepEqual(testJob.printerNames, ["Harness 12441 Printer 2"]);
    const testLease = await leaseYardPrintJob(credentials.token, configured.agentId, 1);
    assert.equal(testLease.job.id, testJob.id);
    await updateLeasedPrintJob(testJob.id, credentials.token, configured.agentId, testLease.job.leaseToken, "completed");

    const salesJob = await queueSmartScmPrintJob({
      locationId: 15,
      documentType: "sales_order_picking_ticket",
      documentName: "SO-dual-printer-harness.pdf",
      documentBuffer: createSimplePdf(["SO single-printer routing harness"]),
      jobKey: `dual-printer-harness:so:${Date.now()}`
    });
    await rememberPrintPath(salesJob.id);
    assert.deepEqual(salesJob.printerNames, ["Harness 12441 Printer 1"]);
    const salesLease = await leaseYardPrintJob(credentials.token, configured.agentId, 1);
    assert.equal(salesLease.job.id, salesJob.id);
    await updateLeasedPrintJob(salesJob.id, credentials.token, configured.agentId, salesLease.job.leaseToken, "completed");

    const transferJob = await queueSmartScmPrintJob({
      locationId: 15,
      documentType: "picking_ticket",
      documentName: "TO-dual-printer-harness.pdf",
      documentBuffer: createSimplePdf(["TO dual-printer routing harness"]),
      jobKey: `dual-printer-harness:to:${Date.now()}`
    });
    await rememberPrintPath(transferJob.id);
    assert.deepEqual(transferJob.printerNames, ["Harness 12441 Printer 1", "Harness 12441 Printer 2"]);
    await query("UPDATE scm_print_jobs SET printer_names = '[\"Legacy Printer\"]'::jsonb WHERE id = $1", [transferJob.id]);
    await assert.rejects(
      leaseYardPrintJob(credentials.token, configured.agentId, 1),
      /Update the MBBS Yard Printer Agent/
    );
    const transferLease = await leaseYardPrintJob(credentials.token, configured.agentId, 2);
    assert.equal(transferLease.job.id, transferJob.id);
    assert.equal(transferLease.job.copyCount, 2);
    await updateLeasedPrintJob(transferJob.id, credentials.token, configured.agentId, transferLease.job.leaseToken, "failed", { error: "Harness retry check" });
    await query("UPDATE scm_print_jobs SET printer_names = '[\"Legacy Printer\"]'::jsonb WHERE id = $1", [transferJob.id]);
    const retriedTransfer = await retrySmartScmPrintJob(transferJob.id);
    assert.deepEqual(retriedTransfer.printerNames, ["Harness 12441 Printer 1", "Harness 12441 Printer 2"]);
    const retriedLease = await leaseYardPrintJob(credentials.token, configured.agentId, 2);
    assert.equal(retriedLease.job.id, transferJob.id);
    assert.equal(retriedLease.job.copyCount, 2);
    await updateLeasedPrintJob(transferJob.id, credentials.token, configured.agentId, retriedLease.job.leaseToken, "completed");

    await assert.rejects(
      updateYardPrinter(15, {
        printers: [
          { slot: 1, printerName: "Harness 12441 Printer 1", printTransferOrders: true, printSalesOrders: true },
          { slot: 2, printerName: "Harness 12441 Printer 2", printTransferOrders: true, printSalesOrders: true }
        ]
      }),
      /exactly one printer/
    );
  }, { rollback: true });

  console.log("Dual yard-printer routing checks passed.");
} finally {
  await Promise.all(printPaths.map((printPath) => fs.unlink(printPath).catch(() => null)));
  await closeDb();
}
