import assert from "node:assert/strict";
import test from "node:test";

import {
  assertScmTransferOrderPrintable,
  listScmTransferOrderPrintJobs,
  prepareScmTransferOrderPrintPreview,
  queueScmTransferOrderPrint,
  resolveScmTransferOrderPrinter
} from "../../../src/scm-transfer-order-print-service.js";

function printableCandidate(overrides = {}) {
  return {
    orderId: 870123,
    orderRef: "TOB00999",
    sourceLocationId: 28,
    sourceLocation: "2967",
    destinationLocationId: 15,
    destinationLocation: "12441",
    status: "B",
    statusText: "Transfer Order : Pending Fulfillment",
    netsuiteActive: true,
    ...overrides
  };
}

function readyPrinter(overrides = {}) {
  return {
    locationId: 28,
    yardCode: "2967",
    status: "online",
    transferOrderReady: true,
    transferOrderPrinterNames: ["TO Printer A", "TO Printer B"],
    ...overrides
  };
}

function authoritativeTransferOrder(overrides = {}) {
  return {
    id: 870123,
    tranid: "TOB00999",
    source_location_id: 28,
    source_location: "2967",
    destination_location_id: 15,
    destination_location: "12441",
    status: "B",
    status_text: "Transfer Order : Pending Fulfillment",
    ...overrides
  };
}

test("SCM TO printing fetches the current NetSuite ticket and queues both source-yard printers", async () => {
  const calls = { fetch: [], queue: [], audit: [] };
  const pdf = Buffer.from("%PDF-1.4 test", "utf8");
  const result = await queueScmTransferOrderPrint({
    orderRef: "TOB00999",
    sourceId: 870123,
    requestId: "scm-to-print-request-001",
    actor: { id: 42, username: "scm.user", sessionId: "session-1" }
  }, {
    findCandidate: async (input) => {
      assert.deepEqual(input, { orderRef: "TOB00999", sourceId: 870123 });
      return printableCandidate();
    },
    fetchTransferOrder: async (orderId) => {
      assert.equal(orderId, 870123);
      return authoritativeTransferOrder();
    },
    listPrinters: async () => [readyPrinter()],
    fetchPickingTicket: async (...args) => {
      calls.fetch.push(args);
      return { filename: "TOB00999-picking-ticket.pdf", buffer: pdf };
    },
    queuePrintJob: async (...args) => {
      calls.queue.push(args);
      return {
        id: 551,
        status: "queued",
        printerNames: ["TO Printer A", "TO Printer B"]
      };
    },
    writeAudit: async (entry) => {
      calls.audit.push(entry);
      return { id: 901 };
    }
  });

  assert.deepEqual(calls.fetch, [[870123, {
    locationId: 28,
    filenamePrefix: "TOB00999"
  }]]);
  assert.equal(calls.queue.length, 1);
  const [job, actorId] = calls.queue[0];
  assert.equal(actorId, 42);
  assert.equal(job.locationId, 28);
  assert.equal(job.documentType, "picking_ticket");
  assert.equal(job.documentBuffer, pdf);
  assert.equal(job.sourceOrderId, 870123);
  assert.equal(job.sourceOrderRef, "TOB00999");
  assert.equal(job.lineLocationId, 28);
  assert.match(job.jobKey, /^scm-to-printing:to:870123:picking-ticket:[a-f0-9]{64}$/u);
  assert.equal(calls.audit[0].action, "scm.transfer_order.print_queued");
  assert.equal(calls.audit[0].details.printJobId, 551);
  assert.deepEqual(result.printer.printerNames, ["TO Printer A", "TO Printer B"]);
  assert.equal(result.printJob.id, 551);
});

test("the same request ID produces the same durable print-job key", async () => {
  const jobKeys = [];
  const dependencies = {
    findCandidate: async () => printableCandidate(),
    fetchTransferOrder: async () => authoritativeTransferOrder(),
    listPrinters: async () => [readyPrinter()],
    fetchPickingTicket: async () => ({ filename: "ticket.pdf", buffer: Buffer.from("pdf") }),
    queuePrintJob: async (job) => {
      jobKeys.push(job.jobKey);
      return { id: jobKeys.length, status: "queued", printerNames: ["TO Printer A", "TO Printer B"] };
    },
    writeAudit: async () => ({})
  };
  const input = {
    orderRef: "TOB00999",
    sourceId: 870123,
    requestId: "retry-safe-request-id"
  };
  await queueScmTransferOrderPrint(input, dependencies);
  await queueScmTransferOrderPrint(input, dependencies);
  assert.equal(jobKeys.length, 2);
  assert.equal(jobKeys[0], jobKeys[1]);
});

test("an authoritative NetSuite status or source-yard change blocks printing", async () => {
  let pickingTicketFetches = 0;
  const baseDependencies = {
    findCandidate: async () => printableCandidate(),
    listPrinters: async () => [readyPrinter()],
    fetchPickingTicket: async () => {
      pickingTicketFetches += 1;
      return { filename: "ticket.pdf", buffer: Buffer.from("pdf") };
    },
    queuePrintJob: async () => ({ id: 1, status: "queued" }),
    writeAudit: async () => ({})
  };
  await assert.rejects(
    queueScmTransferOrderPrint({
      orderRef: "TOB00999",
      sourceId: 870123,
      requestId: "authoritative-closed-request"
    }, {
      ...baseDependencies,
      fetchTransferOrder: async () => authoritativeTransferOrder({
        status: "H",
        status_text: "Transfer Order : Closed"
      })
    }),
    (error) => error?.status === 409 && error?.code === "SCM_TO_PRINT_CLOSED"
  );
  await assert.rejects(
    queueScmTransferOrderPrint({
      orderRef: "TOB00999",
      sourceId: 870123,
      requestId: "authoritative-yard-change-request"
    }, {
      ...baseDependencies,
      fetchTransferOrder: async () => authoritativeTransferOrder({
        source_location_id: 1,
        source_location: "3445"
      })
    }),
    (error) => error?.status === 409 && error?.code === "SCM_TO_PRINT_SOURCE_MISMATCH"
  );
  assert.equal(pickingTicketFetches, 0);
});

test("printing fails closed before document retrieval for unsafe TO states", () => {
  const cases = [
    [printableCandidate({ netsuiteActive: false }), "SCM_TO_PRINT_INACTIVE"],
    [printableCandidate({ status: "H", statusText: "Transfer Order : Closed" }), "SCM_TO_PRINT_CLOSED"],
    [printableCandidate({ status: "A", statusText: "Transfer Order : Pending Approval" }), "SCM_TO_PRINT_STATUS"]
  ];
  for (const [candidate, code] of cases) {
    assert.throws(
      () => assertScmTransferOrderPrintable(candidate),
      (error) => error?.status === 409 && error?.code === code
    );
  }
});

test("printing requires a request ID and a ready dual-printer source yard", async () => {
  await assert.rejects(
    queueScmTransferOrderPrint({ orderRef: "TOB00999" }, {}),
    (error) => error?.status === 400 && /request ID/i.test(error.message)
  );
  assert.throws(
    () => resolveScmTransferOrderPrinter(printableCandidate(), [readyPrinter({ transferOrderReady: false })]),
    (error) => error?.status === 409 && error?.code === "SCM_TO_PRINT_PRINTER_NOT_READY"
  );
});

test("source-yard name is a safe fallback when the TO header location ID is absent", () => {
  const printer = resolveScmTransferOrderPrinter(
    printableCandidate({ sourceLocationId: null, sourceLocation: "2967" }),
    [readyPrinter()]
  );
  assert.equal(printer.locationId, 28);
});

test("3445 Special source tickets route to the shared 3445 TO printers", () => {
  const printer = resolveScmTransferOrderPrinter(
    printableCandidate({ sourceLocationId: 14, sourceLocation: "3445 Special" }),
    [readyPrinter({ locationId: 1, yardCode: "3445" })]
  );
  assert.equal(printer.locationId, 1);
});

test("preview fetches the live ticket even while the source-yard printer is not ready", async () => {
  const document = { filename: "TOB00999.pdf", buffer: Buffer.from("%PDF-test") };
  const result = await prepareScmTransferOrderPrintPreview({
    orderRef: "TOB00999",
    sourceId: 870123
  }, {
    findCandidate: async () => printableCandidate(),
    fetchTransferOrder: async () => authoritativeTransferOrder(),
    listPrinters: async () => [readyPrinter({ transferOrderReady: false })],
    fetchPickingTicket: async () => document
  });
  assert.equal(result.candidate.orderRef, "TOB00999");
  assert.equal(result.printer.transferOrderReady, false);
  assert.equal(result.document, document);
});

test("an approved preview queues its exact PDF without fetching another ticket", async () => {
  const previewDocument = { filename: "preview.pdf", buffer: Buffer.from("%PDF-preview") };
  let remoteTicketFetches = 0;
  let queuedDocument = null;
  await queueScmTransferOrderPrint({
    orderRef: "TOB00999",
    sourceId: 870123,
    requestId: "preview-bound-request-id",
    document: previewDocument
  }, {
    findCandidate: async () => printableCandidate(),
    fetchTransferOrder: async () => authoritativeTransferOrder(),
    listPrinters: async () => [readyPrinter()],
    fetchPickingTicket: async () => {
      remoteTicketFetches += 1;
      return { filename: "wrong.pdf", buffer: Buffer.from("wrong") };
    },
    queuePrintJob: async (job) => {
      queuedDocument = job.documentBuffer;
      return { id: 91, status: "queued", printerNames: ["TO Printer A", "TO Printer B"] };
    },
    writeAudit: async () => ({})
  });
  assert.equal(remoteTicketFetches, 0);
  assert.equal(queuedDocument, previewDocument.buffer);
});

test("recent TO history exposes its originating module and both printer names", async () => {
  const jobs = await listScmTransferOrderPrintJobs({ limit: 20 }, {
    runQuery: async (sql, params) => {
      assert.match(sql, /scm_smart_proposals proposal/u);
      assert.deepEqual(params[0], ["picking_ticket", "transfer_dependency_picking_ticket"]);
      return {
        rows: [{
          id: 77,
          resolved_order_id: 870123,
          resolved_order_ref: "TOB00999",
          source_module: "Stock Requests",
          line_location_id: 28,
          resolved_source_location_id: 28,
          source_yard_code: "2967",
          location_id: 28,
          printer_yard_code: "2967",
          printer_names: ["TO Printer A", "TO Printer B"],
          requested_by: "SCM User",
          queued_at: "2026-08-18T12:00:00.000Z",
          status: "printed",
          attempts: 1,
          document_type: "transfer_dependency_picking_ticket",
          document_name: "TOB00999.pdf",
          document_sha256: "abc"
        }],
        rowCount: 1
      };
    }
  });
  assert.equal(jobs[0].sourceModule, "Stock Requests");
  assert.deepEqual(jobs[0].printerNames, ["TO Printer A", "TO Printer B"]);
});
