import crypto from "node:crypto";

import { query } from "./db.js";
import { writeDispatchAudit } from "./dispatch-audit-repository.js";
import {
  fetchPickingTicketFromNetSuite,
  fetchTransferOrderByIdFromNetSuite
} from "./netsuite.js";
import { isNetSuiteOrderClosed } from "./netsuite-closed-order-policy.js";
import {
  listYardPrinters,
  queueSmartScmPrintJob
} from "./smart-scm-print-repository.js";

export const SCM_TRANSFER_ORDER_PRINT_DOCUMENT_TYPES = Object.freeze([
  "picking_ticket",
  "transfer_dependency_picking_ticket"
]);

function httpError(message, status = 400, code = "SCM_TO_PRINT_INVALID") {
  return Object.assign(new Error(message), { status, code });
}

function cleanText(value) {
  return String(value ?? "").trim();
}

function optionalPositiveInteger(value, field) {
  if (value === undefined || value === null || cleanText(value) === "") return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw httpError(`${field} must be a positive integer.`);
  }
  return number;
}

function printRequestIdentity(value) {
  const requestId = cleanText(value);
  if (requestId.length < 8 || requestId.length > 200 || /[\u0000-\u001f\u007f]/u.test(requestId)) {
    throw httpError("A valid TO print request ID is required.");
  }
  return requestId;
}

function normalizedYard(value) {
  return cleanText(value).toUpperCase().replace(/\s+/g, " ");
}

function transferOrderPrinterLocationId(locationId, location = "") {
  const id = Number(locationId);
  const yard = normalizedYard(location);
  if ([1, 14].includes(id) || /(^|[^0-9])3445([^0-9]|$)/u.test(yard)) return 1;
  if (id === 28 || /(^|[^0-9])2967([^0-9]|$)/u.test(yard)) return 28;
  if (id === 15 || /(^|[^0-9])12441([^0-9]|$)/u.test(yard)) return 15;
  if (id === 26 || /(^|[^0-9])150([^0-9]|$)/u.test(yard)) return 26;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function mapCandidate(row = {}) {
  return {
    orderId: Number(row.netsuite_id),
    orderRef: cleanText(row.tranid),
    sourceLocationId: row.source_location_id === null || row.source_location_id === undefined
      ? null
      : Number(row.source_location_id),
    sourceLocation: cleanText(row.source_location),
    destinationLocationId: row.to_location_id === null || row.to_location_id === undefined
      ? null
      : Number(row.to_location_id),
    destinationLocation: cleanText(row.to_location),
    status: cleanText(row.status),
    statusText: cleanText(row.status_text),
    netsuiteActive: row.netsuite_active === true
  };
}

function mapPrintCandidate(row = {}) {
  const itemLines = (Array.isArray(row.item_lines) ? row.item_lines : []).map((line) => ({
    lineId: Number(line.lineId),
    itemName: cleanText(line.itemName || line.sku || "Item"),
    sku: cleanText(line.sku),
    quantity: line.quantity === null || line.quantity === undefined ? null : Number(line.quantity),
    unit: cleanText(line.unit)
  }));
  const candidate = mapCandidate({
    ...row,
    netsuite_id: row.order_id,
    tranid: row.order_ref,
    from_location_id: row.source_location_id,
    from_location: row.source_location,
    to_location_id: row.destination_location_id,
    to_location: row.destination_location
  });
  const pendingFulfillment = cleanText(candidate.status).toUpperCase() === "B"
    || /pending fulfillment/iu.test(cleanText(candidate.statusText));
  return {
    ...candidate,
    orderDate: row.order_date,
    lineCount: Number(row.line_count || 0),
    printHistoryCount: Number(row.print_history_count || 0),
    itemLines,
    items: cleanText(row.items),
    printable: candidate.orderId > 0
      && candidate.netsuiteActive
      && pendingFulfillment
      && !isNetSuiteOrderClosed({ status: candidate.status, statusText: candidate.statusText })
  };
}

function mapPrintHistory(row = {}) {
  const printerNames = (Array.isArray(row.printer_names) ? row.printer_names : [])
    .map(cleanText)
    .filter(Boolean);
  const resolvedOrderId = Number(row.resolved_order_id);
  return {
    jobId: Number(row.id),
    orderId: Number.isSafeInteger(resolvedOrderId) && resolvedOrderId > 0 ? resolvedOrderId : null,
    orderRef: cleanText(row.resolved_order_ref),
    sourceModule: cleanText(row.source_module) || "SCM",
    sourceLocationId: row.resolved_source_location_id === null || row.resolved_source_location_id === undefined
      ? null
      : Number(row.resolved_source_location_id),
    sourceYardCode: cleanText(row.source_yard_code),
    printerLocationId: Number(row.location_id),
    printerYardCode: cleanText(row.printer_yard_code),
    printerName: printerNames.join(" + ") || cleanText(row.printer_name),
    printerNames,
    requestedBy: cleanText(row.requested_by) || "System",
    requestedIpAddress: cleanText(row.requested_ip_address),
    requestedAt: row.queued_at,
    status: cleanText(row.status),
    attempts: Number(row.attempts || 0),
    printedAt: row.printed_at,
    lastError: cleanText(row.last_error),
    documentType: cleanText(row.document_type),
    documentName: cleanText(row.document_name),
    documentSha256: cleanText(row.document_sha256)
  };
}

const TO_PRINT_HISTORY_SELECT = `
  SELECT job.*,
         COALESCE(job.source_order_id, proposal.netsuite_transfer_order_id) AS resolved_order_id,
         COALESCE(NULLIF(job.source_order_ref, ''), NULLIF(proposal.netsuite_transfer_order_ref, '')) AS resolved_order_ref,
         COALESCE(job.line_location_id, proposal.source_location_id) AS resolved_source_location_id,
         printer.yard_code AS printer_yard_code,
         printer.printer_name,
         COALESCE(NULLIF(operator.display_name, ''), NULLIF(operator.username, ''), job.queued_by_operator_id, 'System') AS requested_by,
         CASE COALESCE(job.line_location_id, proposal.source_location_id)
           WHEN 1 THEN '3445'
           WHEN 14 THEN '3445 Special'
           WHEN 28 THEN '2967'
           WHEN 15 THEN '12441'
           WHEN 26 THEN '150'
           ELSE COALESCE(NULLIF(proposal.source_name, ''), COALESCE(job.line_location_id, proposal.source_location_id)::text, '')
         END AS source_yard_code,
         CASE
           WHEN job.job_key LIKE 'stock-request:%' THEN 'Stock Requests'
           WHEN job.job_key LIKE 'transfer-dependency:%' THEN 'Auto Transfer'
           WHEN job.job_key LIKE 'smart-scm:%' THEN 'Smart SCM'
           WHEN job.job_key LIKE 'scm-to-printing:%' OR job.job_key LIKE 'scm-schedule:%' THEN 'TO Printing'
           WHEN job.document_type = 'transfer_dependency_picking_ticket' THEN 'Auto Transfer'
           ELSE 'SCM'
         END AS source_module
    FROM scm_print_jobs job
    JOIN scm_yard_printers printer ON printer.location_id = job.location_id
    LEFT JOIN scm_smart_proposals proposal
      ON proposal.id = job.proposal_id
     AND proposal.proposal_type = 'TO'
    LEFT JOIN operators operator ON operator.id = job.queued_by_operator_id
`;

export async function listScmTransferOrderPrintCandidates({
  search = "",
  sourceLocationId = null,
  limit = 500
} = {}, { runQuery = query } = {}) {
  const term = cleanText(search).toLowerCase();
  const sourceId = optionalPositiveInteger(sourceLocationId, "TO printing source yard");
  const max = Math.min(2500, Math.max(1, Number(limit) || 500));
  const result = await runQuery(
    `WITH transfer_scope AS (
       SELECT transfer.netsuite_id AS order_id,
              transfer.tranid AS order_ref,
              transfer.trandate AS order_date,
              transfer.status,
              transfer.status_text,
              transfer.netsuite_active,
              COALESCE(transfer.from_location_id, outbound.location_id) AS source_location_id,
              COALESCE(NULLIF(BTRIM(transfer.from_location), ''), outbound.location) AS source_location,
              transfer.to_location_id AS destination_location_id,
              transfer.to_location AS destination_location,
              COALESCE(lines.line_count, 0) AS line_count,
              COALESCE(lines.item_lines, '[]'::jsonb) AS item_lines,
              COALESCE(lines.items, '') AS items,
              COALESCE(history.print_history_count, 0) AS print_history_count
         FROM transfer_orders transfer
         LEFT JOIN LATERAL (
           SELECT CASE
                    WHEN COUNT(DISTINCT line.location_id) FILTER (WHERE line.location_id IS NOT NULL) = 1
                    THEN MIN(line.location_id) FILTER (WHERE line.location_id IS NOT NULL)
                    ELSE NULL
                  END AS location_id,
                  CASE
                    WHEN COUNT(DISTINCT line.location_id) FILTER (WHERE line.location_id IS NOT NULL) = 1
                    THEN MAX(NULLIF(BTRIM(line.location), '')) FILTER (WHERE line.location_id IS NOT NULL)
                    ELSE NULL
                  END AS location
             FROM transfer_order_lines line
            WHERE line.transfer_order_id = transfer.netsuite_id
              AND line.line_stage = 'outbound'
              AND line.netsuite_active = true
         ) outbound ON true
         LEFT JOIN LATERAL (
           SELECT COUNT(*)::integer AS line_count,
                  COALESCE(jsonb_agg(jsonb_build_object(
                    'lineId', line.id,
                    'sku', line.sku,
                    'itemName', COALESCE(NULLIF(line.item_name, ''), NULLIF(line.sku, ''), 'Item'),
                    'quantity', line.quantity,
                    'unit', line.unit
                  ) ORDER BY line.id), '[]'::jsonb) AS item_lines,
                  COALESCE(string_agg(DISTINCT trim(concat_ws(' ', NULLIF(line.sku, ''), NULLIF(line.item_name, ''))), ', '), '') AS items
             FROM transfer_order_lines line
            WHERE line.transfer_order_id = transfer.netsuite_id
              AND line.line_stage = 'outbound'
              AND line.netsuite_active = true
         ) lines ON true
         LEFT JOIN LATERAL (
           SELECT COUNT(*)::integer AS print_history_count
             FROM scm_print_jobs job
             LEFT JOIN scm_smart_proposals proposal
               ON proposal.id = job.proposal_id
              AND proposal.proposal_type = 'TO'
            WHERE job.document_type = ANY($4::text[])
              AND (
                COALESCE(job.source_order_id, proposal.netsuite_transfer_order_id) = transfer.netsuite_id
                OR LOWER(COALESCE(NULLIF(job.source_order_ref, ''), NULLIF(proposal.netsuite_transfer_order_ref, ''))) = LOWER(transfer.tranid)
              )
         ) history ON true
        WHERE transfer.netsuite_id > 0
     )
     SELECT *
       FROM transfer_scope scope
      WHERE ($2::bigint IS NULL
             OR scope.source_location_id = $2::bigint
             OR ($2::bigint = 1 AND scope.source_location_id = 14))
        AND (
          ($1 = '' AND scope.netsuite_active = true
            AND (UPPER(COALESCE(scope.status, '')) = 'B' OR scope.status_text ILIKE '%pending fulfillment%'))
          OR ($1 <> '' AND LOWER(concat_ws(
            ' ', scope.order_ref, scope.source_location, scope.destination_location,
            scope.status, scope.status_text, scope.items
          )) LIKE '%' || $1 || '%')
        )
      ORDER BY scope.order_date DESC NULLS LAST, scope.order_ref DESC
      LIMIT $3`,
    [term, sourceId, max, SCM_TRANSFER_ORDER_PRINT_DOCUMENT_TYPES]
  );
  return result.rows.map(mapPrintCandidate);
}

export async function listScmTransferOrderPrintJobs({ limit = 200 } = {}, { runQuery = query } = {}) {
  const max = Math.min(1000, Math.max(1, Number(limit) || 200));
  const result = await runQuery(
    `${TO_PRINT_HISTORY_SELECT}
      WHERE job.document_type = ANY($1::text[])
        AND (
          COALESCE(job.source_order_id, proposal.netsuite_transfer_order_id) IS NOT NULL
          OR COALESCE(NULLIF(job.source_order_ref, ''), NULLIF(proposal.netsuite_transfer_order_ref, '')) IS NOT NULL
        )
      ORDER BY job.queued_at DESC, job.id DESC
      LIMIT $2`,
    [SCM_TRANSFER_ORDER_PRINT_DOCUMENT_TYPES, max]
  );
  return result.rows.map(mapPrintHistory);
}

export async function listScmTransferOrderPrintHistory({ orderId, orderRef = "" } = {}, { runQuery = query } = {}) {
  const id = optionalPositiveInteger(orderId, "Transfer Order ID");
  const ref = cleanText(orderRef);
  if (!id || !ref) throw httpError("A valid Transfer Order is required.");
  const result = await runQuery(
    `${TO_PRINT_HISTORY_SELECT}
      WHERE job.document_type = ANY($3::text[])
        AND (
          COALESCE(job.source_order_id, proposal.netsuite_transfer_order_id) = $1
          OR LOWER(COALESCE(NULLIF(job.source_order_ref, ''), NULLIF(proposal.netsuite_transfer_order_ref, ''))) = LOWER($2)
        )
      ORDER BY job.queued_at DESC, job.id DESC`,
    [id, ref, SCM_TRANSFER_ORDER_PRINT_DOCUMENT_TYPES]
  );
  return result.rows.map(mapPrintHistory);
}

export async function getScmTransferOrderPrintSnapshot({
  orderId,
  orderRef = "",
  jobId
} = {}, { runQuery = query } = {}) {
  const id = optionalPositiveInteger(orderId, "Transfer Order ID");
  const ref = cleanText(orderRef);
  const printJobId = optionalPositiveInteger(jobId, "TO print job ID");
  if (!id || !ref || !printJobId) throw httpError("Select a valid TO picking-ticket snapshot.");
  const result = await runQuery(
    `${TO_PRINT_HISTORY_SELECT}
      WHERE job.id = $1
        AND job.document_type = ANY($4::text[])
        AND (
          COALESCE(job.source_order_id, proposal.netsuite_transfer_order_id) = $2
          OR LOWER(COALESCE(NULLIF(job.source_order_ref, ''), NULLIF(proposal.netsuite_transfer_order_ref, ''))) = LOWER($3)
        )
      LIMIT 1`,
    [printJobId, id, ref, SCM_TRANSFER_ORDER_PRINT_DOCUMENT_TYPES]
  );
  if (!result.rowCount) {
    throw httpError("The picking-ticket snapshot was not found for this Transfer Order.", 404, "SCM_TO_PRINT_SNAPSHOT_NOT_FOUND");
  }
  return {
    ...mapPrintHistory(result.rows[0]),
    documentPath: result.rows[0].document_path
  };
}

export async function findScmTransferOrderPrintCandidate({
  orderRef = "",
  sourceId = null
} = {}, { runQuery = query } = {}) {
  const ref = cleanText(orderRef);
  if (!ref || ref.length > 120) throw httpError("A valid Transfer Order reference is required.");
  const expectedSourceId = optionalPositiveInteger(sourceId, "Transfer Order source ID");
  const result = await runQuery(
    `SELECT transfer.netsuite_id,
            transfer.tranid,
            COALESCE(transfer.from_location_id, outbound_location.location_id) AS source_location_id,
            COALESCE(NULLIF(BTRIM(transfer.from_location), ''), outbound_location.location) AS source_location,
            transfer.to_location_id,
            transfer.to_location,
            transfer.status,
            transfer.status_text,
            transfer.netsuite_active
       FROM transfer_orders transfer
       LEFT JOIN LATERAL (
         SELECT CASE
                  WHEN COUNT(DISTINCT line.location_id) FILTER (WHERE line.location_id IS NOT NULL) = 1
                  THEN MIN(line.location_id) FILTER (WHERE line.location_id IS NOT NULL)
                  ELSE NULL
                END AS location_id,
                CASE
                  WHEN COUNT(DISTINCT line.location_id) FILTER (WHERE line.location_id IS NOT NULL) = 1
                  THEN MAX(NULLIF(BTRIM(line.location), '')) FILTER (WHERE line.location_id IS NOT NULL)
                  ELSE NULL
                END AS location
           FROM transfer_order_lines line
          WHERE line.transfer_order_id = transfer.netsuite_id
            AND line.line_stage = 'outbound'
            AND line.netsuite_active = true
       ) outbound_location ON true
      WHERE (LOWER(transfer.tranid) = LOWER($1) OR transfer.netsuite_id::text = $1)
        AND ($2::bigint IS NULL OR transfer.netsuite_id = $2::bigint)
      ORDER BY transfer.netsuite_active DESC, transfer.synced_at DESC NULLS LAST
      LIMIT 1`,
    [ref, expectedSourceId]
  );
  if (!result.rowCount) {
    throw httpError(`Transfer Order ${ref} was not found.`, 404, "SCM_TO_PRINT_NOT_FOUND");
  }
  return mapCandidate(result.rows[0]);
}

export function assertScmTransferOrderPrintable(candidate = {}) {
  const orderId = optionalPositiveInteger(candidate.orderId, "NetSuite Transfer Order ID");
  const orderRef = cleanText(candidate.orderRef);
  if (!orderId) {
    throw httpError("Only a NetSuite-backed Transfer Order can be printed.", 409, "SCM_TO_PRINT_LOCAL_ONLY");
  }
  if (!orderRef) throw httpError("The Transfer Order has no printable reference.", 409);
  if (candidate.netsuiteActive !== true) {
    throw httpError(`${orderRef} is inactive and cannot be printed.`, 409, "SCM_TO_PRINT_INACTIVE");
  }
  if (isNetSuiteOrderClosed({
    status: candidate.status,
    statusText: candidate.statusText
  })) {
    throw httpError(`${orderRef} is closed and cannot be printed.`, 409, "SCM_TO_PRINT_CLOSED");
  }
  const pendingFulfillment = cleanText(candidate.status).toUpperCase() === "B"
    || /pending fulfillment/iu.test(cleanText(candidate.statusText));
  if (!pendingFulfillment) {
    throw httpError(
      `${orderRef} must be Pending Fulfillment before its picking ticket can be printed.`,
      409,
      "SCM_TO_PRINT_STATUS"
    );
  }
  return {
    ...candidate,
    orderId,
    orderRef,
    sourceLocationId: optionalPositiveInteger(candidate.sourceLocationId, "Transfer Order source yard"),
    sourceLocation: cleanText(candidate.sourceLocation),
    destinationLocation: cleanText(candidate.destinationLocation)
  };
}

export function resolveScmTransferOrderPrinter(candidate = {}, printers = [], { requireReady = true } = {}) {
  const sourceId = Number(candidate.sourceLocationId);
  const printerLocationId = transferOrderPrinterLocationId(sourceId, candidate.sourceLocation);
  const sourceYard = normalizedYard(candidate.sourceLocation);
  const printer = (Array.isArray(printers) ? printers : []).find((item) =>
    (printerLocationId && Number(item.locationId) === printerLocationId)
    || (sourceYard && normalizedYard(item.yardCode) === sourceYard)
  );
  if (!printer) {
    throw httpError(
      `${candidate.sourceLocation || `Location ${candidate.sourceLocationId || "unknown"}`} has no SCM printer setup.`,
      409,
      "SCM_TO_PRINT_PRINTER_MISSING"
    );
  }
  if (requireReady && printer.transferOrderReady !== true) {
    throw httpError(
      `${printer.yardCode || candidate.sourceLocation} requires an enabled queue, an agent token, and two different printers assigned to TO printing.`,
      409,
      "SCM_TO_PRINT_PRINTER_NOT_READY"
    );
  }
  return printer;
}

export async function prepareScmTransferOrderPrintPreview({
  orderRef = "",
  sourceId = null
} = {}, dependencies = {}) {
  const findCandidate = dependencies.findCandidate || findScmTransferOrderPrintCandidate;
  const listPrinters = dependencies.listPrinters || listYardPrinters;
  const fetchTransferOrder = dependencies.fetchTransferOrder || fetchTransferOrderByIdFromNetSuite;
  const fetchPickingTicket = dependencies.fetchPickingTicket || fetchPickingTicketFromNetSuite;
  const localCandidate = assertScmTransferOrderPrintable(await findCandidate({ orderRef, sourceId }));
  const candidate = assertAuthoritativeScmTransferOrder(
    localCandidate,
    await fetchTransferOrder(localCandidate.orderId)
  );
  const printer = resolveScmTransferOrderPrinter(candidate, await listPrinters(), { requireReady: false });
  const document = await fetchPickingTicket(candidate.orderId, {
    locationId: candidate.sourceLocationId || Number(printer.locationId),
    filenamePrefix: candidate.orderRef
  });
  return { candidate, printer, document };
}

export function assertAuthoritativeScmTransferOrder(candidate = {}, remote = null) {
  if (!remote) {
    throw httpError(
      `${candidate.orderRef || "The Transfer Order"} was not found in NetSuite.`,
      409,
      "SCM_TO_PRINT_NETSUITE_MISSING"
    );
  }
  const remoteId = Number(remote.id);
  const remoteRef = cleanText(remote.tranid);
  if (remoteId !== Number(candidate.orderId) || (remoteRef && remoteRef.toLowerCase() !== candidate.orderRef.toLowerCase())) {
    throw httpError(
      "NetSuite returned a different Transfer Order identity. Refresh SCM before printing.",
      409,
      "SCM_TO_PRINT_IDENTITY_MISMATCH"
    );
  }
  const remoteSourceLocationId = optionalPositiveInteger(
    remote.source_location_id ?? remote.outbound_location_id,
    "NetSuite Transfer Order source yard"
  );
  const localSourceLocationId = optionalPositiveInteger(candidate.sourceLocationId, "Transfer Order source yard");
  if (localSourceLocationId && remoteSourceLocationId && localSourceLocationId !== remoteSourceLocationId) {
    throw httpError(
      `${candidate.orderRef} source yard changed in NetSuite. Refresh SCM before printing.`,
      409,
      "SCM_TO_PRINT_SOURCE_MISMATCH"
    );
  }
  return assertScmTransferOrderPrintable({
    ...candidate,
    orderId: remoteId,
    orderRef: remoteRef || candidate.orderRef,
    sourceLocationId: remoteSourceLocationId || localSourceLocationId,
    sourceLocation: cleanText(remote.source_location ?? remote.outbound_location) || candidate.sourceLocation,
    destinationLocationId: optionalPositiveInteger(
      remote.destination_location_id ?? remote.order_location_id,
      "NetSuite Transfer Order destination yard"
    ) || candidate.destinationLocationId,
    destinationLocation: cleanText(remote.destination_location ?? remote.order_location) || candidate.destinationLocation,
    status: cleanText(remote.status),
    statusText: cleanText(remote.status_text ?? remote.statusText),
    netsuiteActive: true
  });
}

export async function queueScmTransferOrderPrint({
  orderRef = "",
  sourceId = null,
  requestId = "",
  actor = {},
  document = null,
  requestedIpAddress = ""
} = {}, dependencies = {}) {
  const findCandidate = dependencies.findCandidate || findScmTransferOrderPrintCandidate;
  const listPrinters = dependencies.listPrinters || listYardPrinters;
  const fetchTransferOrder = dependencies.fetchTransferOrder || fetchTransferOrderByIdFromNetSuite;
  const fetchPickingTicket = dependencies.fetchPickingTicket || fetchPickingTicketFromNetSuite;
  const queuePrintJob = dependencies.queuePrintJob || queueSmartScmPrintJob;
  const writeAudit = dependencies.writeAudit || writeDispatchAudit;
  const identity = printRequestIdentity(requestId);
  const localCandidate = assertScmTransferOrderPrintable(await findCandidate({ orderRef, sourceId }));
  const candidate = assertAuthoritativeScmTransferOrder(
    localCandidate,
    await fetchTransferOrder(localCandidate.orderId)
  );
  const printer = resolveScmTransferOrderPrinter(candidate, await listPrinters());
  const queuedDocument = document?.buffer
    ? document
    : await fetchPickingTicket(candidate.orderId, {
        locationId: candidate.sourceLocationId || Number(printer.locationId),
        filenamePrefix: candidate.orderRef
      });
  const requestHash = crypto.createHash("sha256").update(identity).digest("hex");
  const printJob = await queuePrintJob({
    proposalId: null,
    locationId: Number(printer.locationId),
    documentType: "picking_ticket",
    documentName: queuedDocument.filename || `${candidate.orderRef}-picking-ticket.pdf`,
    documentBuffer: queuedDocument.buffer,
    jobKey: `scm-to-printing:to:${candidate.orderId}:picking-ticket:${requestHash}`,
    sourceOrderId: candidate.orderId,
    sourceOrderRef: candidate.orderRef,
    lineLocationId: candidate.sourceLocationId || Number(printer.locationId),
    requestedIpAddress: cleanText(requestedIpAddress)
  }, actor?.id || null);
  await writeAudit({
    action: "scm.transfer_order.print_queued",
    entityType: "transfer_order",
    entityId: String(candidate.orderId),
    orderId: candidate.orderRef,
    operatorId: actor?.id,
    operatorName: actor?.display_name || actor?.username,
    sessionId: actor?.sessionId,
    source: "scm-to-printing",
    details: {
      printJobId: printJob.id,
      sourceYard: printer.yardCode || candidate.sourceLocation,
      sourceLocationId: candidate.sourceLocationId,
      destinationYard: candidate.destinationLocation,
      printerNames: printJob.printerNames || printer.transferOrderPrinterNames || [],
      requestHash
    }
  }).catch(() => null);
  return {
    order: candidate,
    printer: {
      locationId: Number(printer.locationId),
      yardCode: printer.yardCode || candidate.sourceLocation,
      status: printer.status || "",
      printerNames: printJob.printerNames || printer.transferOrderPrinterNames || []
    },
    printJob
  };
}
