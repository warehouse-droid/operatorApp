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

async function verifyYardRouting(locationId, yardCode, { inputBins = false } = {}) {
  const printer1 = `Harness ${yardCode} Printer 1`;
  const printer2 = `Harness ${yardCode} Printer 2`;
  const printer1InputBin = inputBins ? 256 : null;
  const printer2InputBin = inputBins ? 257 : null;
  const routing = (secondInputBin = printer2InputBin) => [
    { slot: 1, printerName: printer1, inputBin: printer1InputBin, printTransferOrders: true, printSalesOrders: true },
    { slot: 2, printerName: printer2, inputBin: secondInputBin, printTransferOrders: true, printSalesOrders: false }
  ];
  await query(
    "UPDATE scm_yard_printers SET agent_token_hash = NULL WHERE location_id = $1",
    [locationId]
  );
  const configured = await updateYardPrinter(locationId, {
    enabled: true,
    printers: routing()
  });
  assert.equal(configured.transferOrderReady, false);
  assert.equal(configured.salesOrderReady, false);
  assert.deepEqual(configured.printers.map(({ printerName, inputBin }) => ({ printerName, inputBin })), [
    { printerName: printer1, inputBin: printer1InputBin },
    { printerName: printer2, inputBin: printer2InputBin }
  ]);

  const credentials = await rotateYardPrinterToken(locationId);
  assert.equal(credentials.printer.transferOrderReady, true);
  assert.equal(credentials.printer.salesOrderReady, true);

  const testJob = await queueYardPrinterTest(locationId, null, 2);
  await rememberPrintPath(testJob.id);
  assert.deepEqual(testJob.printerNames, [printer2]);
  assert.deepEqual(testJob.printerTargets, [{ printerName: printer2, inputBin: printer2InputBin }]);
  if (inputBins) {
    await updateYardPrinter(locationId, { printers: routing(300) });
    const duplicateTestJob = await queueSmartScmPrintJob({
      locationId,
      documentType: "test",
      documentName: `MBBS-${yardCode}-duplicate-printer-test.pdf`,
      documentBuffer: createSimplePdf([`${yardCode} duplicate job-key snapshot check`]),
      jobKey: testJob.jobKey,
      printerNames: [printer2]
    });
    assert.equal(duplicateTestJob.id, testJob.id);
    assert.deepEqual(duplicateTestJob.printerTargets, [{ printerName: printer2, inputBin: printer2InputBin }]);
    await updateYardPrinter(locationId, { printers: routing() });
  } else {
    await query("UPDATE scm_print_jobs SET printer_targets = '[]'::jsonb WHERE id = $1", [testJob.id]);
  }
  if (inputBins) {
    await assert.rejects(
      leaseYardPrintJob(credentials.token, configured.agentId, 2),
      /to v3/
    );
  }
  const testLease = await leaseYardPrintJob(credentials.token, configured.agentId, inputBins ? 3 : 1);
  assert.equal(testLease.job.id, testJob.id);
  assert.deepEqual(testLease.job.printerTargets, [{ printerName: printer2, inputBin: printer2InputBin }]);
  const reportedVersion = await query("SELECT agent_version FROM scm_yard_printers WHERE location_id = $1", [locationId]);
  assert.equal(Number(reportedVersion.rows[0].agent_version), inputBins ? 3 : 1);
  const receivedAt = new Date().toISOString();
  const startedTest = await updateLeasedPrintJob(
    testJob.id,
    credentials.token,
    configured.agentId,
    testLease.job.leaseToken,
    "started",
    inputBins ? { diagnostics: { agentVersion: 3, receivedAt, phase: "printing", downloadMs: 10 } } : {}
  );
  if (inputBins) {
    assert.equal(startedTest.agentDiagnostics.phase, "printing");
    const heartbeatTest = await updateLeasedPrintJob(
      testJob.id,
      credentials.token,
      configured.agentId,
      testLease.job.leaseToken,
      "heartbeat",
      { diagnostics: { agentVersion: 3, receivedAt, phase: "sumatra_wait", downloadMs: 10, processingMs: 75 } }
    );
    assert.equal(heartbeatTest.agentDiagnostics.lastAction, "heartbeat");
    assert.equal(heartbeatTest.agentDiagnostics.phase, "sumatra_wait");
  }
  const completedTest = await updateLeasedPrintJob(
    testJob.id,
    credentials.token,
    configured.agentId,
    testLease.job.leaseToken,
    "completed",
    inputBins
      ? {
          diagnostics: {
            agentVersion: 3,
            receivedAt,
            phase: "completed",
            downloadMs: 10,
            processingMs: 123,
            totalMs: 150,
            targets: [{ printerName: printer2, inputBin: printer2InputBin, waitMs: 100, exitCode: 0 }]
          }
        }
      : {}
  );
  assert.equal(completedTest.agentDiagnostics.lastAction, "completed");
  if (inputBins) {
    assert.equal(completedTest.agentDiagnostics.processingMs, 123);
    assert.equal(completedTest.agentDiagnostics.targets[0].inputBin, printer2InputBin);
  } else {
    assert.equal(completedTest.agentDiagnostics.processingMs, undefined);
  }

  const salesJob = await queueSmartScmPrintJob({
    locationId,
    documentType: "sales_order_picking_ticket",
    documentName: `SO-${yardCode}-dual-printer-harness.pdf`,
    documentBuffer: createSimplePdf([`${yardCode} SO single-printer routing harness`]),
    jobKey: `dual-printer-harness:${yardCode}:so:${Date.now()}`
  });
  await rememberPrintPath(salesJob.id);
  assert.deepEqual(salesJob.printerNames, [printer1]);
  assert.deepEqual(salesJob.printerTargets, [{ printerName: printer1, inputBin: printer1InputBin }]);
  const salesLease = await leaseYardPrintJob(credentials.token, configured.agentId, inputBins ? 3 : 1);
  assert.equal(salesLease.job.id, salesJob.id);
  await updateLeasedPrintJob(salesJob.id, credentials.token, configured.agentId, salesLease.job.leaseToken, "completed");

  const transferJob = await queueSmartScmPrintJob({
    locationId,
    documentType: "picking_ticket",
    documentName: `TO-${yardCode}-dual-printer-harness.pdf`,
    documentBuffer: createSimplePdf([`${yardCode} TO dual-printer routing harness`]),
    jobKey: `dual-printer-harness:${yardCode}:to:${Date.now()}`
  });
  await rememberPrintPath(transferJob.id);
  assert.deepEqual(transferJob.printerNames, [printer1, printer2]);
  assert.deepEqual(transferJob.printerTargets, [
    { printerName: printer1, inputBin: printer1InputBin },
    { printerName: printer2, inputBin: printer2InputBin }
  ]);
  await query(
    `UPDATE scm_print_jobs
        SET printer_names = '["Legacy Printer"]'::jsonb,
            printer_targets = '[{"printerName":"Legacy Printer","inputBin":null}]'::jsonb
      WHERE id = $1`,
    [transferJob.id]
  );
  await assert.rejects(
    leaseYardPrintJob(credentials.token, configured.agentId, 1),
    /Update the MBBS Yard Printer Agent/
  );
  if (inputBins) {
    await assert.rejects(
      leaseYardPrintJob(credentials.token, configured.agentId, 2),
      /to v3/
    );
  }
  const transferLease = await leaseYardPrintJob(credentials.token, configured.agentId, inputBins ? 3 : 2);
  assert.equal(transferLease.job.id, transferJob.id);
  assert.equal(transferLease.job.copyCount, 2);
  const failedTransfer = await updateLeasedPrintJob(
    transferJob.id,
    credentials.token,
    configured.agentId,
    transferLease.job.leaseToken,
    "failed",
    inputBins
      ? {
          error: "Harness PDF processing failure",
          diagnostics: {
            agentVersion: 3,
            phase: "pdf_validation",
            processingMs: 4321,
            errorMessage: "Harness PDF processing failure"
          }
        }
      : { error: "Harness PDF processing failure" }
  );
  assert.equal(failedTransfer.lastError, "Harness PDF processing failure");
  if (inputBins) {
    assert.equal(failedTransfer.agentDiagnostics.phase, "pdf_validation");
    assert.equal(failedTransfer.agentDiagnostics.errorMessage, "Harness PDF processing failure");
  }
  await query(
    `UPDATE scm_print_jobs
        SET printer_names = '["Legacy Printer"]'::jsonb,
            printer_targets = '[{"printerName":"Legacy Printer","inputBin":null}]'::jsonb
      WHERE id = $1`,
    [transferJob.id]
  );
  const retriedTransfer = await retrySmartScmPrintJob(transferJob.id);
  assert.deepEqual(retriedTransfer.printerNames, [printer1, printer2]);
  assert.deepEqual(retriedTransfer.printerTargets, [
    { printerName: printer1, inputBin: printer1InputBin },
    { printerName: printer2, inputBin: printer2InputBin }
  ]);
  const retriedLease = await leaseYardPrintJob(credentials.token, configured.agentId, inputBins ? 3 : 2);
  assert.equal(retriedLease.job.id, transferJob.id);
  assert.equal(retriedLease.job.copyCount, 2);
  await updateLeasedPrintJob(transferJob.id, credentials.token, configured.agentId, retriedLease.job.leaseToken, "completed");

  await assert.rejects(
    updateYardPrinter(locationId, {
      printers: [
        { slot: 1, printerName: printer1, inputBin: printer1InputBin, printTransferOrders: true, printSalesOrders: true },
        { slot: 2, printerName: printer2, inputBin: printer2InputBin, printTransferOrders: true, printSalesOrders: true }
      ]
    }),
    /exactly one printer/
  );
  for (const invalidInputBin of [0, 65536, 1.5, true, "not-a-bin"]) {
    await assert.rejects(
      updateYardPrinter(locationId, {
        printers: [
          { ...routing()[0], inputBin: invalidInputBin },
          routing()[1]
        ]
      }),
      /RawKind/
    );
  }
}

try {
  await withTransaction(async () => {
    await verifyYardRouting(1, "3445");
    await verifyYardRouting(15, "12441", { inputBins: true });
  }, { rollback: true });

  console.log("Dual yard-printer routing checks passed.");
} finally {
  await Promise.all(printPaths.map((printPath) => fs.unlink(printPath).catch(() => null)));
  await closeDb();
}
